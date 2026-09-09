/**
 * 服务商模块的共享契约类型。
 *
 * 这些形状由后端决定：目录来自 `list_runtime_catalog` / `get_runtime_catalog_models`，
 * 回读来自 `read_instance_providers`，计划来自 `plan_instance_provider_change`。
 * 集中在一处，避免每个组件各写一份、然后各自漂移。
 */

/** 运行时目录里的一个服务商。字段是探测脚本交出的可观测事实，不是启动器内置清单。 */
export interface CatalogProvider {
  id: string
  name: string
  baseUrl: string
  modelCount: number
  protocols: string[]
  auth: { apiKey: boolean, apiKeyLabel: string, oauth: boolean, oauthSubscription: boolean }
  /** 能力门禁结论由 Rust 算，前端只消费。 */
  configurable: boolean
  /** 不可配置时的稳定原因码；可配置时为空串。 */
  limitation: string
}

/** 目录里的一个模型。枚举值只能取自这里观测到的取值，不做自由文本。 */
export interface CatalogModel {
  id: string
  name: string
  api: string
  contextWindow: number
  maxTokens: number
  /** 观测到的输入模态；只展示——启动器拥有的模型字段里没有它。 */
  input: string[]
  reasoning: boolean
  /** 观测到的推理档位名，供默认模型的 reasoningEffort 下拉使用。 */
  reasoningEfforts: string[]
  protocolSupported: boolean
}

export interface CatalogResponse {
  generatedAt: number
  supportedProtocols: string[]
  providers: CatalogProvider[]
}

export interface CatalogModelsResponse {
  generatedAt: number
  providerId: string
  supportedProtocols: string[]
  models: CatalogModel[]
}

/** 回读里模型条目交出的键：只有模板自有且不含敏感值的那几个。 */
export interface ProviderModelView {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderRouteView {
  id: string
  displayName: string
  /** 模板自有字段的**名字**；值只在下面几个字段里给出。 */
  configuredFields: string[]
  /** 非模板自有字段的**名字**；值一律不回传（可能含请求头与令牌）。 */
  unknownFields: string[]
  protocol: string
  baseUrl: string
  modelIds: string[]
  models: ProviderModelView[]
  overrides: ProviderModelView[]
  selection: 'all' | 'subset'
  credential: { declared: boolean, ref: string, source: 'ambient' | 'file' | 'unverifiable' }
}

export interface InstanceProviderView {
  routes: ProviderRouteView[]
  topSections: string[]
  credentialRefs: string[]
  /** 仅报告，绝不自动清理。 */
  unreferencedCredentialRefs: string[]
  defaultModel: {
    declared: boolean
    provider: string
    model: string
    reasoningEffort: string
    providerStatus: 'unset' | 'known' | 'unconfirmed'
    modelStatus: 'unset' | 'known' | 'unconfirmed'
  }
  fingerprint: string
  settingsFormat: 'yaml' | 'json'
}

/** 凭据在预览里只报动作，不报值。 */
export type CredentialAction = 'keep' | 'replace' | 'add' | 'remove'

export interface RouteChange {
  routeId: string
  kind: 'add' | 'modify' | 'unchanged' | 'remove' | 'absent'
  fields: { field: string, from: unknown, to: unknown }[]
  preservedFields: string[]
  credential: { ref: string, action: CredentialAction } | null
}

export interface ProviderPlan {
  changes: RouteChange[]
  warnings: { code: string, detail: string }[]
  defaultModel: { provider: string, model: string, reasoningEffort?: string } | null
  /** `defaultModel` 单独无法区分"将清空"与"不改动"——两者都是 null，所以意图必须显式表达。 */
  defaultModelAction: 'keep' | 'set' | 'clear'
  retainedCredentialRefs: string[]
  /** 共享影响由注册表算：settings.yaml 是 Home 级，同 Home 的实例全部受影响。 */
  sharing: { level: string, homeUsers: number, profileUsers: number }
}

/**
 * 机会性字段角色发现。只有实例运行且端口确认存活时才可能拿到；
 * `unavailable` 是正常状态不是故障，**绝不能被当成"这个实例没有密钥字段"**——
 * 停机态下真正兜底的仍是"整份 settings 文档 + `.env`"的文本扫描。
 * 只有字段位置，没有任何值。
 */
export interface CredentialRoles {
  source: 'runtime' | 'unavailable'
  reason?: string
  secretPaths: { ns: string, path: string[] }[]
}

export interface PlanResponse {
  plan: ProviderPlan
  digest: string
  fingerprint: string
}

/** 编辑时的凭据三态：留空不再兼任"保留密钥"与"改走环境认证"。 */
export type CredentialMode = 'keep' | 'replace' | 'none'
