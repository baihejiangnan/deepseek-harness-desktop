// External HTTP adapter only; never loads a user's DSH profile or plugins.
const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const fail = code => { throw new Error(code); };

export function probeEndpoint(baseUrl, protocol, operation) {
  let url;
  try { url = new URL(baseUrl); } catch { fail('PROVIDER_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail('PROVIDER_URL_INVALID');
  if (!protocols.includes(protocol)) fail('PROVIDER_PROTOCOL_UNSUPPORTED');
  const base = url.href.replace(/\/+$/, '');
  // Match DSH/OpenAI prefix semantics. Anthropic's SDK adds /v1 itself.
  const prefix = protocol === 'anthropic-messages' && !base.endsWith('/v1') ? `${base}/v1` : base;
  return `${prefix}/${operation === 'models' ? 'models' : protocol === 'anthropic-messages' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`;
}

async function readJson(response) {
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    fail('PROVIDER_RESPONSE_TOO_LARGE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) fail('PROVIDER_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('PROVIDER_RESPONSE_INVALID'); }
}

export async function probeProvider({ baseUrl, protocol, apiKey, operation, modelId }, timeoutMs = 15000) {
  if (!['models', 'test'].includes(operation)) fail('PROVIDER_PROBE_INVALID');
  const endpoint = probeEndpoint(baseUrl, protocol, operation);
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('PROVIDER_KEY_REQUIRED');
  if (apiKey.length > 16384 || /[^\x20-\x7e]/.test(apiKey)) fail('PROVIDER_KEY_INVALID');
  if (operation === 'test' && (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 512 || /[\x00-\x1f\x7f]/.test(modelId))) fail('PROVIDER_MODEL_INVALID');
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (protocol === 'anthropic-messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${apiKey}`;
  const body = operation === 'models' ? undefined : JSON.stringify(protocol === 'openai-responses'
    ? { model: modelId, input: 'Reply OK.', max_output_tokens: 32, stream: false }
    : { model: modelId, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 32, stream: false });
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', headers, body, signal, redirect: 'manual' });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) fail('PROVIDER_AUTH_FAILED');
      if (response.status === 429) fail('PROVIDER_RATE_LIMITED');
      if (response.status >= 300 && response.status < 400) fail('PROVIDER_REDIRECT_REFUSED');
      if (response.status === 404) fail('PROVIDER_ENDPOINT_NOT_FOUND');
      fail('PROVIDER_REQUEST_REJECTED');
    }
    const data = await readJson(response);
    if (operation === 'models') {
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
    }
    const valid = protocol === 'anthropic-messages'
      ? data?.type === 'message' && data.role === 'assistant' && Array.isArray(data.content)
      : protocol === 'openai-responses'
        ? data?.object === 'response' && ['completed', 'incomplete'].includes(data.status) && Array.isArray(data.output) && !data.error
        : Array.isArray(data?.choices) && data.choices.some(choice => choice?.message?.role === 'assistant');
    if (!valid || data.error) fail('PROVIDER_RESPONSE_INVALID');
    return { models: [], elapsedMs: Date.now() - started };
  } catch (error) {
    if (signal.aborted) fail('PROVIDER_PROBE_TIMEOUT');
    // No raw network errors or gateway response bodies may escape with credentials.
    if (/^PROVIDER_[A-Z_]+$/.test(error.message)) throw error;
    fail('PROVIDER_NETWORK_FAILED');
  }
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
