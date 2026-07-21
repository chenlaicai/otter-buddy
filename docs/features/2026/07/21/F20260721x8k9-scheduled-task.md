---
id: F20260721x8k9
title: scheduled-task
doc_type: feature

# 记忆索引
summary: |
  对话维度的定时任务机制：用户可设置 cron 表达式，定时以 system 身份发送消息并触发 Agent 响应。
  包含后端调度引擎、前端管理 UI、执行历史追踪。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260713c7p2  # domain-conversation
    - F20260713e8n4  # message-streaming-model

# 元数据
status: draft
change_type: feature
tags: [conversation, scheduler, cron, system-message]
modules: [src/entities/scheduled-task/, src/usecases/scheduled-task/, src/usecases/scheduler/, web/src/pages/conversation/]

# 时间
created_at: 2026-07-21
---

# F20260721x8k9 对话定时任务

## 背景

### 需求

用户期望在对话中设置定时任务，例如"每天1点发送'开始说hi'并将发言石传递给大獭"。到时间后，系统自动以 `system` 身份发送消息，触发正常的 Agent 响应流程。

### 核心语义

- 定时任务 = 定时让 system 说句话
- 这句话进入对话的消息流（走现有 conversation + message 机制）
- 发言人是 system，发言石传递给指定 Otter，触发 Agent 响应

### 现状分析

| 层 | 状态 | 说明 |
|----|------|------|
| System 消息 | ✅ 已有 | 参与者进场/退场时创建，`senderType="system"`，豁免发言石校验 |
| Turn 模型 | ✅ 已有 | `ensureActiveTurn()` 可自动创建新 Turn |
| Agent 调用 | ✅ 已有 | `AgentInvoker.invokeConversation()` 驱动响应 |
| 定时调度 | ❌ 缺失 | 无 cron 解析、无调度器、无任务管理 |
| 前端 UI | ❌ 缺失 | 无任务管理界面 |

## 用户意图锚

| ID | 用户原话 | 关键修饰语 | 架构师解读 |
|----|---------|-----------|-----------|
| UA-1 | "定一个每天1点，发送'开始说hi'并且发言石传递给大獭" | cron + body + talkingStonePassedTo | 核心功能：定时发送 system 消息并触发 Agent |
| UA-2 | "底层还是通过 message 的形式来发送这句话" | 复用现有消息机制 | 不引入新的消息通道，复用 SendMessage |
| UA-3 | "发言人应该是 system 这种" | senderType = system | System 消息豁免发言石校验，直接 completed 状态 |
| UA-4 | "这句话也要作为当时的 turn 中的一句发言" | 纳入 Turn 机制 | 定时触发的消息属于当前或新建的 Turn |
| UA-5 | "对话维度" | 存储粒度 | 任务跟随对话生命周期，对话完成后自动失效 |
| UA-6 | "CRUD 全套" | API 范围 | 完整的任务管理能力 |

## 目标

### T1 — 定时任务实体与持久化

定义 `ScheduledTask` 实体，支持 CRUD 操作，存储在 SQLite 中。

### T2 — 调度引擎

实现 `SchedulerService`，基于 cron 表达式定时触发任务，创建 system 消息并调用 Agent。

### T3 — 前端管理 UI

在对话页面 RightPanel 中嵌入定时任务管理区块，支持创建、编辑、删除、手动触发、查看执行历史。

### T4 — 触发通知

任务触发后，前端能感知到新消息（轮询方案）。

## 设计方案

### D1 — 数据模型

#### ScheduledTask 实体

```typescript
interface ScheduledTask {
  id: string;
  conversationId: string;
  name: string;                    // 任务名称
  cron: string;                    // 5字段 cron 表达式（分 时 日 月 周）
  timezone: string;                // 时区，默认 'Asia/Shanghai'
  body: string;                    // 触发时发送的消息内容
  talkingStonePassedTo: string[];  // 发言石传递目标（Otter ID 列表）
  senderId: string;                // system 消息的 senderId（与现有约定一致：使用 Otter ID）
  status: 'active' | 'disabled' | 'error';
  consecutiveFailures: number;     // 连续失败次数，>=3 自动置为 error
  lastTriggeredAt?: string;        // 上次触发时间（ISO 8601，与项目约定一致）
  createdAt: string;               // ISO 8601
  updatedAt: string;               // ISO 8601
}
```

> **设计决策**：
> - `senderId` 使用 Otter ID 而非任务 ID，与现有 system 消息约定一致（参见 `manage-participant.ts`）
> - 时间字段使用 `string`（ISO 8601），与项目中所有其他表的约定保持一致

#### ScheduledTaskExecution 实体

```typescript
interface ScheduledTaskExecution {
  id: string;
  taskId: string;
  triggeredAt: string;             // ISO 8601
  completedAt?: string;            // ISO 8601
  status: 'running' | 'completed' | 'failed';
  errorMessage?: string;
  messageId?: string;              // 关联创建的消息 ID
  turnId?: string;                 // 关联的 Turn ID
}
```

#### 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  body TEXT NOT NULL CHECK (length(body) <= 10000),  -- 长度限制
  talking_stone_passed_to TEXT NOT NULL DEFAULT '[]',  -- JSON array
  sender_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_triggered_at TEXT,          -- ISO 8601
  created_at TEXT NOT NULL,        -- ISO 8601
  updated_at TEXT NOT NULL         -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_conversation ON scheduled_tasks(conversation_id);

CREATE TABLE IF NOT EXISTS scheduled_task_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  triggered_at TEXT NOT NULL,      -- ISO 8601
  completed_at TEXT,               -- ISO 8601
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error_message TEXT,
  message_id TEXT REFERENCES messages(id),
  turn_id TEXT REFERENCES turns(id)
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON scheduled_task_executions(task_id, triggered_at);
```

> **Schema 变更说明**：
> - 时间字段改为 `TEXT` 存储 ISO 8601，与项目约定一致
> - 增加 `consecutive_failures` 字段用于连续失败检测
> - `body` 增加 `CHECK (length(body) <= 10000)` 长度限制
> - 外键增加 `ON DELETE CASCADE`，删除任务时级联清理执行历史
> - `status` 增加 `CHECK` 约束确保合法值

### D2 — 分层架构

```
src/
├── entities/scheduled-task/
│   └── scheduled-task.ts                    # 实体定义 + 校验函数
├── usecases/scheduled-task/
│   ├── scheduled-task-repository.ts         # Repository 接口
│   └── manage-scheduled-task.ts             # Use Case（CRUD）
├── usecases/scheduler/
│   └── scheduler-service.ts                 # 调度服务
├── frameworks/db/scheduled-task/
│   ├── sqlite-scheduled-task-repository.ts  # SQLite 实现
│   └── scheduled-task-mapper.ts             # DB 映射
├── frameworks/scheduler/
│   └── cron-scheduler.ts                    # Cron 解析与调度（croner）
└── interface-adapters/http/
    ├── controllers/scheduled-task-controller.ts
    └── dto/scheduled-task-dto.ts
```

### D3 — 调度引擎

#### 并发安全机制

```typescript
// 乐观锁：任务开始执行时立即原子更新 lastTriggeredAt
async function claimTask(taskId: string, now: number): Promise<boolean> {
  const result = await db.run(
    `UPDATE scheduled_tasks
     SET last_triggered_at = ?, updated_at = ?
     WHERE id = ? AND (last_triggered_at IS NULL OR last_triggered_at < ?)`,
    [now, now, taskId, now - 60_000]  // 至少间隔 60 秒
  )
  return result.changes > 0
}
```

#### 触发流程

```typescript
class SchedulerService {
  // Timer 管理
  private timers = new Map<string, NodeJS.Timeout>()

  // 启动调度器
  start(): void {
    // 为每个 active 任务设置 setTimeout
    this.scheduleNextForAll()
  }

  // 停止调度器（进程退出时调用）
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  // 为单个任务调度下次触发
  private scheduleNext(task: ScheduledTask): void {
    const nextTrigger = getNextCronTime(task.cron, task.timezone)
    const delay = nextTrigger.getTime() - Date.now()

    const timer = setTimeout(async () => {
      await this.triggerTask(task)
      // 触发后重新调度下一次
      const updatedTask = await this.repo.getById(task.id)
      if (updatedTask?.status === 'active') {
        this.scheduleNext(updatedTask)
      }
    }, delay)

    this.timers.set(task.id, timer)
  }

  // 触发单个任务
  private async triggerTask(task: ScheduledTask): Promise<void> {
    const now = new Date().toISOString()

    // 1. 乐观锁抢占
    if (!await this.claimTask(task.id, now)) return

    // 2. 检查对话状态
    const conversation = await this.convRepo.getById(task.conversationId)
    if (conversation.status !== 'active') {
      await this.disableTask(task.id)
      return
    }

    // 3. 创建执行记录
    const execution = await this.createExecution(task.id, now)

    try {
      // 4. 确保有活跃 Turn
      const turn = await this.ensureActiveTurn(task.conversationId)

      // 5. 创建 system 消息（复用 SendMessage.send，需扩展支持 senderType）
      const message = await this.sendMessage.send({
        conversationId: task.conversationId,
        senderType: 'system',
        senderId: task.senderId,
        body: task.body,
        talkingStonePassedTo: task.talkingStonePassedTo,
      })

      // 6. 触发 Agent 响应（复用现有 invokeConversation，将 system 消息的 body 作为触发内容）
      await this.agentInvoker.invokeConversation({
        otterId: task.talkingStonePassedTo[0],
        conversationId: task.conversationId,
        userMessageContent: task.body,  // system 消息的内容作为触发输入
        senderId: task.senderId,
      })

      // 7. 更新执行记录为成功
      await this.completeExecution(execution.id, message.id, turn.id)

      // 8. 重置连续失败计数
      await this.repo.resetConsecutiveFailures(task.id)

    } catch (error) {
      // 9. 更新执行记录为失败
      await this.failExecution(execution.id, error.message)

      // 10. 增加连续失败计数，>=3 次自动置为 error
      const failures = await this.repo.incrementConsecutiveFailures(task.id)
      if (failures >= 3) {
        await this.repo.updateStatus(task.id, 'error')
      }
    }
  }
}
```

> **关键设计决策**：
>
> **1. 调度方式**：使用 `setTimeout` 动态计算下次触发时间，为每个任务维护独立的 timer。
> 进程退出时通过 `stop()` 清理所有 timer，确保 Node.js 可以正常退出。
>
> **2. Agent 触发路径**：复用现有 `AgentInvoker.invokeConversation()` 方法，将 system
> 消息的 body 作为 `userMessageContent` 传入。这与用户发消息的流程完全一致，
> 唯一的区别是第一步创建的消息 `senderType` 为 `'system'` 而非 `'user'`。
> 不需要新增任何 Agent 触发方法。
>
> **3. 连续失败检测**：通过 `consecutive_failures` 字段追踪，每次失败递增，
> 成功时重置。>=3 次自动置为 error 状态。

#### 技术选型

- **Cron 解析**: `croner` 库（零依赖、支持暂停/恢复、内置时区支持）
- **调度方式**: `setTimeout` 动态计算下次触发时间，每个任务独立 timer
- **Cron 校验**: 创建/更新时校验表达式合法性，限制最小间隔 1 分钟
- **时区校验**: 后端校验 timezone 是否为合法的 IANA 时区标识符

### D4 — API 设计

#### HTTP 接口

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/conversations/:id/scheduled-tasks` | 创建定时任务 |
| GET | `/api/conversations/:id/scheduled-tasks` | 列出对话的定时任务 |
| GET | `/api/scheduled-tasks/:taskId` | 获取单个任务详情 |
| PATCH | `/api/scheduled-tasks/:taskId` | 更新任务 |
| DELETE | `/api/scheduled-tasks/:taskId` | 删除任务 |
| POST | `/api/scheduled-tasks/:taskId/trigger` | 手动触发 |
| GET | `/api/scheduled-tasks/:taskId/executions` | 查询执行历史 |

#### DTO 定义

```typescript
// api-contract/api/scheduled-task.dto.ts

interface CreateScheduledTaskDTO {
  name: string;
  cron: string;
  timezone?: string;           // 默认 'Asia/Shanghai'
  body: string;
  talkingStonePassedTo: string[];
  senderId?: string;           // 默认为 talkingStonePassedTo[0]（第一个 Otter ID）
}

interface UpdateScheduledTaskDTO {
  name?: string;
  cron?: string;
  timezone?: string;
  body?: string;
  talkingStonePassedTo?: string[];
  status?: 'active' | 'disabled' | 'error';  // 支持从 error 恢复到 active
}

interface ScheduledTaskDTO {
  id: string;
  conversationId: string;
  name: string;
  cron: string;
  timezone: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId: string;
  status: 'active' | 'disabled' | 'error';
  consecutiveFailures: number;
  lastTriggeredAt?: string;      // ISO 8601
  nextTriggerAt?: string;        // ISO 8601，后端计算的下次触发时间
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
}

interface ScheduledTaskExecutionDTO {
  id: string;
  taskId: string;
  triggeredAt: string;           // ISO 8601
  completedAt?: string;          // ISO 8601
  status: 'running' | 'completed' | 'failed';
  errorMessage?: string;
  messageId?: string;
  turnId?: string;
}

interface ListExecutionsDTO {
  executions: ScheduledTaskExecutionDTO[];
  total: number;
  limit: number;
  offset: number;
}
```

### D5 — 前端设计

#### 整体定位

定时任务是对话维度的功能，嵌入到对话页面的 RightPanel 中，保持现有平铺布局（非 Tab），在底部追加第四个 section。

#### 组件结构

```
web/src/pages/conversation/
├── index.tsx                    -- 提取 useScheduledTasks Hook
├── hooks/
│   └── useScheduledTasks.ts    -- 新增：定时任务逻辑 Hook
├── RightPanel.tsx               -- 修改：底部追加 section
├── ScheduledTaskSection.tsx     -- 新增：任务列表区块
├── ScheduledTaskModal.tsx       -- 新增：创建/编辑弹窗
├── ExecutionHistoryModal.tsx    -- 新增：执行历史弹窗
└── Modals.tsx                   -- 修改：ModalState 增加定时任务相关状态
```

#### 状态管理

提取 `useScheduledTasks` 自定义 Hook，隔离定时任务逻辑：

```typescript
// hooks/useScheduledTasks.ts
function useScheduledTasks(conversationId: string | null) {
  const [tasks, setTasks] = useState<LocalScheduledTask[]>([])
  const [loading, setLoading] = useState(false)

  // 使用 useRef 持有最新 tasks，避免 stale closure 问题
  const tasksRef = useRef(tasks)
  useEffect(() => { tasksRef.current = tasks }, [tasks])

  // 数据加载
  useEffect(() => {
    if (!conversationId) return
    setLoading(true)
    api.listScheduledTasks(conversationId)
      .then(res => setTasks(res.map(mapScheduledTaskDTO)))
      .finally(() => setLoading(false))
  }, [conversationId])

  // 轮询（每 30 秒）
  useEffect(() => {
    if (!conversationId) return
    const timer = setInterval(() => {
      api.listScheduledTasks(conversationId)
        .then(res => setTasks(res.map(mapScheduledTaskDTO)))
    }, 30_000)
    return () => clearInterval(timer)
  }, [conversationId])

  // 乐观更新：启用/禁用
  const toggleStatus = useCallback(async (taskId: string) => {
    // 使用 ref 获取最新 tasks，避免 stale closure
    const task = tasksRef.current.find(t => t.id === taskId)
    if (!task) return
    const newStatus = task.status === 'active' ? 'disabled' : 'active'

    // 乐观更新
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t))

    try {
      await api.updateScheduledTask(taskId, { status: newStatus })
    } catch {
      // 回滚：从服务器重新获取最新状态，而非依赖闭包中的旧值
      if (conversationId) {
        const fresh = await api.listScheduledTasks(conversationId)
        setTasks(fresh.map(mapScheduledTaskDTO))
      }
      showToast('操作失败', 'error')
    }
  }, [conversationId])

  // 手动触发后立即刷新
  const trigger = useCallback(async (taskId: string) => {
    try {
      await api.triggerScheduledTask(taskId)
      showToast('任务已触发', 'success')
      // 立即刷新，不等待轮询
      if (conversationId) {
        const fresh = await api.listScheduledTasks(conversationId)
        setTasks(fresh.map(mapScheduledTaskDTO))
      }
    } catch {
      showToast('触发失败', 'error')
    }
  }, [conversationId])

  return { tasks, loading, toggleStatus, trigger, /* ...其他方法 */ }
}
```

> **P0-3 修复说明**：
> - 使用 `useRef` 持有最新 tasks，避免 `useCallback` 闭包捕获旧值
> - 回滚时从服务器重新获取状态，而非依赖闭包中的 `task.status`
> - `toggleStatus` 的依赖只包含 `conversationId`，不会因 tasks 变化而重建

#### Local 类型与 Mapper

```typescript
// lib/mappers.ts
interface LocalScheduledTask {
  id: string
  conversationId: string
  name: string
  cron: string
  timezone: string
  body: string
  talkingStonePassedTo: string[]
  senderId: string
  status: 'active' | 'disabled' | 'error'
  lastTriggeredAt?: number
  nextTriggerAt?: number
  createdAt: number
  updatedAt: number
}

function mapScheduledTaskDTO(dto: ScheduledTaskDTO): LocalScheduledTask {
  return {
    id: dto.id,
    conversationId: dto.conversationId,
    name: dto.name,
    cron: dto.cron,
    timezone: dto.timezone,
    body: dto.body,
    talkingStonePassedTo: dto.talkingStonePassedTo,
    senderId: dto.senderId,
    status: dto.status,
    lastTriggeredAt: dto.lastTriggeredAt,
    nextTriggerAt: dto.nextTriggerAt,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}
```

#### ModalState 扩展

```typescript
// Modals.tsx
type ModalState =
  | { type: 'none' }
  | { type: 'new-conv' }
  | { type: 'create-otter' }
  | { type: 'dissolve-otter'; otterId: string }
  | { type: 'complete-conv'; convId: string }
  | { type: 'archive-conv'; convId: string }
  | { type: 'create-scheduled-task' }                    // 新增
  | { type: 'edit-scheduled-task'; task: LocalScheduledTask }  // 新增
  | { type: 'delete-scheduled-task'; taskId: string }    // 新增
  | { type: 'scheduled-task-history'; taskId: string }   // 新增
```

#### RightPanel 布局

```typescript
// RightPanel.tsx - 保持平铺布局，底部追加 section
function RightPanel({ conversationId, otters, ... }: Props) {
  const { tasks, toggleStatus } = useScheduledTasks(conversationId)

  return (
    <aside className="w-64 border-l overflow-y-auto">
      {/* 参与者 section */}
      <div className="border-b p-4">
        <h3>参与者</h3>
        {/* ... */}
      </div>

      {/* 关键事实 section */}
      <div className="border-b p-4">
        <h3>关键事实</h3>
        {/* ... */}
      </div>

      {/* 链接资源 section */}
      <div className="border-b p-4">
        <h3>链接资源</h3>
        {/* ... */}
      </div>

      {/* 定时任务 section - 新增 */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3>定时任务</h3>
          <button onClick={onCreateTask} className="btn-secondary text-xs">
            <Plus size={12} /> 新建
          </button>
        </div>
        <ScheduledTaskSection
          tasks={tasks}
          onToggle={toggleStatus}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onTrigger={handleTrigger}
          onViewHistory={handleViewHistory}
        />
      </div>
    </aside>
  )
}
```

#### ScheduledTaskSection 组件

```typescript
function ScheduledTaskSection({ tasks, onToggle, onEdit, onDelete, onTrigger, onViewHistory }: Props) {
  if (tasks.length === 0) {
    return <div className="text-center text-gray-400 py-4 text-sm">暂无定时任务</div>
  }

  return (
    <div className="space-y-2">
      {tasks.map(task => (
        <div key={task.id} className="glass-card p-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{task.name}</span>
            <button onClick={() => onToggle(task.id)} className="relative">
              {/* 开关样式 */}
              <div className={`w-8 h-4 rounded-full ${task.status === 'active' ? 'bg-green-500' : 'bg-gray-300'}`}>
                <div className={`w-3 h-3 rounded-full bg-white mt-0.5 transition ${task.status === 'active' ? 'ml-4' : 'ml-0.5'}`} />
              </div>
            </button>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            <Clock size={12} className="inline" /> {task.cron}
          </div>
          {task.nextTriggerAt && (
            <div className="text-xs text-gray-400">
              下次: {formatTime(task.nextTriggerAt)}
            </div>
          )}
          <div className="text-xs text-gray-600 mt-1 line-clamp-2">{task.body}</div>
          <div className="flex gap-1 mt-2">
            <button onClick={() => onTrigger(task.id)} className="btn-secondary text-xs px-2 py-1">
              <Play size={10} />
            </button>
            <button onClick={() => onViewHistory(task.id)} className="btn-secondary text-xs px-2 py-1">
              <History size={10} />
            </button>
            <button onClick={() => onEdit(task)} className="btn-secondary text-xs px-2 py-1">
              <Edit size={10} />
            </button>
            <button onClick={() => onDelete(task.id)} className="btn-danger text-xs px-2 py-1">
              <Trash size={10} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
```

#### ScheduledTaskModal 组件

创建/编辑弹窗，包含：
- 任务名称输入
- Cron 表达式输入 + 预设选择器（每天 09:00、每天 01:00、每 2 小时、工作日 09:00）
- 时区下拉选择（默认浏览器时区）
- 消息内容 textarea
- 目标 Otter 复选框列表（仅 1 个 Otter 时自动填充）
- Cron 预览：未来 5 次触发时间

#### ExecutionHistoryModal 组件

执行历史弹窗，包含：
- 默认加载 20 条，支持"加载更多"
- 每条记录显示：触发时间、状态图标、耗时、关联消息跳转
- 失败记录显示错误信息
- 空状态提示

#### System 消息展示

> **P0-2 修复**：现有 `LocalMessage.st` 类型只有 `'user' | 'otter'`，需要扩展为
> `'user' | 'otter' | 'system'`。同时需要修改 `mapMessageDTO` 的类型断言。

**需要修改的文件**：

1. `web/src/lib/mappers.ts` - 扩展 `LocalMessage.st` 类型：
```typescript
export interface LocalMessage {
  id: string
  st: 'user' | 'otter' | 'system'  // 新增 'system'
  // ... 其他字段
}

function mapMessageDTO(dto: MessageDTO): LocalMessage {
  return {
    // ...
    st: dto.st as 'user' | 'otter' | 'system',  // 修改类型断言
    // ...
  }
}
```

2. `web/src/pages/conversation/MessageList.tsx` - `MessageItem` 增加 system 分支：
```typescript
function MessageItem({ message, otters }: Props) {
  // System 消息：居中显示，特殊样式
  if (message.st === 'system') {
    return (
      <div className="flex justify-center my-2">
        <div className="glass-card px-3 py-1 text-xs text-gray-500 flex items-center gap-1">
          <Clock size={12} />
          <span>{message.body}</span>
          <span className="text-gray-400">· {formatTime(message.createdAt)}</span>
        </div>
      </div>
    )
  }

  // 用户消息：右对齐
  const isUser = message.st === 'user'
  const otter = isUser ? null : otters.find(o => o.id === message.si)

  // ... 其他渲染逻辑
}
```

### D6 — 触发通知机制

采用轮询方案，不引入 GET SSE：

- 进入对话页面时启动轮询，离开时停止
- 轮询间隔 30 秒
- 轮询结果与本地状态 diff，有变化时更新 UI
- 手动触发后立即刷新任务列表

### D7 — 边缘情况处理

| 场景 | 处理方式 |
|------|----------|
| 对话完成/归档 | 触发前检查对话状态，非 active 自动 disable 任务 |
| 没有活跃 Turn | 自动创建新 Turn |
| Agent 调用失败 | execution 记录失败状态，不修改任务状态 |
| 无 Otter | 创建任务时 talkingStonePassedTo 为空则阻止提交 |
| 任务连续失败 | 超过 3 次连续失败自动置为 error 状态 |
| 删除任务 | 需要确认弹窗 |
| Cron 表达式无效 | 客户端校验 + 后端校验，阻止提交 |

## 硬约束

1. 复用现有 SendMessage 机制，不引入新的消息通道
2. System 消息的 `senderType` 必须为 `'system'`，需扩展 `SendMessage.send()` 支持
3. `lastTriggeredAt` 在任务开始执行时立即原子更新，防止重复触发
4. 前端保持 RightPanel 平铺布局，不改为 Tab
5. 不引入 GET SSE，使用轮询方案
6. 新增 `croner` 依赖用于 cron 解析
7. 遵循现有分层架构，usecases 层不依赖 interface-adapters 层
8. 遵循现有 DTO → Local 类型映射约定
9. 时间字段使用 `string`（ISO 8601），与项目约定一致
10. `senderId` 使用 Otter ID，与现有 system 消息约定一致
11. 复用 `AgentInvoker.invokeConversation()` 触发 Agent 响应，不新增方法
12. 前端 `LocalMessage.st` 扩展为 `'user' | 'otter' | 'system'`
13. `SchedulerService` 必须实现 `stop()` 方法，进程退出时清理所有 timer
14. 外键使用 `ON DELETE CASCADE`，删除任务时级联清理执行历史

## 验证

### 数据层
- [ ] `scheduled_tasks` 和 `scheduled_task_executions` 表创建成功
- [ ] 时间字段使用 TEXT 存储 ISO 8601
- [ ] 外键 `ON DELETE CASCADE` 生效
- [ ] `consecutive_failures` 字段正常工作

### API 层
- [ ] CRUD API 功能正常
- [ ] Cron 表达式后端校验
- [ ] 时区后端校验
- [ ] 手动触发 API 返回 executionId
- [ ] 执行历史 API 支持分页（limit/offset）

### 调度引擎
- [ ] 定时任务按时触发，创建 system 消息
- [ ] system 消息触发 Agent 响应（复用 `invokeConversation()`）
- [ ] 并发场景下不重复触发
- [ ] 对话完成后任务自动禁用
- [ ] 连续失败 >=3 次自动置为 error
- [ ] 进程退出时 timer 正确清理（`stop()` 方法）

### 前端
- [ ] `LocalMessage.st` 类型扩展为 `'user' | 'otter' | 'system'`
- [ ] `MessageItem` 正确渲染 system 消息
- [ ] 前端 RightPanel 显示任务列表
- [ ] 创建/编辑弹窗功能正常
- [ ] Cron 预设选择器和预览功能
- [ ] 执行历史可查看（分页加载）
- [ ] 手动触发后立即刷新
- [ ] 启用/禁用乐观更新（无 stale closure）
- [ ] 删除需确认弹窗
- [ ] error 状态任务可恢复为 active
