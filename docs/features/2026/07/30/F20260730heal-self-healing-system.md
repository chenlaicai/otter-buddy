# Self-Healing System 方案（v6 — 五轮审视终稿）

> **v1 → v2**：解决了 3 个 CRITICAL（body 不可变、记忆污染、数据访问脱节）。
> **v2 → v3**：补齐 3 个 MAJOR（createTools DI、SchedulerService 依赖、triggerTask 双路径一致性）。
> **v3 → v4**：解决了 2 个 CRITICAL（空 body 入库、bigOtterId 不存在）+ 4 个 MAJOR。
> **v4 → v5**：解决了 3 个 CRITICAL（createTools DI 路径断裂、SettingsRepository API、QueryConversation）+ 5 个 MAJOR。
> **v5 → v6**：解决了 2 个 CRITICAL（triggerTask null 跳过缺失、sendMessage 依赖缺失）+ 2 个 MAJOR（D8/D16 文档矛盾、闭包与签名扩展关系不清）。

## 1. 设计目标

让 otter-buddy 在日常使用中自动发现问题、归因分析、并在人的参与下修复问题，形成 **"使用 → 发现 → 分析 → 修复 → 验证"** 的闭环。

核心原则：
- **Agent 自报告**：每次 invocation 结束时，agent 在 speak 中附带一段结构化的 "healing report"
- **系统自动采集**：在 speak 工具执行层拦截 healing report，写入 `healing_events` 表，healing 标签**永远不进入 message body**
- **对话式修复**：系统维护一个专属 "Self-Healing" 对话，定时任务触发 agent 在该对话中分析问题，人和 agent 协作决定修复方案
- **人在回路**：agent 只能提议，不能自主修改 prompt/工具/代码

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  普通对话 invocation                                              │
│  ┌──────────┐    ┌──────────────────────────────────────────┐   │
│  │ LLM 推理 │───▶│ speak tool execute (tool-factory.ts)     │   │
│  │ + 工具调用│    │                                          │   │
│  └──────────┘    │  1. parseHealingReport(body) → issues[]  │   │
│                  │  2. stripHealingReport(body) → cleanBody  │   │
│                  │  3. startSpeaking(cleanBody, targets)     │   │
│                  │  4. healingEventRepo.create(issues)       │   │
│                  └──────────────────────┬───────────────────┘   │
└─────────────────────────────────────────┼───────────────────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          │                               │
                          ▼                               ▼
              ┌──────────────────────┐      ┌──────────────────────┐
              │ messages 表           │      │ healing_events 表    │
              │ body = 纯净内容       │      │ 结构化 issues        │
              │ (无 healing 标签)     │      │ status=open          │
              │ memory 索引纯净       │      └──────────┬───────────┘
              └──────────────────────┘                 │
                                        ┌──────────────┼──────────────┐
                                        │              │              │
                                        ▼              ▼              ▼
                                ┌────────────┐ ┌────────────┐ ┌────────────┐
                                │ 日志记录    │ │ 定时分析    │ │ 手动触发    │
                                │ pino logger │ │ (cron 调度) │ │ 对话中直接  │
                                └────────────┘ └─────┬──────┘ │ 询问 agent  │
                                                      │        └─────┬──────┘
                                                      ▼              ▼
                                            ┌──────────────────────────────┐
                                            │ Self-Healing 对话             │
                                            │ (系统启动时自动创建)          │
                                            │                              │
                                            │ 系统侧在 prompt 中注入:       │
                                            │   - 待处理 healing_events     │
                                            │   - 统计摘要                  │
                                            │                              │
                                            │ Agent 在此对话中:             │
                                            │   1. 分析注入的问题数据       │
                                            │   2. 聚类分析根因             │
                                            │   3. 提出修复建议             │
                                            │   4. 人审核、拍板             │
                                            │   5. 记录决策到 memory        │
                                            └──────────────────────────────┘
```

**关键设计变更（v2）**：healing report 的拦截点在 speak 工具的 `execute` 闭包中（`tool-factory.ts`），而非 `_handlePostInvocation()`。这意味着 `<healing>` 标签**从未被写入 message body**，从根本上解决了 body 不可变和记忆索引污染的问题。

## 3. 详细设计

### 3.1 Agent 自报告：Healing Report 协议

#### 3.1.1 Prompt 层：在 speak body 中嵌入 healing report

**只修改 BIG_OTTER.md**。Small Otter 是任务型 agent，干完即走，不承担系统级 healing 报告职责。Small Otter 发现的系统问题会自然地在 speak 中提出，Big Otter 在聚合时捕获。

在 BIG_OTTER.md 末尾追加：

```markdown
## Self-Healing Report

在你每次 speak 时，如果你在本次调用中遇到了系统层面的问题（不是用户问题本身，而是工具/机制/流程让你感到"不好用"），请在 speak body 末尾附加一个 healing report：

<healing>
[no_issue] 或
[issues]
- type: tool_failure | missing_context | wrong_tool | format_violation | knowledge_gap | performance | other
  severity: low | medium | high
  description: 简要描述问题（单行，不超过 200 字）
  suggestion: 你认为应该怎么修（单行，不超过 200 字）
[/issues]
</healing>

规则：
- 如果本次调用一切顺利，输出 `<healing>[no_issue]</healing>`
- 如果有多个问题，每个问题一个条目
- severity 判断标准：
  - low: 不影响结果，但体验不佳（如工具返回格式不够友好）
  - medium: 影响效率，需要额外步骤绕过（如检索不到该有的记忆）
  - high: 导致任务失败或严重偏离预期（如工具报错、格式违反协议）
- description 和 suggestion 必须单行，不要换行
- 不要在 healing report 中包含用户对话原文、API 密钥、token 等敏感信息
- 这段内容会被系统自动解析并从你的发言中剥离，用户不会看到
```

#### 3.1.2 speak 工具侧：拦截 + 剥离（核心变更）

**修改 `tool-factory.ts` 中的 `createSpeakTool()`**。在 speak 的 `execute` 闭包中，在调用 `startSpeaking()` 之前，解析并剥离 `<healing>` 标签。

```typescript
function createSpeakTool(ctx: ToolContext, healingRepo?: HealingEventRepo, logger?: Logger): AgentTool {
  return {
    name: "speak",
    // ... description, parameters 不变 ...
    execute: async (_id: string, params: Record<string, unknown>) => {
      const rawBody = params.body as string;
      const recipients = params.talkingStonePassedTo as string[];

      // ── Self-Healing: 先 strip，再校验（R3-01 修复） ──
      let cleanBody = rawBody;
      if (healingRepo) {
        cleanBody = stripHealingReport(rawBody);
        // 解析用 rawBody（包含 healing 标签）
        const report = parseHealingReport(rawBody);
        if (report.hasIssues) {
          const context = { otterId: ctx.otterId, conversationId: ctx.conversationId, messageId: ctx.currentMessageId };
          for (const issue of report.issues) {
            healingRepo.create({
              id: generateId(),
              messageId: ctx.currentMessageId,
              conversationId: ctx.conversationId,
              otterId: ctx.otterId,
              errorType: issue.type,
              severity: issue.severity,
              description: issue.description,
              suggestion: issue.suggestion,
              context,
              status: 'open',
              resolution: null,
            }).catch(err => logger?.error('Failed to store healing event', err));
          }
        }
      }
      // ── end healing ──

      // 现有验证逻辑：校验 cleanBody（而非 rawBody）
      if (!cleanBody || cleanBody.trim().length === 0) {
        return textResponse("[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。");
      }
      if (!recipients || recipients.length === 0) {
        return textResponse("[错误] talkingStonePassedTo 不能为空数组。请指定下一个应该发言的参与者 ID。");
      }
      if (recipients.includes(ctx.otterId)) {
        return textResponse(`[错误] 不能把发言石传给自己（${ctx.otterId}）。请先调用 get_active_participants 获取在场成员，然后选择其他参与者。`);
      }

      // ... 现有目标校验 + startSpeaking(cleanBody) ...
    },
  };
}
```

**R3-01 修复**：先 strip 再校验。当 agent 输出 `<healing>[no_issue]</healing>` 且无其他内容时，`cleanBody` 为空，校验拦截并返回错误提示，不会写入 DB。

**R3-07 修复**：`createSpeakTool` 新增可选 `logger` 参数，由闭包注入。

**为什么这个方案优于 v1：**

| 问题 | v1 方案 | v2 方案（当前） |
|------|---------|----------------|
| body 不可变 | post-invocation strip，无写回路径 | speak execute 中 strip，**从未写入 DB** |
| 记忆索引污染 | strip 后需 reindex | body 本身无标签，**索引天然纯净** |
| 前端展示 | 需要额外 strip | **直接正确** |
| 修改文件 | 声称不改 tool-factory.ts（矛盾） | 诚实列出修改 tool-factory.ts |

#### 3.1.3 为什么放在 speak 而不是单独工具

不变。核心理由：
- 不增加 LLM 的工具调用开销
- 不破坏现有的 tool call 计数和熔断器逻辑
- 与 speak 的"终结发言"语义天然契合
- 如果 agent 忘了写，不造成任何副作用

### 3.2 解析器设计

```typescript
// src/usecases/healing/healing-report-parser.ts

const VALID_TYPES = [
  'tool_failure', 'missing_context', 'wrong_tool',
  'format_violation', 'knowledge_gap', 'performance', 'other',
] as const;

const VALID_SEVERITIES = ['low', 'medium', 'high'] as const;

export interface HealingIssue {
  type: typeof VALID_TYPES[number];
  severity: typeof VALID_SEVERITIES[number];
  description: string;
  suggestion: string;
}

export interface ParsedHealingReport {
  hasIssues: boolean;
  issues: HealingIssue[];
}

/**
 * 从 speak body 中解析 healing report。
 * 鲁棒性处理：normalize、白名单校验、多行支持。
 */
export function parseHealingReport(body: string): ParsedHealingReport {
  // 1. Normalize：去 markdown 转义、统一大小写
  const normalized = body
    .replace(/\\<|\\>/g, m => m.slice(1))  // \<healing\> → <healing>
    .replace(/`<healing>`/gi, '<healing>')  // `<healing>` → <healing>
    .replace(/<\/healing>/gi, '</healing>');

  // 2. 提取 <healing>...</healing> 块（不区分大小写）
  const match = normalized.match(/<healing>([\s\S]*?)<\/healing>/i);
  if (!match) return { hasIssues: false, issues: [] };

  const content = match[1].trim();
  if (/\[no.?issue\]/i.test(content)) return { hasIssues: false, issues: [] };

  // 3. 提取 [issues]...[/issues] 块
  const issueBlock = content.match(/\[issues\]([\s\S]*?)\[\/issues\]/i);
  if (!issueBlock) return { hasIssues: false, issues: [] };

  // 4. 按 "- type:" 分割条目
  const entries = issueBlock[1].split(/(?=- type:)/gi).filter(Boolean);
  const issues: HealingIssue[] = [];

  for (const entry of entries) {
    const type = entry.match(/type:\s*(\S+)/i)?.[1]?.toLowerCase();
    const severity = entry.match(/severity:\s*(\S+)/i)?.[1]?.toLowerCase();
    // description/suggestion 支持多行：匹配到下一个 key 或条目结尾
    const description = entry.match(/description:\s*([\s\S]*?)(?=\s*suggestion:|$)/i)?.[1]?.trim();
    const suggestion = entry.match(/suggestion:\s*([\s\S]*?)$/i)?.[1]?.trim();

    if (!description) continue;

    issues.push({
      type: VALID_TYPES.includes(type as any) ? type as HealingIssue['type'] : 'other',
      severity: VALID_SEVERITIES.includes(severity as any) ? severity as HealingIssue['severity'] : 'low',
      description: description.slice(0, 500),  // 防止异常长文本
      suggestion: (suggestion ?? '').slice(0, 500),
    });
  }

  // 5. 防误解析：R3-10 修复 — 改为绝对长度阈值（避免短 body 误杀）
  if (issues.length > 0 && match[0].length > 5000) {
    return { hasIssues: false, issues: [] };
  }

  // 6. 单次报告 issues 数量上限
  const MAX_ISSUES_PER_REPORT = 10;
  const capped = issues.slice(0, MAX_ISSUES_PER_REPORT);

  return { hasIssues: capped.length > 0, issues: capped };
}

/**
 * 从 speak body 中剥离 healing report。
 */
export function stripHealingReport(body: string): string {
  return body
    .replace(/<healing>[\s\S]*?<\/healing>/gi, '')
    .replace(/\n{3,}/g, '\n\n')  // 清理多余空行
    .trim();
}
```

### 3.3 数据存储：healing_events 表

#### 3.3.1 Schema

```sql
CREATE TABLE healing_events (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  otter_id        TEXT NOT NULL,
  error_type      TEXT NOT NULL,  -- HealingIssue.type
  severity        TEXT NOT NULL,  -- low | medium | high
  description     TEXT NOT NULL,
  suggestion      TEXT NOT NULL DEFAULT '',
  context         TEXT,           -- JSON: { otterId, conversationId, messageId }
  status          TEXT NOT NULL DEFAULT 'open',  -- open | analyzing | resolved | dismissed
  resolution      TEXT,           -- JSON: { action, decidedBy, decidedAt, notes }
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX idx_healing_events_status ON healing_events(status);
CREATE INDEX idx_healing_events_severity ON healing_events(severity);
CREATE INDEX idx_healing_events_created ON healing_events(created_at);
CREATE INDEX idx_healing_events_type ON healing_events(error_type);
```

#### 3.3.2 Entity + Repository 接口

```typescript
// src/entities/healing/healing-event.ts

export interface HealingEvent {
  id: string;
  messageId: string;
  conversationId: string;
  otterId: string;
  errorType: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  suggestion: string;
  context: Record<string, unknown> | null;
  status: 'open' | 'analyzing' | 'resolved' | 'dismissed';
  resolution: HealingResolution | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface HealingResolution {
  action: 'prompt_updated' | 'memory_added' | 'tool_fixed' | 'config_changed' | 'no_action' | 'deferred';
  decidedBy: 'user' | 'agent';
  decidedAt: string;
  notes: string;
}

export interface HealingEventRepo {
  create(event: Omit<HealingEvent, 'createdAt' | 'resolvedAt'>): Promise<void>;
  findById(id: string): Promise<HealingEvent | null>;
  findOpen(limit?: number): Promise<HealingEvent[]>;
  findAll(status: HealingEvent['status'], limit?: number): Promise<HealingEvent[]>;  // R3-14: 全局查询
  findByConversation(conversationId: string): Promise<HealingEvent[]>;
  updateStatus(id: string, status: HealingEvent['status']): Promise<void>;
  resolve(id: string, resolution: HealingResolution): Promise<void>;
  getStats(): Promise<{
    open: number;
    resolved: number;
    dismissed: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  }>;
  /** 自动清理：dismiss 超过 N 天未更新的 open 事件 */
  autoStaleDismiss(staleDays: number): Promise<number>;
}
```

### 3.4 Self-Healing 对话

#### 3.4.1 启动时自动创建

在 `main.ts` 的初始化序列中，`reconcileOrphans()` 之后，新增一步：

```typescript
// src/usecases/healing/ensure-healing-conversation.ts
// C-02 + C-03 修复：使用实际存在的 API

const HEALING_CONVERSATION_TITLE = '🩺 Self-Healing';
const HEALING_CONVERSATION_KEY = '__self_healing_conversation_id__';
const HEALING_BIG_OTTER_ID_KEY = '__self_healing_big_otter_id__';

export interface HealingConversationResult {
  conversationId: string;
  bigOtterId: string;
}

export async function ensureHealingConversation(deps: {
  manageConversation: ManageConversation;  // C-03: 用 ManageConversation.getById
  convRepo: ConversationRepository;         // C-03: 用 ConversationRepository.getActiveParticipants
  settings: SettingsRepository;             // C-02: 用 update() 不是 set()
  sendMessage: SendMessage;                 // R5-Issue2: sendSystem 依赖
}): Promise<HealingConversationResult> {
  // 检查是否已有
  const existingId = await deps.settings.get(HEALING_CONVERSATION_KEY);
  if (existingId) {
    const conv = await deps.manageConversation.getById(existingId);
    if (conv && conv.status === 'active') {
      const bigOtterId = await deps.settings.get(HEALING_BIG_OTTER_ID_KEY);
      if (bigOtterId) return { conversationId: existingId, bigOtterId };
    }
  }

  // 创建对话（ManageConversation.create 内部自动创建大獭 + 加入参与者）
  const conversation = await deps.manageConversation.create({
    title: HEALING_CONVERSATION_TITLE,
  });

  // C-03: 查询参与者找到大獭 ID（使用 ConversationRepository.getActiveParticipants）
  const participants = await deps.convRepo.getActiveParticipants(conversation.id);
  const bigOtterParticipant = participants.find(p => p.status === 'active');
  if (!bigOtterParticipant) {
    throw new Error('Self-Healing conversation created without a big otter participant');
  }
  const bigOtterId = bigOtterParticipant.otterId;

  // C-02: 使用 update() 而非 set()
  await deps.settings.update(HEALING_CONVERSATION_KEY, conversation.id);
  await deps.settings.update(HEALING_BIG_OTTER_ID_KEY, bigOtterId);

  return { conversationId: conversation.id, bigOtterId };
}
```

#### 3.4.2 Self-Healing 对话 UX 设计（M-05 修复）

**首条引导消息**：创建对话后发送系统消息，引导用户了解用途：

```typescript
// ensureHealingConversation 中，创建对话后
await deps.sendMessage.sendSystem(conversation.id,
  `🩺 **Self-Healing 对话已创建**

这是系统的自愈对话。系统会自动收集日常使用中发现的问题（如工具报错、检索不准等），并定期在此对话中汇报分析结果。

**你可以：**
- 查看 agent 的分析报告和修复建议
- 对修复建议说"同意"让 agent 执行（术语/记忆类）
- 对修复建议说"驳回"标记为已忽略
- 随时在这里说"分析最近的问题"触发即时分析

**定时分析**：每天上午 10 点自动触发。`
);
```

**Big Otter 在 Self-Healing 对话中的身份 prompt**（通过对话级别 systemPrompt 注入）：

```markdown
你是 Self-Healing 系统的分析 agent。你的职责：

1. 分析系统收集的 healing events（定时任务会自动注入待处理问题）
2. 按类型聚类，识别根因模式
3. 提出修复建议（分三类）：
   - 记忆/知识类：你可以用 add_terminology 或 set_context 直接修复
   - Prompt 类：需要人审核后修改 identity prompt
   - 工具/流程类：需要开发介入，生成 issue 描述
4. 和搭档讨论，达成共识后用 manage_healing_events 标记决策

修复能力边界：
- 你可以：添加术语、添加 memory、调整 otter context、查询/管理 healing events
- 你不能：修改 system prompt 文件、修改工具代码、修改数据库 schema
- 对于你需要但不能做的，生成清晰的修复指令供搭档执行

交互规则：
- 搭档说"同意" → 执行你建议的修复，然后 resolve 事件
- 搭档说"驳回" → dismiss 事件
- 搭档说"延后" → 保持 open
```

**"无问题"时静默处理**（M-05 噪音修复）：`buildHealingAnalysisBody` 返回 `null` 表示无待处理事件，`triggerTask` 中跳过本次分析不产生噪音消息。

### 3.5 定时分析任务

#### 3.5.1 Scheduler 集成

```typescript
// src/usecases/healing/ensure-healing-scheduler.ts

const HEALING_CRON = '0 10 * * *'; // 每天上午 10 点
const HEALING_TASK_NAME = 'self-healing-analysis';

export async function ensureHealingScheduler(deps: {
  manageScheduledTask: ManageScheduledTask;
  scheduledTaskRepo: ScheduledTaskRepository;
  healingConversationId: string;
  bigOtterId: string;
}): Promise<void> {
  // R3-05 修复：方法名对齐为 getByConversationId
  const tasks = await deps.scheduledTaskRepo.getByConversationId(deps.healingConversationId);
  const existing = tasks.find(t => t.name === HEALING_TASK_NAME);
  if (existing && existing.status === 'active') return;

  await deps.manageScheduledTask.create({
    conversationId: deps.healingConversationId,
    name: HEALING_TASK_NAME,
    cron: HEALING_CRON,
    timezone: 'Asia/Shanghai',
    body: '[self-healing-analysis]',
    talkingStonePassedTo: [deps.bigOtterId],
    senderId: 'system',
  });
}
```

#### 3.5.2 定时任务 prompt 动态注入（关键变更）

**不依赖 agent 自己查询 healing_events**。在 `SchedulerService.triggerTask()` 中，当识别到 `[self-healing-analysis]` 标记时，系统侧查询 healing_events 并拼接到 prompt 中。

```typescript
// 修改 scheduler-service.ts 的 triggerTask 方法
// 在创建 system message 之前，检查 body 是否为 healing analysis 标记

async function buildHealingAnalysisBody(
  originalBody: string,
  healingRepo: HealingEventRepo,
): Promise<string | null> {
  if (!originalBody.includes('[self-healing-analysis]')) {
    return originalBody;
  }

  await healingRepo.autoStaleDismiss(30);
  const stats = await healingRepo.getStats();
  const openEvents = await healingRepo.findOpen(20);

  // M-05: 无待处理事件时返回 null，triggerTask 跳过本次分析
  if (openEvents.length === 0) {
    return null;
  }

  const eventsByType = openEvents.reduce((acc, e) => {
    (acc[e.errorType] ??= []).push(e);
    return acc;
  }, {} as Record<string, typeof openEvents>);

  let prompt = `## Self-Healing 定期分析任务

当前系统健康概况：
- 待处理: ${stats.open} 个
- 已解决: ${stats.resolved} 个
- 已忽略: ${stats.dismissed} 个
- 按类型分布: ${JSON.stringify(stats.byType)}
- 按严重程度分布: ${JSON.stringify(stats.bySeverity)}

以下是待处理的 healing events（共 ${openEvents.length} 条，按类型分组）：

`;

  for (const [type, events] of Object.entries(eventsByType)) {
    prompt += `### ${type} (${events.length} 条)\n\n`;
    for (const e of events) {
      prompt += `- [${e.severity}] ${e.description}\n`;
      if (e.suggestion) prompt += `  建议: ${e.suggestion}\n`;
    }
    prompt += '\n';
  }

  prompt += `请执行以下步骤：
1. 分析上述问题的根因，识别是否有重复/聚类模式
2. 对于你有能力直接修复的（术语、记忆类），提出具体建议
3. 对于需要修改 prompt 或代码的，生成清晰的修复描述
4. 与搭档讨论，达成共识后记录决策`;

  // 总长度硬上限：超过 8000 字时截断
  const MAX_PROMPT_LENGTH = 8000;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = prompt.slice(0, MAX_PROMPT_LENGTH) + '\n\n... (内容过长已截断，请使用 manage_healing_events 工具查询更多)';
  }

  return prompt;
}
```

**这个方案的优势：**
- Agent 无需额外工具即可访问 healing events 数据
- 数据在 prompt 中直接可见，不依赖检索
- 如果无待处理事件，prompt 自动简化为"无问题"，不浪费 token

#### 3.5.3 SchedulerService.triggerTask 改造

`triggerTask` 中 `task.body` 被两处消费（`createSystemMessage` 和 `invokeAgentWithTimeout`）。改造方案：提取 `effectiveBody` 局部变量，同时注入两处。

```typescript
// scheduler-service.ts 改造

interface SchedulerServiceOptions {
  // ... 现有字段 ...
  healingRepo?: HealingEventRepo;  // 新增，可选
}

private async triggerTask(task: ScheduledTask): Promise<{ executionId: string }> {
  const now = new Date().toISOString();
  await this.claimAndValidateTask(task, now);

  // ── Healing: 动态替换 body ──
  let effectiveBody: string | null = task.body;
  if (this.healingRepo && task.body.includes('[self-healing-analysis]')) {
    // M-04: autoStaleDismiss 用独立 try-catch，失败不中断主流程
    try {
      await this.healingRepo.autoStaleDismiss(30);
    } catch (err) {
      this.logger.warn('autoStaleDismiss failed, continuing with analysis', err as Error);
    }
    effectiveBody = await buildHealingAnalysisBody(task.body, this.healingRepo);

    // R5-Issue1: 无 open events 时静默跳过，不创建 execution 记录
    if (effectiveBody === null) {
      this.logger.info('Healing analysis skipped: no open events');
      return { executionId: '' };
    }
  }
  // ── end healing ──

  const executionId = crypto.randomUUID();
  await this.createExecution(executionId, task.id, now);

  try {
    // 两个子方法都使用 effectiveBody
    const message = await this.createSystemMessageWithBody(task, effectiveBody!);
    await this.invokeAgentWithTimeoutAndBody(task, effectiveBody);
    await this.completeExecution(executionId, task.conversationId, message.id);
    await this.taskRepo.resetConsecutiveFailures(task.id, now);
    return { executionId };
  } catch (error) {
    await this.handleExecutionFailure(executionId, task.id, error);
    throw error;
  }
}

// 新增两个接受 override body 的内部方法
private async createSystemMessageWithBody(task: ScheduledTask, body: string) {
  return this.sendMessage.send({
    conversationId: task.conversationId,
    senderType: 'system',
    senderId: task.senderId,
    body,
    talkingStonePassedTo: task.talkingStonePassedTo,
  });
}

private async invokeAgentWithTimeoutAndBody(task: ScheduledTask, body: string): Promise<void> {
  const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      this.agentInvokePort.invokeConversation({
        otterId: task.talkingStonePassedTo[0],
        conversationId: task.conversationId,
        userMessageContent: body,  // 使用 dynamic body
        senderId: task.senderId,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Agent invocation timeout')), AGENT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

**关键点**：`effectiveBody` 同时传给 `createSystemMessageWithBody`（用户看到的系统消息）和 `invokeAgentWithTimeoutAndBody`（agent 收到的 userMessageContent），保证一致性。

### 3.6 流程端到端

#### 3.6.1 问题发现流程（自动）

```
1. 用户发消息
2. Agent 执行 invocation，调用工具，生成回复
3. Agent 调用 speak，body 末尾附带 <healing> 报告
4. speak tool execute (tool-factory.ts)：
   a. parseHealingReport(rawBody) → 提取 issues
   b. stripHealingReport(rawBody) → cleanBody
   c. startSpeaking(cleanBody, targets)  ← DB 中 body 无 healing 标签
   d. healingEventRepo.create(issues)    ← 异步写入 healing_events
5. 如果有 high severity issue：
   a. pino logger 记录 warning
   b. (Phase 2) 发送 SSE event 通知前端
```

#### 3.6.2 问题分析流程（定时）

```
1. SchedulerService 触发定时任务
2. 系统识别 [self-healing-analysis] 标记
3. buildHealingAnalysisBody() 查询 healing_events，拼接到 prompt
4. 系统发送消息到 Self-Healing 对话（body = 动态生成的分析 prompt）
5. Big Otter 被调用，收到完整的待处理 issues 列表
6. Agent 分析、聚类、提出修复建议
7. speak 到对话中
8. 用户看到分析报告后：
   a. 同意修复 → agent 执行（术语/记忆类）或人执行（prompt/代码类）
   b. 驳回 → agent 调用 healingEventRepo 更新 status=dismissed
   c. 延后 → 保持 open
9. 修复后 agent 调用 healingEventRepo.resolve() 记录决策
```

#### 3.6.3 手动触发流程

用户在 Self-Healing 对话中直接说"分析最近的问题"或"修复 XX 类型的问题"。Agent 拥有 healing_events 的查询工具（见 3.7），可以即时响应。

### 3.7 Agent 工具支持

为了让 agent 在 Self-Healing 对话中能自主查询和更新 healing events，新增一个工具：

```typescript
// tool-factory.ts 中新增
function createManageHealingEventsTool(ctx: ToolContext, healingRepo: HealingEventRepo): AgentTool {
  return {
    name: "manage_healing_events",
    description: "查询和管理 healing events（系统自愈问题记录）。用于：查看待处理问题、标记已解决、标记忽略。仅在 Self-Healing 对话中使用。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "resolve", "dismiss"],
          description: "操作类型：query=查询, resolve=标记已解决, dismiss=标记忽略"
        },
        status: {
          type: "string",
          enum: ["open", "resolved", "dismissed"],
          description: "（query 时）按状态筛选，默认 open"
        },
        errorType: {
          type: "string",
          description: "（query 时）按错误类型筛选"
        },
        eventIds: {
          type: "array",
          items: { type: "string" },
          description: "（resolve/dismiss 时）要操作的 event ID 列表"
        },
        resolutionAction: {
          type: "string",
          enum: ["prompt_updated", "memory_added", "tool_fixed", "config_changed", "no_action", "deferred"],
          description: "（resolve 时）采取的修复行动"
        },
        resolutionNotes: {
          type: "string",
          description: "（resolve 时）解决方式说明"
        },
      },
      required: ["action"],
    },
    execute: async (_id, params) => {
      const action = params.action as string;

      if (action === 'query') {
        const status = params.status as string ?? 'open';
        const errorType = params.errorType as string;
        // R3-14 修复：全局查询而非按 conversationId
        let events = await healingRepo.findOpen(50);
        if (status !== 'open') {
          // 对于非 open 状态，需要全局查询（新增 findAll 方法）
          events = await healingRepo.findAll(status, 50);
        }
        if (errorType) events = events.filter(e => e.errorType === errorType);
        return textResponse(JSON.stringify(events, null, 2));
      }

      if (action === 'resolve') {
        const ids = params.eventIds as string[];
        const resolutionAction = (params.resolutionAction as string) ?? 'no_action';
        const notes = params.resolutionNotes as string ?? '';
        for (const id of ids) {
          await healingRepo.resolve(id, {
            action: resolutionAction as HealingResolution['action'],
            decidedBy: 'agent',
            decidedAt: new Date().toISOString(),
            notes,
          });
        }
        return textResponse(`已标记 ${ids.length} 个事件为 resolved (${resolutionAction})`);
      }

      if (action === 'dismiss') {
        const ids = params.eventIds as string[];
        for (const id of ids) {
          await healingRepo.updateStatus(id, 'dismissed');
        }
        return textResponse(`已忽略 ${ids.length} 个事件`);
      }

      return textResponse(`未知操作: ${action}`);
    },
  };
}
```

**工具分配**：此工具只分配给 Big Otter（在 `getOtterToolNamesForType` 中添加），Small Otter 不需要。

### 3.8 生命周期管理

- **自动清理**：在 `main.ts` 启动时或定时任务中调用 `healingRepo.autoStaleDismiss(30)`，将超过 30 天未更新的 open 事件自动标记为 dismissed
- **定时分析时顺带清理**：`buildHealingAnalysisBody()` 可以在查询前先执行 autoStaleDismiss
- **resolved 事件保留 90 天**：可选，后续按需实现

### 3.9 前端集成（Phase 2）

#### SSE 事件

新增 SSE event 类型（Phase 2 实现）：

```typescript
"healing.event": {
  messageId: string;
  otterId: string;
  issues: Array<{
    type: string;
    severity: string;
    description: string;
  }>;
}
```

Phase 1 只通过 pino logger 记录 high severity 事件。

### 3.10 测试策略（第三轮审视补充）

#### 3.10.1 单元测试（纯函数，最容易测试）

**`healing-report-parser.ts`** — 核心测试目标：
- 正常格式：单 issue、多 issue、no_issue
- LLM 偏差变体（对抗测试集，20+ 用例）：
  - 大小写混合：`<Healing>`, `<HEALING>`
  - Markdown 转义：`\<healing\>`, `` `<healing>` ``
  - 标签不闭合：`<healing>[no_issue]`
  - 缺少 `[issues]` 包裹：`<healing>- type: tool_failure ...</healing>`
  - 枚举值偏差：`type: timeout`（不在白名单中，fallback 为 `other`）
  - 多行 description
  - 超长字段（>500 字）
  - 空字符串
  - 多个 `<healing>` 块（只取第一个）
  - code block 中的 `<healing>`（已知 limitation）
- `stripHealingReport()`：strip 后清理多余空行

**`healing-event-repo.ts`** — 使用内存 SQLite：
- CRUD 操作
- 状态转换（open → resolved / dismissed）
- `autoStaleDismiss(30)` 正确清理过期事件
- `findAll(status, limit)` 全局查询

#### 3.10.2 集成测试

1. **`createSpeakTool` + healingRepo**：mock `ctx.client`，验证：
   - 含 healing 标签的 body → cleanBody 入库 + events 写入
   - 空 cleanBody → 返回错误提示，不入库
   - 无 healing 标签 → 正常行为不变
   - healingRepo 为 undefined → 完全跳过 healing 逻辑

2. **`SchedulerService.triggerTask` + healingRepo**：验证：
   - `[self-healing-analysis]` body → 动态替换为含 events 的 prompt
   - 普通 task body → 不替换
   - 无 open events → prompt 为"无问题"

3. **启动序列**：`ensureHealingConversation` + `ensureHealingScheduler`

#### 3.10.3 回滚策略

**不需要 feature flag**。healing 系统具备天然回滚能力：
- `healingRepo` 可选注入，不传则所有 healing 逻辑跳过
- `SchedulerService` 的 `healingRepo` 也是可选的
- BIG_OTTER.md 的 healing prompt 删除即回滚
- `healing_events` 是新表，不影响现有表

### 3.11 DI 装配详解（二轮审视补充）

#### 3.10.1 createTools 闭包注入

当前 `main.ts` 中的调用方式（已从代码确认）：

```typescript
// main.ts L472-476
const agentGateway = await initAgentSessionFactory({
  model, db,
  otterToolClient: {} as OtterToolClient,
  identityPromptDir: "./prompts/identity",
  createTools,  // 直接传入 tool-factory.ts 的 createTools 函数
  otterConfigProvider,
  // ...
});
```

`pi-session-factory.ts` 中的类型定义（L78）：

```typescript
createTools: (ctx: ToolContext) => AgentTool[];
```

**闭包方案**：在 `main.ts` 中包装 `createTools`，闭包捕获 `healingRepo`：

**C-01 修复：必须修改 `createTools` 签名 + `pi-session-factory.ts`**

`createTools` 当前签名为 `(ctx: ToolContext) => AgentTool[]`（单参数），healingRepo 和 logger 无法传入。方案需要修改签名。

**Step 1：修改 `createTools` 签名（tool-factory.ts）**

```typescript
// tool-factory.ts — 修改前
export function createTools(ctx: ToolContext): AgentTool[] { ... }

// tool-factory.ts — 修改后（C-01: 增加可选 healingRepo + logger）
export function createTools(ctx: ToolContext, healingRepo?: HealingEventRepo, logger?: Logger): AgentTool[] {
  return [
    createSpeakTool(ctx, healingRepo, logger),
    // ... 其他工具不变 ...
  ];
}
```

**Step 2：修改 `pi-session-factory.ts` 类型定义（L78 + L125）**

```typescript
// pi-session-factory.ts L78 — 修改前
createTools: (ctx: ToolContext) => AgentTool[];

// pi-session-factory.ts L78 — 修改后
createTools: (ctx: ToolContext, healingRepo?: HealingEventRepo, logger?: Logger) => AgentTool[];
```

同步修改 L125 的相同类型定义。

**Step 3：修改 `pi-session-factory.ts` L552 调用处**

```typescript
// L552 — 修改前
const otterTools = this.cfg.createTools({ client, otterId, conversationId, currentMessageId });

// L552 — 修改后（传入 healingRepo 和 logger）
const otterTools = this.cfg.createTools(
  { client, otterId, conversationId, currentMessageId },
  this.healingRepo,
  this.logger,
);
```

PiSessionFactory 构造函数新增可选 `healingRepo` 参数，通过 `initAgentSessionFactory` config 传入。

**Step 4：main.ts 闭包包装**

```typescript
// main.ts
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { SqliteHealingEventRepository } from "@frameworks/db/repos/healing-event-repo";
import { createManageHealingEventsTool } from "@interface-adapters/agent-runtime/tools/tool-factory";

const healingRepo = new SqliteHealingEventRepository(db);
const logger = new PinoLogger();

// 包装 createTools：在原始工具列表基础上追加 manage_healing_events
const createToolsWithHealing: typeof createTools = (ctx, repo, log) => {
  const tools = createTools(ctx, repo, log);
  tools.push(createManageHealingEventsTool(ctx, repo!));
  return tools;
};

const agentGateway = await initAgentSessionFactory({
  // ...
  createTools: createToolsWithHealing,
  healingRepo,  // 新增：传入 PiSessionFactory
  // ...
});
```

**为什么可行**：
- `createTools` 签名扩展为 3 参数（可选），向后兼容
- `pi-session-factory.ts` 类型定义同步更新
- `healingRepo` 通过 config 注入 PiSessionFactory，再传给 createTools
- `manage_healing_events` 通过闭包追加到工具列表

#### 3.10.2 SchedulerService 依赖注入

```typescript
// main.ts 中
const schedulerService = new SchedulerService({
  taskRepo: repos.scheduledTask,
  convRepo: repos.conversation,
  sendMessage,
  agentInvokePort: new AgentInvokePortAdapter(agentInvoker),
  cronParser: { getNextTime: (cron, tz) => /* croner 实现 */ },
  logger,
  healingRepo,  // 新增注入
});
```

#### 3.10.3 完整 DI 装配顺序

```
1. initSchema           → healing_events 表（schema migration）
2. initRepositories     → 新增 SqliteHealingEventRepository
3. initAgentSessionFactory → createToolsWithHealing 闭包（捕获 healingRepo）
4. initUseCases         → 不变
5. buildOtterToolClient → 不变
6. initAgentAndScheduler → SchedulerService({ ..., healingRepo })
7. NEW: ensureHealingConversation
8. NEW: ensureHealingScheduler
9. schedulerService.start()
```

## 4. 文件变更清单（诚实版）

### 4.1 新增文件

| 文件 | 用途 |
|------|------|
| `src/entities/healing/healing-event.ts` | HealingEvent 实体 + Repo 接口 |
| `src/usecases/healing/healing-report-parser.ts` | 解析 + 剥离 healing report |
| `src/usecases/healing/ensure-healing-conversation.ts` | 启动时确保 Self-Healing 对话存在 |
| `src/usecases/healing/ensure-healing-scheduler.ts` | 启动时确保定时任务存在 |
| `src/frameworks/db/repos/healing-event-repo.ts` | SQLite 实现 |
| `src/usecases/healing/healing-report-parser.test.ts` | 解析器单元测试（20+ LLM 偏差变体） |
| `src/frameworks/db/repos/healing-event-repo.test.ts` | Repo 集成测试 |

### 4.2 修改文件

| 文件 | 变更内容 |
|------|---------|
| `src/frameworks/db/schema.ts` | 新增 `healing_events` 表 + 索引 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | `createSpeakTool(ctx, healingRepo?, logger?)` 增加 healing 拦截 + strip 逻辑；新增 `createManageHealingEventsTool()` |
| `src/interface-adapters/agent-runtime/session-helpers.ts` | `allToolNames` 数组中添加 `"manage_healing_events"`（M-01 修复：否则白名单过滤会丢弃此工具） |
| `prompts/identity/BIG_OTTER.md` | 追加 self-healing report 指引 |
| `src/usecases/scheduler/scheduler-service.ts` | `triggerTask()` 中识别 `[self-healing-analysis]` 标记，动态注入 healing 数据 |
| `src/main.ts` | 启动序列中增加 healing 初始化（对话创建、定时任务、DI 装配） |

### 4.3 不修改的文件

- `agent-invoker.ts` — 不变（healing 采集不在 post-invocation 层）
- `send-message.ts` — 不变（body 由 speak 工具写入时已是纯净的）
- `tool-call-circuit-breaker.ts` — 不变
- `output-guard.ts` — 不变
- `SMALL_OTTER.md` — 不变

### 4.4 前轮声称不变但实际需要修改的文件（诚实更正）

| 文件 | 修改原因 |
|------|---------|
| `pi-session-factory.ts` | C-01：`createTools` 类型定义（L78, L125）需扩展为 3 参数；L552 调用处需传入 healingRepo + logger；构造函数 config 新增可选 healingRepo |

## 5. 实现顺序

1. **实体 + 数据库**：HealingEvent 实体、Repo 接口、SQLite 实现、schema migration
2. **解析器**：HealingReportParser（parse + strip），含鲁棒性处理
3. **speak 工具集成**：修改 `createSpeakTool()`，在 execute 中拦截 healing report
4. **manage_healing_events 工具**：新增工具，供 agent 查询/管理 healing events
5. **Identity Prompt**：修改 BIG_OTTER.md，追加 healing report 指引
6. **Self-Healing 对话**：ensureHealingConversation，启动时自动创建
7. **定时任务**：ensureHealingScheduler + scheduler-service 动态注入
8. **main.ts DI 装配**：串联所有组件
9. **前端（Phase 2）**：SSE event、Healing 面板

## 6. 设计决策记录

### D1: 为什么用 `<healing>` 标签而不是单独工具？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **标签嵌入 speak body** ✅ | 不增加工具调用、不干扰熔断器、agent 自然表达 | 需要解析 |
| 新增 `report_healing` 工具 | 结构化、易解析 | 增加工具调用计数、agent 可能忘记调用、增加推理负担 |
| 独立 post-invocation LLM 调用 | 完全解耦 | 成本翻倍、延迟增加 |

### D2: 为什么在 speak execute 中拦截而不是 post-invocation？

**v1 方案的致命问题**：message body 一旦由 `startSpeaking()` 写入 DB 就不可变。post-invocation strip 没有写回路径，且 `complete()` 内部的 `memoryIndex.indexMessage()` 已经将含标签的 body 索引。

**v2 方案**：在 speak execute 中先 strip 再调 `startSpeaking()`，标签从未进入 DB。一步到位解决 body 污染、记忆污染、前端展示三个问题。

### D3: 为什么定时分析用系统侧注入而不是 agent 工具查询？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **系统侧注入 prompt** ✅ | 无额外工具、数据完整、无检索失败风险 | prompt 可能较长 |
| Agent 调用 query_healing_events 工具 | 灵活、agent 可按需查询 | 增加工具调用、可能检索不全、增加推理步骤 |

系统侧注入更简单可靠，且 healing events 的数据量有限（每天几条），直接注入 prompt 不会造成 token 压力。

### D4: 为什么只让 Big Otter 做 healing report？

Small Otter 是任务型 agent，干完即走。它遇到的"系统问题"通常是任务层面的（如 read-only 限制），这些信息价值有限。Big Otter 作为系统全貌的掌控者，其 healing report 质量更高。Small Otter 的问题可以通过 Big Otter 在聚合时捕获。

### D5: severity 分级的作用？

- `high`：logger warning，Phase 2 后触发前端通知
- `medium`：定时任务批量处理
- `low`：积累后统一分析，可能发现低 severity 的集群模式

### D6: 鲁棒性处理策略

LLM 输出格式偏差是客观存在的。解析器的防御策略：
1. **Normalize**：去 markdown 转义、统一大小写
2. **白名单校验**：type/severity 不在预设枚举中的 fallback 为 `other`/`low`
3. **多行支持**：description/suggestion 匹配到下一个 key 或条目结尾
4. **长度截断**：单字段最多 500 字，防止异常输出
5. **误解析防护**：healing block 超过 5000 字（绝对长度）时视为误匹配丢弃（M-03 修复：已从比例阈值改为绝对阈值，避免短 body 误杀）
6. **缺省值**：无 healing 标签视为 `[no_issue]`，agent 忘写也不影响

### D7: 重试路径的幂等性

speak 重试场景中，第一次 invocation 可能调用 speak 失败（不进入 execute），重试后第二次调用成功。healing events 的写入只发生在 speak execute 成功路径中，且按 message_id 关联。即使重试产生多条 healing events，它们关联的是同一个最终成功的 message，可以通过 message_id 去重。

### D8: createTools DI 策略 — 签名扩展 + 闭包追加工具（R5-Issue4 更正）

**问题**：`createSpeakTool` 和 `createManageHealingEventsTool` 需要 `healingRepo` 依赖，但 `ToolContext` 接口只有 `{ client, otterId, conversationId, currentMessageId }`。

**最终方案**（经 R4 C-01 修正）：
1. 扩展 `createTools` 签名为 `(ctx, healingRepo?, logger?)`（见 D16）
2. `pi-session-factory.ts` 同步修改类型定义和调用处
3. `main.ts` 中闭包包装，在原始工具列表基础上追加 `createManageHealingEventsTool`

**为什么不用纯闭包方案**：纯闭包无法将 `healingRepo` 传入 `createTools` 内部的 `createSpeakTool` 调用，因为 `createTools` 是单参数函数。必须先扩展签名，再用闭包追加额外工具。

### D9: 安全防护 — issues 数量上限与 prompt 长度上限

- `MAX_ISSUES_PER_REPORT = 10`：单次 speak 最多采集 10 个 issues，防止异常输出导致 DB 膨胀
- `MAX_PROMPT_LENGTH = 8000`：定时分析 prompt 超过 8000 字时截断，引导 agent 使用 `manage_healing_events` 工具查询更多
- `autoStaleDismiss(30)`：每次定时分析前清理超过 30 天未更新的 open 事件

### D10: strip 在校验之前（R3-01）

**问题**：如果先校验 rawBody 非空再 strip，当 agent 输出 `<healing>[no_issue]</healing>` 且无其他内容时，rawBody 非空通过校验，但 strip 后 cleanBody 为空，`startSpeaking("")` 写入 DB，后续 `complete()` 校验 body 非空会抛错，消息卡在 speaking 状态。

**决策**：先 strip 再校验。顺序为：rawBody → stripHealingReport → cleanBody → 校验 cleanBody 非空 → startSpeaking(cleanBody)。同时 parseHealingReport 用 rawBody（包含标签）。

### D11: ManageConversation.create() 自动创建大獭（R3-04）

**问题**：方案假设存在全局 bigOtterId，但代码库中每个对话创建时自动创建独立大獭。`ensureHealingConversation` 的 bigOtterId 参数无来源。

**决策**：去掉 bigOtterId 参数。调用 `ManageConversation.create({ title })` 后查询参与者列表找到 type=big 的 otter ID。返回 `{ conversationId, bigOtterId }` 供 scheduler 使用。

### D12: manage_healing_events 的 resolutionAction 参数（R3-06）

**问题**：resolve 操作硬编码 `action: 'no_action'`，丧失了决策记录价值。

**决策**：在工具 parameters 中增加 `resolutionAction` 字段（enum 6 种），让 agent 指定实际采取的修复行动。默认值 `'no_action'`。

### D13: logger 通过闭包注入（R3-07）

**问题**：`createSpeakTool` 中使用了 logger 但 ToolContext 不包含 logger。

**决策**：在 main.ts 的闭包包装中同时捕获 `healingRepo` 和 `logger`，传入 `createSpeakTool(ctx, healingRepo, logger)`。不修改 ToolContext 接口。

### D14: 误解析阈值改为绝对长度（R3-10）

**问题**：50% 比例阈值在短 body 时会误杀合法 healing report（如 100 字 body + 200 字 healing block = 66%）。

**决策**：改为绝对长度阈值 5000 字。超过 5000 字的 healing block 视为误匹配。正常 healing report 约 200-500 字，不会触发。

### D15: manage_healing_events 的 query 使用全局查询（R3-14）

**问题**：按 `ctx.conversationId` 查询非 open 事件，在 Self-Healing 对话中只能看到自身的事件（数量为零）。

**决策**：query 操作默认使用 `findAll(status, limit)` 全局查询。新增 `findAll` 方法到 `HealingEventRepo` 接口。

### D16: 使用实际存在的 API（R4 C-02 + C-03）

**问题**：方案引用了不存在的类和方法（`settings.set`、`QueryConversation`、`ConversationParticipantRepo.listByConversation`）。

**决策**：使用实际 API：
- `SettingsRepository.update(key, value)` 替代 `settings.set`
- `ManageConversation.getById(id)` 替代 `queryConversation.findById`
- `ConversationRepository.getActiveParticipants(conversationId)` 替代 `participantRepo.listByConversation`

### D17: manage_healing_events 必须加入工具白名单（M-01）

**问题**：`pi-session-factory.ts` L560 有白名单过滤，`allToolNames` 中没有 `manage_healing_events`，工具被 push 后立刻被 filter 掉。

**决策**：在 `session-helpers.ts` 的 `allToolNames` 数组中添加 `"manage_healing_events"`。Small Otter 白名单中不添加（只给 Big Otter）。

### D18: autoStaleDismiss 异常不中断主流程（M-04）

**问题**：`autoStaleDismiss` 放在 triggerTask 主逻辑中，DB 异常会导致定时任务失败，连续 3 次后任务被禁用。

**决策**：用独立 try-catch 包裹 `autoStaleDismiss`，失败时 logger.warn 但继续执行分析。

### D19: 无 open events 时静默跳过（M-05）

**问题**：每天定时任务在无问题时仍发送"系统运行状况良好"消息，产生噪音。

**决策**：`buildHealingAnalysisBody` 返回 `null` 表示无待处理事件。`triggerTask` 检测到 `null` 时跳过本次分析，不创建系统消息、不触发 agent。
