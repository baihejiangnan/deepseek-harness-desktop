import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importProviders, commitProviderDocuments, readProviders, planProviderOperations, applyProviderOperations } from './provider-import.mjs';
import { resolveRuntimeEntry, resolvePackageRoot } from './runtime-under-test.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 集成用例需要一份真实 DSH 运行时。未显式指定时解析全局安装，
// 解析不到必须明说"这批用例没跑"，否则剩下几个单元测试通过会看起来像全绿。
// 解析规则在 runtime-under-test.mjs 里只定义一次，provider-probe.test.mjs 用同一份。
const runtime = resolveRuntimeEntry();
if (!runtime) {
  console.warn('[provider-import.test] no DSH runtime resolved (set DSH_TEST_ENTRY to the DSH CLI entry): the integration cases below are SKIPPED, not passed.');
}
test('settings commit failure restores the exact previous credential document', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-rollback-'));
  try {
    const require = createRequire(runtime);
    const { writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href);
    const settingsPath = join(home, 'settings.yaml');
    const keyPath = join(home, '.credentials.yaml');
    const previous = '# preserve\nversion: 1\nrefs:\n  EXISTING: previous-test-key\n';
    await writeFile(keyPath, previous);
    await writeFile(settingsPath, 'other: unchanged\n');
    let sawNewCredentials = false;
    const failingWriter = async (path, content, options) => {
      if (path === settingsPath) {
        sawNewCredentials = (await readFile(keyPath, 'utf8')).includes('new-test-key');
        throw new Error('INJECTED_SETTINGS_WRITE_FAILURE');
      }
      return writeFileAtomic(path, content, options);
    };
    await assert.rejects(commitProviderDocuments(failingWriter, settingsPath, keyPath, 'new: settings\n', 'version: 1\nrefs:\n  NEW: new-test-key\n', previous), /INJECTED_SETTINGS_WRITE_FAILURE/);
    assert.ok(sawNewCredentials);
    assert.equal(await readFile(keyPath, 'utf8'), previous);
    assert.equal(await readFile(settingsPath, 'utf8'), 'other: unchanged\n');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
// 与 Rust 侧 ProviderTemplate::profile() 的输出保持一致：字段归属由启动器定义，
// .mjs 只负责把它合并进 YAML Document。
const gatewayProfile = (overrides = {}) => ({
  displayName: 'Test',
  baseURL: 'https://example.com/v1',
  api: 'openai-completions',
  apiKeyEnv: 'DSH_LAUNCHER_TEST_GATEWAY_API_KEY',
  models: [{ id: 'test-model' }],
  ...overrides,
});
const example = () => [{
  template: { id: 'test-gateway', name: 'Test' },
  api_key: 'test-only-secret',
  credentialRef: 'DSH_LAUNCHER_TEST_GATEWAY_API_KEY',
  profile: gatewayProfile(),
}];

const catalogRoot = runtime ? resolvePackageRoot(runtime) : '';
const CATALOG_SOURCE = readFileSync(new URL('./provider-catalog.mjs', import.meta.url), 'utf8');

/**
 * 向**被安装的那个运行时**问它的服务商目录，与宿主 `get_runtime_catalog` 同款调用方式：
 * `node --input-type=module -e <脚本>`，且 cwd 必须是运行时包目录（裸标识符按模块基准解析）。
 * 之所以现问而不是在测试里写一个服务商 id：写死就等于在测试里再造一份服务商清单，
 * 那正是方案禁止的东西，而且 DSH 换目录之后用例会一边变红一边骗人说实现坏了。
 */
async function askRuntimeCatalog(requestBody) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CATALOG_SOURCE],
    { cwd: catalogRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(requestBody));
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, `runtime catalog probe must succeed, got: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

test('native DSH recovers from a disabled broken plugin and reaches authenticated Web readiness after provider import', { skip: !runtime, timeout: 75000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-boot-'));
  let child;
  try {
    const profile = join(home, 'profiles', 'tauri');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-boot', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const importedEntries = example();
    importedEntries[0].profile.models = [{ id: 'first-model' }, { id: 'second-model', contextWindow: 64000 }];
    // 第二条专门走"目录继承"：只写 displayName + apiKeyEnv，端点/协议/模型清单一个都不写。
    // 选哪条来自运行时自己的目录答案（见 askRuntimeCatalog），测试里没有本地服务商清单。
    const runtimeCatalogList = await askRuntimeCatalog({ operation: 'list' });
    const inheritedRoute = runtimeCatalogList.providers.find(item => item.id
      && item.id !== 'test-gateway'
      && item.modelCount > 0
      && item.baseUrl
      && item.auth?.apiKey);
    assert.ok(inheritedRoute, 'the installed runtime must expose at least one api-key catalog provider with a bundled endpoint and models, otherwise this claim cannot be proven here');
    const inheritedRef = `DSH_LAUNCHER_${inheritedRoute.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    importedEntries.push({
      template: { id: inheritedRoute.id, name: inheritedRoute.name || inheritedRoute.id },
      api_key: 'test-only-secret',
      credentialRef: inheritedRef,
      profile: { displayName: inheritedRoute.name || inheritedRoute.id, apiKeyEnv: inheritedRef },
    });
    await importProviders(runtime, home, importedEntries, false, 'tauri');
    // 验收链路里的"明确设置默认模型 → 保存"必须走界面同一条 plan→apply 路径，
    // 而不是另开一条直写文件的捷径：默认模型与路由要在同一次摘要/指纹比对下落盘。
    const bootOperations = { entries: importedEntries, removals: [], defaultModel: { provider: 'test-gateway', model: 'first-model' } };
    const bootPreview = await planProviderOperations(runtime, home, 'tauri', bootOperations);
    assert.equal(bootPreview.plan.defaultModelAction, 'set', 'the preview must record an explicit default-model write');
    await applyProviderOperations(runtime, home, 'tauri', { ...bootOperations, digest: bootPreview.digest, fingerprint: bootPreview.fingerprint });
    const brokenPlugin = join(profile, 'audit-broken.mjs');
    await writeFile(brokenPlugin, "throw new Error('AUDIT_PLUGIN_INCOMPATIBLE');\n");
    const patch = disabled => `- insert:\n    - id: audit-broken\n      name: ${JSON.stringify(pathToFileURL(brokenPlugin).href)}\n      disabled: ${disabled}\n`;
    await writeFile(join(profile, 'cordis.patch.yml'), patch(false));
    const failed = spawnSync(process.execPath, [runtime, '--profile', 'tauri', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: home }, cwd: home, windowsHide: true, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(failed.error);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr + failed.stdout, /AUDIT_PLUGIN_INCOMPATIBLE/);
    await writeFile(join(profile, 'cordis.patch.yml'), patch(true));
    child = spawn(process.execPath, [runtime, '--profile', 'tauri', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: home }, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let nativeGroups = [];
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, 'isolated DSH exited before Web readiness');
      const links = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\x1b]*/g) ?? [];
      const link = links.find(url => url.includes('token='));
      if (link) {
        const response = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
        if (response.status === 303 && response.headers.get('location') === '/') {
          const cookie = response.headers.get('set-cookie')?.split(';')[0];
          assert.ok(cookie, 'authentication redirect must issue a cookie');
          const page = await fetch(new URL('/', link), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
          assert.equal(page.status, 200);
          const method = 'session/modelCatalog';
          const catalogResponse = await fetch(new URL(`/api/${method}`, link), {
            method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: 'provider-catalog-test', method, payload: { args: {} } }),
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(catalogResponse.status, 200);
          const catalog = await catalogResponse.json();
          assert.equal(catalog.result?.ok, true, `native model catalog RPC must succeed: ${JSON.stringify(catalog)}`);
          nativeGroups = catalog.result.value.groups;
          const provider = catalog.result.value.groups.find(group => group.id === 'test-gateway');
          assert.ok(provider, 'imported custom provider must be routable in native DSH');
          assert.deepEqual(provider.models.map(model => model.id), ['first-model', 'second-model']);
          ready = true;
          break;
        }
        assert.equal(response.status, 200, 'authenticated endpoint failed');
        ready = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'native Web did not become authenticated within 45 seconds');
    // "保存并回读"这一腿：DSH 启动过后，默认模型必须还在磁盘上、还能被回读取出，
    // 并且它指向的就是上面原生目录 RPC 认出来的那条路由。
    // 证明边界要说清：DSH 对 agent-default-model 这一段**不设校验**（已核实），所以这条
    // 证明的是"启动一轮后仍能从磁盘解析回同一对 provider/model"，**不是**"DSH 认可该模型
    // 真实存在"，也不是逐字节未变（逐字节那条在"reading back and re-applying…"用例里）。
    const booted = await readProviders(runtime, home, 'tauri');
    assert.equal(booted.defaultModel.declared, true);
    assert.equal(booted.defaultModel.provider, 'test-gateway');
    assert.equal(booted.defaultModel.model, 'first-model');
    // 不再用正则去钉 YAML 的具体排版：写入器对新建节点是流式风格
    // （`agent-default-model: { provider: …, model: … }`），钉排版等于把序列化风格当成语义，
    // 风格一变就假失败。上面的 readProviders 已经是从磁盘解析回来的结果，
    // 这里只补一条与风格无关的存在性检查。
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /agent-default-model:/);
    // 目录继承的运行时证据：这条路由我们只写了 displayName + apiKeyEnv，
    // 但 DSH 自己的 modelCatalog 仍报得出它的模型——清单来自 DSH 的目录，不是启动器写的。
    const inheritedGroup = nativeGroups.find(group => group.id === inheritedRoute.id);
    assert.ok(inheritedGroup, `booted DSH must route the catalog key ${inheritedRoute.id}`);
    assert.ok(inheritedGroup.models.length > 0, 'models must be inherited from the native catalog since the launcher wrote none');
    // 另一半证据：磁盘上确实没有把它内建的端点钉死，否则"跟随目录升级"就是假话。
    const pinnedEndpoint = new RegExp(inheritedRoute.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.doesNotMatch(await readFile(join(home, 'settings.yaml'), 'utf8'), pinnedEndpoint, 'a catalog route must not pin the catalog baseURL');
  } finally {
    if (child && child.exitCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('isolated native profile exposes its settings and credential contract without booting', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-contract-'));
  try {
    const profile = join(home, 'profiles', 'tauri');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-test', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const dump = execFileSync(process.execPath, [runtime, '--profile', 'tauri', '--dump-config'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.match(dump, /@deepseek-ai\/dsh-settings-file/);
    assert.match(dump, /@deepseek-ai\/dsh-credentials-local/);
    await importProviders(runtime, home, example(), false, 'tauri');
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /test-gateway/);
    const customSettings = join(home, 'nested', 'custom.json');
    const customKeys = join(home, 'nested', 'custom-credentials.yaml');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: settings\n  config:\n    path: ${JSON.stringify(customSettings)}\n- id: credentials\n  config:\n    path: ${JSON.stringify(customKeys)}\n`);
    await importProviders(runtime, home, example(), false, 'tauri');
    const imported = JSON.parse(await readFile(customSettings, 'utf8'));
    assert.equal(imported['llm-pi-ai'].providers['test-gateway'].displayName, 'Test');
    assert.match(await readFile(customKeys, 'utf8'), /test-only-secret/);
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: settings\n  config:\n    path: ${JSON.stringify(join(home, '..', 'outside.yaml'))}\n`);
    await assert.rejects(importProviders(runtime, home, example(), false, 'tauri'), /PROVIDER_PATH_OUTSIDE_HOME/);
    const redirected = join(home, 'redirected');
    await symlink(join(home, 'nested'), redirected, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: settings\n  config:\n    path: ${JSON.stringify(join(redirected, 'other.yaml'))}\n`);
    await assert.rejects(importProviders(runtime, home, example(), false, 'tauri'), /PROVIDER_SYMLINK_UNSUPPORTED/);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('empty and comment-only native documents accept provider imports', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-empty-'));
  try {
    await writeFile(join(home, 'settings.yaml'), '# existing comment\n');
    await writeFile(join(home, '.credentials.yaml'), '');
    await importProviders(runtime, home, example());
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /existing comment/);
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /version: 1/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('unsupported protocols and malformed credential maps never partially import', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-invalid-'));
  try {
    const settings = 'other: untouched\n';
    const keyPath = join(home, '.credentials.yaml');
    await writeFile(join(home, 'settings.yaml'), settings);
    for (const credentials of ['version: 2\n', 'version: 1\nrefs: wrong\n', 'version: 1\nunknown: invalid\n']) {
      await writeFile(keyPath, credentials);
      await assert.rejects(importProviders(runtime, home, example()), /PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED/);
      assert.equal(await readFile(keyPath, 'utf8'), credentials);
      assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), settings);
    }
    const credentials = 'version: 1\nrefs: {}\n';
    await writeFile(keyPath, credentials);
    const entries = example();
    entries.push({ ...example()[0], template: { id: 'second', name: 'Second' }, credentialRef: 'DSH_LAUNCHER_SECOND_API_KEY', profile: gatewayProfile({ apiKeyEnv: 'DSH_LAUNCHER_SECOND_API_KEY', api: 'not-supported' }) });
    await assert.rejects(importProviders(runtime, home, entries), /PROVIDER_PROTOCOL_UNSUPPORTED/);
    assert.equal(await readFile(keyPath, 'utf8'), credentials);
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), settings);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('unresolved native YAML tags are rejected without rewriting either document', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-tag-'));
  try {
    const settings = 'other: !runtime-expression preserve-me\n';
    const credentials = 'version: 1\nrefs: {}\n';
    await writeFile(join(home, 'settings.yaml'), settings);
    await writeFile(join(home, '.credentials.yaml'), credentials);
    await assert.rejects(importProviders(runtime, home, example()), /PROVIDER_DOCUMENT_INVALID/);
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), settings);
    assert.equal(await readFile(join(home, '.credentials.yaml'), 'utf8'), credentials);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('DSH import preserves unrelated settings and credentials, rejects conflicts, and explicitly replaces a route', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-import-'));
  try {
    await writeFile(join(home, 'settings.yaml'), '# keep comment\nother:\n  value: keep\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  EXISTING_KEY: preserve\n');
    const entries = [{
      template: { id: 'test-gateway', name: 'Test' },
      api_key: 'test-only-secret',
      credentialRef: 'DSH_LAUNCHER_TEST_GATEWAY_API_KEY',
      profile: gatewayProfile({ models: [{ id: 'first', contextWindow: 64000 }, { id: 'second' }] }),
    }];
    await importProviders(runtime, home, entries);
    const settings = await readFile(join(home, 'settings.yaml'), 'utf8');
    const keys = await readFile(join(home, '.credentials.yaml'), 'utf8');
    assert.match(settings, /keep comment/);
    assert.match(settings, /value: keep/);
    assert.match(settings, /llm-pi-ai:/);
    assert.match(settings, /id: first/);
    assert.match(settings, /id: second/);
    assert.match(settings, /contextWindow: 64000/);
    assert.doesNotMatch(settings, /test-only-secret/);
    assert.match(keys, /EXISTING_KEY: preserve/);
    assert.match(keys, /DSH_LAUNCHER_TEST_GATEWAY_API_KEY: test-only-secret/);
    await assert.rejects(importProviders(runtime, home, entries), /PROVIDER_ID_CONFLICT/);
    assert.equal(await readFile(join(home, '.credentials.yaml'), 'utf8'), keys);
    entries[0].template.name = 'Updated';
    entries[0].profile.displayName = 'Updated';
    entries[0].profile.models = [{ id: 'second' }, { id: 'third' }];
    await importProviders(runtime, home, entries, true);
    const updated = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.match(updated, /displayName: Updated/);
    assert.match(updated, /id: third/);
    assert.doesNotMatch(updated, /id: first/);
  } finally {
    // DSH 的锁文件与原子写残留会在 Windows 上造成短暂 ENOTEMPTY，清理需退避。
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const deepseekEntry = profile => [{
  template: { id: 'deepseek', name: 'DeepSeek' },
  api_key: 'test-only-secret',
  credentialRef: 'DSH_LAUNCHER_DEEPSEEK_API_KEY',
  profile,
}];

test('read-back reports shape only, never leaks secrets, and refuses to over-claim state', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-read-'));
  try {
    await writeFile(join(home, 'settings.yaml'), '# keep\nllm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\n      apiKeyEnv: DSH_LAUNCHER_DEEPSEEK_API_KEY\n      models:\n        - id: deepseek-v4-flash\n      headers:\n        authorization: Bearer super-secret-token\n    mystery-route:\n      baseURL: https://example.invalid/v1\nagent-default-model:\n  provider: mystery-route\n  model: not-listed\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_LAUNCHER_DEEPSEEK_API_KEY: written-secret\n  ORPHAN_KEY: orphan-secret\n');
    const view = await readProviders(runtime, home);
    const serialized = JSON.stringify(view);
    // 值一律不外泄：凭据值、未知字段里的令牌都不能出现在返回体里。
    for (const secret of ['written-secret', 'orphan-secret', 'super-secret-token']) {
      assert.ok(!serialized.includes(secret), `回读泄漏了敏感值：${secret}`);
    }
    assert.deepEqual(view.routes.map(route => route.id), ['deepseek', 'mystery-route']);
    const [deepseek, mystery] = view.routes;
    assert.equal(deepseek.credential.source, 'file');
    assert.equal(deepseek.selection, 'subset');
    assert.deepEqual(deepseek.modelIds, ['deepseek-v4-flash']);
    // headers 不是模板自有字段：只报字段名，界面据此只读展示。
    assert.deepEqual(deepseek.unknownFields, ['headers']);
    // 未声明引用的路由是"走环境认证"，不是"缺密钥"。
    assert.equal(mystery.credential.declared, false);
    assert.equal(mystery.credential.source, 'ambient');
    assert.equal(mystery.selection, 'all');
    // 默认模型指向文件里认不出的路由：未确认，而不是失效——插件可在运行时注册路由。
    assert.equal(view.defaultModel.provider, 'mystery-route');
    assert.equal(view.defaultModel.providerStatus, 'known');
    assert.equal(view.defaultModel.modelStatus, 'unconfirmed');
    // 无人引用的凭据只报告，绝不自动删除。
    assert.deepEqual(view.unreferencedCredentialRefs, ['ORPHAN_KEY']);
    assert.match(view.fingerprint, /^[0-9a-f]{64}$/);
    // 指纹必须随文档内容变化，供写入前的并发校验使用。
    await writeFile(join(home, 'settings.yaml'), '# keep\nllm-pi-ai: {}\n');
    assert.notEqual((await readProviders(runtime, home)).fingerprint, view.fingerprint);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('import then read-back reflects exactly what the template owns', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-roundtrip-'));
  try {
    await importProviders(runtime, home, deepseekEntry({ displayName: 'DeepSeek', apiKeyEnv: 'DSH_LAUNCHER_DEEPSEEK_API_KEY' }), false);
    const view = await readProviders(runtime, home);
    const route = view.routes.find(item => item.id === 'deepseek');
    assert.equal(route.displayName, 'DeepSeek');
    assert.equal(route.credential.source, 'file');
    // 最小写入的模板回读后仍是"跟随目录"，且没有留下任何被钉死的字段。
    assert.equal(route.selection, 'all');
    assert.deepEqual(route.configuredFields.sort(), ['apiKeyEnv', 'displayName']);
    assert.deepEqual(route.unknownFields, []);
    assert.equal(route.baseUrl, '');
    assert.equal(route.protocol, '');
    await writeFile(join(home, '.env'), 'DEEPSEEK_UNUSED=1\n');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('change preview reports diffs, apply honours them, and a stale plan aborts', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-plan-'));
  try {
    const initial = '# keep\nllm-pi-ai:\n  providers:\n    deepseek:\n      displayName: 旧名\n      api: openai-completions\n      baseURL: https://stale.example/v1\n      models:\n        - id: only-one\n      headers:\n        x-custom: keep-me\nagent-default-model:\n  provider: ghost\n  model: nope\n';
    await writeFile(join(home, 'settings.yaml'), initial);
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  EXISTING_KEY: preserve\n');
    const operations = {
      entries: deepseekEntry({ displayName: 'DeepSeek', apiKeyEnv: 'DSH_LAUNCHER_DEEPSEEK_API_KEY' }),
      removals: [],
      defaultModel: { provider: 'ghost', model: 'nope' },
    };
    const preview = await planProviderOperations(runtime, home, undefined, operations);
    const change = preview.plan.changes[0];
    assert.equal(change.kind, 'modify');
    // 非模板自有字段只报"会保留"，不报值。
    assert.deepEqual(change.preservedFields, ['headers']);
    assert.deepEqual(change.fields.map(field => field.field).sort(), ['api', 'apiKeyEnv', 'baseURL', 'displayName', 'models']);
    // 默认模型指向认不出的路由：给"无法确认"警告，但不硬拦——插件可以运行时注册路由。
    assert.deepEqual(preview.plan.warnings, [{ code: 'PROVIDER_DEFAULT_MODEL_UNCONFIRMED', detail: 'ghost' }]);

    await applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint });
    const settings = await readFile(join(home, 'settings.yaml'), 'utf8');
    const keys = await readFile(join(home, '.credentials.yaml'), 'utf8');
    assert.match(settings, /# keep/);
    assert.match(settings, /x-custom: keep-me/);
    assert.match(settings, /displayName: DeepSeek/);
    assert.doesNotMatch(settings, /api: openai-completions/);
    assert.doesNotMatch(settings, /stale\.example/);
    assert.doesNotMatch(settings, /only-one/);
    assert.match(settings, /provider: ghost/);
    assert.match(keys, /EXISTING_KEY: preserve/);
    assert.match(keys, /DSH_LAUNCHER_DEEPSEEK_API_KEY: test-only-secret/);

    // 同一份计划已经过期（应用后差异消失），必须中止且不再改文档。
    const after = await readFile(join(home, 'settings.yaml'), 'utf8');
    await assert.rejects(
      applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint }),
      /PROVIDER_SETTINGS_CHANGED/,
    );
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), after);
  }
  finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('returning a route to catalog inheritance unpins api, baseURL and models but preserves foreign fields', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-inherit-'));
  try {
    await writeFile(join(home, 'settings.yaml'), '# hand pinned\nllm-pi-ai:\n  providers:\n    deepseek:\n      displayName: 旧名\n      api: openai-completions\n      baseURL: https://stale.example/v1\n      models:\n        - id: only-one\n      headers:\n        x-custom: keep-me\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  EXISTING_KEY: preserve\n');
    // 目录型最小写入：只声明显示名与凭据引用，其余交给 DSH 目录继承。
    await importProviders(runtime, home, deepseekEntry({ displayName: 'DeepSeek', apiKeyEnv: 'DSH_LAUNCHER_DEEPSEEK_API_KEY' }), true);
    const settings = await readFile(join(home, 'settings.yaml'), 'utf8');
    const keys = await readFile(join(home, '.credentials.yaml'), 'utf8');
    assert.match(settings, /# hand pinned/);
    assert.match(settings, /displayName: DeepSeek/);
    assert.doesNotMatch(settings, /api: openai-completions/);
    assert.doesNotMatch(settings, /stale\.example/);
    assert.doesNotMatch(settings, /only-one/);
    assert.match(settings, /x-custom: keep-me/);
    assert.match(keys, /EXISTING_KEY: preserve/);
    assert.match(keys, /DSH_LAUNCHER_DEEPSEEK_API_KEY: test-only-secret/);
    // 继承模式下的单模型调整走 modelOverrides，不得混出 models。
    await importProviders(runtime, home, deepseekEntry({
      displayName: 'DeepSeek',
      apiKeyEnv: 'DSH_LAUNCHER_DEEPSEEK_API_KEY',
      modelOverrides: { 'deepseek-v4-flash': { contextWindow: 64000 } },
    }), true);
    const again = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.match(again, /modelOverrides:/);
    assert.match(again, /deepseek-v4-flash/);
    assert.doesNotMatch(again, /models:/);
    assert.match(again, /x-custom: keep-me/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('credential three-state keeps, replaces and detaches the reference without ever deleting a stored value', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-credential-'));
  try {
    const declared = 'DSH_LAUNCHER_DEEPSEEK_API_KEY';
    await writeFile(join(home, 'settings.yaml'), '# keep\nllm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\n      apiKeyEnv: DSH_LAUNCHER_DEEPSEEK_API_KEY\n      headers:\n        x-custom: keep-me\n');
    await writeFile(join(home, '.credentials.yaml'), `version: 1\nrefs:\n  ${declared}: first-secret\n  ORPHAN_KEY: orphan-secret\n`);
    // .env 里的同名变量也算"仍被引用"：扫描必须覆盖它，否则会把还能用的引用报成可清理。
    await writeFile(join(home, '.env'), `${declared}=from-env\n`);
    const edit = (credentialMode, apiKey, profile) => ({
      entries: [{ template: { id: 'deepseek', name: 'DeepSeek' }, api_key: apiKey, credentialRef: declared, credentialMode, profile }],
      removals: [],
      defaultModel: null,
    });
    const run = async (operations) => {
      const preview = await planProviderOperations(runtime, home, undefined, operations);
      await applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint });
      return preview.plan.changes[0];
    };

    // keep：不提交密钥。引用名由脚本从文档里取回，因此预览不得报出 apiKeyEnv 的假差异。
    const keep = await run(edit('keep', null, { displayName: '改名了' }));
    assert.deepEqual(keep.fields, [{ field: 'displayName', from: 'DeepSeek', to: '改名了' }]);
    assert.deepEqual(keep.credential, { ref: declared, action: 'keep' });
    let settings = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.match(settings, /# keep/);
    assert.match(settings, /x-custom: keep-me/);
    assert.match(settings, /displayName: 改名了/);
    assert.match(settings, new RegExp(`apiKeyEnv: ${declared}`));
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /first-secret/);

    // replace：引用名没变也要如实报"将替换密钥"，因为值确实被写。
    const replace = await run(edit('replace', 'second-secret', { displayName: '改名了', apiKeyEnv: declared }));
    assert.deepEqual(replace.fields, []);
    assert.equal(replace.kind, 'unchanged');
    assert.deepEqual(replace.credential, { ref: declared, action: 'replace' });
    const keys = await readFile(join(home, '.credentials.yaml'), 'utf8');
    assert.match(keys, /second-secret/);
    assert.doesNotMatch(keys, /first-secret/);
    // 只动凭据：其余引用与 settings 一概不碰。
    assert.match(keys, /ORPHAN_KEY: orphan-secret/);
    assert.deepEqual((await readProviders(runtime, home)).unreferencedCredentialRefs, ['ORPHAN_KEY']);

    // none：引用从路由上摘除，但凭据值留在文档里——别的段落或插件可能还在用。
    const detach = await run(edit('none', null, { displayName: '改名了' }));
    assert.deepEqual(detach.credential, { ref: declared, action: 'remove' });
    settings = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.doesNotMatch(settings, /apiKeyEnv/);
    assert.match(settings, /x-custom: keep-me/);
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /second-secret/);
    // 摘除后走环境认证，不是"缺密钥"；.env 里的同名变量让该引用仍算保留。
    assert.equal((await readProviders(runtime, home)).routes[0].credential.source, 'ambient');
    // 此时 settings 里已经没有这个名字，只剩 .env 命中：ORPHAN_KEY 两边都没有，必须被排除。
    const detached = await planProviderOperations(runtime, home, undefined, { entries: [], removals: [], defaultModel: null });
    assert.deepEqual(detached.plan.retainedCredentialRefs, [declared]);

    // 删路由同样不删凭据。先把引用声明回去，否则这条路由此时压根没有引用可保留。
    const restore = edit('replace', 'second-secret', { displayName: '改名了', apiKeyEnv: declared });
    const restorePreview = await planProviderOperations(runtime, home, undefined, restore);
    await applyProviderOperations(runtime, home, undefined, { ...restore, digest: restorePreview.digest, fingerprint: restorePreview.fingerprint });
    const removals = { entries: [], removals: ['deepseek'], defaultModel: null };
    const preview = await planProviderOperations(runtime, home, undefined, removals);
    assert.deepEqual(preview.plan.changes[0].credential, { ref: declared, action: 'keep' });
    await applyProviderOperations(runtime, home, undefined, { ...removals, digest: preview.digest, fingerprint: preview.fingerprint });
    assert.doesNotMatch(await readFile(join(home, 'settings.yaml'), 'utf8'), /deepseek/);
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /second-secret/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * 预览里的 `to` 必须是"合并后真正落盘的值"，不是调用方递交的那份。
 * 这条是拿真实代码跑出来的：切到"跟随目录全部"时 `modelOverrides` 按 id 并入，
 * 没被提到的 `legacy` 会留下；而预览原先只报递交值，读起来像那份调整会被清掉。
 */
test('the preview reports the merged result, not the submitted value, when selection mode flips', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-selection-switch-'));
  try {
    const initial = [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      displayName: DeepSeek',
      '      models:',
      '        - id: chat',
      '          contextWindow: 64000',
      '        - id: coder',
      '      modelOverrides:',
      '        legacy:',
      '          contextWindow: 4096',
      '',
    ].join('\n');
    await writeFile(join(home, 'settings.yaml'), initial);
    const operations = profile => ({ entries: [{ template: { id: 'deepseek', name: 'DeepSeek' }, api_key: null, credentialRef: '', profile }], removals: [], defaultModel: null });
    const fieldOf = (plan, name) => plan.changes[0].fields.find(item => item.field === name);

    // 子集 -> 跟随目录全部：models 被删，modelOverrides 并入而不是替换。
    const toAll = operations({ displayName: 'DeepSeek', modelOverrides: { chat: { id: 'chat', contextWindow: 64000 }, coder: { id: 'coder', name: 'Coder' } } });
    const preview = await planProviderOperations(runtime, home, undefined, toAll);
    assert.deepEqual(fieldOf(preview.plan, 'models').to, null, 'inheriting must show models being removed');
    assert.deepEqual(fieldOf(preview.plan, 'modelOverrides').to, {
      legacy: { contextWindow: 4096 },
      chat: { id: 'chat', contextWindow: 64000 },
      coder: { id: 'coder', name: 'Coder' },
    }, 'an untouched model must survive the merge in the preview too');

    await applyProviderOperations(runtime, home, undefined, { ...toAll, digest: preview.digest, fingerprint: preview.fingerprint });
    // 预览说的和文档里落的必须一模一样——这条断言才是这次修复的意义。
    const route = (await readProviders(runtime, home)).routes.find(item => item.id === 'deepseek');
    assert.equal(route.selection, 'all');
    assert.deepEqual(route.overrides, [
      { id: 'legacy', contextWindow: 4096 },
      { id: 'chat', contextWindow: 64000 },
      { id: 'coder', name: 'Coder' },
    ], 'written overrides must equal the previewed ones');

    // 反向：切回子集时 modelOverrides 整体删除，models 变成钉住的清单。
    const toSubset = operations({ displayName: 'DeepSeek', models: [{ id: 'chat', contextWindow: 64000 }, { id: 'coder' }] });
    const back = await planProviderOperations(runtime, home, undefined, toSubset);
    assert.deepEqual(fieldOf(back.plan, 'modelOverrides').to, null);
    assert.deepEqual(fieldOf(back.plan, 'models').to, [{ id: 'chat', contextWindow: 64000 }, { id: 'coder' }]);
    await applyProviderOperations(runtime, home, undefined, { ...toSubset, digest: back.digest, fingerprint: back.fingerprint });
    const pinned = (await readProviders(runtime, home)).routes.find(item => item.id === 'deepseek');
    assert.equal(pinned.selection, 'subset');
    assert.deepEqual(pinned.overrides, [], 'leaving inherit mode drops the overrides, as previewed');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * "清空 Home 默认模型"和"根本不碰它"此前塌成同一份计划（两者 defaultModel 都是 null），
 * 预览于是给出完全相同的画面。默认模型是 §2.9 的验收点，这个区别不能只存在于调用方内存里。
 */
test('the plan distinguishes clearing the default model from leaving it alone', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-default-action-'));
  try {
    const initial = 'llm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\nagent-default-model:\n  provider: deepseek\n  model: chat\n';
    await writeFile(join(home, 'settings.yaml'), initial);
    const plan = defaultModel => planProviderOperations(runtime, home, undefined, { entries: [], removals: [], defaultModel });
    const keep = await plan(null);
    const clear = await plan('clear');
    const set = await plan({ provider: 'deepseek', model: 'other' });

    // 被修掉的那个塌缩：两种意图在 defaultModel 上确实同值。
    assert.equal(keep.plan.defaultModel, null);
    assert.equal(clear.plan.defaultModel, null);
    // 意图必须由显式字段分开。
    assert.equal(keep.plan.defaultModelAction, 'keep');
    assert.equal(clear.plan.defaultModelAction, 'clear');
    assert.equal(set.plan.defaultModelAction, 'set');
    assert.deepEqual(set.plan.defaultModel, { provider: 'deepseek', model: 'other' });

    // 计划里的动作要与真正落盘的结果一致，否则这个字段只是装饰。
    await applyProviderOperations(runtime, home, undefined, { entries: [], removals: [], defaultModel: null, digest: keep.digest, fingerprint: keep.fingerprint });
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /agent-default-model/);
    const again = await plan('clear');
    await applyProviderOperations(runtime, home, undefined, { entries: [], removals: [], defaultModel: 'clear', digest: again.digest, fingerprint: again.fingerprint });
    assert.doesNotMatch(await readFile(join(home, 'settings.yaml'), 'utf8'), /agent-default-model/);
    // 清空不影响服务商段落本身。
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /displayName: DeepSeek/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('credential keep on a route that never declared a reference invents nothing', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-credential-none-'));
  try {
    await writeFile(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\n');
    const operations = {
      entries: [{ template: { id: 'deepseek', name: 'DeepSeek' }, api_key: null, credentialRef: 'DSH_LAUNCHER_DEEPSEEK_API_KEY', credentialMode: 'keep', profile: { displayName: 'DeepSeek' } }],
      removals: [],
      defaultModel: null,
    };
    const preview = await planProviderOperations(runtime, home, undefined, operations);
    // 没有现存引用可保留：不报凭据变化，也不凭空写一个引用出去。
    assert.equal(preview.plan.changes[0].credential, null);
    assert.equal(preview.plan.changes[0].kind, 'unchanged');
    await applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint });
    assert.doesNotMatch(await readFile(join(home, 'settings.yaml'), 'utf8'), /apiKeyEnv/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('read-back exposes owned model options only, and the default reasoning effort round-trips', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-options-'));
  try {
    await writeFile(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\n      models:\n        - id: pinned\n          contextWindow: 64000\n          maxTokens: 8192\n          nativeOnly: do-not-leak\n        - id: bare\n      modelOverrides:\n        inherited:\n          maxTokens: 4096\n          nativeOnly: also-secret\n');
    const view = await readProviders(runtime, home);
    const route = view.routes[0];
    assert.deepEqual(route.models, [{ id: 'pinned', contextWindow: 64000, maxTokens: 8192 }, { id: 'bare' }]);
    assert.deepEqual(route.modelIds, ['pinned', 'bare']);
    assert.deepEqual(route.overrides, [{ id: 'inherited', maxTokens: 4096 }]);
    assert.equal(route.selection, 'subset');
    // 模型条目里的原生私有选项不外泄：编辑只能拿到模板自有的键。
    const serialized = JSON.stringify(view);
    for (const secret of ['do-not-leak', 'also-secret', 'nativeOnly']) {
      assert.ok(!serialized.includes(secret), `回读泄漏了模型条目的私有字段：${secret}`);
    }

    // reasoningEffort 属于 agent-default-model 的 schema；模型在已声明清单里，不该报"无法确认"。
    const operations = { entries: [], removals: [], defaultModel: { provider: 'deepseek', model: 'pinned', reasoningEffort: 'high' } };
    const preview = await planProviderOperations(runtime, home, undefined, operations);
    assert.deepEqual(preview.plan.warnings, []);
    await applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint });
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /reasoningEffort: high/);
    assert.equal((await readProviders(runtime, home)).defaultModel.reasoningEffort, 'high');
    // 写默认模型不该动到服务商段落里的私有选项。
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /nativeOnly: do-not-leak/);

    // 空档位不写键，而不是写一个空值进去。
    const blank = { entries: [], removals: [], defaultModel: { provider: 'deepseek', model: 'pinned', reasoningEffort: '' } };
    const blankPreview = await planProviderOperations(runtime, home, undefined, blank);
    await applyProviderOperations(runtime, home, undefined, { ...blank, digest: blankPreview.digest, fingerprint: blankPreview.fingerprint });
    assert.doesNotMatch(await readFile(join(home, 'settings.yaml'), 'utf8'), /reasoningEffort/);
    assert.equal((await readProviders(runtime, home)).defaultModel.reasoningEffort, '');

    // 形状不合法的默认模型直接拒绝：这一段 DSH 自己不校验，写坏了要到请求时才炸。
    const invalid = { entries: [], removals: [], defaultModel: { provider: '', model: 'pinned' } };
    const invalidPreview = await planProviderOperations(runtime, home, undefined, invalid);
    const before = await readFile(join(home, 'settings.yaml'), 'utf8');
    await assert.rejects(
      applyProviderOperations(runtime, home, undefined, { ...invalid, digest: invalidPreview.digest, fingerprint: invalidPreview.fingerprint }),
      /PROVIDER_DEFAULT_MODEL_INVALID/,
    );
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), before);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * "模板复用"的实际含义是同一条模板先后应用到两个不同的 Home。
 * 这里刻意复用同一个 entries 数组对象：如果导入路径就地改写了调用方传入的 entry，
 * 第二次导入拿到的就是被第一次污染过的形状——而这是"复用"最容易坏掉的方式。
 */
test('one template entry applies to two Homes independently and survives the first import unchanged', { skip: !runtime }, async () => {
  const first = await mkdtemp(join(tmpdir(), 'dsh-reuse-a-'));
  const second = await mkdtemp(join(tmpdir(), 'dsh-reuse-b-'));
  try {
    const entries = [{
      template: { id: 'shared-gateway', name: 'Shared' },
      api_key: 'shared-secret',
      credentialRef: 'DSH_LAUNCHER_SHARED_GATEWAY_API_KEY',
      profile: gatewayProfile({ models: [{ id: 'alpha' }] }),
    }];
    const snapshot = JSON.stringify(entries);
    await importProviders(runtime, first, entries);
    assert.equal(JSON.stringify(entries), snapshot, 'import must not mutate the caller entry');
    await importProviders(runtime, second, entries);

    const hasRoute = async home => (await readProviders(runtime, home)).routes.some(route => route.id === 'shared-gateway');
    for (const home of [first, second]) {
      assert.ok(await hasRoute(home), 'the reused template must appear in both Homes');
      assert.match(
        await readFile(join(home, '.credentials.yaml'), 'utf8'),
        /DSH_LAUNCHER_SHARED_GATEWAY_API_KEY: shared-secret/,
        'each Home gets its own credential record',
      );
    }

    // 共享的是模板，不是落库结果：从一个 Home 删掉不能波及另一个。
    const removal = { entries: [], removals: ['shared-gateway'], defaultModel: null };
    const preview = await planProviderOperations(runtime, first, undefined, removal);
    await applyProviderOperations(runtime, first, undefined, { ...removal, digest: preview.digest, fingerprint: preview.fingerprint });
    assert.equal(await hasRoute(first), false, 'the route should be gone from the edited Home');
    assert.ok(await hasRoute(second), 'removing from one Home must not touch the other');
    // 删除同样不删凭据值。
    assert.match(await readFile(join(first, '.credentials.yaml'), 'utf8'), /shared-secret/);
  } finally {
    await rm(first, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(second, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * 前端的契约类型是对本脚本产物的**手写断言**：TS 在运行时不存在，所以这里改个键名，
 * `provider-contracts.ts` 不会报错，界面会安静地读到 `undefined`。
 * 反过来以 TS 文件为准逐字段核对真实产物，而不是在测试里另抄一份键名清单
 * ——抄一份就等于再造一个会漂移的真相来源。
 * 限制：只核对顶层**必需**字段（可选字段允许缺席），不下钻内联嵌套对象。
 */
test('read-back and plan JSON carry exactly the keys the frontend types require', { skip: !runtime }, async () => {
  const source = readFileSync(new URL('../../../src/components/provider-contracts.ts', import.meta.url), 'utf8');
  const requiredFieldsOf = name => {
    const block = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `provider-contracts.ts must still declare interface ${name}`);
    return [...block[1].matchAll(/^ {2}(\w+)(\?)?:/gm)].filter(match => !match[2]).map(match => match[1]);
  };
  const carries = (label, required, produced) => assert.deepEqual(
    required.filter(key => !(key in produced)),
    [],
    `${label} must expose every field its TypeScript type requires`,
  );

  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-contract-'));
  try {
    await writeFile(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\n      models:\n        - id: chat\nagent-default-model:\n  provider: deepseek\n  model: chat\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_LAUNCHER_DEEPSEEK_API_KEY: k\n');

    const view = await readProviders(runtime, home);
    carries('read_instance_providers', requiredFieldsOf('InstanceProviderView'), view);
    assert.ok(view.routes.length > 0, 'the fixture must produce at least one route to inspect');
    carries('a provider route', requiredFieldsOf('ProviderRouteView'), view.routes[0]);
    carries('a route model view', requiredFieldsOf('ProviderModelView'), view.routes[0].models[0]);

    const response = await planProviderOperations(runtime, home, undefined, { entries: [], removals: ['deepseek'], defaultModel: 'clear' });
    carries('plan_instance_provider_change', requiredFieldsOf('PlanResponse'), response);
    // 共享影响由 Rust 依注册表注入（见 IPC_CONTRACTS.md），不在这份脚本产物里。
    // 反过来断言它缺席：免得有一天脚本和宿主各算一套"谁会被影响"。
    carries('the change plan', requiredFieldsOf('ProviderPlan').filter(key => key !== 'sharing'), response.plan);
    assert.ok(!('sharing' in response.plan), 'sharing impact must be computed by the host, never by the script');
    carries('a route change', requiredFieldsOf('RouteChange'), response.plan.changes[0]);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * 声明了引用却没带密钥，写出来就是悬空引用：settings.yaml 指向凭据文件里不存在的名字，
 * 要等到真正发请求时才失败。宿主侧本来保证这条不成立，但那个保证跨过了一次键名边界
 * （`api_key` 蛇形、`credentialRef` 驼峰）。这里直接模拟命名漂移后的产物，要求写入端
 * 和预览端都拒绝——预览能渲染出一份 apply 会拒的计划，本身就是另一种不一致。
 */
test('an entry declaring a reference without a key is refused by both the writer and the preview', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-dangling-'));
  const entry = () => [{
    template: { id: 'deepseek', name: 'DeepSeek' },
    credentialRef: 'DSH_LAUNCHER_DEEPSEEK_API_KEY',
    profile: gatewayProfile({ apiKeyEnv: 'DSH_LAUNCHER_DEEPSEEK_API_KEY' }),
  }];
  try {
    await writeFile(join(home, 'settings.yaml'), 'other: keep-me\n');
    const before = await readFile(join(home, 'settings.yaml'), 'utf8');

    await assert.rejects(importProviders(runtime, home, entry()), /PROVIDER_KEY_REQUIRED/);
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), before, 'a refused import must not touch the settings document');

    await assert.rejects(
      planProviderOperations(runtime, home, undefined, { entries: entry(), removals: [], defaultModel: null }),
      /PROVIDER_KEY_REQUIRED/,
      'the preview must refuse exactly what the writer refuses',
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * 既有用例触发的中止是"文件被改动过"，从来没单独验过另一个输入：**模板本身在预览之后变了**
 * （用户在模板库里编辑了同一条模板，而实例的 settings.yaml 一字未动）。
 * 这里刻意让 fingerprint 保持有效、只换掉 entry，证明摘要挡住的是"预览的那件事"，
 * 不只是"那份文件"。
 */
test('a template that changed after the preview aborts the apply even if the file never moved', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-template-drift-'));
  try {
    await writeFile(join(home, 'settings.yaml'), '# untouched throughout\nother: keep\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\n');
    const before = await readFile(join(home, 'settings.yaml'), 'utf8');
    const entry = displayName => [{
      template: { id: 'drift-gateway', name: displayName },
      api_key: 'k',
      credentialRef: 'DSH_LAUNCHER_DRIFT_GATEWAY_API_KEY',
      profile: gatewayProfile({ displayName }),
    }];

    const preview = await planProviderOperations(runtime, home, undefined, { entries: entry('原始名'), removals: [], defaultModel: null });
    // 模板库里被改成了别的名字；文件与凭据文档都没动，所以 fingerprint 依旧有效。
    const drift = { entries: entry('预览后被改过的名字'), removals: [], defaultModel: null };
    await assert.rejects(
      applyProviderOperations(runtime, home, undefined, { ...drift, digest: preview.digest, fingerprint: preview.fingerprint }),
      /PROVIDER_SETTINGS_CHANGED/,
      'a stale digest from a drifted template must abort even with a valid fingerprint',
    );
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), before, 'an aborted apply must not create the route');
    assert.ok(!before.includes('drift-gateway'));
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * 回读 → 编辑 → 原样应用必须是**真正的空操作**：预览报 0 项变更、`settings.yaml` 逐字节不变。
 * 这条此前没有测试，而它防的是最坏的一类静默数据丢失 —— 用户只是打开编辑器又点了应用。
 * 关键在模型条目：回读交出模板拥有的白名单键（包括 contextWindow），但不交出
 * `temperature` 等原生扩展。写入按 id 保留外部字段，不能把它们抹掉。
 * 先跑真实代码确认了行为，再把断言写死。
 */
test('reading back and re-applying unchanged config is a byte-identical no-op', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-roundtrip-'));
  try {
    const initial = [
      '# leading comment must survive',
      'other:',
      '  value: keep-me',
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      displayName: DeepSeek',
      '      apiKeyEnv: DSH_LAUNCHER_DEEPSEEK_API_KEY',
      '      models:',
      '        - id: chat',
      '          contextWindow: 64000',
      '          temperature: 0.4',
      '        - id: coder',
      '      headers:',
      '        X-Tenant: acme',
      '      unknownNativeOption: preserved-me',
      '',
    ].join('\n');
    await writeFile(join(home, 'settings.yaml'), initial);
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_LAUNCHER_DEEPSEEK_API_KEY: k\n');

    const view = await readProviders(runtime, home);
    const route = view.routes.find(item => item.id === 'deepseek');
    assert.deepEqual(route.modelIds, ['chat', 'coder']);
    // 原生模型选项与请求头一律不外泄：回读只有白名单键。
    const shipped = JSON.stringify(view);
    assert.ok(!shipped.includes('temperature'), 'per-model native options must not cross to the frontend');
    assert.ok(!shipped.includes('acme'), 'header values must not cross to the frontend');
    assert.ok(!shipped.includes('preserved-me'), 'foreign field values must not cross to the frontend');
    assert.deepEqual(route.unknownFields, ['headers', 'unknownNativeOption']);

    // 与编辑器 buildTemplate 一致：把回读到的自有模型字段原样带回。
    const profile = {
      displayName: route.displayName,
      apiKeyEnv: route.credential.ref,
      models: route.models,
    };
    const operations = {
      entries: [{ template: { id: 'deepseek', name: 'DeepSeek' }, api_key: null, credentialMode: 'keep', credentialRef: route.credential.ref, profile }],
      removals: [], defaultModel: null,
    };
    const preview = await planProviderOperations(runtime, home, undefined, operations);
    assert.deepEqual(preview.plan.changes[0].fields, [], 'an untouched edit must not be previewed as a change');

    await applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint });
    const after = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.equal(after, initial, 'applying an unchanged route must leave settings.yaml byte-identical');
    // 显式确认这些确实还在：注释、外部段落、路由外字段、以及没被回读交出的原生模型选项。
    assert.match(after, /^# leading comment must survive/);
    assert.match(after, /value: keep-me/);
    assert.match(after, /unknownNativeOption: preserved-me/);
    assert.match(after, /X-Tenant: acme/);
    assert.match(after, /temperature: 0\.4/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('model options can be explicitly cleared while foreign nested fields stay private and preserved', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-model-clear-'));
  try {
    await writeFile(join(home, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      displayName: DeepSeek',
      '      models:',
      '        - id: chat',
      '          contextWindow: 64000',
      '          temperature: 0.4',
      '',
    ].join('\n'));
    const operations = {
      entries: [{
        template: { id: 'deepseek', name: 'DeepSeek' }, credentialMode: 'none', credentialRef: '', api_key: null,
        profile: { displayName: 'DeepSeek', models: [{ id: 'chat' }] },
      }],
      removals: [], defaultModel: null,
    };
    const preview = await planProviderOperations(runtime, home, undefined, operations);
    const serialized = JSON.stringify(preview);
    assert.ok(!serialized.includes('temperature'), 'foreign nested field names and values must not cross to the frontend');
    assert.deepEqual(preview.plan.changes[0].fields.find(item => item.field === 'models')?.to, [{ id: 'chat' }]);
    await applyProviderOperations(runtime, home, undefined, { ...operations, digest: preview.digest, fingerprint: preview.fingerprint });
    const after = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.doesNotMatch(after, /contextWindow:/, 'clearing an owned option must remove it');
    assert.match(after, /temperature: 0\.4/, 'foreign nested options must remain on disk');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an old preview cannot apply a different credential value', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-key-intent-'));
  try {
    await writeFile(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    deepseek:\n      displayName: DeepSeek\n      apiKeyEnv: DSH_LAUNCHER_DEEPSEEK_API_KEY\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_LAUNCHER_DEEPSEEK_API_KEY: original-test-key\n');
    const operation = key => ({
      entries: [{
        template: { id: 'deepseek', name: 'DeepSeek' }, credentialMode: 'replace', credentialRef: 'DSH_LAUNCHER_DEEPSEEK_API_KEY', api_key: key,
        profile: { displayName: 'DeepSeek', apiKeyEnv: 'DSH_LAUNCHER_DEEPSEEK_API_KEY' },
      }],
      removals: [], defaultModel: null,
    });
    const preview = await planProviderOperations(runtime, home, undefined, operation('preview-test-key'));
    await assert.rejects(
      applyProviderOperations(runtime, home, undefined, { ...operation('changed-after-preview'), digest: preview.digest, fingerprint: preview.fingerprint }),
      /PROVIDER_SETTINGS_CHANGED/,
    );
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /original-test-key/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * 界面对"由后端决定的码值"全部走动态拼 key：t(`providers.error.${group}`)、
 * t(`providers.add.limitation.${code}`)、t(`providers.change.${kind}`)、
 * t(`providers.credential_action.${action}`)。静态扫 t('字面量') 看不见这类调用，
 * 少一条文案也不会报错——它会把 PROVIDER_CATALOG_AUTH_UNSUPPORTED 这种原始码值
 * 直接印到用户面前。这里反过来**从产码的一方抽值域**（Rust 的判定函数、TS 的联合、
 * 错误码分组表），再要求中英两份 locale 都有对应键；测试里不另抄一份清单。
 * 反向也查：码值已经删掉、文案却还留着的那些。
 * 不碰运行时，所以永远参与运行，不会被 skip 掩盖。
 */
test('every dynamically composed provider label has copy in both locales', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const locales = ['zh-CN', 'en-US'].map(name => JSON.parse(read(`../../../src/i18n/locales/${name}.json`)));
  const has = key => locales.every(copy => Object.prototype.hasOwnProperty.call(copy, key));

  const groups = [...read('../../../src/utils/provider-error.ts').matchAll(/^ {4}([a-z]+): \[/gm)].map(match => match[1]);
  assert.ok(groups.length > 10, 'the error-group table must still be the single source of code mapping');
  for (const group of groups)
    assert.ok(has(`providers.error.${group}`), `group ${group} has no providers.error.${group} copy`);

  const rust = read('./providers.rs');
  const decided = rust.indexOf('pub fn judge_catalog_provider');
  assert.ok(decided >= 0, 'judge_catalog_provider must still be the one deciding the reason code');
  const verdict = rust.slice(decided, rust.indexOf('\n}\n', decided));
  const codes = [...new Set([...verdict.matchAll(/"(PROVIDER_CATALOG_[A-Z_]+)"/g)].map(match => match[1]))];
  assert.ok(codes.length >= 4, 'the gate must still emit one reason code per unmet condition');
  for (const code of codes)
    assert.ok(has(`providers.add.limitation.${code}`), `limitation ${code} has no copy`);
  const prefix = 'providers.add.limitation.';
  const orphans = Object.keys(locales[0])
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length))
      .filter(code => !codes.includes(code));
  assert.deepEqual(orphans, [], 'copy remains for a code the gate no longer emits');

  const contracts = read('../../../src/components/provider-contracts.ts');
  const routeChange = contracts.slice(contracts.indexOf('export interface RouteChange'));
  const kinds = (routeChange.match(/^\s+kind: (.*)$/m)?.[1] ?? '')
      .split("'")
      .filter((_, index) => index % 2 === 1);
  assert.ok(kinds.length >= 5, 'RouteChange.kind must still enumerate every preview state');
  for (const kind of kinds)
    assert.ok(has(`providers.change.${kind}`), `change kind ${kind} has no copy`);

  const actions = (contracts.match(/^export type CredentialAction = (.*)$/m)?.[1] ?? '')
      .split("'")
      .filter((_, index) => index % 2 === 1);
  assert.ok(actions.length >= 4, 'CredentialAction must still be a union of literals');
  for (const action of actions)
    assert.ok(has(`providers.credential_action.${action}`), `credential action ${action} has no copy`);
});
