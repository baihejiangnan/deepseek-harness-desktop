import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeProvider, listingUrl, LISTABLE_PROTOCOLS } from './provider-probe.mjs';
import { resolveRuntimeEntry, resolvePackageRoot, readRuntimeFile } from './runtime-under-test.mjs';

// test 路径把请求构造整个交给运行时，因此它必须在"宿主同款 cwd"下跑：
// 裸标识符按模块基准解析，而测试进程的基准是本文件所在目录，解析不到运行时包。
// 解析不到运行时的用例一律 skip 并说明，不能让剩下的用例看起来像全绿。
const runtimeEntry = resolveRuntimeEntry();
const packageRoot = runtimeEntry ? resolvePackageRoot(runtimeEntry) : '';
if (!packageRoot) {
  console.warn('[provider-probe.test] no DSH runtime package root resolved (set DSH_TEST_ENTRY): the delegation cases below are SKIPPED, not passed.');
}

const PROBE_SOURCE = readFileSync(new URL('./provider-probe.mjs', import.meta.url), 'utf8');
const request = { protocol: 'openai-completions', apiKey: 'fake-test-key', operation: 'models' };

/** 与宿主 probe_provider_template 同款的调用方式。 */
async function runProbe(requestBody, cwd) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE, '--', '--launcher-provider-probe'],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(requestBody));
  const code = await new Promise(resolve => child.once('exit', resolve));
  return { code, stdout, stderr };
}

/**
 * 本地网关就是"对端"，绝不出网，因此这批用例不消耗任何真实用量。
 * 默认回 401：本文件要锁的是"请求由谁构造、发到哪条路径、密钥放哪个头、状态怎么分类、
 * 有没有偷偷重试"，这些在错误响应上同样成立。成功路径另外用一帧合法的
 * openai-completions SSE 走通（见"reports a runtime-constructed success"），
 * 仍然零出网零用量；但要注意那是**我们自己造的响应**，它证明的是探测器与适配器的
 * 接线，不证明任何真实服务商可用。
 */
async function withGateway(run, respond = (_req, res) => { res.writeHead(401); res.end('{"error":"unauthorized"}'); }) {
  const hits = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, hits);
  }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('model discovery preserves URL prefixes and model metadata, deduplicating IDs', async () => {
  await withGateway(async (base, hits) => {
    const result = await probeProvider({ ...request, baseUrl: `${base}/gateway/v1/` });
    assert.deepEqual(result.models.map(m => m.id), ['one', 'two']);
    assert.equal(result.models[0].contextWindow, 64000);
    assert.equal(result.models[1].name, 'Second');
    assert.equal(hits.length, 1);
  }, (req, res) => {
    assert.equal(req.url, '/gateway/v1/models');
    assert.equal(req.headers.authorization, 'Bearer fake-test-key');
    res.end(JSON.stringify({ data: [{ id: 'one', context_length: 64000 }, { id: 'two', display_name: 'Second' }, { id: 'two', display_name: 'Second' }, {}] }));
  });
});

/**
 * 运行时对 anthropic-messages 明确拒绝读取模型清单
 * （"pi-ai protocol ... has no model listing this build can read; enter this provider's models by hand"）。
 * 启动器曾自行拼出 `${base}/v1/models` 并把它当成功——那是比运行时更乐观的假能力。
 * 这里锁两件事：判定拒绝，且一个字节都不发出去。
 */
test('anthropic model listing is refused without touching the network, matching the runtime', async () => {
  await withGateway(async (base, hits) => {
    await assert.rejects(probeProvider({ ...request, baseUrl: base, protocol: 'anthropic-messages' }),
      error => error.message === 'PROVIDER_DISCOVERY_UNSUPPORTED');
    assert.deepEqual(hits, []);
  });
});

test('listing URL mirrors the runtime: strip trailing slashes only, never invent /v1', () => {
  assert.equal(listingUrl('https://example.com/prefix/v1/', 'openai-completions'), 'https://example.com/prefix/v1/models');
  assert.equal(listingUrl('https://example.com', 'openai-responses'), 'https://example.com/models');
  assert.throws(() => listingUrl('https://example.com', 'anthropic-messages'), error => error.message === 'PROVIDER_DISCOVERY_UNSUPPORTED');
  assert.throws(() => listingUrl('https://example.com', 'pi-messages'), error => error.message === 'PROVIDER_DISCOVERY_UNSUPPORTED');
});

test('auth errors, redirects, malformed successes and timeouts never pass or echo secrets', async () => {
  for (const [status, body, code] of [[401, 'fake-test-key', 'PROVIDER_AUTH_FAILED'], [302, '', 'PROVIDER_REDIRECT_REFUSED'], [200, '<html>fake-test-key</html>', 'PROVIDER_RESPONSE_INVALID'], [200, '{}', 'PROVIDER_RESPONSE_INVALID']]) {
    await withGateway(async base => {
      await assert.rejects(probeProvider({ ...request, baseUrl: base }), error => error.message === code);
    }, (_req, res) => { res.writeHead(status, { location: 'http://example.invalid/' }); res.end(body); });
  }
  await withGateway(async base => {
    await assert.rejects(probeProvider({ ...request, baseUrl: base }, 40), /PROVIDER_PROBE_TIMEOUT/);
  }, () => { /* 永不回应，专门用来触发超时 */ });
});

test('keys are trimmed like the runtime and refused before a header could carry them', async () => {
  await assert.rejects(probeProvider({ ...request, baseUrl: 'https://example.com', apiKey: '   ' }), error => error.message === 'PROVIDER_KEY_REQUIRED');
  await assert.rejects(probeProvider({ ...request, baseUrl: 'https://example.com', apiKey: 'bad\nkey' }), error => error.message === 'PROVIDER_KEY_INVALID');
  await withGateway(async (base, hits) => {
    await probeProvider({ ...request, baseUrl: base, apiKey: '  fake-test-key  ' });
    assert.equal(hits[0].headers.authorization, 'Bearer fake-test-key');
  }, (_req, res) => { res.end('{"data":[]}'); });
});

// ---- 以下锁"请求由运行时构造"这件事，需要真实运行时 ----

test('the connection test delegates request construction to the installed runtime', { skip: !packageRoot }, async () => {
  const cases = [
    ['openai-completions', '', '/chat/completions', 'authorization'],
    ['openai-completions', '/v1', '/v1/chat/completions', 'authorization'],
    ['openai-responses', '/v1', '/v1/responses', 'authorization'],
    ['anthropic-messages', '', '/v1/messages', 'x-api-key'],
  ];
  for (const [protocol, suffix, path, header] of cases) {
    await withGateway(async (base, hits) => {
      const result = await runProbe({ baseUrl: `${base}${suffix}`, protocol, apiKey: 'fake-test-key', operation: 'test', modelId: 'second-model' }, packageRoot);
      assert.equal(result.stderr, 'PROVIDER_AUTH_FAILED', `${protocol} must classify a 401 as an auth failure`);
      // maxRetries 显式为 0：探测要一次给出结论，不能静默重试。
      assert.equal(hits.length, 1, `${protocol} must not silently retry`);
      assert.equal(hits[0].url, path, `${protocol} @ ${suffix || '(no prefix)'} must hit the runtime's own path`);
      assert.equal(hits[0].headers[header], header === 'x-api-key' ? 'fake-test-key' : 'Bearer fake-test-key');
      assert.match(hits[0].body, /"second-model"/, 'the selected model must reach the request body');
    });
  }
});

/**
 * 成功路径此前只在真实服务商上手动验过，本地网关一律回 401，于是"200 + 合法完成流"
 * 这条分支其实没有守卫——把成功判错成失败、或把状态丢掉，都能从这里溜过去。
 * 下面伪造的是**我们自己造的响应**：它证明探测器与运行时适配器的接线（请求由谁构造、
 * 状态有没有如实带出来、成功后不再重试、密钥不外泄），不证明任何真实服务商可用。
 */
test('a valid completion stream reports success with the status the runtime actually saw', { skip: !packageRoot }, async () => {
  await withGateway(async (base, hits) => {
    const result = await runProbe({ baseUrl: `${base}/v1`, protocol: 'openai-completions', apiKey: 'fake-test-key', operation: 'test', modelId: 'second-model' }, packageRoot);
    assert.equal(result.code, 0, `a well-formed completion stream must pass, stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 200, 'the result must carry the HTTP status the adapter saw');
    assert.ok(Number.isFinite(payload.elapsedMs) && payload.elapsedMs >= 0, 'elapsed must be reported for the UI');
    assert.equal(hits.length, 1, 'a success must never retry');
    assert.match(hits[0].body, /second-model/, 'the model the user picked must be the one requested');
    assert.ok(!result.stdout.includes('fake-test-key'), 'the key must never ride along in the result');
  }, (_req, res) => {
    const chunk = delta => `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'second-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`${chunk({ role: 'assistant' })}${chunk({ content: 'OK' })}data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'second-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
});

/**
 * §2.7 要求"已知的路径拼接差异必须修复或禁用对应测试，二选一，不留现状"。
 * 选修复，且修复方式是不再由启动器拼 URL：baseURL 原样交给运行时，Anthropic 的 SDK 自己补 `/v1/messages`。
 * 于是 `.../v1` 这种写法会得到 `/v1/v1/messages`——与 DSH 完全相同的失败。
 * 旧探测器会把它"纠正"成 `/v1/messages` 并报告测试成功，等于让用户以为一份 DSH 跑不通的配置是好的。
 */
test('a /v1-suffixed Anthropic baseURL now fails exactly where DSH fails instead of quietly passing', { skip: !packageRoot }, async () => {
  await withGateway(async (base, hits) => {
    const result = await runProbe({ baseUrl: `${base}/v1`, protocol: 'anthropic-messages', apiKey: 'fake-test-key', operation: 'test', modelId: 'm' }, packageRoot);
    assert.equal(result.stderr, 'PROVIDER_AUTH_FAILED');
    assert.equal(hits[0].url, '/v1/v1/messages');
  });
});

/**
 * 运行时模块不可达时必须失败关闭。回退到启动器自己拼请求，就等于把刚消掉的分叉
 * 重新变成一条静默的降级路径——而且这条路径只有装了坏运行时的人才会走到。
 */
test('an unreachable runtime fails closed instead of falling back to hand-built requests', { skip: !packageRoot }, async () => {
  const orphan = await mkdtemp(join(tmpdir(), 'dsh-probe-orphan-'));
  try {
    const result = await runProbe({ baseUrl: 'https://example.invalid', protocol: 'openai-completions', apiKey: 'fake-test-key', operation: 'test', modelId: 'm' }, orphan);
    assert.equal(result.stderr, 'PROVIDER_RUNTIME_UNAVAILABLE');
  }
  finally {
    await rm(orphan, { recursive: true, force: true });
  }
  // 自定义接口的模型清单不 import 运行时，因此运行时不可达时它仍应可用。
  await withGateway(async base => {
    assert.deepEqual((await probeProvider({ ...request, baseUrl: base })).models, []);
  }, (_req, res) => { res.end('{"data":[]}'); });
});

test('unsupported protocols are rejected by the runtime answer, not by a launcher list', { skip: !packageRoot }, async () => {
  // pi-messages 在运行时注册表里确有实现，但不在 DSH 写配置的白名单内：
  // 可测集合是"运行时支持 ∩ 注册表有实现"，两个判据都现场问运行时，启动器不存清单。
  const result = await runProbe({ baseUrl: 'https://example.invalid', protocol: 'pi-messages', apiKey: 'fake-test-key', operation: 'test', modelId: 'm' }, packageRoot);
  assert.equal(result.stderr, 'PROVIDER_PROTOCOL_UNSUPPORTED');
});

// ---- 对照测试：探测自己声明的清单不能与安装中的运行时漂移 ----

test('the mirrored LISTABLE_PROTOCOLS still matches the installed runtime source', { skip: !packageRoot }, () => {
  const adapterPath = join('node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
  const source = readRuntimeFile(packageRoot, adapterPath);
  assert.ok(source !== '', `cannot read ${adapterPath} from the resolved runtime`);

  const declared = source.match(/const LISTABLE_PROTOCOLS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, 'the runtime no longer declares LISTABLE_PROTOCOLS in the shape this probe mirrors — update provider-probe.mjs instead of keep serving the old set');
  assert.deepEqual([...LISTABLE_PROTOCOLS].sort(), [...JSON.parse(`[${declared[1]}]`)].sort());

  const start = source.indexOf('function listingUrl(baseURL)');
  assert.notEqual(start, -1, 'the runtime no longer has a listingUrl to mirror');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.ok(body.includes('/models'), 'the listing target is no longer /models');
  assert.ok(body.includes('replace(/\\/+$/, "")'), 'trailing-slash handling changed');
  assert.ok(!body.includes('/v1'), 'the runtime started prefixing /v1 in listingUrl; the probe must follow it, not keep its own rule');
});

test('the response-size ceiling still matches the runtime', { skip: !packageRoot }, () => {
  const source = readRuntimeFile(packageRoot, join('node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'));
  const runtime = source.match(/const MAX_RESPONSE_BYTES = ([^;]+);/);
  assert.ok(runtime, 'the runtime no longer declares MAX_RESPONSE_BYTES');
  const probe = PROBE_SOURCE.match(/const MAX_RESPONSE_BYTES = ([^;]+);/);
  assert.ok(probe, 'the probe no longer declares MAX_RESPONSE_BYTES');
  assert.equal(probe[1], runtime[1]);
});
