//! Launcher provider templates and the public DSH settings mapping.
//!
//! Secrets are separate from metadata and must never be returned by list APIs.
//!
//! 模板分两类，对应 DSH 的两条路由语义（见 docs/PROVIDER_UI_UPGRADE_PLAN.md §2.2）：
//! - `Catalog`：route key 命中运行时已安装的 pi-ai 目录，DSH 继承其端点、协议与模型清单。
//!   启动器只写用户**显式设置**的字段，其余一律省略，让 DSH 升级目录后实例能跟随。
//! - `Custom`：目录不提供该路由，DSH 要求自带 `api` + `baseURL` + `models`，行为同旧版。
//!
//! 这里刻意用"扁平结构 + `kind` 判别字段"而不是 serde 内部标签枚举：DPAPI 存储里已有
//! 大量旧记录，`#[serde(default)]` 能让它们原样反序列化成 `Custom`，不需要迁移脚本。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 目录内由 `llm-deepseek` 在运行时注册 `ctx.llm.registerAdapter` 占用的 route key。
/// 把它写进 `llm-pi-ai.providers` 会让 DSH 启动时抛 `DUPLICATE_ADAPTER`。
pub const RESERVED_ROUTE_IDS: &[&str] = &["deepseek-official"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderTemplateKind {
    /// 自定义接口：必须自带端点、协议与模型清单。旧记录默认落到这一类。
    #[default]
    Custom,
    /// 运行时目录路由：继承目录默认值，只写显式覆盖。
    Catalog,
}

/// 目录路由的模型来源。两者与 `modelOverrides` 的关系由 DSH 硬性规定：
/// `models` 一旦存在就**替换**目录清单，此时 `modelOverrides` 会被 DSH 拒绝而非忽略。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderModelSelection {
    /// 跟随目录全部模型；单模型调整写进 `modelOverrides`。
    #[default]
    All,
    /// 仅使用所选模型；DSH 目录新增的模型不会自动出现。单模型调整写进条目自身。
    Subset,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTemplate {
    /// 实例 `llm-pi-ai.providers` 下的 dict key，同时**也是模板库自身的定位键**：
    /// `provider_store` 的 save/get/remove 全部按它匹配。因此可以改 `name`，
    /// 改这个 key 等于新建一条模板（`editing = true` 时直接 `PROVIDER_NOT_FOUND`，
    /// 不会留下半条记录）。曾有的 `templateId` / `revision` 因从不被读写已删除。
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: ProviderTemplateKind,
    /// 空串表示"未设置"：Catalog 下不写该字段、由目录继承；Custom 下视为非法。
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    /// 仅 Catalog + `selection = All` 有效：按模型 id 调整目录里已有的条目。
    #[serde(default)]
    pub model_overrides: Vec<ProviderModel>,
    #[serde(default)]
    pub selection: ProviderModelSelection,
    #[serde(default)]
    pub default_for_new: bool,
}

impl ProviderTemplate {
    pub fn is_catalog(&self) -> bool {
        self.kind == ProviderTemplateKind::Catalog
    }

    /// Validate without a runtime. `Catalog` 是否真的命中目录需要运行时事实，
    /// 由 `validate_against_catalog` 负责，这里只校验与目录无关的结构不变量。
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 80
            || !self.id.as_bytes()[0].is_ascii_lowercase()
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || self.id.ends_with('-')
            || self.id.contains("--")
        {
            return Err("PROVIDER_ID_INVALID".into());
        }
        if RESERVED_ROUTE_IDS.contains(&self.id.as_str()) {
            return Err("PROVIDER_ID_RESERVED".into());
        }
        if self.name.trim().is_empty()
            || self.name.len() > 160
            || self.name.chars().any(char::is_control)
        {
            return Err("PROVIDER_NAME_INVALID".into());
        }
        if !self.base_url.is_empty() {
            let url = reqwest::Url::parse(&self.base_url).map_err(|_| "PROVIDER_URL_INVALID")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("PROVIDER_URL_INVALID".into());
            }
        } else if !self.is_catalog() {
            return Err("PROVIDER_URL_INVALID".into());
        }
        if self.protocol.chars().any(char::is_control) {
            return Err("PROVIDER_PROTOCOL_INVALID".into());
        }
        if self.protocol.is_empty() && !self.is_catalog() {
            return Err("PROVIDER_PROTOCOL_INVALID".into());
        }

        if self.is_catalog() {
            // DSH 语义：models 与 modelOverrides 互斥，且 override 只在
            // "目录路由 + 无 models 列表"时成立，违反即整段被拒（不是忽略）。
            if self.selection == ProviderModelSelection::All && !self.models.is_empty() {
                return Err("PROVIDER_MODEL_OVERRIDES_CONFLICT".into());
            }
            if self.selection == ProviderModelSelection::All && !self.model_id.is_empty() {
                return Err("PROVIDER_MODEL_OVERRIDES_CONFLICT".into());
            }
            if self.selection == ProviderModelSelection::Subset && !self.model_overrides.is_empty() {
                return Err("PROVIDER_MODEL_OVERRIDES_CONFLICT".into());
            }
        }

        let mut unique = std::collections::HashSet::new();
        let declared: Vec<&ProviderModel> = if self.is_catalog() && self.selection == ProviderModelSelection::All {
            self.model_overrides.iter().collect()
        } else if self.models.is_empty() {
            vec![]
        } else {
            self.models.iter().collect()
        };
        if self.is_catalog() && self.selection == ProviderModelSelection::All {
            // All 模式下 models 必须为空，否则就是上面已经拒绝过的冲突。
            if !self.models.is_empty() {
                return Err("PROVIDER_MODEL_OVERRIDES_CONFLICT".into());
            }
        } else {
            let ids: Vec<&str> = if self.models.is_empty() {
                if self.is_catalog() {
                    vec![]
                } else {
                    vec![&self.model_id]
                }
            } else {
                self.models.iter().map(|m| m.id.as_str()).collect()
            };
            if ids.iter().any(|id| !Self::model_id_ok(id)) || !ids.iter().all(|id| unique.insert(*id)) {
                return Err("PROVIDER_MODEL_INVALID".into());
            }
        }
        let mut override_ids = std::collections::HashSet::new();
        if declared.iter().any(|m| !Self::model_id_ok(&m.id) || !override_ids.insert(m.id.as_str())) {
            return Err("PROVIDER_MODEL_INVALID".into());
        }
        if self
            .models
            .iter()
            .chain(self.model_overrides.iter())
            .any(|m| m.context_window == Some(0) || m.max_tokens == Some(0) || m.name.as_ref().is_some_and(|n| n.len() > 512 || n.chars().any(char::is_control)))
        {
            return Err("PROVIDER_MODEL_INVALID".into());
        }
        Ok(())
    }

    fn model_id_ok(id: &str) -> bool {
        !id.trim().is_empty() && id == id.trim() && id.len() <= 512 && !id.chars().any(char::is_control)
    }

    /// Catalog 专用校验：route key 必须命中该运行时的目录（目录给出至少一个模型），
    /// 且声明的每个模型 id 都要在目录里真实存在。只消费 `catalog_models` 的键。
    ///
    /// 这里**不**核对协议：钉死的 `api` 只在 `profile()` 里对 `supportedProtocols()` 校验，
    /// 并不比对目录模型实际使用的线协议。DSH 内部路由级 `api` 与模型级 `api` 的优先级
    /// 尚未核实，所以不做"钉死协议必须匹配模型"这种无法兑现的断言；可选项由前端限制为
    /// 该路由模型实际观测到的取值。
    pub fn validate_against_catalog(&self, catalog_models: &Value) -> Result<(), String> {
        if !self.is_catalog() {
            return Ok(());
        }
        if !catalog_models.is_object() {
            return Err("PROVIDER_CATALOG_UNAVAILABLE".into());
        }
        let models = catalog_models.as_object().unwrap();
        if models.is_empty() {
            return Err("PROVIDER_CATALOG_ROUTE_UNKNOWN".into());
        }
        if self.selection == ProviderModelSelection::Subset {
            for entry in &self.models {
                if !models.contains_key(&entry.id) {
                    return Err("PROVIDER_MODEL_OVERRIDES_CONFLICT".into());
                }
            }
        }
        for entry in &self.model_overrides {
            if !models.contains_key(&entry.id) {
                return Err("PROVIDER_CATALOG_MODEL_UNKNOWN".into());
            }
        }
        Ok(())
    }

    pub fn credential_ref(&self) -> String {
        format!(
            "DSH_LAUNCHER_{}_API_KEY",
            self.id.replace('-', "_").to_ascii_uppercase()
        )
    }

    /// Build the settings profile written into `llm-pi-ai.providers.<id>`.
    ///
    /// Catalog 下只写用户显式设置过的字段：省略 `api`/`baseURL`/`models` 才会走目录继承，
    /// 写死它们就是把自己钉在今天的目录快照上。
    /// Only use protocols discovered from the selected runtime's schema.
    pub fn profile(&self, supported_protocols: &[String]) -> Result<Value, String> {
        self.validate()?;
        let mut profile = serde_json::Map::new();
        profile.insert("displayName".into(), json!(self.name));
        profile.insert("apiKeyEnv".into(), json!(self.credential_ref()));

        if self.is_catalog() {
            if !self.base_url.is_empty() {
                profile.insert("baseURL".into(), json!(self.base_url));
            }
            if !self.protocol.is_empty() {
                if !supported_protocols.contains(&self.protocol) {
                    return Err("PROVIDER_PROTOCOL_UNSUPPORTED".into());
                }
                profile.insert("api".into(), json!(self.protocol));
            }
            match self.selection {
                ProviderModelSelection::All => {
                    if !self.model_overrides.is_empty() {
                        let mut overrides = serde_json::Map::new();
                        for entry in &self.model_overrides {
                            overrides.insert(entry.id.clone(), serde_json::to_value(entry).map_err(|_| "PROVIDER_MODEL_INVALID")?);
                        }
                        profile.insert("modelOverrides".into(), Value::Object(overrides));
                    }
                }
                ProviderModelSelection::Subset => {
                    profile.insert("models".into(), serde_json::to_value(&self.models).map_err(|_| "PROVIDER_MODEL_INVALID")?);
                }
            }
            return Ok(Value::Object(profile));
        }

        if !supported_protocols.contains(&self.protocol) {
            return Err("PROVIDER_PROTOCOL_UNSUPPORTED".into());
        }
        profile.insert("baseURL".into(), json!(self.base_url));
        profile.insert("api".into(), json!(self.protocol));
        profile.insert(
            "models".into(),
            if self.models.is_empty() { json!([{ "id": self.model_id }]) } else { serde_json::to_value(&self.models).map_err(|_| "PROVIDER_MODEL_INVALID")? },
        );
        Ok(Value::Object(profile))
    }
}

/// 目录服务商的可配置判定。**规则只写在这里一处**：探测脚本只交出事实，
/// 前端只显示这里的结论，避免出现"前端一份、后端一份"的门禁分叉。
///
/// 判定是"可观测运行时事实的表达式"，不是服务商 id 白名单——DSH 升级目录后
/// 结论自动跟随，也不需要启动器手工维护清单。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVerdict {
    pub configurable: bool,
    /// 不可配置时的稳定原因码；可配置时为空串。前端据此出文案，不显示原始数据。
    pub limitation: &'static str,
}

pub fn judge_catalog_provider(facts: &Value) -> CatalogVerdict {
    let auth = facts.get("auth");
    let has_credential_auth = auth.and_then(|a| a.get("apiKey")).and_then(Value::as_bool).unwrap_or(false);
    let has_endpoint = matches!(facts.get("baseUrl").and_then(Value::as_str), Some(url) if !url.is_empty());
    let every_protocol = facts.get("supportsEveryProtocol").and_then(Value::as_bool).unwrap_or(false);
    let has_models = facts.get("modelCount").and_then(Value::as_u64).unwrap_or(0) > 0;

    // 顺序即优先级：先认证、再端点、再协议、最后模型，保证同一输入永远得到同一个原因码。
    let limitation = if !has_credential_auth {
        "PROVIDER_CATALOG_AUTH_UNSUPPORTED"
    } else if !has_endpoint {
        "PROVIDER_CATALOG_ENDPOINT_REQUIRED"
    } else if !every_protocol {
        "PROVIDER_CATALOG_PROTOCOL_UNSUPPORTED"
    } else if !has_models {
        "PROVIDER_CATALOG_NO_MODELS"
    } else {
        ""
    };
    CatalogVerdict { configurable: limitation.is_empty(), limitation }
}

/// 目录模型是否落在当前运行时的协议白名单内。按模型细分，不给服务商一个布尔值。
pub fn mark_catalog_models(models: &mut Vec<Value>, supported: &[String]) {
    for model in models.iter_mut() {
        let api = model.get("api").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(map) = model.as_object_mut() {
            map.insert("protocolSupported".into(), json!(supported.contains(&api)));
        }
    }
}

/// 把 `settings.describe` 的响应摊平成"运行时声明为密钥的字段位置"，元素为
/// `{ ns, path }`。
///
/// **只取路径、不取值**：远端本身固定带 `redactSecrets: true`，但把"密钥值不回传
/// 前端"这条自己的规则建立在对方的行为上，等于把它降级成一个下游依赖。这里只取
/// 位置，将来即使对方开始在描述符里带正文，也不会顺着这条路漏出去。
///
/// 形状不合法的条目跳过而非整次失败：部分可用的角色列表仍值得展示，而停机态下
/// 真正兜底的引用扫描本来就不依赖它。
pub fn secret_paths(describe: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for namespace in describe.get("namespaces").and_then(Value::as_array).into_iter().flatten() {
        let ns = match namespace.get("ns").and_then(Value::as_str) {
            Some(ns) => ns,
            None => continue,
        };
        let secrets = match namespace.get("secrets").and_then(Value::as_array) {
            Some(secrets) => secrets,
            None => continue,
        };
        for secret in secrets {
            let segments = match secret.get("path").and_then(Value::as_array) {
                Some(segments) => segments,
                None => continue,
            };
            let path: Vec<&str> = match segments.iter().map(Value::as_str).collect::<Option<Vec<&str>>>() {
                Some(path) if !path.is_empty() && path.iter().all(|segment| !segment.is_empty()) => path,
                _ => continue,
            };
            out.push(json!({ "ns": ns, "path": path }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_paths_keeps_positions_and_drops_values_and_malformed_entries() {
        let describe = json!({
            "writable": true,
            "namespaces": [
                { "ns": "llm-pi-ai", "secrets": [
                    { "path": ["providers", "deepseek", "headers", "authorization"], "set": true },
                    { "path": [], "set": false },
                    { "path": ["providers", "", "apiKey"], "set": false },
                    { "path": ["providers", "deepseek", 7], "set": false },
                    { "set": true }
                ] },
                { "ns": "web-search-deepseek", "secrets": [ { "path": ["apiKey"], "set": true } ] },
                { "ns": "session", "value": { "do-not-return": "this" } },
                { "secrets": [ { "path": ["orphan"] } ] },
                "not-an-object"
            ]
        });
        let paths = secret_paths(&describe);
        // 只有 llm-pi-ai 与 web-search-deepseek 各一条是合法的：空路径、空片段、
        // 非字符串片段、缺 path、缺 ns 全部被跳过。
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0]["ns"], "llm-pi-ai");
        assert_eq!(paths[0]["path"].as_array().unwrap().len(), 4, "nested header path survives intact");
        assert_eq!(paths[1]["ns"], "web-search-deepseek");
        // 关键：结果里只有位置，一个值都没有。
        let rendered = describe.to_string();
        for path in &paths {
            let serialized = path.to_string();
            assert!(!serialized.contains("this"), "descriptor payload must never ride along: {serialized}");
        }
        assert!(rendered.contains("do-not-return"));
        assert!(secret_paths(&json!({})).is_empty(), "a response without namespaces yields no roles");
        assert!(secret_paths(&json!({ "namespaces": "nope" })).is_empty());
    }
    fn template() -> ProviderTemplate {
        ProviderTemplate {
            id: "my-gateway".into(),
            name: "Gateway".into(),
            kind: ProviderTemplateKind::Custom,
            base_url: "https://example.com/v1".into(),
            protocol: "openai-completions".into(),
            model_id: "gateway-model".into(),
            models: vec![],
            model_overrides: vec![],
            selection: ProviderModelSelection::All,
            default_for_new: true,
        }
    }
    fn catalog(id: &str) -> ProviderTemplate {
        ProviderTemplate { kind: ProviderTemplateKind::Catalog, base_url: String::new(), protocol: String::new(), model_id: String::new(), ..ProviderTemplate { id: id.into(), ..template() } }
    }
    #[test]
    fn supports_multiple_models_and_legacy_templates() {
        let mut item = template();
        item.model_id.clear();
        assert!(item.validate().is_err());
        item.models = serde_json::from_value(json!([
            {"id":"first", "contextWindow":64000}, {"id":"second", "name":"Second"}
        ])).unwrap();
        assert!(item.validate().is_ok());
        let restored: ProviderTemplate = serde_json::from_value(serde_json::to_value(&item).unwrap()).unwrap();
        assert_eq!(restored.models[0].context_window, Some(64000));
        item.models.push(item.models[0].clone());
        assert_eq!(item.validate().unwrap_err(), "PROVIDER_MODEL_INVALID");
        let mut legacy = serde_json::to_value(template()).unwrap();
        legacy.as_object_mut().unwrap().remove("models");
        let legacy: ProviderTemplate = serde_json::from_value(legacy).unwrap();
        assert!(legacy.validate().is_ok());
        // 旧记录没有 kind，磁盘上还可能带着本次删掉的 templateId / revision。
        // 未知字段必须被忽略、缺失字段必须回退默认值，才不需要迁移脚本。
        let mut stale = serde_json::to_value(template()).unwrap();
        {
            let obj = stale.as_object_mut().unwrap();
            obj.remove("kind");
            obj.insert("templateId".into(), json!("whatever"));
            obj.insert("revision".into(), json!(7));
        }
        let stale: ProviderTemplate = serde_json::from_value(stale).unwrap();
        assert_eq!(stale.kind, ProviderTemplateKind::Custom);
        assert_eq!(stale.id, "my-gateway");
        assert!(stale.validate().is_ok());
    }
    #[test]
    fn catalog_profile_writes_only_explicit_overrides() {
        let protocols = vec!["openai-completions".into(), "anthropic-messages".into()];
        let item = catalog("deepseek");
        assert_eq!(item.validate(), Ok(()));
        // 跟随目录：只写 displayName + apiKeyEnv，绝不写 baseURL/api/models。
        assert_eq!(item.profile(&protocols).unwrap(), json!({
            "displayName": "Gateway",
            "apiKeyEnv": "DSH_LAUNCHER_DEEPSEEK_API_KEY",
        }));
        // 显式覆盖端点时才落盘该项。
        let overridden = ProviderTemplate { base_url: "https://gateway.internal/v1".into(), ..catalog("deepseek") };
        assert_eq!(overridden.profile(&protocols).unwrap()["baseURL"], "https://gateway.internal/v1");
        assert!(overridden.profile(&protocols).unwrap().get("api").is_none());
    }
    #[test]
    fn models_and_model_overrides_are_mutually_exclusive() {
        let protocols = vec!["openai-completions".into()];
        let model: ProviderModel = serde_json::from_value(json!({"id":"deepseek-v4-flash"})).unwrap();
        // All + models 非空 → DSH 会整段拒绝，这里必须提前拦住。
        let bad = ProviderTemplate { models: vec![model.clone()], ..catalog("deepseek") };
        assert_eq!(bad.validate().unwrap_err(), "PROVIDER_MODEL_OVERRIDES_CONFLICT");
        // Subset + modelOverrides 同理。
        let bad = ProviderTemplate { selection: ProviderModelSelection::Subset, model_overrides: vec![model.clone()], models: vec![model.clone()], ..catalog("deepseek") };
        assert_eq!(bad.validate().unwrap_err(), "PROVIDER_MODEL_OVERRIDES_CONFLICT");
        // Subset 的单模型调整写进条目本身，并且必须真的产出 models 字段。
        let subset = ProviderTemplate {
            selection: ProviderModelSelection::Subset,
            models: vec![ProviderModel { context_window: Some(64000), ..model.clone() }],
            ..catalog("deepseek")
        };
        assert_eq!(subset.validate(), Ok(()));
        assert_eq!(subset.profile(&protocols).unwrap()["models"], json!([{"id":"deepseek-v4-flash","contextWindow":64000}]));
        // All 的单模型调整走 modelOverrides。
        let all = ProviderTemplate { model_overrides: vec![ProviderModel { name: Some("别名".into()), ..model }], ..catalog("deepseek") };
        assert_eq!(all.validate(), Ok(()));
        assert_eq!(all.profile(&protocols).unwrap()["modelOverrides"]["deepseek-v4-flash"]["name"], "别名");
    }
    #[test]
    fn catalog_gate_is_a_rule_over_runtime_facts_not_an_id_list() {
        // 形状取自 provider-catalog.mjs 的真实输出。
        let configurable = json!({"id":"deepseek","baseUrl":"https://api.deepseek.com","modelCount":3,"supportsEveryProtocol":true,"auth":{"apiKey":true,"oauth":false}});
        assert_eq!(judge_catalog_provider(&configurable), CatalogVerdict { configurable: true, limitation: "" });
        // 只有 oauth（openai-codex 的实测形状）
        let oauth_only = json!({"id":"openai-codex","baseUrl":"https://chatgpt.com/backend-api","modelCount":7,"supportsEveryProtocol":false,"auth":{"apiKey":false,"oauth":true}});
        assert_eq!(judge_catalog_provider(&oauth_only).limitation, "PROVIDER_CATALOG_AUTH_UNSUPPORTED");
        // 缺端点（amazon-bedrock / google-vertex 等）
        let no_endpoint = json!({"id":"amazon-bedrock","baseUrl":"","modelCount":118,"supportsEveryProtocol":false,"auth":{"apiKey":true}});
        assert_eq!(judge_catalog_provider(&no_endpoint).limitation, "PROVIDER_CATALOG_ENDPOINT_REQUIRED");
        // 有端有密钥但协议不受支持（google / mistral 的实测形状）
        let bad_protocol = json!({"id":"google","baseUrl":"https://generativelanguage.googleapis.com","modelCount":22,"supportsEveryProtocol":false,"auth":{"apiKey":true}});
        assert_eq!(judge_catalog_provider(&bad_protocol).limitation, "PROVIDER_CATALOG_PROTOCOL_UNSUPPORTED");
        // 0 模型的动态 provider（radius）
        let no_models = json!({"id":"radius","baseUrl":"","modelCount":0,"supportsEveryProtocol":false,"auth":{"apiKey":true}});
        assert_eq!(judge_catalog_provider(&no_models).limitation, "PROVIDER_CATALOG_ENDPOINT_REQUIRED");
        let no_models_only = json!({"id":"radius","baseUrl":"https://radius.example","modelCount":0,"supportsEveryProtocol":true,"auth":{"apiKey":true}});
        assert_eq!(judge_catalog_provider(&no_models_only).limitation, "PROVIDER_CATALOG_NO_MODELS");
        // 事实缺失时保守判为不可配置，绝不默认放开。
        assert!(!judge_catalog_provider(&json!({})).configurable);
        assert!(!judge_catalog_provider(&Value::Null).configurable);
    }
    #[test]
    fn model_protocols_are_marked_per_model_not_per_provider() {
        let supported = vec!["openai-completions".to_string()];
        let mut models = vec![
            json!({"id":"a","api":"openai-completions"}),
            json!({"id":"b","api":"bedrock-converse-stream"}),
            json!({"id":"c"}),
        ];
        mark_catalog_models(&mut models, &supported);
        assert_eq!(models[0]["protocolSupported"], json!(true));
        assert_eq!(models[1]["protocolSupported"], json!(false));
        assert_eq!(models[2]["protocolSupported"], json!(false));
    }
    #[test]
    fn reserved_and_unsafe_ids_are_rejected() {
        let mut item = catalog("deepseek-official");
        item.model_id.clear();
        assert_eq!(item.validate().unwrap_err(), "PROVIDER_ID_RESERVED");
        for id in ["", "../other", "MyProvider", "my_provider", "my--provider", "my-"] {
            let mut item = template();
            item.id = id.into();
            assert!(item.validate().is_err());
        }
        for url in ["file:///tmp/key", "https://key@example.com", "https://example.com?key=secret", "https://example.com#secret"] {
            let mut item = template();
            item.base_url = url.into();
            assert!(item.validate().is_err());
        }
        // 自定义型仍必须有端点与协议。
        assert!(template().profile(&[]).is_err());
        let mut missing_url = template();
        missing_url.base_url.clear();
        assert_eq!(missing_url.validate().unwrap_err(), "PROVIDER_URL_INVALID");
    }
    #[test]
    fn catalog_route_must_exist_in_the_runtime() {
        let item = ProviderTemplate { selection: ProviderModelSelection::Subset, models: vec![serde_json::from_value(json!({"id":"not-in-catalog"})).unwrap()], ..catalog("deepseek") };
        assert_eq!(item.validate_against_catalog(&json!({"deepseek-v4-flash":{}})).unwrap_err(), "PROVIDER_MODEL_OVERRIDES_CONFLICT");
        assert_eq!(item.validate_against_catalog(&json!({})).unwrap_err(), "PROVIDER_CATALOG_ROUTE_UNKNOWN");
        assert_eq!(item.validate_against_catalog(&Value::Null).unwrap_err(), "PROVIDER_CATALOG_UNAVAILABLE");
        let ok = ProviderTemplate { selection: ProviderModelSelection::Subset, models: vec![serde_json::from_value(json!({"id":"deepseek-v4-flash"})).unwrap()], ..catalog("deepseek") };
        assert_eq!(ok.validate_against_catalog(&json!({"deepseek-v4-flash":{}})), Ok(()));
    }
}
