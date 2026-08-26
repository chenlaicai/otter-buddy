/**
 * stock_data 工具——聚合式 A 股数据查询工具。
 *
 * 封装 scripts/stock-cli.py（PR1 桥脚本），通过 child_process.spawn 调用。
 * 单工具聚合五命令，防 tool-factory 膨胀。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

/** stock-cli.py 相对仓库根的路径 */
const STOCK_CLI_REL = "scripts/stock-cli.py";

/** 合法命令枚举 */
const VALID_COMMANDS = ["kline", "overview", "finance", "news", "northflow", "selftest"] as const;
type StockCommand = (typeof VALID_COMMANDS)[number];

/** 需要 code 参数的命令 */
const COMMANDS_NEEDING_CODE = new Set(["kline", "overview", "finance", "news"]);

/** 默认超时 60 秒 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 最大输出字符数（~4K tokens） */
const MAX_OUTPUT_CHARS = 15_000;

/**
 * 探测 Python 解释器路径。
 * 优先级：STOCK_PYTHON 环境变量 > <repo>/.venv-stock/bin/python > 系统 python3
 */
function resolvePython(repoRoot: string): string {
  const envPython = process.env.STOCK_PYTHON;
  if (envPython && existsSync(envPython)) return envPython;
  const venvPython = join(repoRoot, ".venv-stock", "bin", "python");
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}

/** akshare 检查缓存——避免每次调用多付 1-2s Python 冷启动税 */
const akshareCheckCache = new Map<string, string | null>();

/** 清空 akshare 检查缓存（测试用） */
export function clearAkshareCheckCache(): void {
  akshareCheckCache.clear();
}

/** 检查 python 是否有 akshare。返回 null 表示正常，否则返回错误消息。结果进程内缓存。 */
async function checkAkshare(pythonPath: string): Promise<string | null> {
  const cached = akshareCheckCache.get(pythonPath);
  if (cached !== undefined) return cached;

  return new Promise((resolveCheck) => {
    const proc = spawn(pythonPath, ["-c", "import akshare"], { timeout: 10_000 });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        akshareCheckCache.set(pythonPath, null);
        return resolveCheck(null);
      }
      const msg =
        `akshare 未安装。请先安装：\n` +
        `  python3 -m venv .venv-stock\n` +
        `  source .venv-stock/bin/activate\n` +
        `  pip install akshare\n` +
        `详见 scripts/README-stock-cli.md\n` +
        `原始错误: ${stderr.slice(0, 200)}`;
      akshareCheckCache.set(pythonPath, msg);
      resolveCheck(msg);
    });
    proc.on("error", (err) => {
      const msg = `Python 解释器不可用 (${pythonPath}): ${err.message}`;
      // spawn 失败不缓存（可能是临时问题）
      resolveCheck(msg);
    });
  });
}

/** 执行 stock-cli.py 命令 */
function executeStockCli(
  repoRoot: string,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const scriptPath = resolve(repoRoot, STOCK_CLI_REL);
  const pythonPath = resolvePython(repoRoot);
  const fullArgs = [scriptPath, command, ...args];

  return new Promise((res) => {
    const proc = spawn(pythonPath, fullArgs, {
      cwd: repoRoot,
      timeout: timeoutMs,
      shell: false, // Why: 参数数组传递不经 shell，防注入
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => res({ stdout, stderr, exitCode: code }));
    proc.on("error", (err) => res({ stdout: "", stderr: err.message, exitCode: -1 }));
  });
}

/** 校验参数，返回错误消息或 null */
function validateParams(command: string, code?: string): string | null {
  if (!VALID_COMMANDS.includes(command as StockCommand)) {
    return `未知命令: ${command}。合法命令: ${VALID_COMMANDS.join(", ")}`;
  }
  if (COMMANDS_NEEDING_CODE.has(command)) {
    if (!code) return `命令 ${command} 需要 code 参数（6 位数字）`;
    if (!/^\d{6}$/.test(code)) return `非法股票代码: ${code}。必须为 6 位数字（如 600519）`;
  }
  return null;
}

/** 从 params 构造 CLI 参数数组 */
function buildCliArgs(command: string, params: Record<string, unknown>): string[] {
  const args: string[] = [];
  if (params.code && COMMANDS_NEEDING_CODE.has(command)) args.push(params.code as string);
  if (command === "kline") {
    if (params.days) args.push("--days", String(params.days));
    if (params.adjust) args.push("--adjust", params.adjust as string);
  }
  if (command === "finance" && params.quarter) args.push("--quarter", String(params.quarter));
  if (command == "news" && params.limit) args.push("--limit", String(params.limit));
  if (params.no_cache) args.push("--no-cache");
  return args;
}

/** 处理执行结果，返回 ToolResponse */
function processResult(result: { stdout: string; stderr: string; exitCode: number | null }) {
  if (result.exitCode === -1 && result.stderr.includes("spawn")) {
    return errorResponse(`[错误] Python 执行失败: ${result.stderr}`);
  }

  const rawOutput = result.stdout.trim();
  if (!rawOutput) {
    const stderrHint = result.stderr ? `\nstderr: ${result.stderr.slice(0, 500)}` : "";
    return errorResponse(`[错误] stock-cli.py 无输出（可能超时）。exitCode=${result.exitCode}${stderrHint}`);
  }

  try {
    const parsed = JSON.parse(rawOutput);
    if (parsed.error) return errorResponse(JSON.stringify(parsed, null, 2));
    const output = JSON.stringify(parsed);
    if (output.length > MAX_OUTPUT_CHARS) {
      return textResponse(
        output.slice(0, MAX_OUTPUT_CHARS) + "\n\n[结果已截断，请缩小查询范围（如减少 days）获取完整内容。]"
      );
    }
    return textResponse(output);
  } catch {
    return errorResponse(
      `[错误] stock-cli.py 输出非 JSON。\nstdout: ${rawOutput.slice(0, 500)}\nstderr: ${result.stderr.slice(0, 500)}`
    );
  }
}

/** 工具 description——LLM 消费的引导文案是本工具价值的一半 */
const TOOL_DESCRIPTION = [
  "A 股数据查询工具——通过 akshare 获取个股行情、财务、新闻、北向资金。",
  "命令：",
  "  kline <code> — 日 K 线（默认摘要：最近 30 日 OHLCV + 区间统计；adjust 控制复权方式）",
  "  overview <code> — 个股概览（基本信息 + 实时行情 + 估值 PE/PB/市值）",
  "  finance <code> — 财务指标（营收/净利/ROE/毛利率，quarter 控制季数）",
  "  news <code> — 个股新闻（limit 控制条数）",
  "  northflow — 北向资金汇总（无需 code）",
  "  selftest — 自检各接口连通性",
  "输出：单行 JSON 到 stdout；错误时 {\"error\":\"...\"}。",
  "缓存：默认 5 分钟落盘缓存，no_cache=true 强制刷新。",
  "股票代码格式：6 位数字（如 600519、000001）。",
  "复权方式（adjust）：qfq=前复权（默认），hfq=后复权，空字符串=不复权。",
].join("\n");

export function createStockDataTool(_ctx: ToolContext): AgentTool {
  return {
    name: "stock_data",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [...VALID_COMMANDS],
          description: "数据命令",
        },
        code: {
          type: "string",
          description: "6 位股票代码（如 600519）。kline/overview/finance/news 必填，northflow/selftest 不需要。",
        },
        days: {
          type: "number",
          description: "kline 命令：获取最近 N 个交易日数据（默认 120）",
        },
        adjust: {
          type: "string",
          enum: ["qfq", "hfq", ""],
          description: "kline 命令：复权方式。qfq=前复权（默认），hfq=后复权，空字符串=不复权。",
        },
        quarter: {
          type: "number",
          description: "finance 命令：获取最近 N 个季度数据（默认 4）",
        },
        limit: {
          type: "number",
          description: "news 命令：最大新闻条数（默认 10）",
        },
        no_cache: {
          type: "boolean",
          description: "强制刷新缓存（忽略 5 分钟缓存）",
        },
      },
      required: ["command"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const command = params.command as string;
      const code = params.code as string | undefined;

      const validationError = validateParams(command, code);
      if (validationError) return errorResponse(`[错误] ${validationError}`);

      // Why: ESM 环境无 __dirname，用 import.meta.dirname（Node 21.2+ / 22+）
      const repoRoot = resolve(import.meta.dirname, "../../../../..");
      if (!existsSync(resolve(repoRoot, STOCK_CLI_REL))) {
        return errorResponse(`[错误] stock-cli.py 不存在。请确认 scripts/stock-cli.py 已入库。`);
      }

      const pythonPath = resolvePython(repoRoot);
      const akErr = await checkAkshare(pythonPath);
      if (akErr) return errorResponse(`[错误] ${akErr}`);

      const cliArgs = buildCliArgs(command, params);
      const result = await executeStockCli(repoRoot, command, cliArgs, DEFAULT_TIMEOUT_MS);
      return processResult(result);
    },
  };
}
