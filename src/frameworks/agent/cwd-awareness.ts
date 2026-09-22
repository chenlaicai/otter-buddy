/**
 * F20260922scwd：bash 感知对齐与主仓写保护——
 * 让 LLM 每条 bash 命令都看到真实执行目录（感知对齐），
 * 并在未 cd 时拦截落点为主仓的写命令（事故兜底）。
 *
 * 背景：pi SDK bash 每条命令独立 spawn shell，cwd 恒为 session 构造时的
 * process.cwd()（主仓根），cd 天然不可能跨命令保持。LLM 终端心理模型
 * （cd 有状态）与 SDK 架构系统性冲突，靠自律不可收敛。
 *
 * 方案（搭档 2026-09-22 决策：「让 agent 知道当前在哪」而非「替它记住」）：
 * ①stderr 前缀：bash execute 包装，每条命令输出前加 [cwd: <实际目录>]——
 *   LLM 每轮看到「我在主仓」，误差显式化，自行决定要不要 cd；
 * ②主仓写拦截：bash 守卫新增规则组——未 cd 时拦截 heredoc/python patch/
 *   git 写族等落点为主仓的写命令，并给出正道指引；
 * ③工具描述补充：bash 工具描述加「每条命令独立 shell，cd 不跨命令保持」。
 *
 * Why 不做粘性：文本跟踪有固有盲区（脚本内 cd、嵌套引用、临时查看误粘），
 * 感知对齐把「状态管理」复杂度换成「误差显式化」的简洁，与 #776 同构。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** AgentToolResult 最小结构面（SDK 类型来自 pi-agent-core 转依赖，不深路径 import——
 *  与 session-slicer.ts:24 同策略：只声明消费到的字段，结构兼容即过型检） */
interface AgentToolResultLike {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: unknown;
}

/** bash 输出前缀：让 LLM 每条命令都看到真实执行目录 */
export const CWD_PREFIX_TAG = "[cwd:";

/**
 * 包装 bash ToolDefinition 的 execute，在输出文本前注入 [cwd: <dir>] 前缀。
 * 感知对齐核心：LLM 每轮看到真实执行目录，自行修正心理模型误差。
 *
 * 注入位置：成功返回的 content[0].text 开头；错误场景（exit code/timeout/abort）
 * 由 SDK 抛 Error，文本在 error.message 里——同样注入前缀（LLM 需要知道
 * 失败命令是在哪跑的）。
 *
 * @param base bash 工具定义（createBashToolDefinition 返回值）
 * @param cwd session 构造时的固定 cwd（主仓根）——即 ctx?.cwd || cwd 的 fallback
 */
export function wrapBashWithCwdPrefix(base: ToolDefinition, cwd: string): ToolDefinition {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: { cwd?: string } | undefined,
    ): Promise<AgentToolResultLike> => {
      const actualCwd = ctx?.cwd || cwd;
      try {
        const result = await base.execute(toolCallId, params, signal, onUpdate as never, ctx as never) as AgentToolResultLike;
        // 成功路径：content[0].text 注入前缀
        const first = result.content?.[0];
        if (first?.type === "text" && typeof first.text === "string") {
          first.text = `${CWD_PREFIX_TAG} ${actualCwd}]\n${first.text}`;
        }
        return result;
      } catch (err) {
        // 错误路径：Error.message 注入前缀（LLM 需要知道失败命令在哪跑的）
        if (err instanceof Error) {
          err.message = `${CWD_PREFIX_TAG} ${actualCwd}]\n${err.message}`;
        }
        throw err;
      }
    },
  };
}

/** bash 工具描述补充：无状态架构声明（感知对齐的认知锚） */
export const BASH_STATELESS_SUFFIX =
  " Note: each bash command runs in an independent shell — `cd` does NOT persist across commands. " +
  "Check the [cwd: ...] prefix in output to see your actual working directory, " +
  "and use `cd <dir> && <command>` when you need to operate in a specific directory.";
