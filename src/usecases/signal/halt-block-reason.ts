/**
 * Halt block reason 文本（F20260826mwrd C1）。
 *
 * SDK 语义：tool_call handler 返回 { block: true, reason } → agent-loop 生成
 * isError tool result（reason 为正文）返回 LLM。本文件构造该正文——
 * 它是 halt 协议的「注入面」，目标獭的全部行为义务写在这里。
 *
 * prompt 义务（SMALL_OTTER.md C4 改版）与此处文本对齐：不重试被 block 的调用、
 * 不开新调用、报告进度快照、报告后停止即交回（speak 是唯一豁免工具）。
 */
import type { HaltDirective } from './halt-registry';

/** block reason 上限（防滥用：多指令堆叠时截断） */
const MAX_HALT_REASON_CHARS = 2000;

export function buildHaltBlockReason(directives: HaltDirective[]): string | undefined {
  if (directives.length === 0) return undefined;
  const parts = directives.map(d =>
    `[halt 指令] 发起者：${d.fromOtterName}（${d.fromOtterId}）｜时间：${d.issuedAt}\n` +
    `理由：${d.reason}\n` +
    `信号台账 ID：${d.id}`,
  );
  const header = '[系统控制信号] 本工具调用被 halt 指令阻断。收到 halt 后的合规动作：\n' +
    '1. 不重试被 block 的调用；除用于报告的 speak 外，不发起任何新的工具调用\n' +
    '2. 一次 speak 输出进度快照：已完成 / 进行中 / 卡点（speak 是唯一被豁免的工具，yield 会被 block）\n' +
    '3. 报告后停止发起一切工具调用——停止即完成行动权交回，无需（也无法）重试 yield；之后等待改派或解除\n' +
    '——上下文完整保留，你不需要重启或从头再来。\n';
  const body = header + parts.join('\n---\n');
  return body.length > MAX_HALT_REASON_CHARS
    ? body.slice(0, MAX_HALT_REASON_CHARS) + '\n[多指令已截断]'
    : body;
}
