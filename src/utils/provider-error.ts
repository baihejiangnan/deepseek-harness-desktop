import i18next from 'i18next'

/** Keep arbitrary backend payloads (which can contain credentials) out of the UI. */
export function providerErrorMessage(error: unknown): string {
  const code = String(error).match(/\b(?:PROVIDER|INSTANCE)_[A-Z_]+\b/)?.[0] ?? ''
  const groups: Record<string, string[]> = {
    conflict: ['PROVIDER_ID_CONFLICT'],
    id: ['PROVIDER_ID_INVALID'],
    reserved: ['PROVIDER_ID_RESERVED'],
    name: ['PROVIDER_NAME_INVALID'],
    model: ['PROVIDER_MODEL_INVALID', 'PROVIDER_DEFAULT_MODEL_INVALID'],
    auth: ['PROVIDER_AUTH_FAILED'],
    network: ['PROVIDER_NETWORK_FAILED', 'PROVIDER_PROBE_FAILED'],
    timeout: ['PROVIDER_PROBE_TIMEOUT'],
    response: ['PROVIDER_RESPONSE_INVALID', 'PROVIDER_RESPONSE_TOO_LARGE'],
    endpoint: ['PROVIDER_ENDPOINT_NOT_FOUND', 'PROVIDER_REDIRECT_REFUSED'],
    rejected: ['PROVIDER_REQUEST_REJECTED', 'PROVIDER_RATE_LIMITED'],
    url: ['PROVIDER_URL_INVALID'],
    key: ['PROVIDER_KEY_INVALID', 'PROVIDER_KEY_REQUIRED'],
    protocol: ['PROVIDER_PROTOCOL_INVALID', 'PROVIDER_PROTOCOL_UNSUPPORTED', 'PROVIDER_PROTOCOL_PROBE_FAILED', 'PROVIDER_PROTOCOL_PROBE_TIMEOUT'],
    discovery: ['PROVIDER_DISCOVERY_UNSUPPORTED'],
    runtime: ['PROVIDER_RUNTIME_UNAVAILABLE'],
    document: ['PROVIDER_DOCUMENT_INVALID', 'PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED', 'PROVIDER_SETTINGS_INVALID'],
    path: ['PROVIDER_PATH_OUTSIDE_HOME', 'PROVIDER_SYMLINK_UNSUPPORTED'],
    profile: ['PROVIDER_PROFILE_PROBE_FAILED', 'PROVIDER_PROFILE_UNSUPPORTED'],
    running: ['INSTANCE_RUNNING', 'INSTANCE_HOME_RUNNING'],
    missing: ['PROVIDER_NOT_FOUND', 'INSTANCE_NOT_FOUND'],
    storage: ['PROVIDER_SECURE_STORAGE_FAILED', 'PROVIDER_SECURE_STORAGE_UNSUPPORTED', 'PROVIDER_STORE_INVALID', 'PROVIDER_STORE_PATH_INVALID', 'PROVIDER_STORE_READ_FAILED', 'PROVIDER_STORE_TOO_LARGE', 'PROVIDER_STORE_WRITE_FAILED'],
  }
  const group = Object.entries(groups).find(([, codes]) => codes.includes(code))?.[0] ?? 'generic'
  return i18next.t(`providers.error.${group}`)
}
