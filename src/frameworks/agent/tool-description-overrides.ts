/**
 * F20260904cg77（#776）：编码工具描述覆写——「如何正确使用工具」的信息归位到工具自身描述。
 *
 * 背景：9/4 session 解剖实证，bash 万金油习惯是上下文膨胀最大单一源（756 次 bash 占
 * 833KB/1.6M，其中 79 次 sed 读文件——read 全程可用却没人用）。工具可用 ≠ 工具会用，
 * 需要在工具描述层给 LLM 明确的选择引导。搭档决策：引导内容属于「工具如何被正确使用」，
 * 准确位置是工具自身的 description，而非 system prompt（SYSTEM.md/身份层）。
 *
 * 机制（pi SDK 源码核实）：AgentSession._refreshToolRegistry 中 customTools 后注册
 * 无条件覆盖同名的 builtin definition（definitionRegistry.set），而 readOnly 模式的
 * SYNTHESIS_READ_ONLY_TOOL_WHITELIST 过滤在 customTools 汇入 registry 之前完成——
 * 因此 readOnly session 不传本覆写（调用方控制），本模块零副作用。
 *
 * 实现约束：spread builtin definition 拷贝（execute/parameters/promptSnippet 原样引用，
 * 零行为变化），仅追加 description 文本。pi 升级时 description 基线变化会自然带入
 * （我们在运行时读取原 description 再拼接，不做快照）。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 各工具的描述追加文本（ Why 前缀 + 使用边界，与实证数据一致：833KB/1.6M） */
const DESCRIPTION_SUFFIXES: Record<string, string> = {
  bash:
    " Prefer dedicated tools when applicable: use the grep tool (not `grep ...` here) to search file contents; use the read tool (not `sed -n '1,80p'`) to read files; use find/ls tools to locate files or list directories. Reserve bash for git, npm/build commands, multi-command pipelines, and filtering command output (e.g. `npx vitest 2>&1 | grep FAIL`). Why: compound bash commands with long paths accumulate as context bloat (measured: one session had 756 bash calls totaling 833KB of 1.6M context).",
  read:
    " Prefer this over `bash sed -n 'X,Yp'` for reading file fragments — supports offset/limit, cleaner output, and avoids shell quoting noise.",
  grep:
    " Prefer this over running `grep` via the bash tool — structured output with file:line, built-in truncation, respects .gitignore.",
  find: " Prefer this over running `find` via the bash tool — structured output with result limits.",
  ls: " Prefer this over running `ls` via the bash tool — structured output with entry limits.",
};

/**
 * 生成编码工具的描述覆写集（作为 customTools 传入 createAgentSession，
 * 同名覆盖 builtin——见文件头机制说明）。
 *
 * @param baseTools pi builtin 工具定义全集（name → definition）
 * @param toolNames 需要覆写的工具名子集（应与激活的编码工具白名单一致）
 */
export function buildToolDescriptionOverrides(
  baseTools: Record<string, ToolDefinition>,
  toolNames: string[],
): ToolDefinition[] {
  const overrides: ToolDefinition[] = [];
  for (const name of toolNames) {
    const suffix = DESCRIPTION_SUFFIXES[name];
    const base = baseTools[name];
    if (!suffix || !base) continue;
    overrides.push({
      ...base,
      description: `${base.description}${suffix}`,
    });
  }
  return overrides;
}

/**
 * 用 pi SDK 导出的 create*ToolDefinition 组装 builtin 工具定义（覆写目标子集）。
 * Why：createAllToolDefinitions 未从包根导出（index.d.ts 仅有各 create*ToolDefinition），
 * 而同名覆盖机制只需覆写目标工具的定义，按名组装所需子集即可。
 * @param piCodingAgent 懒加载的 pi-coding-agent 模块（getPiCodingAgent() 返回值）
 */
export function buildPiBuiltinToolDefinitions(piCodingAgent: Record<string, unknown>, cwd: string): Record<string, ToolDefinition> {
  const factories: Record<string, (cwd: string) => ToolDefinition> = {
    read: piCodingAgent.createReadToolDefinition as (cwd: string) => ToolDefinition,
    bash: piCodingAgent.createBashToolDefinition as (cwd: string) => ToolDefinition,
    grep: piCodingAgent.createGrepToolDefinition as (cwd: string) => ToolDefinition,
    find: piCodingAgent.createFindToolDefinition as (cwd: string) => ToolDefinition,
    ls: piCodingAgent.createLsToolDefinition as (cwd: string) => ToolDefinition,
  };
  const result: Record<string, ToolDefinition> = {};
  for (const [name, factory] of Object.entries(factories)) {
    if (typeof factory === "function") result[name] = factory(cwd);
  }
  return result;
}

/** DESCRIPTION_SUFFIXES 的键集（测试与调用方校验用） */
export const OVERRIDABLE_TOOL_NAMES = Object.keys(DESCRIPTION_SUFFIXES);
