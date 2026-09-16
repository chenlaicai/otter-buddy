/**
 * F20260916：运行时资源路径统一解析（issue #429）
 *
 * 问题：全仓多处运行时读文件用 `resolve(process.cwd(), …)`，
 * 非项目根 cwd 启动（systemd WorkingDirectory、容器 ENTRYPOINT）时静默失败或回退。
 *
 * 方案：`getRepoRoot()` 基于代码位置（import.meta.dirname）向上逐级查找
 * 含 package.json 且 name === "otter-buddy" 的目录。兼容两种布局：
 * - vitest 直跑 src/：src/frameworks/repo-root.ts → repoRoot 向上 2 级
 * - tsc 编译产物 dist/src/frameworks/：向上 4 级（dist/src/frameworks → dist/src → dist → repoRoot）
 * 向上逐级探测比写死层级数更稳（未来目录结构调整不破坏定位），
 * 且 name 匹配防止误停在 monorepo 子包或 node_modules 里的同名文件。
 *
 * 为什么不用 createRequire(import.meta.url).resolve('otter-buddy/package.json')：
 * 包未发布到 registry、不保证自引用解析可用（experimental 语义、依赖安装布局），
 * 文件系统探测是唯一不依赖包管理器布局的稳定方案。
 *
 * 缓存：模块级 memo——进程生命周期内 repoRoot 不变，逐次探测是纯浪费。
 * 探测上限 10 级防失控（正常最多 4 级）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PACKAGE_NAME = 'otter-buddy';
const MAX_UPWARD_STEPS = 10;

let cachedRepoRoot: string | null = null;

function isPackageRoot(dir: string): boolean {
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** 基于代码位置定位仓库根（含 package.json 且 name === "otter-buddy" 的目录）。
 *  与 process.cwd() 无关，任意 cwd 启动均可正确定位。结果进程内缓存。 */
export function getRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;

  let dir = dirname(import.meta.dirname);
  for (let i = 0; i < MAX_UPWARD_STEPS; i++) {
    if (isPackageRoot(dir)) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到达文件系统根
    dir = parent;
  }

  // fail-soft：找不到锚点时退回启动目录，保持旧行为（不引入 fail-fast，#429 方案决策）
  cachedRepoRoot = process.cwd();
  return cachedRepoRoot;
}

/** 测试专用：清空缓存（repo-root 自身测试需要冷启动路径） */
export function __resetRepoRootCacheForTests(): void {
  cachedRepoRoot = null;
}
