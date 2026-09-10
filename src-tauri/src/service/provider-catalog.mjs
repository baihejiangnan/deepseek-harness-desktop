// 运行时服务商目录探测。由启动器用当前选中运行时的 Node 起进程，
// 因此这里 import 到的就是那个版本 DSH 的真实目录，不是启动器内置清单。
//
// 输出只含公开元数据与目录默认值；不读凭据、不读 Home 内容。
// 失败一律以稳定 PROVIDER_* 码结束，绝不回显模块原始错误（其中可能带路径或配置正文）。

const codes = new Set([
  'PROVIDER_CATALOG_UNAVAILABLE',
  'PROVIDER_CATALOG_TIMEOUT',
  'PROVIDER_CATALOG_INPUT_INVALID',
  'PROVIDER_CATALOG_ROUTE_UNKNOWN',
])

function fail(code) {
  process.stderr.write(codes.has(code) ? code : 'PROVIDER_CATALOG_UNAVAILABLE')
  process.exitCode = 1
}

// auth 的形状是 {apiKey?: {name}, oauth?: {name, isSubscription?, loginLabel?}}。
// 只提取启动器门禁需要的布尔事实与展示用名称，不猜测认证是否真的可用。
function authFacts(auth) {
  return {
    apiKey: Boolean(auth && auth.apiKey),
    apiKeyLabel: auth && auth.apiKey && typeof auth.apiKey.name === 'string' ? auth.apiKey.name : '',
    oauth: Boolean(auth && auth.oauth),
    oauthSubscription: Boolean(auth && auth.oauth && auth.oauth.isSubscription),
  }
}

function modelFacts(model) {
  const effortMap = model.reasoningEfforts ?? model.thinkingLevelMap
  return {
    id: String(model.id ?? ''),
    name: typeof model.name === 'string' ? model.name : '',
    api: typeof model.api === 'string' ? model.api : '',
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : 0,
    maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : 0,
    input: Array.isArray(model.input) ? model.input.filter(x => typeof x === 'string') : [],
    reasoning: Boolean(model.reasoning),
    reasoningEfforts: effortMap && typeof effortMap === 'object' && !Array.isArray(effortMap)
      ? Object.keys(effortMap).filter(k => typeof k === 'string')
      : (Array.isArray(effortMap) ? effortMap.filter(k => typeof k === 'string') : []),
  }
}

async function readRequest() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input || '{}')
  if (request.operation !== 'list' && request.operation !== 'models') throw new Error('PROVIDER_CATALOG_INPUT_INVALID')
  if (request.operation === 'models' && typeof request.providerId !== 'string') throw new Error('PROVIDER_CATALOG_INPUT_INVALID')
  return request
}

async function load() {
  // 硬性前置：调用方必须把子进程的 cwd 设为所选 DSH 的包目录。
  // 裸标识符按模块基准解析；`node -e` 的基准就是启动时的 cwd，进程内 chdir 改不动它。
  // 目录来自 pi-ai 的正规子路径导出（只有 import 条件，require.resolve 会被 exports 挡下），
  // 协议白名单来自 DSH 自己的适配器——两者都从同一个 cwd 解析，因此必然同属一个运行时。
  try {
    const [all, adapter] = await Promise.all([
      import('@earendil-works/pi-ai/providers/all'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
    ])
    if (typeof all.builtinProviders !== 'function' || typeof adapter.supportedProtocols !== 'function') throw new Error('PROVIDER_CATALOG_UNAVAILABLE')
    return { all, adapter }
  } catch {
    // cwd 不对、或 DSH 升级后换掉目录提供方，都统一降级为"目录不可用"：
    // 界面据此引导用户改用自定义接口，绝不回退到任何启动器内置清单，也不回显模块原始错误。
    throw new Error('PROVIDER_CATALOG_UNAVAILABLE')
  }
}

try {
  const [request, { all, adapter }] = await Promise.all([readRequest().catch(err => { throw err }), load()])
  const supported = [...adapter.supportedProtocols()]
  const generatedAt = typeof all.getBuiltinModelDataGeneratedAt === 'function' ? (all.getBuiltinModelDataGeneratedAt() ?? 0) : 0

  if (request.operation === 'list') {
    const providers = []
    for (const provider of all.builtinProviders()) {
      let models = []
      try {
        const result = await provider.getModels()
        models = Array.isArray(result) ? result : (result && result.models) || []
      } catch { models = [] }
      // 协议按模型细分：一个服务商内部可能混用多种线协议，不给服务商一个布尔值。
      const protocols = [...new Set(models.map(model => model.api).filter(x => typeof x === 'string' && x))]
      const auth = authFacts(provider.auth)
      providers.push({
        id: String(provider.id ?? ''),
        name: typeof provider.name === 'string' ? provider.name : '',
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : (typeof provider.baseURL === 'string' ? provider.baseURL : ''),
        modelCount: models.length,
        protocols,
        auth,
        // 门禁判据本身在启动器 Rust 侧，这里只交出它需要的可观测事实。
        supportsEveryProtocol: protocols.length > 0 && protocols.every(api => supported.includes(api)),
        supportsSomeProtocol: protocols.some(api => supported.includes(api)),
      })
    }
    providers.sort((a, b) => a.name.localeCompare(b.name))
    process.stdout.write(JSON.stringify({ generatedAt, supportedProtocols: supported, providers }))
  } else {
    const provider = all.builtinProviders().find(item => String(item.id) === request.providerId)
    if (!provider) throw new Error('PROVIDER_CATALOG_ROUTE_UNKNOWN')
    let models = []
    try {
      const result = await provider.getModels()
      models = Array.isArray(result) ? result : (result && result.models) || []
    } catch { throw new Error('PROVIDER_CATALOG_ROUTE_UNKNOWN') }
    process.stdout.write(JSON.stringify({
      generatedAt,
      providerId: request.providerId,
      supportedProtocols: supported,
      models: models.map(modelFacts).filter(model => model.id),
    }))
  }
} catch (error) {
  fail(error && typeof error.message === 'string' && codes.has(error.message) ? error.message : 'PROVIDER_CATALOG_UNAVAILABLE')
}
