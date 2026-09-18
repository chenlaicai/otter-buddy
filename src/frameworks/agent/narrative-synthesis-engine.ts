/**
 * F20260918uhuc：统一叙事合成引擎——压缩/交接共享的单一七段算法。
 *
 * 合并来源（两套模板的合并体，谱系同源）：
 * - compaction-hook.ts 的七段模板（Pi preparation 视角：messagesToSummarize 序列化 + previousSummary 谱系继承）
 * - synthesis-prompt-builder.ts 的七节模板（DB 视角：状态盘点 §⑤ 机械供料 + prefetch §④/⑥）
 *
 * 统一后所有交接场景（水位/手动/自重启/熔断/首哑复活）共用本引擎构建合成 prompt；
 * 影子通道执行合成（pi-session-factory runCompactionSynthesis，inMemory session 直调 LLM）。
 *
 * fail-closed 防线（与 Pi getSummarizationFailure 同立场）：
 * 空/截断摘要拒绝入库——由调用方（影子通道闭包）在拿到结果后校验，
 * 本引擎在 prompt 层声明预算与输出要求。
 */

import { serializeConversation } from "@earendil-works/pi-coding-agent";

/** 合成超时上界（ms）：影子通道外层兜底，超时降级机械转储档案 */
export const NARRATIVE_SYNTHESIS_TIMEOUT_MS = 60_000;

/** 引擎输入原料包（原料层统一收集器的产出——触发层负责收集，算法层只管消费） */
export interface NarrativeSynthesisInput {
  /** otter 显示名（meta 行） */
  otterName: string;
  /** 旧 session ID（meta 行 + 谱系行；缺省时用 'unknown'） */
  oldSessionId?: string;
  /** 触发场景 */
  trigger: '水位' | '手动' | '自重启' | '熔断' | '首哑复活';
  /** 待压缩的对话历史切片（SDK AgentMessage[]，jsonl 权威源切片的产物） */
  messagesToSummarize: Array<{ role: string; content?: unknown }>;
  /** 上一代摘要（谱系继承：合并式更新，非重置） */
  previousSummary?: string;
  /** 交接谱系（gen N 跨代链，从旧 summary 提取的既有谱系行） */
  lineage?: string;
  /** 触发方自总结（獭写的 restart summary / 搭档填的）——同时作为合成原料（§①② 段需要意图） */
  selfSummary?: string;
  /** 状态盘点渲染文本（§⑤ 机械供料——DB 权威源，不依赖 jsonl 质量） */
  stateInventoryText?: string;
  /** §④/⑥ 机械预取（context keys / active 产物 / 最近搭档消息） */
  prefetch?: {
    contextKeys?: string[];
    activeArtifacts?: Array<{ id: string; resourceType: string; title?: string }>;
    recentUserMessages?: string[];
  };
  /** 当前时间戳（缺省 now） */
  timestamp?: string;
}

/**
 * 构建统一七段合成 prompt。
 *
 * 模板段（合并两套模板后的统一形态）：
 * ① 下一步 ② 当前任务与完成标准 ③ 关键决策与理由 ④ 产物与锚点
 * ⑤ 协作状态（机械供料）⑥ 搭档上下文 ⑦ 交接谱系（每代一行追加）
 *
 * 原料三源：序列化对话历史（jsonl 切片）+ 上一代摘要（合并式）+ 机械供料（DB 快照）。
 * selfSummary 的处理：作为原料注入（引擎写 ①② 需要知道交接意图），但输出层
 * 由调用方独立保留原话（叠加式档案 §①交接意图书），不转述。
 */
export function buildNarrativeSynthesisPrompt(input: NarrativeSynthesisInput): string {
  const ctx = resolvePromptContext(input);
  const lines: string[] = [];
  appendPromptHeader(lines, ctx);
  appendRuleLines(lines, input.selfSummary, input.previousSummary);
  appendMaterialSections(lines, ctx, input);
  appendTemplateSection(lines, ctx, input);
  lines.push('');
  lines.push('请基于上述原料，按七段模板直接输出摘要文本。');
  return lines.join('\n');
}

/** prompt 组装上下文（代数/时间/短 ID 的机械推导） */
interface PromptContext {
  otterName: string;
  shortId: string;
  trigger: string;
  genN: number;
  ts: string;
}

function resolvePromptContext(input: NarrativeSynthesisInput): PromptContext {
  const ts = input.timestamp ?? new Date().toISOString();
  const shortId = (input.oldSessionId ?? 'unknown').slice(0, 8);
  // gen N 谱系代数机械推导（lineage 行数 + 1），无 lineage 则 gen1——与旧模板同源逻辑
  const genN = input.lineage
    ? input.lineage.split('\n').filter(l => l.trim().length > 0).length + 1
    : 1;
  return { otterName: input.otterName, shortId, trigger: input.trigger, genN, ts };
}

function appendPromptHeader(lines: string[], ctx: PromptContext): void {
  lines.push(`[系统-前世叙事合成] 你正在为一只海獭的转世生成「历史叙事摘要」。以下是即将被封存的对话历史，请按七段模板写摘要——这是新世海獭理解前世的唯一叙事来源。`);
  lines.push('');
  lines.push(`meta: ${ctx.otterName} | gen ${ctx.genN} | ${ctx.shortId} → 新session | ${ctx.ts} | 触发: ${ctx.trigger}`);
  lines.push('');
}

function appendRuleLines(lines: string[], selfSummary: string | undefined, previousSummary: string | undefined): void {
  lines.push('## 规则');
  lines.push('1. §④/⑤/⑥ 的机械供料数据已在下方提供——枚举型事实用这些，不要自行回忆或编造');
  lines.push('2. 锚点优于复制——引用 ID（PR#/F文档/entry_id）而非复述内容');
  lines.push('3. 搭档指令用原话引用（引号内）——从下方预取的搭档消息里挑');
  lines.push('4. 谱系继承旧摘要的谱系行并追加一代，不得重置');
  lines.push('5. 「为什么这么定」和「什么试过不行」必须保留——防止后代重蹈覆辙');
  lines.push('6. 直接输出摘要文本，不要调用任何工具');
  lines.push('7. 预算：≤1200 token，硬上限 2000 token');
  lines.push('');

  appendSelfSummary(lines, selfSummary);
  appendPreviousSummary(lines, previousSummary);
}

function appendSelfSummary(lines: string[], selfSummary: string | undefined): void {
  if (selfSummary?.trim()) {
    lines.push('## 触发方自总结（交接意图，最高优先参考）');
    lines.push('<self-summary>');
    lines.push(selfSummary.trim());
    lines.push('</self-summary>');
    lines.push('');
    lines.push('这是触发本次交接的一方（獭自己/搭档）写的意图交代——§① 下一步和 §② 任务状态必须与其对齐；用户视角的意图优先于你从历史中的推断。');
    lines.push('');
  }

}

function appendPreviousSummary(lines: string[], previousSummary: string | undefined): void {
  if (previousSummary) {
    lines.push('## 上一代摘要（合并式更新）');
    lines.push('<previous-summary>');
    lines.push(previousSummary);
    lines.push('</previous-summary>');
    lines.push('');
    lines.push('保留其中仍有效的信息，合并本次新进展——不是重写，是迭代。');
    lines.push('');
  }
}

function appendMaterialSections(lines: string[], ctx: PromptContext, input: NarrativeSynthesisInput): void {
  void ctx;
  lines.push('## 待压缩的对话历史（前世 agent 视角完整记录）');
  lines.push('<conversation-to-summarize>');
  lines.push(serializeConversation(input.messagesToSummarize as never));
  lines.push('</conversation-to-summarize>');
  lines.push('');

  lines.push('## 机械供料（枚举事实，直接用）');
  lines.push('### §④ 预取数据');
  lines.push(formatPrefetch(input.prefetch));
  if (input.stateInventoryText) {
    lines.push('');
    lines.push('### §⑤ 活状态盘点（DB 权威源快照）');
    lines.push(stripInventoryTitle(input.stateInventoryText ?? ''));
  }
  lines.push('');
  lines.push('### §⑥ 最近搭档消息原文（挑选指令性语句引用）');
  lines.push(formatRecentUserMessages(input.prefetch));
  lines.push('');

}

function appendTemplateSection(lines: string[], ctx: PromptContext, input: NarrativeSynthesisInput): void {
  const { genN, shortId } = ctx;
  const lineage = input.lineage;
  lines.push('## 七段模板（输出结构）');
  lines.push('### ① 下一步（最高优先）');
  lines.push('- 立即动作：{一句具体可执行的话，含对象和预期产出}');
  lines.push('- 阻塞于：{等谁/等什么，无则写"无"}');
  lines.push('### ② 当前任务与完成标准');
  lines.push('- 任务：{一句话}');
  lines.push('- 完成标准：{可判定的标准，尽量引用搭档原话}');
  lines.push('- 状态：in_progress / awaiting_review / awaiting_user / blocked');
  lines.push('### ③ 关键决策与理由（最多5条，只增不删）');
  lines.push('- {决策} ← 因为 {一句话理由} 〔锚点: Fxxx/msg/entry_id〕');
  lines.push('- ⚠️ 已排除路径：{试过什么、为什么不行}');
  lines.push('### ④ 产物与锚点');
  lines.push('- PR: {#号 状态} ｜ 文档: {F-ID 标题} ｜ 记忆: {entry_id 一句话}');
  lines.push('- otter_context keys: {key 名列表，不含值——新 session 用 get_context 自取}');
  lines.push('### ⑤ 协作状态');
  lines.push('- {用上方 §⑤ 机械供料，不自行回忆}');
  lines.push('### ⑥ 搭档上下文');
  lines.push('- 最近明确指令/偏好（原话引用）："{...}"');
  lines.push('### ⑦ 交接谱系（每代一行，只追加）');
  lines.push(lineage ? `${lineage}\n- gen${genN} ${shortId}: {一句话干了什么}` : `- gen1 ${shortId}: {一句话干了什么}`);
}

/** §④ 预取数据格式化（无数据明说"无预取"——省略会让 LLM 不确定是"没查"还是"没有"） */
function formatPrefetch(prefetch?: NarrativeSynthesisInput['prefetch']): string {
  if (!prefetch) return '- （无预取数据）';
  const parts: string[] = [];
  if (prefetch.contextKeys) {
    parts.push(`- otter_context keys: ${prefetch.contextKeys.length > 0 ? prefetch.contextKeys.join(', ') : '（空）'}`);
  }
  if (prefetch.activeArtifacts) {
    if (prefetch.activeArtifacts.length === 0) {
      parts.push('- active 产物: 无');
    } else {
      const arts = prefetch.activeArtifacts.map(a => `${a.resourceType} ${a.id.slice(0, 8)}${a.title ? `「${a.title}」` : ''}`);
      parts.push(`- active 产物（${prefetch.activeArtifacts.length} 个）: ${arts.join(' ｜ ')}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : '- （无预取数据）';
}

/** §⑥ 最近搭档消息格式化（时间正序带序号） */
function formatRecentUserMessages(prefetch?: NarrativeSynthesisInput['prefetch']): string {
  if (!prefetch?.recentUserMessages || prefetch.recentUserMessages.length === 0) {
    return '- （无预取，从对话历史中自行识别搭档消息）';
  }
  return prefetch.recentUserMessages
    .map((m, i) => `${i + 1}. ${m}`)
    .join('\n');
}

/** 裁掉状态盘点首行标题（含时间戳，meta 行已有——保持 §⑤ 紧凑） */
function stripInventoryTitle(text: string): string {
  return text
    .split('\n')
    .filter(l => !l.startsWith('## '))
    .join('\n')
    .trim();
}

/**
 * 机械转储档案（合成降级形态）——synthesizePast=false 或合成失败/超时的完整合法档案。
 *
 * 档案形态有叙事/机械之分，无「先缺后补」：机械档案本身就是合法交付物。
 */
export function buildMechanicalArchive(input: {
  otterName: string;
  trigger: string;
  oldSessionId?: string;
  selfSummary?: string;
  stateInventoryText?: string;
  recencyWindow?: string;
  fileTrail?: string;
}): string {
  const ts = new Date().toISOString();
  const shortId = (input.oldSessionId ?? 'unknown').slice(0, 8);
  const parts: string[] = [
    `## 前世档案（机械转储，LLM 叙事合成未执行/降级）`,
    `meta: ${input.otterName} | ${shortId} | ${ts} | 触发: ${input.trigger}`,
    '',
  ];

  if (input.selfSummary?.trim()) {
    parts.push('### ① 交接意图书（触发方自总结原话）');
    parts.push(input.selfSummary.trim());
    parts.push('');
  }

  parts.push('### 说明');
  parts.push('- LLM 叙事合成未执行或降级（synthesizePast=false / 失败 / 超时），本档案为机械转储形态');
  parts.push('- 完整上下文请查阅：记忆检索（search_messages）、产物（list_artifacts）、上下文（get_context）');
  parts.push('- 上一世 session 文件完整保留在磁盘（Session Chain 可追溯）');
  parts.push('');

  if (input.recencyWindow) {
    parts.push('### 近期保留段（前世最近对话原文）');
    parts.push(input.recencyWindow);
    parts.push('');
  }
  if (input.fileTrail) {
    parts.push('### 文件轨迹');
    parts.push(input.fileTrail);
    parts.push('');
  }
  if (input.stateInventoryText) {
    parts.push('### 活状态盘点');
    parts.push(input.stateInventoryText);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * 组装新世起始上下文（叠加式档案，T4 核心）。
 *
 * 结构（方案「新世起始上下文」节）：
 * ## 前世档案（新世必读）
 * ### ① 交接意图书   ← selfSummary 原话独立保留，不转述（有则显示）
 * ### ② 历史叙事摘要 ← 引擎七段合成（synthesizePast=true 时）
 * ### ③ 交接谱系     ← gen N 跨代链（总在；机械追加）
 * ### ④ 机械供料段   ← 文件轨迹 / 状态盘点 / 近期保留段（总在）
 */
// eslint-disable-next-line max-statements, complexity -- 叠加式档案四段组装：每段一个 if+push 直排（档案段序即结构语义，抽 helper 反而模糊段落边界）
export function assembleHandoffArchive(params: {
  narrativeSummary?: string;
  selfSummary?: string;
  lineage?: string;
  genNAware?: { oldSessionId?: string; oneLineAchievement?: string };
  fileTrail?: string;
  stateInventory?: string;
  recencyWindow?: string;
}): string {
  const parts: string[] = ['## 前世档案（新世必读）', ''];

  if (params.selfSummary?.trim()) {
    parts.push('### ① 交接意图书（触发方原话，不转述）');
    parts.push(params.selfSummary.trim());
    parts.push('');
  }

  if (params.narrativeSummary?.trim()) {
    parts.push('### ② 历史叙事摘要（七段合成）');
    parts.push(params.narrativeSummary.trim());
    parts.push('');
  }

  // ③ 谱系：叙事摘要内含 §⑦ 谱系行；无叙事（synthesizePast=false/降级）时机械追加防断档
  if (!params.narrativeSummary?.trim() && params.lineage) {
    parts.push('### ③ 交接谱系');
    parts.push(params.lineage);
    if (params.genNAware?.oneLineAchievement) {
      parts.push(`- gen? ${(params.genNAware.oldSessionId ?? 'unknown').slice(0, 8)}: ${params.genNAware.oneLineAchievement}`);
    }
    parts.push('');
  }

  if (params.fileTrail) {
    parts.push('### ④ 机械供料：文件轨迹');
    parts.push(params.fileTrail);
    parts.push('');
  }
  if (params.stateInventory) {
    parts.push('### ④ 机械供料：活状态盘点');
    parts.push(params.stateInventory);
    parts.push('');
  }
  if (params.recencyWindow) {
    parts.push('### ④ 机械供料：近期保留段（前世最近对话原文，对齐 Pi keepRecent 20K）');
    parts.push(params.recencyWindow);
    parts.push('');
  }

  return parts.join('\n').trim();
}
