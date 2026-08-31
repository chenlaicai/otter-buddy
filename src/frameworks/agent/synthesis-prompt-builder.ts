/**
 * 交接摘要 LLM 叙事合成 prompt 构建器（F20260825hndf Phase 2）
 *
 * 基于 kimi 的六分区模板（info-preservation §2.2），
 * 将件④机械数据（B1/B6）注入合成 prompt，指令"§⑤ 用这个数据别自己编"。
 *
 * 设计原则：
 * - 机械查事实 + LLM 写叙事（convergence 要点 3）
 * - 锚点优于复制（引用 ID 不复述，防衰减）
 * - 预算 ≤1200 token，硬上限 2000
 */

import type { StateInventory } from './state-inventory';

/** 合成 prompt 选项 */
export interface SynthesisPromptOptions {
  /** otter 名称 */
  otterName: string;
  /** 旧 session ID（取前 8 位） */
  oldSessionId: string;
  /** 交接谱系（从旧 summary 继承） */
  lineage?: string;
  /** 件④机械数据（B1/B6） */
  stateInventory?: StateInventory;
  /** 件④渲染后的完整文本 */
  stateInventoryText?: string;
  /** 触发原因 */
  trigger: '70%阈值' | '手动' | '熔断';
  /** 当前时间 */
  timestamp?: string;
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
  } = options;

  const ts = timestamp ?? new Date().toISOString();
  const shortId = oldSessionId.slice(0, 8);

  const parts: string[] = [
    `[系统-交接摘要合成] 你正在执行上下文交接。请按照以下模板生成交接摘要。

规则：
1. 使用 get_context 获取结构化工作状态
2. 使用 list_artifacts 获取当前对话产物
3. 锚点优于复制——引用 ID 而非复述内容
4. 搭档指令用原话引用（引号内）
5. 谱系继承旧 summary 并追加一行
6. §⑤ 协作状态必须使用下方提供的机械数据，不要自行回忆
7. 完成后直接输出摘要文本，不需要调用 speak
8. 预算：≤1200 token，硬上限 2000 token

模板：

## 交接摘要
meta: ${otterName} | ${shortId} → 新session | ${ts} | 触发: ${trigger}

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

### ⑤ 协作状态
${formatStateInventoryForPrompt(stateInventory, stateInventoryText)}

### ⑥ 搭档上下文
- 最近明确指令/偏好（原话引用）："{{...}}"
- 节奏信号（可选一句）：{{如"搭档今天偏向快速迭代，别走重流程"}}

### ⑦ 交接谱系（每代一行，只追加）
${lineage ? `- ${lineage}` : `- gen1 ${shortId}: {{一句话干了什么}}`}

请基于当前 session 的完整上下文，按照上述模板生成交接摘要。`,
  ];

  return parts.join('\n');
}

/**
 * 格式化件④机械数据为 prompt 内容。
 *
 * 如果有完整的 stateInventory 对象，渲染为结构化文本；
 * 否则使用预渲染的 stateInventoryText（降级）。
 */
function formatStateInventoryForPrompt(
  inventory?: StateInventory,
  fallbackText?: string,
): string {
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
  if (fallbackText) {
    // 从预渲染文本中提取 §⑤ 相关行
    const lines = fallbackText.split('\n');
    const relevant = lines.filter(l =>
      l.includes('发言石') || l.includes('进行中') || l.includes('在场')
    );
    return relevant.length > 0 ? relevant.join('\n') : '- 在场: 无数据';
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
