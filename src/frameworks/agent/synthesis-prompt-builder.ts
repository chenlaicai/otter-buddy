/**
 * 交接摘要 LLM 叙事合成 prompt 构建器（F20260825hndf Phase 2）
 *
 * 基于 kimi 的七段模板（info-preservation §2.2），
 * 将件④机械数据注入合成 prompt，指令"§⑤ 用这个数据别自己编"。
 *
 * F20260901mbfx（机械/LLM 分工边界审计）：
 * - §⑤ 注入全量 B1-B6 渲染文本（此前只有 B1/B6 结构化数据，B2-B5 对合成 LLM 不可见）
 * - §④ 注入机械预取数据（context keys + active 产物清单）——枚举型事实不再依赖 LLM 自行调工具
 * - §⑥ 注入最近搭档消息原文——LLM 只负责挑选，不负责翻找
 * - meta 行补 gen N（谱系代数，机械推导）
 *
 * 设计原则：
 * - 机械查事实 + LLM 写叙事（convergence 要点 3）
 * - 锚点优于复制（引用 ID 不复述，防衰减）
 * - 预算 ≤1200 token，硬上限 2000
 */

import type { StateInventory } from './state-inventory';

/** F20260901mbfx：readOnly 合成的自定义工具白名单——只放行只读查询类工具。
 * 设计判据（机制/LLM 分工审计）：合成獭只该读事实，一切写操作/发言/交棒/
 * 实体管理/调度创建都不该在摘要生成路径出现。白名单走"正道"（只列安全项），
 * 新注册工具默认不进白名单——比黑名单（新工具默认放行）安全。
 * 注意：pi-session-factory 的 readOnly 过滤发生在 allowedNames 求交之后，
 * 本名单与 otterType manifest 白名单再求交，双重过滤。 */
export const SYNTHESIS_READ_ONLY_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  // 文件与工作区（只读）
  'read', 'workspace_read', 'workspace_list', 'workspace_info',
  // 上下文与产物（查询）
  'get_context', 'list_artifacts',
  // 记忆系统（检索）
  'search_memory', 'get_memory_detail', 'get_related', 'search_terminology',
  // 消息与对话（查询）
  'search_messages', 'list_messages', 'get_message', 'get_turn_history',
  // 协作状态（查询）
  'get_active_participants', 'query_dispatch_ledger',
]);

/** §④ 机械预取数据 */
export interface SynthesisPrefetch {
  /** otter_context 的 key 名列表（不含值——新 session 用 get_context 自取） */
  contextKeys?: string[];
  /** active 产物清单（ID + 类型 + 标题） */
  activeArtifacts?: Array<{ id: string; resourceType: string; title?: string }>;
  /** 最近搭档（用户）消息原文，按时间正序，供 §⑥ 挑选引用 */
  recentUserMessages?: string[];
}

/** 合成 prompt 选项 */
export interface SynthesisPromptOptions {
  /** otter 名称 */
  otterName: string;
  /** 旧 session ID（取前 8 位） */
  oldSessionId: string;
  /** 交接谱系（从旧 summary 继承） */
  lineage?: string;
  /** 件④机械数据（B1-B6 全量） */
  stateInventory?: StateInventory;
  /** 件④渲染后的完整文本（§⑤ 注入用） */
  stateInventoryText?: string;
  /** 触发原因 */
  trigger: '70%阈值' | '手动' | '熔断';
  /** 当前时间 */
  timestamp?: string;
  /** §④/§⑥ 机械预取数据（F20260901mbfx） */
  prefetch?: SynthesisPrefetch;
}

/**
 * 构建 LLM 叙事合成 prompt。
 *
 * 将 kimi 六分区模板 + 件④机械数据组装为一个完整的合成指令，
 * 发送给旧 session 的 LLM（readOnly invocation）。
 */
export function buildSynthesisPrompt(options: SynthesisPromptOptions): string {
  const {
    otterName,
    oldSessionId,
    lineage,
    stateInventory,
    stateInventoryText,
    trigger,
    timestamp,
    prefetch,
  } = options;

  const ts = timestamp ?? new Date().toISOString();
  const shortId = oldSessionId.slice(0, 8);
  // F20260901mbfx：gen N 谱系代数机械推导（lineage 行数 + 1），无 lineage 则 gen1
  const genN = lineage ? lineage.split('\n').filter(l => l.trim().length > 0).length + 1 : 1;

  const parts: string[] = [
    `[系统-交接摘要合成] 你正在执行上下文交接。请按照以下模板生成交接摘要。

规则：
1. §④/⑥ 的机械预取数据已在下方提供——枚举型事实用这些，不要自行调工具重查（查错了没有完据）
2. 需要补充细节时可用只读工具（search_memory / search_messages 等），但优先用已提供数据
3. 锚点优于复制——引用 ID 而非复述内容
4. 搭档指令用原话引用（引号内）——从下方预取的搭档消息里挑
5. 谱系继承旧 summary 并追加一行
6. §⑤ 协作状态必须使用下方提供的机械数据，不要自行回忆
7. 完成后直接输出摘要文本，不需要调用 speak
8. 预算：≤1200 token，硬上限 2000 token

模板：

## 交接摘要
meta: ${otterName} | gen ${genN} | ${shortId} → 新session | ${ts} | 触发: ${trigger}

### ① 下一步（最高优先）
- 立即动作：{{一句具体可执行的话，含对象和预期产出}}
- 阻塞于：{{等谁/等什么，无则写"无"}}

### ② 当前任务与完成标准
- 任务：{{一句话}}
- 完成标准：{{可判定的标准，尽量引用搭档原话}}
- 状态：in_progress / awaiting_review / awaiting_user / blocked

### ③ 关键决策与理由（最多5条，只增不删）
- {{决策}} ← 因为 {{一句话理由}} 〔锚点: Fxxx/msg/entry_id〕
- ⚠️ 已排除路径：{{试过什么、为什么不行}} ← 防止后代重蹈

### ④ 产物与锚点
- PR: {{#号 状态}} ｜ 文档: {{F-ID 标题}} ｜ 记忆: {{entry_id 一句话}}
- worktree/分支: {{路径}} ｜ 工作区文件: {{相对路径}}
- otter_context keys: {{key名列表，不含值——新 session 用 get_context 自取}}

【§④ 机械预取数据（枚举事实，直接用）】
${formatPrefetchSection(prefetch)}

### ⑤ 协作状态
${formatStateInventoryForPrompt(stateInventory, stateInventoryText)}

### ⑥ 搭档上下文
- 最近明确指令/偏好（原话引用）："{{...}}"

【§⑥ 机械预取：最近搭档消息原文（从中挑选指令性语句，按时间正序）】
${formatRecentUserMessages(prefetch)}
- 节奏信号（可选一句）：{{如"搭档今天偏向快速迭代，别走重流程"}}

### ⑦ 交接谱系（每代一行，只追加）
${lineage ? `${lineage}
- gen${genN} ${shortId}: {{一句话干了什么}}` : `- gen1 ${shortId}: {{一句话干了什么}}`}

请基于当前 session 的完整上下文，按照上述模板生成交接摘要。`,
  ];

  return parts.join('\n');
}

/**
 * F20260901mbfx：格式化 §④ 机械预取数据。
 * 无数据时明说"无预取"——省略会让 LLM 不确定是"没查"还是"没有"（件④设计同源原则）。
 */
function formatPrefetchSection(prefetch?: SynthesisPrefetch): string {
  if (!prefetch) return '- （无预取数据，可用只读工具自查）';
  const lines: string[] = [];
  if (prefetch.contextKeys) {
    lines.push(`- otter_context keys: ${prefetch.contextKeys.length > 0 ? prefetch.contextKeys.join(', ') : '（空）'}`);
  }
  if (prefetch.activeArtifacts) {
    if (prefetch.activeArtifacts.length === 0) {
      lines.push('- active 产物: 无');
    } else {
      const arts = prefetch.activeArtifacts.map(a => `${a.resourceType} ${a.id.slice(0, 8)}${a.title ? `「${a.title}」` : ''}`);
      lines.push(`- active 产物（${prefetch.activeArtifacts.length} 个）: ${arts.join(' ｜ ')}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '- （无预取数据，可用只读工具自查）';
}

/**
 * F20260901mbfx：格式化 §⑥ 最近搭档消息原文（去空白行，带序号，时间正序）。
 */
function formatRecentUserMessages(prefetch?: SynthesisPrefetch): string {
  if (!prefetch?.recentUserMessages || prefetch.recentUserMessages.length === 0) {
    return '- （无预取，从 session 上下文中自行识别搭档消息）';
  }
  return prefetch.recentUserMessages
    .map((m, i) => `${i + 1}. ${m}`)
    .join('\n');
}

/**
 * 格式化件④机械数据为 prompt 内容（§⑤）。
 *
 * F20260901mbfx：优先注入 stateInventoryText（renderStateInventory 的全量 B1-B6
 * 渲染文本——此前只注入 B1/B6 结构化摘要，B2-B5（调度任务/工作区/产物/healing）
 * 对合成 LLM 不可见）；无渲染文本时降级用结构化数据现拼 B1/B6。
 */
function formatStateInventoryForPrompt(
  inventory?: StateInventory,
  fallbackText?: string,
): string {
  // F20260901mbfx：优先全量 B1-B6 渲染文本（件④一次聚合两用，与给新 session 的
  // otter_context 注入同源——同一份数据两处消费，无竞态窗口）。
  // 裁掉首行标题（含时间戳，meta 行已有）保持 §⑤ 紧凑。
  // 仅滤标题行与首尾空行（boundary 审视发现：全量空行过滤会在未来
  // renderStateInventory 增加分组空行时静默吞掉分隔——只裁首尾，保留中段）。
  if (fallbackText) {
    // 先滤标题行，再裁首尾空行（顺序关键：标题行若在首，filter 后会暴露首空行）
    const stripped = fallbackText.split('\n').filter(l => !l.startsWith('## '));
    const first = stripped.findIndex(l => l.trim() !== '');
    const last = stripped.length - 1 - [...stripped].reverse().findIndex(l => l.trim() !== '');
    const body = first >= 0 ? stripped.slice(first, last + 1) : [];
    if (body.length > 0) return body.join('\n');
  }
  if (inventory) {
    const parts: string[] = [];
    if (inventory.talkingStone) {
      const holders = inventory.talkingStone.holders.join(', ');
      const from = inventory.talkingStone.from ? `（${inventory.talkingStone.from} yield）` : '';
      parts.push(`- 在场: ${holders} 手中${from}`);
    } else {
      parts.push('- 在场: 无悬置');
    }
    if (inventory.activity.status !== 'idle' && inventory.activity.status !== 'unknown') {
      let line = `- 进行中: ${inventory.activity.status}`;
      if (inventory.activity.waitingFor) line += `，等待 ${inventory.activity.waitingFor}`;
      parts.push(line);
    } else {
      parts.push('- 进行中: 无');
    }
    return parts.join('\n');
  }
  return '- 在场: 无数据';
}

/**
 * 构建降级摘要（防线②：机械转储）。
 *
 * 当 LLM 合成失败/超时时使用，保留 Phase 1 的机械转储逻辑。
 */
export function buildMechanicalDump(
  otterName: string,
  trigger: string,
  stateInventoryText?: string,
): string {
  const ts = new Date().toISOString();
  const parts: string[] = [
    '## 交接摘要（机械转储，LLM 合成降级）',
    `meta: ${otterName} | ${ts} | 触发: ${trigger}`,
    '',
    '### 说明',
    '- LLM 叙事合成失败/超时，降级为机械转储',
    '- 完整上下文请查阅：记忆检索（search_messages）、产物（list_artifacts）、上下文（get_context）',
  ];
  if (stateInventoryText) {
    parts.push('', '### 活状态盘点', stateInventoryText);
  }
  return parts.join('\n');
}
