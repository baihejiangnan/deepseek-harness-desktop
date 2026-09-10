// 连接测试的请求由运行时自己构造：本进程 import 当前选中 DSH 的 pi-ai 走真实调用路径，
// 因此路径拼接、请求头、请求体与推理参数都不再由启动器猜测，也不会与 DSH 分叉。
// 仍不加载用户的 DSH Profile 或插件——只 import 运行时包自身的公开模块，
// 且由调用方把子进程 cwd 设为所选 DSH 的包目录（裸标识符按模块基准解析）。
const fail = code => { throw new Error(code); };

/**
 * 能力声明：协议 → 请求由谁构造。界面据此判断"可测试 / 可读取清单"，不另维护清单。
 *
 * `test` 一律委托给运行时的 pi-ai 适配器，所以"探测器已实现"就等于"运行时注册表里有
 * 这个协议的实现"，在 `testViaRuntime` 里用 `getApiProvider` 现场核验——不存在第二份
 * 会随运行时升级而漂移的协议表。这也是为什么这里**没有** testable 协议清单。
 *
 * `models` 是本模块唯一自己拼 URL 的地方，因此必须显式声明，并与 dsh-llm-pi-ai 的
 * `LISTABLE_PROTOCOLS` 逐字一致：运行时对其余协议明确拒绝读取清单（"has no model
 * listing this build can read; enter this provider's models by hand"），启动器不得比
 * 运行时更乐观。`provider-probe.test.mjs` 拿安装中的运行时源码核对本集合，漂移即失败。
 */
export const LISTABLE_PROTOCOLS = ['openai-completions', 'openai-responses'];

// 与 dsh-llm-pi-ai 的 MAX_RESPONSE_BYTES 同值：上限按实际读到的字节数生效，
// 而不是按服务器声明的长度，因为被截断的模型清单根本无法解析。
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function safeUrl(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { fail('PROVIDER_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail('PROVIDER_URL_INVALID');
  return url;
}

/** 与 dsh-llm-pi-ai 的 `listingUrl` 对齐：只去尾部斜杠，不做任何 `/v1` 补全。 */
export function listingUrl(baseUrl, protocol) {
  if (!LISTABLE_PROTOCOLS.includes(protocol)) fail('PROVIDER_DISCOVERY_UNSUPPORTED');
  return `${safeUrl(baseUrl).href.replace(/\/+$/, '')}/models`;
}

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail('PROVIDER_RESPONSE_TOO_LARGE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('PROVIDER_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('PROVIDER_RESPONSE_INVALID'); }
}

/** 状态码来自运行时自己的 `onResponse` 钩子，不是启动器猜的传输结果。 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 300 && status < 400) return 'PROVIDER_REDIRECT_REFUSED';
  if (status === 404) return 'PROVIDER_ENDPOINT_NOT_FOUND';
  if (status >= 400) return 'PROVIDER_REQUEST_REJECTED';
  return 'PROVIDER_NETWORK_FAILED';
}

async function listModels({ baseUrl, protocol, apiKey }, timeoutMs) {
  const endpoint = listingUrl(baseUrl, protocol);
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // 凭据不得跟随跳转，因此固定 manual；3xx 一律拒绝而不是带着密钥追过去。
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(classifyStatus(response.status));
    }
    const data = await readJson(response);
    if (!Array.isArray(data?.data)) fail('PROVIDER_RESPONSE_INVALID');
    const models = new Map();
    const capacity = (...values) => values.find(v => Number.isSafeInteger(v) && v > 0 && v <= 4294967295);
    for (const item of data.data) {
      if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 512 || /[\x00-\x1f\x7f]/.test(item.id)) continue;
      const name = [item.name, item.display_name].find(v => typeof v === 'string' && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v));
      models.set(item.id, { id: item.id, ...(name ? { name } : {}),
        contextWindow: capacity(item.context_window, item.context_length), maxTokens: capacity(item.max_output_tokens, item.max_tokens) });
    }
    if (models.size > 2000) fail('PROVIDER_RESPONSE_TOO_LARGE');
    return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), elapsedMs: Date.now() - started };
  } catch (error) {
    if (signal.aborted) fail('PROVIDER_PROBE_TIMEOUT');
    // No raw network errors or gateway response bodies may escape with credentials.
    if (/^PROVIDER_[A-Z_]+$/.test(error.message)) throw error;
    fail('PROVIDER_NETWORK_FAILED');
  }
}

/** 只在 test 路径 import 运行时；models 路径不 import，自定义接口即使运行时模块不可达也仍能列模型。 */
async function loadRuntime() {
  try {
    const [compat, adapter] = await Promise.all([
      import('@earendil-works/pi-ai/compat'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
    ]);
    if (typeof compat.complete !== 'function' || typeof compat.getApiProvider !== 'function' || typeof adapter.supportedProtocols !== 'function')
      fail('PROVIDER_RUNTIME_UNAVAILABLE');
    return { compat, adapter };
  } catch (error) {
    if (error?.message === 'PROVIDER_RUNTIME_UNAVAILABLE') throw error;
    // cwd 不对、或运行时升级后换掉了调用入口：统一降级为"这项测试暂不可用"，
    // 绝不回退到启动器自己拼请求——那正是要消除的分叉来源。
    fail('PROVIDER_RUNTIME_UNAVAILABLE');
  }
}

/**
 * 交给 pi-ai 的 Model。容量字段只影响请求里的 token 上限与本地计费，
 * 探测统一用 `maxTokens: 32`，所以这里给保守占位值，不冒充目录数据。
 * `provider` 用启动器自有标识：密钥按请求注入（`options.apiKey`），
 * 因此不需要、也不会去查任何服务商的环境变量。
 */
function probeModel(baseUrl, protocol, modelId) {
  return {
    id: modelId, name: modelId, api: protocol, provider: 'dsh-launcher-probe',
    baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 32,
  };
}

async function testViaRuntime({ baseUrl, protocol, apiKey, modelId }, timeoutMs) {
  const { compat, adapter } = await loadRuntime();
  // 允许测试的范围 = 运行时支持 ∩ 探测器已实现 ∩ 当前配置可准确表达。
  // 前两项在此现场核验；界面那层门禁只是提前禁用按钮，不是这里的依据。
  if (!adapter.supportedProtocols().includes(protocol)) fail('PROVIDER_PROTOCOL_UNSUPPORTED');
  if (!compat.getApiProvider(protocol)) fail('PROVIDER_PROTOCOL_UNSUPPORTED');
  // baseURL 原样交给运行时：Anthropic 的 SDK 自己补 `/v1/messages`，启动器不再插手。
  // 用户把 baseURL 写成 `.../v1` 时会得到与 DSH 完全相同的失败，而不是探测器独自"成功"。
  const base = safeUrl(baseUrl).href.replace(/\/+$/, '');
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let status = 0;
  try {
    const message = await compat.complete(
      probeModel(base, protocol, modelId),
      { messages: [{ role: 'user', content: 'Reply OK.' }] },
      {
        apiKey,
        maxTokens: 32,
        signal,
        // 探测要的是快速结论，不静默重试：429 直接如实报为限流。
        maxRetries: 0,
        // 状态码在注入的 fetch 里取，不用 `onResponse`：适配器只在**成功**路径上调用它。
        // 顺带强制 manual 重定向——pi-ai 默认跟随跳转，而这一跳带着用户密钥。
        fetch: async (target, init) => {
          const response = await fetch(target, { ...init, redirect: 'manual' });
          // undici 可能把 manual 下的跳转报成 opaqueredirect 且 status 0，它仍然是一次跳转。
          status = response.type === 'opaqueredirect' ? 302 : response.status;
          return response;
        },
      },
    );
    // 传输层状态码是真相，且必须先于消息体判定：适配器不会为非 2xx 抛错，
    // 而是把 SDK 的错误咽下去、返回一条 stopReason 为 error 的消息。
    // 若先看消息，401 就会被误报成"响应无效"，丢掉的正是"密钥被拒"这条最有用的信息。
    if (status >= 300) fail(classifyStatus(status));
    if (message?.stopReason === 'error' || message?.errorMessage) fail('PROVIDER_RESPONSE_INVALID');
    return { models: [], elapsedMs: Date.now() - started, status };
  } catch (error) {
    if (signal.aborted) fail('PROVIDER_PROBE_TIMEOUT');
    if (/^PROVIDER_[A-Z_]+$/.test(error?.message ?? '')) throw error;
    // 原始错误可能带 URL、响应正文或密钥片段，一律换成稳定码。
    fail(classifyStatus(status));
  }
}

export async function probeProvider({ baseUrl, protocol, apiKey, operation, modelId }, timeoutMs = 15000) {
  if (!['models', 'test'].includes(operation)) fail('PROVIDER_PROBE_INVALID');
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('PROVIDER_KEY_REQUIRED');
  // 与运行时的 normalizeApiKey 一致：先 trim，再拒绝任何 HTTP 头带不动的字符。
  const key = apiKey.trim();
  if (key.length > 16384 || /[^\x20-\x7e]/.test(key)) fail('PROVIDER_KEY_INVALID');
  if (operation === 'models') return listModels({ baseUrl, protocol, apiKey: key }, timeoutMs);
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 512 || /[\x00-\x1f\x7f]/.test(modelId)) fail('PROVIDER_MODEL_INVALID');
  return testViaRuntime({ baseUrl, protocol, apiKey: key, modelId: modelId.trim() }, timeoutMs);
}

if (process.argv[1] === '--launcher-provider-probe') {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(JSON.stringify(await probeProvider(JSON.parse(input))));
  } catch (error) {
    process.stderr.write(/^PROVIDER_[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_PROBE_FAILED');
    process.exitCode = 1;
  }
}
