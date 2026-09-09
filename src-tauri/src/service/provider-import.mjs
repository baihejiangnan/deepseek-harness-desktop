// Runs with the selected DSH Node and modules. Input and keys arrive on stdin.
import { createHash } from 'node:crypto';
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

/**
 * 路径解析 + 文档读写通道。导入与回读必须共用这一处定义：它同时是
 * "配置只能在 Home 内"、"拒绝符号链接"、"凭据文档形态是否认识"这些安全规则的唯一出处。
 */
export async function openProviderDocuments(entry, home, profile) {
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
  return { yaml, withFileLock, writeFileAtomic, supportedProtocols, settingsPath, keyPath, read, parse };
}

export async function importProviders(entry, home, entries, overwrite = false, profile) {
  const { yaml, withFileLock, writeFileAtomic, supportedProtocols, settingsPath, keyPath, read, parse } = await openProviderDocuments(entry, home, profile);
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
    for (const entry of entries) mergeRoute({ yaml, settings, keys, entry, overwrite, supportedProtocols })
    // Credentials first: a failed settings write leaves no provider with a missing key.
    // Roll back credentials while holding both DSH-native locks on failure.
    const content = extname(settingsPath).toLowerCase() === '.json' ? `${JSON.stringify(settings.toJSON(), null, 2)}\n` : String(settings);
    await commitProviderDocuments(writeFileAtomic, settingsPath, keyPath, content, String(keys), oldKeys);
    return { imported: entries.map(entry => entry.template.id) };
  }));
}

/** 模板自己拥有的字段；其余键一律只读展示，且不回传值。 */
const TEMPLATE_OWNED_FIELDS = ['displayName', 'apiKeyEnv', 'api', 'baseURL', 'models', 'modelOverrides'];

/** 模型条目里只有这几个键可以由模板调整、且不含敏感值；其余原生选项一律不回传，只在写入时按 id 原地保留。 */
function ownedModelOptions(model) {
  const options = {};
  if (typeof model.name === 'string' && model.name !== '') options.name = model.name;
  if (Number.isFinite(model.contextWindow)) options.contextWindow = model.contextWindow;
  if (Number.isFinite(model.maxTokens)) options.maxTokens = model.maxTokens;
  return options;
}

/** 把 `models` / `modelOverrides` 收敛成同一种形状：`{ id, ...自有选项 }`。 */
function ownedModelList(value) {
  if (Array.isArray(value)) {
    return value
      .filter(model => model && typeof model === 'object' && typeof model.id === 'string' && model.id !== '')
      .map(model => ({ id: model.id, ...ownedModelOptions(model) }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([id, override]) => id !== '' && override && typeof override === 'object' && !Array.isArray(override))
      .map(([id, override]) => ({ id, ...ownedModelOptions(override) }));
  }
  return [];
}

/**
 * 读回实例里**可识别的**服务商配置。插件可在运行时注册路由，无法从文件枚举，
 * 因此调用方不得把它当成实例实际可用的全部服务商。
 */
export async function readProviders(entry, home, profile) {
  const { withFileLock, settingsPath, keyPath, read, parse } = await openProviderDocuments(entry, home, profile);
  return withFileLock(settingsPath, () => withFileLock(keyPath, async () => {
    const rawSettings = await read(settingsPath);
    const rawKeys = await read(keyPath);
    const settings = parse(rawSettings);
    const keys = parse(rawKeys);
    if (keys.contents.items.some(item => !['version', 'refs', 'records'].includes(String(item.key)))) throw new Error('PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED');
    const tree = settings.toJSON() ?? {};
    const providers = tree?.['llm-pi-ai']?.providers;
    const refs = keys.toJSON()?.refs;
    const refNames = refs && typeof refs === 'object' ? Object.keys(refs) : [];
    const routes = Object.entries(providers && typeof providers === 'object' ? providers : {}).map(([id, declared]) => {
      const value = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : {};
      const declaredRef = typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : '';
      // 有 models 即限定清单；没有才是跟随目录（此时单模型调整落在 modelOverrides）。
      const models = ownedModelList(value.models);
      const overrides = ownedModelList(value.modelOverrides);
      return {
        id,
        displayName: typeof value.displayName === 'string' ? value.displayName : '',
        // 字段名可以交出，值不行：headers 之类可能携带令牌。
        configuredFields: Object.keys(value).filter(field => TEMPLATE_OWNED_FIELDS.includes(field)),
        unknownFields: Object.keys(value).filter(field => !TEMPLATE_OWNED_FIELDS.includes(field)),
        protocol: typeof value.api === 'string' ? value.api : '',
        baseUrl: typeof value.baseURL === 'string' ? value.baseURL : '',
        modelIds: models.map(model => model.id),
        models,
        overrides,
        selection: models.length ? 'subset' : 'all',
        credential: {
          declared: declaredRef !== '',
          ref: declaredRef,
          // 进程 env 与 cwd/.env 在这一层不可见：引用查不到只能判"不可核实"，不能判缺失。
          source: declaredRef === '' ? 'ambient' : (refNames.includes(declaredRef) ? 'file' : 'unverifiable'),
        },
      };
    });
    const known = new Set(routes.map(route => route.id));
    const defaultModel = tree?.['agent-default-model'];
    const source = defaultModel && typeof defaultModel === 'object' ? defaultModel : {};
    const defaultProvider = String(source.provider ?? '');
    const defaultId = String(source.model ?? '');
    return {
      routes,
      // 只报告"还存在哪些顶层段落"的名字，供上层判断是否有别的凭据承载点；不报告内容。
      topSections: Object.keys(tree).filter(section => section !== 'llm-pi-ai' && section !== 'agent-default-model'),
      credentialRefs: refNames,
      // 仅报告，绝不自动清理：其他段落或插件可能正在用同一个引用。
      unreferencedCredentialRefs: refNames.filter(name => !routes.some(route => route.credential.ref === name)),
      defaultModel: {
        declared: defaultProvider !== '' || defaultId !== '',
        provider: defaultProvider,
        model: defaultId,
        // 该段的 schema 允许 reasoningEffort，缺省即"用服务商/默认行为"。
        reasoningEffort: typeof source.reasoningEffort === 'string' ? source.reasoningEffort : '',
        // 命中已识别路由才叫 known；否则 unconfirmed（可能是运行时注册的插件路由），不判失效。
        providerStatus: defaultProvider === '' ? 'unset' : (known.has(defaultProvider) ? 'known' : 'unconfirmed'),
        modelStatus: defaultId === '' ? 'unset' : (known.has(defaultProvider) && routes.find(route => route.id === defaultProvider)?.modelIds.includes(defaultId) ? 'known' : 'unconfirmed'),
      },
      // 并发校验指纹：只覆盖纳入检查的两个文档与解析出的实际路径。
      fingerprint: createHash('sha256').update([rawSettings ?? '', rawKeys ?? '', settingsPath, keyPath].join('\0---\0')).digest('hex'),
      settingsFormat: extname(settingsPath).toLowerCase() === '.json' ? 'json' : 'yaml',
    };
  }));
}

/** 模板自有的字段：只有这些会被写入或取消钉死，其余键原样保留。 */
const OWNED_FIELDS = ['displayName', 'apiKeyEnv', 'api', 'baseURL', 'models', 'modelOverrides'];

/** 路由当前声明的凭据引用名；没声明就是空串（走服务商环境认证）。 */
function declaredRef(previous) {
  return typeof previous?.apiKeyEnv === 'string' ? previous.apiKeyEnv : '';
}

/**
 * 凭据三态下真正要落盘的 profile。
 * `keep` 必须把文档里现有的引用原样带回来：启动器侧不知道这个名字，
 * 而不带回来就会被下面的自有字段清理当成"模板不再声明"删掉。
 */
function effectiveProfile(entry, previous) {
  const key = typeof entry.api_key === 'string' ? entry.api_key.trim() : '';
  // 声明了引用却拿不到可用的密钥，写出来的就是一个悬空引用：settings.yaml 指向凭据
  // 文件里不存在的名字，要等到真正发请求时才以 MISSING_CREDENTIAL 失败。宿主侧
  // `provider_planned_entry` 本来保证"声明引用 ⇒ 带密钥"，但那条保证跨过了一次键名
  // 边界（`api_key` 是蛇形、`credentialRef` 是驼峰）。这里把同一个约束在写入端也钉住：
  // 命名哪天漂了要当场报错，而不是悄悄留下一个把用户坑到运行期的引用。
  if (typeof entry.profile?.apiKeyEnv === 'string' && entry.profile.apiKeyEnv !== '' && key === '' && entry.credentialMode !== 'keep')
    throw new Error('PROVIDER_KEY_REQUIRED');
  if (entry.credentialMode !== 'keep') return entry.profile;
  const kept = declaredRef(previous);
  return kept === '' ? entry.profile : { ...entry.profile, apiKeyEnv: kept };
}

/** 预览里的凭据变化：只报动作与引用名，绝不报值。 */
function credentialChange(entry, previous, credentialRefs) {
  const { api_key: key, credentialRef: ref, credentialMode } = entry;
  const declared = declaredRef(previous);
  if (credentialMode === 'keep') return declared === '' ? null : { ref: declared, action: 'keep' };
  // 显式取消引用，或压根没带密钥（此时启动器已把 apiKeyEnv 从 profile 摘掉）：
  // 引用会从路由上摘除，但凭据值一律不删——别的段落或插件可能还在用同一个引用。
  if (credentialMode === 'none' || !key) return declared === '' ? null : { ref: declared, action: 'remove' };
  if (!ref) return null;
  // 显式替换：用户刚填了新密钥，值一定会被写，哪怕引用名没变。
  if (credentialMode === 'replace') return { ref, action: credentialRefs.includes(ref) ? 'replace' : 'add' };
  // 未声明模式（模板库导入）：引用名没变就当作保持不变，避免每次导入都报"将替换密钥"。
  return { ref, action: credentialRefs.includes(ref) ? (declared === ref ? 'keep' : 'replace') : 'add' };
}

/**
 * `models` 的合并规则：清单整体替换，但仍在清单里的模型保留它原有的原生高级选项。
 * 单独抽出来是因为预览必须报"合并后会是什么样"，而不是"调用方递交了什么"。
 */
const OWNED_MODEL_FIELDS = ['id', 'name', 'contextWindow', 'maxTokens'];

function mergedModel(previous, next) {
  const merged = { ...(previous && typeof previous === 'object' ? previous : {}) };
  for (const field of OWNED_MODEL_FIELDS) {
    if (field in next)
      merged[field] = next[field];
    else
      delete merged[field];
  }
  return merged;
}

function publicModel(model) {
  const result = {};
  if (!model || typeof model !== 'object') return result;
  for (const field of OWNED_MODEL_FIELDS) {
    if (field in model) result[field] = model[field];
  }
  return result;
}

function publicModelValue(field, value) {
  if (field === 'models')
    return Array.isArray(value) ? value.map(publicModel) : value;
  if (field === 'modelOverrides' && value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).map(([id, model]) => [id, publicModel(model)]));
  return value;
}

function mergedModels(previous, next) {
  const before = Array.isArray(previous) ? previous : [];
  return next.map(model => mergedModel(before.find(item => item?.id === model.id), model));
}

/**
 * `modelOverrides` 的合并规则：按模型 id 逐条并入，本次没提到的旧条目原样留下。
 * 所以"切到跟随目录全部"不会清掉别的模型上已有的调整。
 */
function mergedOverrides(previous, next) {
  const before = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const merged = { ...before };
  for (const [id, override] of Object.entries(next)) {
    const old = before[id] && typeof before[id] === 'object' ? before[id] : {};
    merged[id] = mergedModel(old, override);
  }
  return merged;
}

/**
 * 某个自有字段**合并后真正会落盘的值**；`undefined` 表示该字段会被删掉。
 * 预览与写入共用这一份定义，否则两边会对同一个字段各说一套。
 */
function mergedValue(field, from, to) {
  if (to === undefined)
    return undefined;
  if (field === 'models' && Array.isArray(to))
    return mergedModels(from, to);
  if (field === 'modelOverrides' && typeof to === 'object')
    return mergedOverrides(from, to);
  return to;
}

/** 把一条模板声明合并进 YAML Document。导入与预览应用共用，避免两套合并语义。 */
export function mergeRoute({ yaml, settings, keys, entry, overwrite, supportedProtocols }) {
  const { template, api_key: key, credentialRef: ref } = entry;
  const path = ['llm-pi-ai', 'providers', template.id];
  // 字段归属在 Rust 侧定义；这里只做一致性守卫：运行时要真的说得出这个协议。
  if (entry.profile.api && !supportedProtocols().includes(entry.profile.api)) throw new Error('PROVIDER_PROTOCOL_UNSUPPORTED');
  if (!overwrite && (settings.hasIn(path) || (ref && keys.hasIn(['refs', ref])))) throw new Error('PROVIDER_ID_CONFLICT');
  if (settings.hasIn(path) && !yaml.isMap(settings.getIn(path, true))) throw new Error('PROVIDER_DOCUMENT_INVALID');
  const profile = effectiveProfile(entry, settings.hasIn(path) ? settings.getIn(path, true).toJSON() : null);
  // deleteIn 在中间节点缺失时会抛错，所以只在 route 与字段都真实存在时才删。
  if (settings.hasIn(path)) {
    for (const field of OWNED_FIELDS) {
      if (!(field in profile) && settings.hasIn([...path, field])) settings.deleteIn([...path, field]);
    }
  }
  for (const [field, value] of Object.entries(profile)) {
    if (field === 'models' || field === 'modelOverrides') continue;
    settings.setIn([...path, field], value);
  }
  if (Array.isArray(profile.models)) {
    const ids = new Set();
    for (const model of profile.models) {
      if (typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) throw new Error('PROVIDER_MODEL_INVALID');
      ids.add(model.id);
    }
    // Replace the selection, retaining advanced native options for retained models.
    settings.setIn([...path, 'models'], mergedModels(settings.getIn([...path, 'models'], true)?.toJSON(), profile.models));
  }
  if (profile.modelOverrides)
    settings.setIn([...path, 'modelOverrides'], mergedOverrides(settings.getIn([...path, 'modelOverrides'], true)?.toJSON(), profile.modelOverrides));
  keys.set('version', 1);
  // 没有密钥就不写引用；反过来，模板取消引用时也不删已有凭据（默认不自动清理）。
  if (ref && key) keys.setIn(['refs', ref], key);
}

/** 计划摘要：应用时用它确认"要做的事"和用户预览过的是同一件。 */
function planDigest(plan, entries) {
  // 摘要还绑定凭据写入意图。返回的是单向摘要，密钥值本身从不进入响应。
  return createHash('sha256').update(JSON.stringify({ plan, entries })).digest('hex');
}

/**
 * 变更预览。只依据当前文档与启动器算好的 profile 推差异，不接受前端提交的 diff；
 * 值只涉及模板自有字段（不含凭据与请求头），因此可以安全展示。
 * 差异必须按 `effectiveProfile` 算，否则预览会与 mergeRoute 实际写入的不一致。
 */
export function buildPlan({ providers, entries = [], removals = [], defaultModel = null, credentialRefs = [], settingsText = '', envText = '' }) {
  const existing = providers && typeof providers === 'object' ? providers : {};
  const changes = [];
  const projected = { ...existing };
  for (const entry of entries) {
    const { template } = entry;
    const before = existing[template.id];
    const previous = before && typeof before === 'object' ? before : {};
    const profile = effectiveProfile(entry, previous);
    const fields = [];
    // `to` 取"合并后真正会落盘的值"，不是调用方递交的那份：两者对 modelOverrides
    // 并不相同（写入按 id 并入，旧条目保留）。用递交值会让预览谎称别的模型的调整会被清掉。
    const next = { ...previous };
    for (const field of OWNED_FIELDS) {
      const from = previous[field];
      const to = mergedValue(field, from, profile[field]);
      if (to === undefined)
        delete next[field];
      else
        next[field] = to;
      if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null))
        fields.push({ field, from: publicModelValue(field, from ?? null), to: publicModelValue(field, to ?? null) });
    }
    projected[template.id] = next;
    changes.push({
      routeId: template.id,
      kind: before === undefined ? 'add' : (fields.length === 0 ? 'unchanged' : 'modify'),
      fields,
      // 不属于模板的字段一律保留，预览里只报名字。
      preservedFields: Object.keys(previous).filter(field => !OWNED_FIELDS.includes(field)),
      credential: credentialChange(entry, previous, credentialRefs),
    });
  }
  for (const routeId of removals) {
    const before = existing[routeId];
    const previous = before && typeof before === 'object' ? before : {};
    delete projected[routeId];
    changes.push({
      routeId,
      kind: before === undefined ? 'absent' : 'remove',
      fields: [],
      preservedFields: Object.keys(previous).filter(field => !OWNED_FIELDS.includes(field)),
      // 删 route 不删凭据：其他段落或插件可能正在用同一个引用。
      credential: declaredRef(previous) === '' ? null : { ref: declaredRef(previous), action: 'keep' },
    });
  }
  const warnings = [];
  if (defaultModel && defaultModel !== 'clear') {
    const route = projected[defaultModel.provider];
    if (route === undefined) {
      // 只能判"无法确认"：插件可以在运行时注册路由，DSH 又对本段不设校验。
      warnings.push({ code: 'PROVIDER_DEFAULT_MODEL_UNCONFIRMED', detail: defaultModel.provider });
    }
    else if (Array.isArray(route.models) && !route.models.some(model => (model && typeof model === 'object' ? model.id : model) === defaultModel.model)) {
      warnings.push({ code: 'PROVIDER_DEFAULT_MODEL_UNCONFIRMED', detail: `${defaultModel.provider}/${defaultModel.model}` });
    }
  }
  // 引用扫描覆盖整份 settings 文档与 $DSH_HOME/.env（方案 §2）。刻意保守：扫的是改动前的文本，
  // 只被待删路由引用的名字仍会算作"保留"——反正凭据一律不自动清理，宁可少建议、不可多删。
  const referenced = `${settingsText}\n${envText}`;
  // 计划必须能区分"将清空 Home 默认模型"与"根本不碰它"：此前两者都塌成 defaultModel: null，
  // 预览于是给出完全相同的画面，而默认模型正是 §2.9 的验收点之一。
  const defaultModelAction = defaultModel === 'clear' ? 'clear' : (defaultModel ? 'set' : 'keep');
  return { changes, warnings, defaultModel: defaultModel === 'clear' ? null : (defaultModel ?? null), defaultModelAction, retainedCredentialRefs: credentialRefs.filter(ref => ref !== '' && referenced.includes(ref)) };
}

async function readPlanContext(entry, home, profileName) {
  const context = await openProviderDocuments(entry, home, profileName);
  const rawSettings = await context.read(context.settingsPath);
  const rawKeys = await context.read(context.keyPath);
  const settings = context.parse(rawSettings);
  const keys = context.parse(rawKeys);
  if (keys.contents.items.some(item => !['version', 'refs', 'records'].includes(String(item.key)))) throw new Error('PROVIDER_CREDENTIAL_FORMAT_UNSUPPORTED');
  // `.env` 只用于引用扫描，从不改写，也不回传内容；读不到就当没有。
  const envText = await readFile(join(home, '.env'), 'utf8').catch(() => '');
  return { ...context, rawSettings, rawKeys, settings, keys, envText };
}

/** 只算不写。 */
export async function planProviderOperations(entry, home, profile, operations) {
  const { settings, keys, rawSettings, rawKeys, settingsPath, keyPath, envText } = await readPlanContext(entry, home, profile);
  const tree = settings.toJSON() ?? {};
  const plan = buildPlan({
    providers: tree?.['llm-pi-ai']?.providers,
    entries: operations.entries ?? [],
    removals: operations.removals ?? [],
    defaultModel: operations.defaultModel ?? null,
    credentialRefs: Object.keys(keys.toJSON()?.refs ?? {}),
    settingsText: rawSettings ?? '',
    envText,
  });
  return {
    plan,
    digest: planDigest(plan, operations.entries ?? []),
    fingerprint: createHash('sha256').update([rawSettings ?? '', rawKeys ?? '', settingsPath, keyPath].join('\0---\0')).digest('hex'),
  };
}

/** 写。锁内重读、重算并比对摘要与指纹，不接受陈旧预览，也不接受前端算的 diff。 */
export async function applyProviderOperations(entry, home, profile, operations) {
  const context = await readPlanContext(entry, home, profile);
  const { yaml, withFileLock, writeFileAtomic, supportedProtocols, settingsPath, keyPath, read, parse, envText } = context;
  return withFileLock(settingsPath, () => withFileLock(keyPath, async () => {
    const oldSettings = await read(settingsPath);
    const oldKeys = await read(keyPath);
    const settings = parse(oldSettings);
    const keys = parse(oldKeys);
    const entries = operations.entries ?? [];
    const removals = operations.removals ?? [];
    const defaultModel = operations.defaultModel ?? null;
    const tree = settings.toJSON() ?? {};
    const plan = buildPlan({
      providers: tree?.['llm-pi-ai']?.providers,
      entries,
      removals,
      defaultModel,
      credentialRefs: Object.keys(keys.toJSON()?.refs ?? {}),
      settingsText: oldSettings ?? '',
      envText,
    });
    if (planDigest(plan, entries) !== operations.digest) throw new Error('PROVIDER_SETTINGS_CHANGED');
    const fingerprint = createHash('sha256').update([oldSettings ?? '', oldKeys ?? '', settingsPath, keyPath].join('\0---\0')).digest('hex');
    if (operations.fingerprint !== fingerprint) throw new Error('PROVIDER_SETTINGS_CHANGED');
    // 预览已经呈现过冲突，应用阶段一律按声明覆盖；非自有字段仍由 mergeRoute 保住。
    for (const item of entries) mergeRoute({ yaml, settings, keys, entry: item, overwrite: true, supportedProtocols });
    for (const routeId of removals) {
      const path = ['llm-pi-ai', 'providers', routeId];
      if (settings.hasIn(path)) settings.deleteIn(path);
    }
    if (defaultModel === 'clear') settings.deleteIn(['agent-default-model']);
    else if (defaultModel) {
      const { provider: route, model, reasoningEffort } = defaultModel;
      // 这一段在 DSH 里完全不校验，写坏了要到请求时才炸，所以由启动器自己守住形状。
      if (typeof route !== 'string' || route === '' || typeof model !== 'string' || model === '') throw new Error('PROVIDER_DEFAULT_MODEL_INVALID');
      const value = { provider: route, model };
      // 空串即"用服务商默认行为"：不写这个键，而不是写一个空值进去。
      if (typeof reasoningEffort === 'string' && reasoningEffort !== '') value.reasoningEffort = reasoningEffort;
      settings.setIn(['agent-default-model'], value);
    }
    const content = extname(settingsPath).toLowerCase() === '.json' ? `${JSON.stringify(settings.toJSON(), null, 2)}\n` : String(settings);
    await commitProviderDocuments(writeFileAtomic, settingsPath, keyPath, content, String(keys), oldKeys);
    return { plan };
  }));
}

if (process.argv[1] === '--launcher-provider-import') {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const result = request.operation === 'read'
      ? await readProviders(request.entry, request.home, request.profile)
      : request.operation === 'plan'
        ? await planProviderOperations(request.entry, request.home, request.profile, request)
        : request.operation === 'apply'
          ? await applyProviderOperations(request.entry, request.home, request.profile, request)
          : await importProviders(request.entry, request.home, request.entries, request.overwrite, request.profile);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Never echo arbitrary module errors: they may embed document contents or keys.
    process.stderr.write(/^PROVIDER_[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_IMPORT_FAILED');
    process.exitCode = 1;
  }
}
