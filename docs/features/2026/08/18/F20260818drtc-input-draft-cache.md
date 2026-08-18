# 输入框草稿缓存

## 背景

搭档原话："web侧的输入框，你看看能不能加一个 缓存，我有时候可能在某一个对话中临时输入一些内容，但是暂时不发送，这个缓存可能就在浏览器侧，不需要进入后台，你分析下是不是有业界主流的做法"

当前问题：MessageInput 组件使用局部 `useState` 管理输入内容，切换对话（MPA 整页跳转）或刷新页面时，未发送的输入内容丢失。

## 目标

T1: 用户在对话 A 中输入未发送的内容，切换到对话 B 再切回对话 A 时，输入内容恢复
T2: 用户刷新页面后，当前对话的未发送输入内容恢复
T3: 用户发送消息后，该对话的草稿缓存自动清除

## 非目标

- 草稿内容不进入后端（纯浏览器侧实现）
- 不支持多设备同步（localStorage 是单设备的）
- 不支持富文本草稿（仅纯文本）

## 方案设计

### 技术方案

使用 `localStorage` 实现草稿缓存，这是业界主流做法（ChatGPT、Telegram Web、Discord、飞书 Web 均采用）。

#### 存储格式

```
Key: draft:{conversationId}
Value: string (用户输入的文本)
```

#### 核心逻辑

1. **加载草稿**：组件挂载或 `activeId` 变化时，从 localStorage 读取对应对话的草稿
2. **保存草稿**：用户输入时 debounce 300ms 写入 localStorage（避免频繁写入）
3. **清除草稿**：发送成功后 `localStorage.removeItem('draft:{convId}')`
4. **兜底保存**：监听 `beforeunload` 事件，页面关闭或跳转前**立即同步写入** localStorage 并**取消 debounced 保存**，避免重复写入
5. **边界处理**：当 `conversationId` 为 null 时（如新建对话、未选择对话），不保存草稿（因为无法关联到具体对话）

#### 实现方式

新增自定义 Hook `useDraftCache`，封装草稿的加载/保存/清除逻辑：

```typescript
// web/src/hooks/use-draft-cache.ts
function useDraftCache(conversationId: string | null) {
  // 加载草稿
  // 保存草稿（debounced）
  // 清除草稿
  return { draft, setDraft, clearDraft }
}
```

在 `MessageInput` 组件中集成此 Hook。

### 涉及模块/文件

- `web/src/hooks/use-draft-cache.ts`（新增）
- `web/src/pages/conversation/MessageInput.tsx`（修改）

### 数据模型变更

无。纯浏览器侧 localStorage，不涉及后端数据模型。

### 关键接口

无新增接口。

## 影响范围

- 仅影响 Web 端输入框组件
- 不影响消息发送逻辑
- 不影响后端 API
- 不影响 SSE/消息流

## 风险与约束

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| localStorage 容量限制（通常 5-10MB） | 单条草稿通常 < 1KB，风险极低 | 无需特殊处理 |
| 同源 Tab 共享 localStorage | 多 Tab 编辑同一对话可能冲突 | 可接受，草稿以最后写入为准；后续可优化：监听 `storage` 事件实现跨 Tab 同步 |
| 对话被删除后草稿残留 | localStorage 中残留无用数据 | 可选：定期清理或忽略（影响极小） |
| localStorage 不可用（隐私模式、用户禁用、存储空间已满） | 草稿缓存功能降级 | 功能降级，不影响正常使用；不保存草稿，用户仍可正常使用输入框 |

## 不兼容更新

无破坏性变更。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 存储方案 | localStorage | sessionStorage | sessionStorage 刷新后丢失，不满足 T2；localStorage 跨刷新持久化 |
| 存储方案 | localStorage | IndexedDB | IndexedDB 过度设计，草稿是简单字符串，localStorage 足够 |
| 保存时机 | debounce 300ms | 实时保存 | 避免频繁写入影响性能 |
| 作用域 | 按对话 ID 隔离 | 全局单草稿 | 满足 T1，用户可能在多个对话中都有草稿 |

## 验证

### 验收标准

1. 在对话 A 输入内容，切换到对话 B，切回对话 A，输入内容恢复
2. 在对话 A 输入内容，刷新页面，输入内容恢复
3. 在对话 A 输入内容并发送，草稿清除，再次进入对话 A 输入框为空
4. 在对话 A 输入内容，切换到对话 B，在对话 B 输入不同内容，两个对话的草稿各自独立

### 测试设计

#### 单元测试

1. **debounce 行为**：验证输入后 300ms 内不写入 localStorage，300ms 后写入
2. **beforeunload 同步保存**：验证页面关闭前立即同步写入 localStorage
3. **conversationId 为 null 时的行为**：验证不保存草稿
4. **清除草稿**：验证发送成功后 localStorage 中对应 key 被删除
5. **加载草稿**：验证组件挂载时从 localStorage 读取草稿

#### 集成测试

1. **MPA 跳转后恢复**：在对话 A 输入内容，切换到对话 B，切回对话 A，验证输入内容恢复
2. **刷新页面后恢复**：在对话 A 输入内容，刷新页面，验证输入内容恢复
3. **发送后清除**：在对话 A 输入内容并发送，验证草稿清除，再次进入对话 A 输入框为空
4. **多对话独立**：在对话 A 输入内容，切换到对话 B，在对话 B 输入不同内容，验证两个对话的草稿各自独立

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/hooks/use-draft-cache.ts` | 新增 | 草稿缓存 Hook |
| `web/src/pages/conversation/MessageInput.tsx` | 修改 | 集成 useDraftCache |

## 实施计划

| 阶段 | 交付物 | 工作量预估 |
|------|--------|----------|
| 1. Hook 开发 | `useDraftCache` Hook + 单元测试 | 2 小时 |
| 2. 组件集成 | MessageInput 集成 useDraftCache | 1 小时 |
| 3. 集成测试 | 端到端测试验证 | 1 小时 |
| 4. 代码审查 | PR 审查 + 修复 | 1 小时 |

**总工作量预估**：5 小时

## 待办清单（后续优化）

| 编号 | 优化项 | 优先级 | 说明 |
|------|--------|--------|------|
| O1 | 多 Tab 同步 | 低 | 监听 `storage` 事件实现跨 Tab 同步，提升用户体验 |
| O2 | 草稿过期清理 | 低 | 定期清理过期草稿（如超过 30 天未访问的对话草稿） |
