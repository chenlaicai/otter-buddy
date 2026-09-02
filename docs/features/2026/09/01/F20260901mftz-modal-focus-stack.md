---
id: F20260901mftz
title: "多 Modal 叠加 focus trap 栈感知（#510）"
summary: F20260826pfix（PR #503）给 Modal 加了 focus trap 后遗留：多 Modal 叠加（Modal 内开 Modal）时每个实例都往 document 挂 keydown，Tab 循环互相拉扯、Escape 连锁关闭全部。修复：模块级 Modal 栈，只有栈顶实例响应 Tab 循环和 Escape。
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯前端交互修复，无 LLM 行为变更"
tags: [web, frontend, modal, a11y, focus-trap]
modules:
  - web/src/components/Modal.tsx
  - web/src/components/Modal.stack.test.tsx
---

# 多 Modal 叠加 focus trap 栈感知（#510）

## 背景

F20260826pfix（PR #503）检视发现 5：「Modal 内开 Modal 场景（OtterDetailModal → DissolveModal）两个 focus trap 都监听 keydown，Tab 循环可能互相拉扯。需 z-index 层级判断或事件优先级机制」。

## 根因

`Modal.tsx` 的两个 `useEffect`（Escape 关闭 + Tab focus trap）各自往 `document` 挂 keydown listener，无栈/层级意识：

1. **Tab 拉扯**：叠加时两个 trap 都拦截 Tab。内层 trap 先 `preventDefault` 把焦点锁在内层 dialog，外层 trap 的 handler 同样收到事件——两个循环边界都在生效，焦点行为取决于 listener 注册顺序，不可预测。
2. **Escape 连锁**：两个实例都监听 Escape，一次 Esc 把内外两层全部关闭（用户预期只关最上层）。

叠加场景在仓库中真实存在：conversation 页 `ConversationModals` / `ScheduledTaskModal` / `ExecutionHistoryModal` 三者独立 state 可同时开（index.tsx:174 `isAnyModalOpen` 派生即为佐证）；memory 页三个 Modal 也是独立 state。

## 方案设计

**模块级 Modal 栈**（而非 z-index DOM 探测）：

```ts
const modalStack: number[] = []   // 所有打开中的 Modal 实例共享
let nextModalId = 1
function isStackTop(id) { return modalStack[modalStack.length - 1] === id }
```

- 实例 open 时 push 自增 id，close/unmount 时 splice 移除
- Escape handler：`isStackTop(id)` 才调 onClose——叠加时只有最上层响应，连锁关闭消失
- Tab trap handler：`isStackTop` 才接管循环——非栈顶实例静默，焦点始终锁在栈顶 dialog
- 焦点归还（`prevActive?.focus()`）天然正确：栈顶打开时记录的 `prevActive` 就在次层 Modal 内，栈顶关闭后焦点回到次层

**选型对比**：
- z-index DOM 探测（读 `getComputedStyle` 找最高层）——DOM 依赖重、时序脆弱（portal 挂载顺序 vs 渲染顺序），放弃
- 事件优先级（capture 阶段 + stopPropagation）——keydown 在 document 上无天然优先序，仍需层级信息判断谁该拦，绕回栈方案
- 模块级栈——20 行，无 DOM 探测，React 生命周期（effect push / cleanup splice）天然维护栈序。**Portal 挂 body 不影响**：栈是组件实例级的，与 DOM 位置无关

## 变更清单

| 文件 | 变更 |
|---|---|
| `web/src/components/Modal.tsx` | 新增模块级栈 + `isStackTop` 门控（Escape + Tab 两处 handler） |
| `web/src/components/Modal.stack.test.tsx` | 新增：叠加 4 用例（Escape 只关栈顶 / Tab 锁栈顶 / 栈顶关闭后次层恢复 / body.modal-open 不回归） |

## 验证

- web：`npx vitest run` 41 files / **341 tests 全绿**（Modal 既有 6 用例无回归 + 新增 4）；`npx tsc --noEmit` 零错误
- **已过最简实现检查**：未引入 focus-trap 库（react-focus-lock 等约 8KB + 全局行为接管），模块级栈 20 行解决本仓库的实际叠加形态（同一页面组件树内的 Modal 组合）。
- 既有行为锁定：body.modal-open 多重弹窗共存语义（F20260825scrf）有专门用例，未被栈改动破坏。

## 本次变更对旧特性的记录

- **F20260826pfix**（Modal focus trap 初版）：其遗留发现 5 由本特性关闭。单 Modal 行为（打开聚焦关闭按钮 + Tab 循环 + 关闭归还焦点）不变，只加栈门控。
- **F20260825scrf**（body.modal-open）：未触碰。栈只管键盘事件归属，class 生命周期仍由原逻辑管理。
