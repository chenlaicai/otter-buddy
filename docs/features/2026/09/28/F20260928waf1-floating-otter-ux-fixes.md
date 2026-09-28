---
id: F20260928waf1
title: 浮动獭交互三处实测修正：点内收起 bug + hover 快捷气泡砍除 + 侧栏创建按钮移除
summary: 搭档实测 web 助理（#1174 合入后）反馈三问题——点击面板输入框弹窗即消失（真 bug）、hover 三条「随便问点什么」多余、侧栏不该有「创建 web 助理对话」按钮。P1 根因为点外收起判定的 panelRef 定义未绑定恒 null，点面板内部被判「外部」→收起；P2/P3 为交互简化与语义修正。
change_type: fix
tags: [web-assistant, floating-ui, ux, bugfix]
modules:
  - web/src/components/FloatingAssistant/use-floating-otter.ts
  - web/src/components/FloatingAssistant/FloatingAssistant.tsx
  - web/src/components/FloatingAssistant/AssistantPanel.tsx
  - web/src/components/FloatingAssistant/FloatingOtter.tsx
  - web/src/pages/conversation/LeftPanel.tsx
created_in_conversation: 480589fd-5813-400a-9b07-8e7d5707fb34
---

# 浮动獭交互三处实测修正（F20260928waf1）

## 预注册（动手前冻结）

- 预期根因方向：P1 弹窗消失是「点外收起」误判（面板内点击被当成外部）；P2/P3 是设计决策修正，无技术根因
- 验证标准：修复前「点 input 打字面板不消失」用例红、修复后绿；P2/P3 用 DOM 断言（hover 卡 count=0、创建按钮 count=0）
- 最强反例方向：若 P1 红在「獭不可见」而非「面板消失」，则根因在挂载条件而非收起判定——需重查 AppLayout/settings 链路

## 问题现象（搭档实测反馈 2026-09-28）

1. **P1**：点击浮动獭 → 面板弹出 → 点击输入框 → **弹窗消失**（复现链完整）
2. **P2**：鼠标移上浮动獭显示三条「随便问点什么」快捷问句——「我觉得没必要，我只想点击弹出对话」
3. **P3**：左侧栏 web 助理空组显示「创建 web 助理对话」按钮——「web 助理是**固定全局一个**的，你不应该让我创建」

## 根因分析

### P1：点外收起判定的 panelRef 从未绑定（真 bug）

`use-floating-otter.ts` 原代码：

```ts
const panelRef = useRef<HTMLDivElement | null>(null)   // 定义
// ...
function onPointerDown(e: PointerEvent) {
  const target = e.target as Node
  if (panelRef.current?.contains(target)) return      // panelRef.current 恒 null
  // → 恒 undefined → 不 return → 判为外部 → setOpen(false)
```

panelRef 定义在 hook 内但**从未绑定到任何元素**（AssistantPanel 根元素未接收 ref），`panelRef.current` 恒为 null，`?.contains` 短路返回 undefined（falsy）→ 面板内部任何 pointerdown（含点输入框）都被判为「点在面板外」→ 收起。pointerdown 先于 focus 触发，故用户感知为「点输入框瞬间弹窗消失」。

**为何 e2e 没拦住**：存量用例（floating-assistant.spec.ts:40）只断言 `input.toBeEnabled`，从未点击 input——测试盲区。本 PR 先补失败用例（修复前红）再修（troubleshooting 5a 失败固化）。

### P2：hover 快捷气泡与「点击=对话」心智冲突（设计修正）

FloatingOtter.tsx 原有 hover 快捷气泡（三条静态 QUICK_PROMPTS）。全局随问场景实测反馈多余——交互简化为「点击獭=开面板」，无中间层。

### P3：web 助理全局唯一，不存在用户侧「创建」语义（语义修正）

LeftPanel.tsx 的 K4 处置（#1174 检视轮次加的降级入口）在空组渲染「创建 web 助理对话」按钮——但 web 助理固定全局一个、首唤自动开户，用户不需要也不应该「创建」。按钮删除后空组仅余分组头。

**降级路径如实记录**（检视 M1 修正）：settings 页开关是**只读**（`web/src/pages/settings/index.tsx:135-140`），重开浮动獭须改 `config.yaml` 的 `assistant.web.enabled` + 重启；「enabled=false + 从未开户」时用户零 web 助理入口（K4 盲点回归，有搭档 P3 决策背书，属已认领代价）。

## 修复（修法决策树：P1 走①既有语义内修；P2/P3 走③删除机制）

| 点 | 修法 | 文件 |
|---|---|---|
| P1 | panelRef 经 hook return 暴露 → 宿主绑定 → AssistantPanel forwardRef 到根 div | use-floating-otter.ts + FloatingAssistant.tsx + AssistantPanel.tsx |
| P2 | 删 hover 气泡 JSX + QUICK_PROMPTS + onQuickPrompt/initialDraft 预填链路（死代码） | FloatingOtter.tsx + FloatingAssistant.tsx + AssistantPanel.tsx |
| P3 | 删创建按钮 + handleCreateWebAssistant + webAssistantCreating state + showToast 死 import | LeftPanel.tsx |

Modification-Class: narrow-fix（P1 既有语义内修）+ deletion（P2/P3 机制删除）——见 commit 声明。
机制识别检查点：无新增配置/状态生命周期/定时/信号/持久化/决策分支/跨模块调用——P1 是既有判定逻辑的 ref 补绑，P2/P3 是纯删除，不涉净新增机制。

## 验证

### 失败固化（修复前，alpha 3140 实例）

- P1「点击输入框输入文字，面板不消失」：**红**（fill 超时——click 后面板消失 input 不可寻）
- P1「点击消息区空白处，面板不消失」：**红**
- P2「hover 獭不出现快捷气泡」：**红**（hover-card 存在）
- P3「侧栏无创建按钮」：红（mock 普通对话×1 + 零 web 助理对话的列表——防用例间首唤开户污染共享库；首版未 mock 时因 P1 先开户而假绿，已修正用例隔离）

### 修复后（alpha 3142 实例）

- 回归 spec 5/5 **全绿**（P1×2 + P2 + P3 + 正路径「点外收起仍工作」）
- 存量 spec：floating-assistant.spec.ts 4/5 + disabled 1/1——「Esc 收起/⌘J 唤起」全量顺序跑偶发红（**修复前代码同样红**，git stash 对照验证），单独跑稳定过 → 存量 flaky 与本 PR 无关，开 issue 跟踪
- web tsc 0 error；eslint 0 error；单测 11/11

## 影响范围

- 仅 web 前端 5 文件 + 新增 1 回归 spec；后端零改动
- 快捷问句预填（initialDraft/onDraftConsumed）链路随 P2 一并删除——唯一消费者是已删的 hover 气泡
- 侧栏 web 助理空组从「按钮」降级为「仅分组头」——重开浮动獭须改 config.yaml（settings 开关只读）+ 重启，见「根因分析」降级路径如实记录节

## 遗留

- Esc 收起/⌘J 唤起的顺序依赖 flaky（存量，修复前可复现）→ 开 issue 跟踪
