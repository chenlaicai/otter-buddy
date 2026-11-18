/**
 * P2b2：夜审獭提示词构造（从编排器拆出——控编排器文件行数）。
 *
 * buildNightReviewerPrompt：夜审獭系统提示词（受限写者身份 + 承重不变量）。
 * buildNightReviewMessage：夜审任务消息（当日清单 + 原文 + 快照范围注入）。
 */
import { parseBeliefMetadata } from "@entities/memory/belief";
import type { MemoryEntry } from "@entities/memory/memory-entry";

/** 夜审獭系统提示词（受限写者身份 + 承重不变量：全量核对、默认拒、禁删只迁移）。 */
export function buildNightReviewerPrompt(): string {
  return [
    "你是夜间审视獭（night-reviewer），主动记忆层的独立核实者。你的唯一职责：对快照范围内的 recorded belief 逐条核对原文，做出状态迁移。",
    "",
    "判断规则（防编造链承重不变量）：",
    "- 全量核对、非抽样、默认拒——审视是整条防编造链的承重件，不是安检表演。",
    "- 原文与 belief 正文语义吻合 → belief_verify（核实 → verified）",
    "- 原文与 belief 正文不吻合（曲解、过度引申、无中生有）→ belief_reject（打回 → disputed）",
    "- 原文真实但已被后续事实取代（认识过期）→ belief_supersede（标记过期 → superseded，旧条目保留）",
    "- 工具只接受快照范围内创建的条目（范围外调用会被拒）。",
    "- 禁止删除：三个工具都只迁状态，改不了条目内容。",
    "",
    "流程要求：",
    "1. 逐条核对清单中的 belief（正文 + 原文锚点）；每条必须处置——没有「保持原状」选项，拿不准就是 reject。",
    "2. 全部处置完后：speak 一条变更汇总（每条标注 [已核实]/[存疑]/[已过期]），然后 yield 交给 user 收尾。",
    "3. 不要发起讨论、不要派工、不要调用清单外的工具。",
  ].join("\n");
}

/** 夜审任务消息（当日清单 + 原文 + 快照范围注入）。 */
export function buildNightReviewMessage(
  after: string,
  through: string,
  beliefs: MemoryEntry[],
  anchors: Map<string, MemoryEntry | null>,
): string {
  const items = beliefs.map((b, i) => {
    const meta = parseBeliefMetadata(b);
    const anchorLines = (meta?.anchors ?? []).map((a) => {
      const src = anchors.get(a);
      return src
        ? `  - [${a}] ${src.content}`
        : `  - [${a}]（原文缺失——按 reject 处置）`;
    });
    const inferredLines = (meta?.inferredFrom ?? []).map((a) => {
      const src = anchors.get(a);
      return src ? `  - [${a}] ${src.content}` : `  - [${a}]（依据缺失）`;
    });
    return [
      `## 条目 ${i + 1}`,
      `- id: ${b.id}`,
      `- kind: ${meta?.kind ?? "unknown"}`,
      `- belief 正文: ${b.content}`,
      "- 原文锚点:",
      ...anchorLines,
      ...(inferredLines.length > 0 ? ["- 推断依据:", ...inferredLines] : []),
    ].join("\n");
  });
  return [
    `# 夜间审视任务（快照范围 [${after}, ${through}]）`,
    "",
    `当日 recorded belief 共 ${beliefs.length} 条。逐条核对原文，对每条调用 belief_verify / belief_reject / belief_supersede 之一，全部处置完后 speak 汇总并 yield user。`,
    "",
    ...items,
  ].join("\n");
}
