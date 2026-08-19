---
id: F20260818idnw
title: 小獭闲置预警系统
summary: 系统追踪小獭最后活跃轮次，闲置超阈值时注入预警到大獭 prompt，由 AI 决策是否清理
status: draft
change_type: feature
tags: ["agent", "otter", "lifecycle", "idle-warning", "dispatch"]
modules: ["src/usecases/conversation/dispatch-chain-engine.ts", "src/frameworks/db/schema.ts", "src/frameworks/db/migration.ts", "src/entities/conversation/conversation.ts", "src/frameworks/db/conversation/conversation-mapper.ts"]
created_in_conversation: 9bf7b011-ddbc-49b7-98dd-a44315cd83d9
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# 特性文档：小獭闲置预警系统

## 背景

**意图锚**（搭档原话）：
> "案发现场是《Self-Healing》，有十来个小獭，但我看基本上都是历史引入的小獭，以当前来看，这些小獭都可以清理掉了。所以，你来分析下，我感觉咱们系统需要优化一下"
> "或者能不能这样子，系统只负责观测，在小獭超过n轮不发言时（比如说20轮），系统就有一个标记，可以在大獭被invoke时，系统多加一句话到user prompt中，比如"系统提示：额外话，现场有xxx小獭xxx轮没说话了，你评估下是否顺手解散"。也就是用软件系统（固定、准确），然后给ai提供信息，具体决策交由ai！"

## 目标

- **T1**：系统追踪小獭最后活跃轮次，自动计算闲置轮次
- **T2**：当小獭闲置超过阈值（默认20轮）时，注入预警信息到大獭 prompt
- **T3**：大獭根据上下文判断是否清理（观测与决策分离）
- **T4**：阈值可配置，支持不同对话场景

## 非目标

- ❌ 自动清理小獭（AI 决策，非系统强制）
- ❌ 批量清理工具（后续可扩展，本特性不包含）
- ❌ 修复 @多个小獭只响应一个的问题（需查 dispatch-chain-engine，本特性不涉及）

## 方案设计

### 1. 数据层变更

**表**：`conversation_participants`

**新增字段**：
```sql
ALTER TABLE conversation_participants 
ADD COLUMN last_active_turn_number INTEGER NOT NULL DEFAULT 0;
```

**字段说明**：
- `last_active_turn_number`：小獭最后发言的轮次号
- 默认值 0：新加入的小獭或历史数据初始化

**更新时机**：
- 小獭发言完成时（`markBatchRead` 或类似位置）
- 调用 `conversationRepo.updateLastActiveTurnNumber(conversationId, otterId, turnNumber)`

### 2. Entity 层变更

**文件**：`src/entities/conversation/conversation.ts`

**修改接口**：
```typescript
export interface ConversationParticipant {
  // ... 现有字段 ...
  lastReadTurnNumber: number;
  lastActiveTurnNumber: number; // 新增
}
```

### 3. Mapper 层变更

**文件**：`src/frameworks/db/conversation/conversation-mapper.ts`

**修改接口和函数**：
```typescript
interface ParticipantRow {
  // ... 现有字段 ...
  last_read_turn_number: number;
  last_active_turn_number: number; // 新增
}

export function rowToParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    // ... 现有映射 ...
    lastReadTurnNumber: row.last_read_turn_number,
    lastActiveTurnNumber: row.last_active_turn_number, // 新增
  };
}
```

### 4. Migration 层变更

**文件**：`src/frameworks/db/migration.ts`

**新增迁移逻辑**（遵循已有模式，如 `last_read_turn_number` 的处理）：
```typescript
// 探测 last_active_turn_number 列是否存在
const hasLastActiveTurnNumber = db.prepare(
  "PRAGMA table_info(conversation_participants)"
).all().some((col: any) => col.name === 'last_active_turn_number');

if (!hasLastActiveTurnNumber) {
  db.exec(`
    ALTER TABLE conversation_participants 
    ADD COLUMN last_active_turn_number INTEGER NOT NULL DEFAULT 0
  `);
}
```

### 5. 观测层实现

**文件**：`src/usecases/conversation/dispatch-chain-engine.ts`

**新增方法**：
```typescript
/**
 * 构建闲置小獭预警信息
 * @param conversationId 对话 ID
 * @param currentOtterId 当前大獭 ID（排除自己）
 * @param threshold 闲置轮次阈值（默认 20，从 settings 读取）
 * @returns 预警信息字符串，无闲置小獭时返回 null
 */
async buildIdleOttersWarning(
  conversationId: string, 
  currentOtterId: string
): Promise<string | null> {
  // 从 settings 读取阈值，fallback 到默认值 20
  const threshold = this.deps.settingsRepo 
    ? (await this.deps.settingsRepo.get('otter_idle_threshold'))?.trim() 
      ? parseInt((await this.deps.settingsRepo.get('otter_idle_threshold'))!.trim(), 10) 
      : 20
    : 20;
  
  const participants = await this.deps.conversationRepo.getActiveParticipants(conversationId);
  // 使用 getMaxTurnNumber 替代 getActiveTurn，避免链式调用中 turn 已关闭的问题
  const currentTurnNumber = await this.deps.conversationRepo.getMaxTurnNumber(conversationId);
  
  if (!currentTurnNumber) return null;
  
  // 批量预取所有 participant 的 otter 信息，避免 N+1 查询
  const otterNames = new Map<string, string>();
  await Promise.all(participants.map(async p => {
    const otter = await this.deps.queryOtter.getById(p.otterId);
    if (otter) otterNames.set(p.otterId, otter.name);
  }));
  
  const idleOtters: Array<{ name: string; idleTurns: number }> = [];
  
  for (const p of participants) {
    if (p.otterId === currentOtterId) continue;
    const idleTurns = currentTurnNumber - p.lastActiveTurnNumber;
    if (idleTurns > threshold) {
      const name = otterNames.get(p.otterId);
      if (name) {
        idleOtters.push({ name, idleTurns });
      }
    }
  }
  
  if (idleOtters.length === 0) return null;
  
  const warnings = idleOtters.map(o => 
    `${o.name} 已闲置 ${o.idleTurns} 轮`
  ).join('、');
  
  return `系统提示：现场有小獭（${warnings}），你评估下是否顺手解散。`;
}
```

### 6. 注入层实现

**文件**：`src/usecases/conversation/dispatch-chain-engine.ts`

**修改方法**：`buildMessageWithContext()`

```typescript
async buildMessageWithContext(
  conversationId: string,
  otterId: string,
  userMessageContent: string,
  senderId: string,
  roster: string,
): Promise<string> {
  // ... 现有逻辑（获取未读消息、格式化对话历史）...
  
  // 新增：闲置小獭预警
  const idleWarning = await this.buildIdleOttersWarning(conversationId, otterId);
  
  let result = `${roster}\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
  
  if (idleWarning) {
    result += `\n\n${idleWarning}`;
  }
  
  return result;
}
```

### 7. 更新层实现

**文件**：`src/usecases/conversation/dispatch-chain-engine.ts`

**修改方法**：`markBatchRead()`

```typescript
private async markBatchRead(
  conversationId: string,
  results: PromiseSettledResult<InvokeFnResult>[],
  targets: string[],
): Promise<void> {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    let messageId: string | undefined;
    
    if (r.status === 'fulfilled') {
      messageId = r.value.messageId;
    } else {
      // ... 现有逻辑 ...
    }
    
    if (!messageId) continue;
    const msg = await this.deps.queryMessage.getMessageById(messageId);
    if (!msg) continue;
    const turn = await this.deps.conversationRepo.getTurnById(msg.turnId);
    if (!turn) continue;
    
    // 更新最后读取轮次
    await this.deps.conversationRepo.updateLastReadTurnNumber(
      conversationId, 
      msg.senderId, 
      turn.turnNumber
    );
    
    // 新增：更新最后活跃轮次（小獭发言时）
    if (msg.senderType === 'otter') {
      await this.deps.conversationRepo.updateLastActiveTurnNumber(
        conversationId,
        msg.senderId,
        turn.turnNumber
      );
    }
  }
}
```

### 8. 配置层

**阈值配置**：
- 默认值：20 轮
- 可通过 `settings` 表配置：`otter_idle_threshold`
- 读取位置：`buildIdleOttersWarning()` 方法（从 `settingsRepo` 读取）

## 影响范围

| 模块 | 影响 |
|------|------|
| `conversation_participants` 表 | 新增字段，需数据库迁移 |
| `conversation.ts`（Entity） | 接口新增字段 |
| `conversation-mapper.ts`（Mapper） | 新增列映射 |
| `migration.ts` | 新增迁移逻辑 |
| `dispatch-chain-engine.ts` | 新增方法，修改现有方法 |
| `conversation-repository` | 新增 `updateLastActiveTurnNumber()` 方法 |
| 大獭 prompt | 增加闲置预警信息（可选） |

## 风险与约束

| 风险 | 级别 | 缓解措施 |
|------|------|----------|
| 阈值过小小獭被误清理 | 中 | 默认20轮，可配置；AI 根据上下文判断 |
| prompt 膨胀影响性能 | 低 | 只在有闲置小獭时注入；信息简短 |
| 数据库迁移失败 | 低 | 使用 `ALTER TABLE ADD COLUMN`，兼容现有数据 |
| AI 误判清理仍在工作的小獭 | 中 | 信息而非命令；大獭可查看小獭上下文 |

## 不兼容更新

**[Incompatible]** 数据库 schema 变更：
- `conversation_participants` 表新增 `last_active_turn_number` 字段
- 需要数据库迁移脚本（`ALTER TABLE ADD COLUMN`）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 触发时机 | 每次大獭 invoke 时检查 | 定时任务检查 | 实时性更好，实现简单 |
| 阈值类型 | 轮次 | 时间（分钟） | 轮次更精确，不受对话节奏影响 |
| 注入方式 | 字符串拼接 | 单独字段 | 兼容现有 prompt 结构 |
| 清理决策 | AI 判断 | 系统自动清理 | 灵活性高，避免误杀 |
| turn 获取 | getMaxTurnNumber | getActiveTurn | 避免链式调用中 turn 已关闭的问题 |

## 验证

### 验收标准

1. **数据层**：`conversation_participants` 表成功新增 `last_active_turn_number` 字段
2. **Entity 层**：`ConversationParticipant` 接口新增 `lastActiveTurnNumber` 字段
3. **Mapper 层**：`rowToParticipant()` 正确映射 `last_active_turn_number`
4. **观测层**：小獭发言后，`last_active_turn_number` 正确更新
5. **注入层**：闲置超过阈值的小獭信息正确注入大獭 prompt
6. **决策层**：大獭能根据预警信息判断是否清理
7. **配置层**：阈值可通过 `settings` 表配置

### 测试设计

1. **单元测试**：
   - `buildIdleOttersWarning()` 返回正确预警信息
   - `updateLastActiveTurnNumber()` 正确更新字段
2. **集成测试**：
   - 小獭发言后，`last_active_turn_number` 更新
   - 闲置小獭信息注入到大獭 prompt
   - 链式调用中 turn 关闭后仍能正确计算闲置轮次
3. **端到端测试**：
   - 创建多个小獭，模拟闲置场景
   - 验证大獭收到预警信息并能正确决策

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/schema.ts` | 修改 | 新增 `last_active_turn_number` 字段定义 |
| `src/frameworks/db/migration.ts` | 修改 | 新增迁移脚本（PRAGMA 探测 + ALTER TABLE） |
| `src/entities/conversation/conversation.ts` | 修改 | `ConversationParticipant` 接口新增 `lastActiveTurnNumber` |
| `src/frameworks/db/conversation/conversation-mapper.ts` | 修改 | `ParticipantRow` 新增列映射，`rowToParticipant()` 映射字段 |
| `src/usecases/conversation/dispatch-chain-engine.ts` | 修改 | 新增 `buildIdleOttersWarning()` 方法，修改 `buildMessageWithContext()` 和 `markBatchRead()` |
| `src/usecases/conversation/conversation-repository.ts` | 修改 | 新增 `updateLastActiveTurnNumber()` 接口 |
| `src/frameworks/db/conversation/conversation-repository-mixins.ts` | 修改 | 实现 `updateLastActiveTurnNumber()` |
| `tests/usecases/conversation/dispatch-chain-engine.test.ts` | 新增 | 测试用例 |

## 对抗审视记录

### 第一轮审视
- **审视者**：检视獭-idle-warning
- **结论**：需要修改
- **发现**：2 个严重问题、4 个建议发现
- **处置**：全部接受并修订
- **修订内容**：
  1. 补充 Entity/Mapper/Migration 三层变更
  2. 将 `getActiveTurn` 替换为 `getMaxTurnNumber`
  3. 优化 N+1 查询为批量预取
  4. 从 `settingsRepo` 读取阈值配置
  5. 补充特性文档 frontmatter

## 后续扩展

1. **批量清理工具**：`dissolve_all_idle` 工具，一键清理闲置小獭
2. **自动过期机制**：小獭创建时带 TTL，超时自动标记
3. **执行路由修复**：解决 @多个小獭只响应一个的问题
