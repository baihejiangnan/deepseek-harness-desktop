import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeProvider, probeEndpoint } from './provider-probe.mjs';

async function gateway(callback, run) {
  const server = createServer(callback);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const request = { protocol: 'openai-completions', apiKey: 'fake-test-key', operation: 'models' };

test('model discovery preserves URL prefixes and model metadata, deduplicating IDs', async () => {
  await gateway((req, res) => {
    assert.equal(req.url, '/gateway/v1/models');
    assert.equal(req.headers.authorization, 'Bearer fake-test-key');
    res.end(JSON.stringify({ data: [{ id: 'one', context_length: 64000 }, { id: 'two', display_name: 'Second' }, { id: 'two', display_name: 'Second' }, {}] }));
  }, async base => {
    const result = await probeProvider({ ...request, baseUrl: `${base}/gateway/v1/` });
    assert.deepEqual(result.models.map(m => m.id), ['one', 'two']);
    assert.equal(result.models[0].contextWindow, 64000);
    assert.equal(result.models[1].name, 'Second');
  });
});

test('connection testing uses each protocol, credentials and selected model', async () => {
  for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    await gateway(async (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, protocol === 'openai-completions' ? '/v1/chat/completions' : protocol === 'openai-responses' ? '/v1/responses' : '/v1/messages');
      assert.equal(req.headers[protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization'], protocol === 'anthropic-messages' ? 'fake-test-key' : 'Bearer fake-test-key');
      let body = ''; for await (const chunk of req) body += chunk;
      assert.equal(JSON.parse(body).model, 'second-model');
      res.end(JSON.stringify(protocol === 'openai-completions' ? { choices: [{ message: { role: 'assistant', content: 'OK' } }] } : protocol === 'openai-responses' ? { object: 'response', status: 'completed', output: [] } : { type: 'message', role: 'assistant', content: [] }));
    }, async base => {
      await probeProvider({ ...request, baseUrl: protocol === 'anthropic-messages' ? base : `${base}/v1`, protocol, operation: 'test', modelId: 'second-model' });
    });
  }
});

test('auth errors, redirects, malformed successes and timeouts never pass or echo secrets', async () => {
  for (const [status, body, code] of [[401, 'fake-test-key', 'PROVIDER_AUTH_FAILED'], [302, '', 'PROVIDER_REDIRECT_REFUSED'], [200, '<html>fake-test-key</html>', 'PROVIDER_RESPONSE_INVALID'], [200, '{}', 'PROVIDER_RESPONSE_INVALID']]) {
    await gateway((_req, res) => { res.writeHead(status, { location: 'http://example.invalid/' }); res.end(body); }, async base => {
      await assert.rejects(probeProvider({ ...request, baseUrl: base }), error => error.message === code);
    });
  }
  await gateway(() => {}, async base => {
    await assert.rejects(probeProvider({ ...request, baseUrl: base }, 40), /PROVIDER_PROBE_TIMEOUT/);
  });
  assert.equal(probeEndpoint('https://example.com/prefix/v1/', 'anthropic-messages', 'models'), 'https://example.com/prefix/v1/models');
});
