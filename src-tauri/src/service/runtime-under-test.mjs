// 测试专用的运行时解析。两份服务商测试都要"拿安装中的真实 DSH 当对照"，
// 解析规则只在这里定义一次：复制一份就等于让两套测试对"什么算运行时"各持一个答案。
//
// 解析不到一律返回空串，由调用方把对应用例标成 skip 并**明说没跑**，
// 否则剩下几个单元测试通过会看起来像全绿。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function candidateGlobalRoots() {
  const roots = [];
  for (const variable of [process.env.npm_config_prefix, process.env.PREFIX]) {
    if (variable)
      roots.push(join(variable, 'lib', 'node_modules'), join(variable, 'node_modules'));
  }
  const nodeDir = dirname(process.execPath);
  // Windows 与 nvm-windows/Volta 把全局包放在 node 同级；POSIX 前缀布局放在 ../lib。
  roots.push(join(nodeDir, 'node_modules'), join(nodeDir, '..', 'lib', 'node_modules'));
  return roots;
}

/** DSH CLI 入口绝对路径；解析不到返回空串。 */
export function resolveRuntimeEntry() {
  if (process.env.DSH_TEST_ENTRY)
    return process.env.DSH_TEST_ENTRY;
  for (const root of candidateGlobalRoots()) {
    try {
      const packageDir = join(root, '@deepseek-ai', 'dsh');
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
      if (!bin)
        continue;
      const entry = join(packageDir, bin);
      if (existsSync(entry))
        return entry;
    }
    catch {
      // 这个根目录没装 DSH，换下一个。
    }
  }
  return '';
}

/**
 * `@deepseek-ai/dsh` 的包目录，也就是宿主给探测子进程设的 cwd。
 * 从 CLI 入口逐级上找，不假设 node_modules 的嵌套层数。
 */
export function resolvePackageRoot(entry) {
  let current = dirname(entry);
  for (let depth = 0; depth < 8 && current !== dirname(current); depth += 1) {
    try {
      if (JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')).name === '@deepseek-ai/dsh')
        return current;
    }
    catch {
      // 这一层不是包目录，继续往上。
    }
    current = dirname(current);
  }
  return '';
}

/** 读运行时包内的文件；读不到返回空串，由调用方决定 skip 还是失败。 */
export function readRuntimeFile(packageRoot, relativePath) {
  try {
    return readFileSync(join(packageRoot, relativePath), 'utf8');
  }
  catch {
    return '';
  }
}
