/**
 * Python 解释器探测——共享模块
 *
 * resolvePython 逻辑在 stock-tools.ts 和 stock-quote-gateway-impl.ts 中各有一份拷贝，
 * 抽成单源消除单边漂移风险（章鱼 N3 发现）。
 *
 * 优先级：STOCK_PYTHON 环境变量 > <repo>/.venv-stock/bin/python > 系统 python3
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolvePython(repoRoot: string): string {
  const envPython = process.env.STOCK_PYTHON;
  if (envPython && existsSync(envPython)) return envPython;
  const venvPython = join(repoRoot, ".venv-stock", "bin", "python");
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}
