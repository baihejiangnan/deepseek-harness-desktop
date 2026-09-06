// Runs with the selected DSH Node and modules. Input and keys arrive on stdin.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, extname, dirname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Caller holds both native file locks throughout commit and rollback. */
export async function commitProviderDocuments(writeAtomic, settingsPath, keyPath, settings, keys, oldKeys) {
  await writeAtomic(keyPath, keys, { mode: 0o600 });
  try {
    await writeAtomic(settingsPath, settings, { mode: 0o600 });
  } catch (error) {
    await writeAtomic(keyPath, oldKeys ?? 'version: 1\nrefs: {}\n', { mode: 0o600 });
    throw error;
  }
}

export async function importProviders(entry, home, entries, overwrite = false, profile) {
  const require = createRequire(entry);
  const load = async name => import(pathToFileURL(require.resolve(name)).href);
  const { supportedProtocols } = await load('@deepseek-ai/dsh-llm-pi-ai');
  const { withFileLock, writeFileAtomic } = await load('@deepseek-ai/dsh-atomic-write');
  const yaml = createRequire(require.resolve('@deepseek-ai/dsh-settings-file'))('yaml');
  let settingsPath = join(home, 'settings.yaml');
  let keyPath = join(home, '.credentials.yaml');
  if (profile) {
    let tree;
    try {
      // Public boot-free CLI composition: never evaluate plugin JavaScript to find paths.
      const dump = execFileSync(process.execPath, [entry, '--profile', profile, '--dump-config'], {
        env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const document = yaml.parseDocument(dump);
      if (document.errors.length) throw new Error();
      tree = document.toJS();
    } catch { throw new Error('PROVIDER_PROFILE_PROBE_FAILED'); }
    if (!Array.isArray(tree)) throw new Error('PROVIDER_PROFILE_UNSUPPORTED');
    const node = name => {
      const matches = tree.filter(item => item?.name === name && !item.disabled);
      if (matches.length !== 1) throw new Error('PROVIDER_PROFILE_UNSUPPORTED');
      return matches[0].config ?? {};
    };
    const location = (config, fallback) => {
      if (config.path != null && typeof config.path !== 'string') throw new Error('PROVIDER_PROFILE_UNSUPPORTED');
      if (config.dshHome != null && typeof config.dshHome !== 'string') throw new Error('PROVIDER_PROFILE_UNSUPPORTED');
      const path = resolve(config.path ?? join(config.dshHome ?? home, fallback));
      const inside = relative(resolve(home), path);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('PROVIDER_PATH_OUTSIDE_HOME');
      return path;
    };
    node('@deepseek-ai/dsh-llm-pi-ai');
    settingsPath = location(node('@deepseek-ai/dsh-settings-file'), 'settings.yaml');
    keyPath = location(node('@deepseek-ai/dsh-credentials-local'), '.credentials.yaml');
    if (!['.yaml', '.yml', '.json'].includes(extname(settingsPath).toLowerCase()) || settingsPath === keyPath) throw new Error('PROVIDER_PROFILE_UNSUPPORTED');
  }
  const read = async path => {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('PROVIDER_SYMLINK_UNSUPPORTED');
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const parse = text => {
    const doc = yaml.parseDocument(text ?? '{}', { uniqueKeys: true });
    if (!doc.errors.length && doc.contents === null) doc.contents = doc.createNode({});
    if (doc.errors.length || doc.warnings.length || !yaml.isMap(doc.contents)) throw new Error('PROVIDER_DOCUMENT_INVALID');
    return doc;
  };
  await mkdir(home, { recursive: true });
  // Reject redirected ancestors before creating native lock files or documents.
  for (const file of [settingsPath, keyPath]) {
    let directory = dirname(resolve(file));
    const root = resolve(home);
    for (;;) {
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink()) throw new Error('PROVIDER_SYMLINK_UNSUPPORTED');
        if (!info.isDirectory()) throw new Error('PROVIDER_DOCUMENT_INVALID');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (directory === root || directory === dirname(directory)) break;
      directory = dirname(directory);
    }
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  await mkdir(dirname(keyPath), { recursive: true });
  return withFileLock(settingsPath, () => withFileLock(keyPath, async () => {
    const oldSettings = await read(settingsPath);
    const oldKeys = await read(keyPath);
    const settings = parse(oldSettings);
    const keys = parse(oldKeys);
    if (keys.contents.items.some(item => !['version', 'refs', 'records'].includes(String(item.key)))) throw new Error('PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED');
    for (const field of ['refs', 'records']) {
      if (keys.has(field) && !yaml.isMap(keys.get(field, true))) throw new Error('PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED');
    }
    if (keys.has('version') && keys.get('version') !== 1) throw new Error('PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED');
    if (oldKeys && !keys.has('version') && keys.contents.items.length) throw new Error('PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED');
    for (const { template, api_key: key } of entries) {
      if (!supportedProtocols().includes(template.protocol)) throw new Error('PROVIDER_PROTOCOL_UNSUPPORTED');
      const path = ['llm-pi-ai', 'providers', template.id];
      const ref = `DSH_LAUNCHER_${template.id.replaceAll('-', '_').toUpperCase()}_API_KEY`;
      if (!overwrite && (settings.hasIn(path) || keys.hasIn(['refs', ref]))) throw new Error('PROVIDER_ID_CONFLICT');
      if (settings.hasIn(path) && !yaml.isMap(settings.getIn(path, true))) throw new Error('PROVIDER_DOCUMENT_INVALID');
      for (const [field, value] of Object.entries({ displayName: template.name, baseURL: template.baseUrl, api: template.protocol, apiKeyEnv: ref })) settings.setIn([...path, field], value);
      const models = template.models?.length ? template.models : [{ id: template.modelId }];
      const ids = new Set();
      for (const model of models) {
        if (typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) throw new Error('PROVIDER_MODEL_INVALID');
        ids.add(model.id);
      }
      const previous = settings.getIn([...path, 'models'], true)?.toJSON();
      // Replace the selection, retaining advanced native options for retained models.
      settings.setIn([...path, 'models'], models.map(model => ({
        ...(Array.isArray(previous) ? previous.find(item => item.id === model.id) : {}), ...model,
      })));
      keys.set('version', 1);
      keys.setIn(['refs', ref], key);
    }
    // Credentials first: a failed settings write leaves no provider with a missing key.
    // Roll back credentials while holding both DSH-native locks on failure.
    const content = extname(settingsPath).toLowerCase() === '.json' ? `${JSON.stringify(settings.toJSON(), null, 2)}\n` : String(settings);
    await commitProviderDocuments(writeFileAtomic, settingsPath, keyPath, content, String(keys), oldKeys);
    return { imported: entries.map(entry => entry.template.id) };
  }));
}

if (process.argv[1] === '--launcher-provider-import') {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const result = await importProviders(request.entry, request.home, request.entries, request.overwrite, request.profile);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Never echo arbitrary module errors: they may embed document contents or keys.
    process.stderr.write(/^PROVIDER_[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_IMPORT_FAILED');
    process.exitCode = 1;
  }
}
