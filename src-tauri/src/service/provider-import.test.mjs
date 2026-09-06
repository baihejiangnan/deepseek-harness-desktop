import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importProviders, commitProviderDocuments } from './provider-import.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const runtime = process.env.DSH_TEST_ENTRY;
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
  } finally { await rm(home, { recursive: true }); }
});
const example = () => [{ template: { id: 'test-gateway', name: 'Test', baseUrl: 'https://example.com/v1', protocol: 'openai-completions', modelId: 'test-model' }, api_key: 'test-only-secret' }];

test('native DSH recovers from a disabled broken plugin and reaches authenticated Web readiness after provider import', { skip: !runtime, timeout: 75000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-boot-'));
  let child;
  try {
    const profile = join(home, 'profiles', 'tauri');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-boot', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const importedEntries = example();
    importedEntries[0].template.models = [{ id: 'first-model' }, { id: 'second-model', contextWindow: 64000 }];
    await importProviders(runtime, home, importedEntries, false, 'tauri');
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
  } finally {
    if (child && child.exitCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
    await rm(home, { recursive: true });
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
  } finally { await rm(home, { recursive: true }); }
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
    await rm(home, { recursive: true });
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
    entries.push({ ...example()[0], template: { ...example()[0].template, id: 'second', protocol: 'not-supported' } });
    await assert.rejects(importProviders(runtime, home, entries), /PROVIDER_PROTOCOL_UNSUPPORTED/);
    assert.equal(await readFile(keyPath, 'utf8'), credentials);
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), settings);
  } finally {
    await rm(home, { recursive: true });
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
    await rm(home, { recursive: true });
  }
});

test('DSH import preserves unrelated settings and credentials, rejects conflicts, and explicitly replaces a route', { skip: !runtime }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-import-'));
  try {
    await writeFile(join(home, 'settings.yaml'), '# keep comment\nother:\n  value: keep\n');
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  EXISTING_KEY: preserve\n');
    const entries = [{ template: { id: 'test-gateway', name: 'Test', baseUrl: 'https://example.com/v1', protocol: 'openai-completions', models: [{ id: 'first', contextWindow: 64000 }, { id: 'second' }] }, api_key: 'test-only-secret' }];
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
    entries[0].template.models = [{ id: 'second' }, { id: 'third' }];
    await importProviders(runtime, home, entries, true);
    const updated = await readFile(join(home, 'settings.yaml'), 'utf8');
    assert.match(updated, /displayName: Updated/);
    assert.match(updated, /id: third/);
    assert.doesNotMatch(updated, /id: first/);
  } finally {
    await rm(home, { recursive: true });
  }
});
