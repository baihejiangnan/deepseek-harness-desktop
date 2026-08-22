//! DSH 实例 HTTP RPC 适配层。
//!
//! 协作执行层通过运行中实例的 loopback API（`POST /api/<method>`）下发、
//! 轮询和取消任务。契约来自 DSH 安装包内 `dsh-host-apiproxy` /
//! `dsh-client-connection` 源码与实测：无令牌，Host 为 loopback 即信任，
//! 业务结果包在 `result.value`，错误包在 `result.error`。

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const COLLAB_STORE_FILE: &str = "collaboration.dat";
const COLLAB_STORE_KEY: &str = "collaboration_graph";
const WORKFLOWS_STORE_KEY: &str = "collaboration_workflows";
const PROMPT_MANUAL_FILE: &str = ".dsh-collab-api.md";
static RPC_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RPC_CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
    std::sync::OnceLock::new();

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabTaskStart {
    pub session_id: String,
    pub workspace_id: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabTaskStatus {
    pub done: bool,
    pub result: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabContractAgent {
    pub instance_id: String,
    pub name: String,
    pub role: String,
    pub port: u16,
    pub parent_instance_id: Option<String>,
    pub children: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabContractInput {
    pub workspace: String,
    pub agents: Vec<CollabContractAgent>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabPortAllocation {
    pub instance_id: String,
    pub port: u16,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub node_count: usize,
    pub updated_at: u64,
}

fn rpc_client() -> Result<reqwest::Client, String> {
    RPC_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(RPC_TIMEOUT)
                .build()
                .map_err(|error| format!("collab http client: {error}"))
        })
        .clone()
}

fn rpc_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "launcher-{nanos}-{}",
        RPC_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

async fn rpc(port: u16, method: &str, payload: Value) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/{method}");
    let body = json!({
        "type": "client-request",
        "rpcId": rpc_id(),
        "method": method,
        "payload": payload,
    });
    let response = rpc_client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("{method} request: {error}"))?;
    let envelope: Value = response
        .json()
        .await
        .map_err(|error| format!("{method} parse: {error}"))?;
    let result = envelope
        .get("result")
        .ok_or_else(|| format!("{method} missing result"))?;
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(result.get("value").cloned().unwrap_or(Value::Null));
    }
    let code = result
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = result
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("rpc failed");
    Err(format!("{code}: {message}"))
}

#[cfg(windows)]
fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

#[cfg(not(windows))]
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn same_path(left: &str, right: &str) -> bool {
    normalize_path(left) == normalize_path(right)
}

async fn ensure_workspace(port: u16, cwd: &str) -> Result<String, String> {
    let list = rpc(port, "workspace.list", json!({})).await?;
    if let Some(items) = list.get("items").and_then(Value::as_array) {
        for item in items {
            let path = item.get("path").and_then(Value::as_str);
            let workspace_id = item.get("workspaceId").and_then(Value::as_str);
            if let (Some(path), Some(workspace_id)) = (path, workspace_id) {
                if same_path(path, cwd) {
                    return Ok(workspace_id.to_string());
                }
            }
        }
    }
    let created = rpc(port, "workspace.create", json!({ "path": cwd })).await?;
    created
        .pointer("/workspace/workspaceId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "workspace.create missing workspaceId".to_string())
}

/// 从 assistant/message 事件的 content 块中提取文本，跳过空内容。
fn extract_text(content: &Value) -> Option<String> {
    let blocks = content.as_array()?;
    let mut text = String::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(part) = block.get("text").and_then(Value::as_str) {
                text.push_str(part);
            }
        }
    }
    if text.trim().is_empty() {
        None
    } else {
        Some(text.trim().to_string())
    }
}

/// 在运行中的实例上创建/复用工作区会话并下发任务，返回会话与工作区 id。
pub async fn start_task(port: u16, task: &str) -> Result<CollabTaskStart, String> {
    let host = rpc(port, "host.describe", json!({})).await?;
    let cwd = host
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| "host.describe missing cwd".to_string())?;

    let workspace_id = ensure_workspace(port, cwd).await?;
    let created = rpc(
        port,
        "session.create",
        json!({ "workspaceId": workspace_id }),
    )
    .await?;
    let session_id = created
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session.create missing sessionId".to_string())?
        .to_string();

    let accepted = rpc(
        port,
        "session.prompt",
        json!({
            "sessionId": session_id,
            "mode": "queue",
            "content": [{ "type": "text", "text": task }]
        }),
    )
    .await?;
    if accepted.get("accepted").and_then(Value::as_bool) != Some(true) {
        return Err("session.prompt not accepted".to_string());
    }
    Ok(CollabTaskStart {
        session_id,
        workspace_id,
    })
}

/// 轮询会话历史：出现 turn/end 即本轮完成，产物取 assistant 消息文本。
pub async fn poll_task(port: u16, session_id: &str) -> Result<CollabTaskStatus, String> {
    let history = rpc(
        port,
        "session.history",
        json!({
            "sessionId": session_id,
            "maxMessages": 100
        }),
    )
    .await?;
    let events = history
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut done = false;
    let mut result = String::new();
    for entry in &events {
        let Some(event) = entry.get("event") else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("turn/end") => done = true,
            Some("assistant/message") => {
                if let Some(text) = event.pointer("/data/message/content").and_then(extract_text) {
                    if !result.is_empty() {
                        result.push('\n');
                    }
                    result.push_str(&text);
                }
            }
            _ => {}
        }
    }
    Ok(CollabTaskStatus { done, result })
}

/// 取消运行中会话的任务（幂等；取消后实例会补写一个中断的 turn/end）。
pub async fn cancel_task(port: u16, session_id: &str) -> Result<(), String> {
    rpc(
        port,
        "session.cancel",
        json!({ "sessionId": session_id }),
    )
    .await?;
    Ok(())
}

/// 读取上次保存的协作画布（节点/连线/视口）；没有记录时返回 null。
pub fn load_graph(app_handle: &AppHandle) -> Option<serde_json::Value> {
    let store = app_handle.store(COLLAB_STORE_FILE).ok()?;
    store.get(COLLAB_STORE_KEY)
}

/// 保存协作画布（含任务、产物与视口位置），覆盖旧记录。
pub fn save_graph(app_handle: &AppHandle, graph: serde_json::Value) -> Result<(), String> {
    let store = app_handle
        .store(COLLAB_STORE_FILE)
        .map_err(|error| format!("COLLAB_STORE_OPEN: {error}"))?;
    store.set(COLLAB_STORE_KEY, graph);
    store
        .save()
        .map_err(|error| format!("COLLAB_STORE_SAVE: {error}"))
}

/// 把协作编排的运行时契约写入工作区（端口、角色、父子关系），供各实例读取。
///
/// 契约文件只是“连接信息 + 角色说明”，更丰富的交互约定由用户在工作区放
/// Markdown 文档规划；契约文件本身应被 Agent 视为只读参考。
pub fn write_contract(input: CollabContractInput) -> Result<String, String> {
    let workspace = std::path::Path::new(&input.workspace);
    if !workspace.is_dir() {
        return Err(format!(
            "COLLAB_CONTRACT_FAILED: workspace not found: {}",
            input.workspace
        ));
    }
    let payload = json!({
        "version": 1,
        "workspace": input.workspace,
        "agents": input.agents,
    });
    let path = workspace.join(".dsh-collab.json");
    let content = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("COLLAB_CONTRACT_FAILED: serialize: {error}"))?;
    std::fs::write(&path, content)
        .map_err(|error| format!("COLLAB_CONTRACT_FAILED: write: {error}"))?;
    // 与契约配套的“实例间发消息”操作手册，供主代理等 Agent 阅读后调用子实例。
    let manual_path = workspace.join(PROMPT_MANUAL_FILE);
    std::fs::write(&manual_path, PROMPT_MANUAL_CONTENT)
        .map_err(|error| format!("COLLAB_CONTRACT_FAILED: write manual: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 生成到工作区的操作手册内容：说明如何通过 loopback HTTP RPC 向其它 DSH 实例
/// 创建会话、下发任务、跟踪进度与取消（与实测通过的 dsh-remote 流程一致）。
const PROMPT_MANUAL_CONTENT: &str = r#"# DSH 实例间消息发送手册（协作运行时）

本文件与 `.dsh-collab.json` 配合使用：契约文件提供每个 Agent 的端口与职责，
本文件说明如何向其它 DSH 实例发送消息。请阅读本文件与契约文件，但**不要修改**它们。

## 目标地址与认证

```
POST http://127.0.0.1:<PORT>/api/<method>
```

- 每个 Agent 的真实端口见契约文件 `.dsh-collab.json` 中对应 `instanceId` 的 `port` 字段。
- 本机回环免认证；请求 Host 头必须是 `127.0.0.1:<PORT>`（HTTP 客户端默认会带）。
- 不需要 Cookie / Token / Origin。

## 请求信封与响应

请求体：

```json
{
  "type": "client-request",
  "rpcId": "任意唯一字符串",
  "method": "<method>",
  "payload": { }
}
```

响应（业务错误也是 HTTP 200，看 `result.ok`）：

```json
{
  "type": "server-response",
  "rpcId": "回显请求的 rpcId",
  "result": { "ok": true, "value": { } }
}
```

## 发送一条任务的完整步骤

### 1. 拿到工作区 id

`workspace.list`，在返回的 `items` 里找到 path 与契约 `workspace` 相同的记录，取 `workspaceId`。

### 2. 创建会话（必须传 workspaceId）

`session.create`：

```json
{ "workspaceId": "<上一步的 workspaceId>" }
```

返回 `value.sessionId`。

### 3. 下发任务

`session.prompt`：

```json
{
  "sessionId": "<上一步的 sessionId>",
  "mode": "queue",
  "content": [{ "type": "text", "text": "任务内容" }]
}
```

`accepted: true` 只表示任务已入队，**不代表完成**。

### 4. 跟踪进度

轮询 `session.history`（`{ "sessionId": "...", "maxMessages": 50 }`），
在返回的 `events` 里找 `event.type`，出现 **`turn/end`** 即本轮完成。

### 5. 取消任务（可选）

`session.cancel`（`{ "sessionId": "..." }`），返回 `accepted: true`。

## 要点与常见错误

- 会话必须带 `workspaceId`，否则会显示为“未分组”。
- 实例正忙时 `session.prompt` 返回 `agent-busy`，等它空闲再发。
- `session-not-found`：会话不存在或实例重启后失效，重新 `session.create`。
- 复用已有会话：先 `session.list` 找 `sessionId`，再直接 `session.prompt`（是“继续对话”）。
- HTTP 404：检查 `method` 与 URL 路径是否一致。
- HTTP 415：确保带了 `Content-Type: application/json`。

## 一句话流程

`session.create`（带 workspaceId）→ `session.prompt`（下发任务）→ 轮询 `session.history` 直到 `turn/end` → 必要时 `session.cancel`。
"#;

fn load_workflows(app_handle: &AppHandle) -> Vec<serde_json::Value> {
    let store = match app_handle.store(COLLAB_STORE_FILE) {
        Ok(store) => store,
        Err(_) => return Vec::new(),
    };
    store
        .get(WORKFLOWS_STORE_KEY)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn save_workflows(app_handle: &AppHandle, workflows: Vec<serde_json::Value>) -> Result<(), String> {
    let store = app_handle
        .store(COLLAB_STORE_FILE)
        .map_err(|error| format!("COLLAB_STORE_OPEN: {error}"))?;
    store.set(
        WORKFLOWS_STORE_KEY,
        serde_json::Value::Array(workflows),
    );
    store
        .save()
        .map_err(|error| format!("COLLAB_STORE_SAVE: {error}"))
}

fn workflow_summary(entry: &serde_json::Value) -> Option<WorkflowSummary> {
    let id = entry.get("id")?.as_str()?.to_string();
    let name = entry
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let graph = entry.get("graph")?;
    let workspace = graph
        .get("workspace")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let node_count = graph
        .get("nodes")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    let updated_at = entry
        .get("updatedAt")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    Some(WorkflowSummary {
        id,
        name,
        workspace,
        node_count,
        updated_at,
    })
}

/// 保存的协作工作流列表（按更新时间倒序）。
pub fn list_workflows(app_handle: &AppHandle) -> Vec<WorkflowSummary> {
    let mut workflows = load_workflows(app_handle);
    workflows.sort_by(|left, right| {
        let left_at = left.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
        let right_at = right.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
        right_at.cmp(&left_at)
    });
    workflows.iter().filter_map(workflow_summary).collect()
}

/// 保存（或按同名更新）一个命名工作流，返回摘要。
pub fn save_workflow(
    app_handle: &AppHandle,
    name: String,
    graph: serde_json::Value,
) -> Result<WorkflowSummary, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("COLLAB_WORKFLOW_NAME_EMPTY".to_string());
    }
    let mut workflows = load_workflows(app_handle);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    if let Some(existing) = workflows.iter_mut().find(|entry| {
        entry.get("name").and_then(|value| value.as_str()) == Some(trimmed.as_str())
    }) {
        existing["graph"] = graph;
        existing["updatedAt"] = serde_json::json!(now);
        let summary = workflow_summary(existing)
            .ok_or_else(|| "COLLAB_WORKFLOW_INVALID".to_string())?;
        save_workflows(app_handle, workflows)?;
        return Ok(summary);
    }
    let entry = serde_json::json!({
        "id": format!("workflow-{now}"),
        "name": trimmed,
        "graph": graph,
        "updatedAt": now,
    });
    let summary =
        workflow_summary(&entry).ok_or_else(|| "COLLAB_WORKFLOW_INVALID".to_string())?;
    workflows.push(entry);
    save_workflows(app_handle, workflows)?;
    Ok(summary)
}

/// 读取命名工作流完整图数据。
pub fn load_workflow(app_handle: &AppHandle, id: &str) -> Result<serde_json::Value, String> {
    load_workflows(app_handle)
        .into_iter()
        .find(|entry| entry.get("id").and_then(|value| value.as_str()) == Some(id))
        .and_then(|entry| entry.get("graph").cloned())
        .ok_or_else(|| format!("COLLAB_WORKFLOW_NOT_FOUND: {id}"))
}

/// 删除命名工作流。
pub fn delete_workflow(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let mut workflows = load_workflows(app_handle);
    let before = workflows.len();
    workflows
        .retain(|entry| entry.get("id").and_then(|value| value.as_str()) != Some(id));
    if workflows.len() == before {
        return Err(format!("COLLAB_WORKFLOW_NOT_FOUND: {id}"));
    }
    save_workflows(app_handle, workflows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_joins_text_blocks_only() {
        let content = json!([
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "x" },
            { "type": "text", "text": " world" }
        ]);
        assert_eq!(extract_text(&content).as_deref(), Some("hello world"));
    }

    #[test]
    fn extract_text_skips_empty_content() {
        assert_eq!(extract_text(&json!([])), None);
        assert_eq!(extract_text(&json!([{ "type": "text", "text": "  " }])), None);
    }

    #[cfg(windows)]
    #[test]
    fn same_path_is_case_insensitive_on_windows() {
        assert!(same_path("C:/Users/A/Work", r"C:\users\a\work"));
        assert!(!same_path("C:/Users/A/Work", "D:/Users/A/Work"));
    }

    #[cfg(not(windows))]
    #[test]
    fn same_path_normalizes_separators() {
        assert!(same_path("/home/a/work", "/home/a/work"));
        assert!(!same_path("/home/a/work", "/home/a/other"));
    }
}
