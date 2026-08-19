/**
 * Dispatch Guard - 派工软守卫（状态挂 ToolContext）
 *
 * Why: 从 tool-factory.ts 下沉派工守卫逻辑，实现领域规则与工具实现分离。
 * dispatch-guard.ts 包含状态操作，依赖 ToolContext 的 pendingDispatches 字段。
 *
 * 设计依据：R20260817arnt Q2 tool-factory 领域规则下沉
 */

import type { ToolContext } from "@usecases/ports/agent-tools";

/**
 * F20260813actk C9：待派工票据的软守卫——检查未派工并提醒（不清除票据）。
 * 若本轮创建的小獭仍有未获行动权的、且本次未提醒过，返回提醒文案（调用方以 terminate=false 返回）。
 * 返回 null 表示无需提醒，可正常提交 speak。
 *
 * 票据清除不在此函数做——移到 startSpeaking 成功后（confirmDispatchesClear）。
 * 若按"意图"提前清除，startSpeaking 失败（如 db locked）会泄漏票据：大獭重试 speak(user) 不再被提醒。
 *
 * 同批调用限制：SDK 默认并行执行同批工具。create_otter 与 speak 同批调用时，
 * create_otter 的 pendingDispatches.set() 可能晚于 speak 的检查执行——C9 只可靠
 * 覆盖串行调用场景（create 先完成返回，speak 后调用）。同批 create+speak(to user)
 * 由 prompt 层（C8 description + C1 skill 工作流 + C2 reframe）保证大獭不产生该路径。
 *
 * @param ctx ToolContext（包含 pendingDispatches 和 dispatchWarningShown）
 * @param resolvedIds 已解析的 ID 列表
 * @param recipients 原始接收者名字列表
 * @returns 提醒文案或 null
 */
export function checkPendingDispatches(
  ctx: ToolContext,
  resolvedIds: string[],
  recipients: string[],
): string | null {
  const pending = ctx.pendingDispatches;
  if (!pending) return null;
  const remaining = [...pending.entries()].filter(([id]) => !resolvedIds.includes(id));
  if (remaining.length === 0 || ctx.dispatchWarningShown) return null;
  const names = remaining.map(([, name]) => name).join("、");
  ctx.dispatchWarningShown = true;
  return (
    `[系统状态] 你本轮创建的小獭还有 ${remaining.length} 只未获得行动权：${names}。它们不会被唤醒执行。` +
    `如果你确实要把行动权交给 [${recipients.join("、")}]，再次调用 yield 即可放行；` +
    `如果是漏派，请把 ${names} 加入 yield 的 to 参数后重新调用 yield。`
  );
}

/**
 * F20260813actk C9：startSpeaking 提交成功后确认清除已派工票据（按"提交成功"清，非按"意图"清）
 *
 * @param ctx ToolContext（包含 pendingDispatches）
 * @param resolvedIds 已解析的 ID 列表
 */
export function confirmDispatchesClear(ctx: ToolContext, resolvedIds: string[]): void {
  const pending = ctx.pendingDispatches;
  if (!pending) return;
  for (const id of resolvedIds) pending.delete(id);
}
