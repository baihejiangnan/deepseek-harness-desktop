import i18next from 'i18next'
import { providerErrorMessage } from './provider-error'

/**
 * 后端错误码到界面文案的唯一映射处（方案 §3.5）。
 *
 * 约定：后端错误一律是 `CODE: detail`，CODE 为稳定大写前缀（AGENTS.md）。此前各页
 * 各写一处 `.includes()`，同一个码在不同页面说法不一，未登记的码把原始串直接甩给用户。
 *
 * 表里只登记**确认由后端发出**的码，来源已逐一核对：Rust 字面量、`{prefix}_XXX`
 * 动态拼接（如 `PLUGIN_PACK_MARKET_NETWORK` 来自 `fetch_text`）、以及 `.mjs` 子进程
 * 经 stderr 回传的 `PROVIDER_*`。没有对应文案时返回原始串——宁可显示生串，也不编一个
 * 看起来确定的原因。
 *
 * `PROVIDER_*` 的载荷可能含 headers 或 token，一律走 provider-error 的分组文案，
 * **不回传原始串**；其余码的 detail 是路径、ID 或子进程输出，可作为排查线索展示。
 */
const CODE_PATTERN = /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/

export interface BackendError {
  /** 解析出的稳定错误码；没有则为空串。 */
  code: string
  /** 错误码之后的原始说明，已去掉分隔符。 */
  detail: string
  /** 后端返回的完整原始串。 */
  raw: string
}

export function parseBackendError(error: unknown): BackendError {
  const raw = String(error)
  const match = raw.match(CODE_PATTERN)
  if (match == null)
    return { code: '', detail: raw, raw }
  const index = match.index ?? 0
  return {
    code: match[0],
    detail: raw.slice(index + match[0].length).replace(/^[:\s-]+/, ''),
    raw,
  }
}

/**
 * 判断某个码是否命中。前一个字符仍是标识符字符时不算命中，否则
 * `COLLAB_INSTANCE_NOT_RUNNING` 会被误判成 `INSTANCE_NOT_RUNNING`。
 */
export function errorHasCode(error: unknown, code: string): boolean {
  const raw = String(error)
  if (parseBackendError(raw).code === code)
    return true
  const index = raw.indexOf(code)
  return index > 0 && !/[A-Z0-9_]/.test(raw[index - 1])
}

/**
 * 按前缀判定。导出取消有两个码：`EXPORT_CANCELLED_BY_USER`（用户主动）与
 * `EXPORT_CANCELLED`（其他取消原因），二者是前缀关系，只能用前缀区分。
 */
export function errorHasCodePrefix(error: unknown, prefix: string): boolean {
  return parseBackendError(error).code.startsWith(prefix)
}

const MESSAGE_KEYS: Record<string, string> = {
  DSH_RUNTIME_BUSY: 'errors.dsh_runtime_busy',
  DSH_RUNTIME_IN_USE: 'errors.dsh_runtime_in_use',
  DSH_RUNTIME_NOT_FOUND: 'errors.dsh_runtime_not_found',
  DSH_RUNTIME_UPDATE_UNSUPPORTED: 'errors.dsh_runtime_update_unsupported',
  INSTANCE_NOT_FOUND: 'errors.instance_not_found',
  INSTANCE_RUNNING: 'errors.instance_running',
  INSTANCE_ALREADY_STARTING_OR_RUNNING: 'errors.instance_already_running',
  INSTANCE_LAUNCH_TIMEOUT: 'errors.instance_launch_timeout',
  INSTANCE_LAUNCH_FAILED: 'errors.instance_launch_failed',
  INSTANCE_HOST_SPAWN: 'errors.instance_host_spawn',
  INSTANCE_NOT_RUNNING: 'errors.instance_not_running',
  PLUGIN_INSTALL_CANCELLED: 'errors.plugin_install_cancelled',
  PLUGIN_INSTALL_FAILED: 'errors.plugin_install_failed',
  PLUGIN_INSTALL_INVALID_SPEC: 'errors.plugin_install_invalid_spec',
  PLUGIN_REMOVE_FAILED: 'errors.plugin_remove_failed',
  PLUGIN_PACK_MARKET_NETWORK: 'errors.market_unreachable',
  PLUGIN_CATALOG_NETWORK: 'errors.catalog_unreachable',
  EXPORT_ALREADY_RUNNING: 'errors.export_already_running',
  EXPORT_CANCELLED_BY_USER: 'errors.export_cancelled',
  EXPORT_DESTINATION_INSIDE_HOME: 'errors.export_destination_inside_home',
  PORT_EXHAUSTED: 'errors.port_exhausted',
  INTEGRITY_CHECK_FAILED: 'errors.integrity_check_failed',
}

/** 取消不是失败：这两处后端码必须与真失败分开处理，避免把"已停止"写成错误。 */
const CANCEL_CODES = ['PLUGIN_INSTALL_CANCELLED', 'EXPORT_CANCELLED_BY_USER']

export function isCancellation(error: unknown): boolean {
  return CANCEL_CODES.some(code => errorHasCode(error, code))
}

export function errorText(error: unknown): string {
  const { code, detail, raw } = parseBackendError(error)
  if (code.startsWith('PROVIDER_'))
    return providerErrorMessage(raw)
  if (code === 'INSTANCE_HOME_RUNNING') {
    // 载荷是 `<id>:<name>`；用户需要知道的是"谁占用了这个 Home"。
    return i18next.t('launcher.same_home_running', { name: detail.split(':').slice(1).join(':') })
  }
  const key = MESSAGE_KEYS[code]
  return key != null ? i18next.t(key) : raw
}

/** 供 ErrorBanner 的 detail 使用。PROVIDER_* 只回码名，避免敏感载荷进界面。 */
export function errorDetail(error: unknown): string {
  const { code, detail, raw } = parseBackendError(error)
  if (code.startsWith('PROVIDER_'))
    return code
  return detail === '' ? raw : detail
}

/**
 * 未登记的码 `errorText` 会原样返回原始串，此时 detail 与 message 相同，
 * 不该把同一句话显示两遍。
 */
export function errorBannerDetail(error: unknown): string | undefined {
  const detail = errorDetail(error)
  return detail === errorText(error) ? undefined : detail
}
