---
fid: F20260929fcln
id: F20260929fcln
title: web 弹窗冻结机制遗留清理（#884）——shimmer 冻结规则与冻结链四组件退役
summary: >
  F20260909srf6（PR #882）把弹窗期模糊语义切换为「内容自模糊」后，前五轮为保
  scrim 采样准静态而建的冻结机制全部失去服务对象（#884）。逐项评估后退役：①
  globals.css shimmer 冻结规则与孤儿类定义（挂载点已随 #886 消失，双孤儿）；②冻结
  链四组件——batcher defer、useDeferredOps 延迟队列（整文件删）、双轮询 modalOpen
  gate、refreshMessages 守卫、关窗 flush 全拆。「关窗 flush 零丢失」论证不成立：
  app-content-scroll 包住整个 Outlet（全部背景更新都在 blur 层内）；且 invoke.*
  事件本就无门控直行（右栏弹窗期一直在更新）。零丢失由 batcher 暂存链+幂等
  materialize 保证，与 defer 无关。modal-open class 保留（现役职责：挂内容自
  模糊）。web 全量 575/575 绿（+8 契约测试），tsc/eslint 零错。
created: 2026-09-28
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
change_type: refactor
status: implemented
related_issues: ["#884"]
related:
  - F20260909srf6      # 模糊语义切换（本清理的直接前提）
  - F20260825scrf      # 冻结链建造者（PR #456）
  - F20260827scrf2     # 第五源治理（deferred ops）
capability_test: web/src/styles/scrim-flicker-6.test.ts
intent:
  problem: >
    issue #884（PR #882 检视产出）：语义切换后冻结机制失去原始服务对象，
    globals.css shimmer 冻结规则与 index.tsx 冻结链成为死代码/双轨语义——
    其中「关窗 flush 零丢失仍有价值」的声明（srf6 文档 :57）未经独立论证。
  expected_effect: >
    死代码清零、双轨语义归一：弹窗期背景渲染走单一语义（内容自模糊 + 直行
    更新），无冻结 gate 残留；不删 Modal/modal-open class（现役职责：挂内容
    自模糊）；不碰 scrim 视觉行为与其他页面。
  verify_by:
    type: capability_test
    note: >
      样式/结构契约测试（scrim-flicker-6.test.ts +5）：stream-shimmer 零残留、
      modal-open 规则白名单（仅内容自模糊/摘 backdrop-filter/reduced-transparency
      三类）、useDeferredOps 文件不存在、useScheduledTasks 无 enabled、
      index.tsx 无冻结链标识、BATCH_WINDOW_MS 仍在（追上能力未削弱）。
      batch-update.test.ts 契约组（+2）：flush 无门控（窗口到期必产出）、
      getShouldDefer 类型退役。web 全量 575/575 绿。
---

# web 弹窗冻结机制遗留清理（#884）

## 背景

弹窗背景玻璃闪烁历经六轮修复（F20260824m2345 memo → F20260825scrf Portal+冻结三源
→ F20260827scrf2 第五源 deferred ops → F20260909srf6 模糊语义切换）。第六轮把语义
从「scrim backdrop-filter 实时采样下层位图」改为「内容自模糊」：`body.modal-open
[data-testid='app-content-scroll'] { filter: var(--scrim-blur) }` + scrim 摘掉
backdrop-filter——闪烁机理（采样失效间隙的清晰帧）整体消除。

语义切换后，前五轮「冻结背景变化源以保 scrim 采样准静态」的全部机制失去服务对象。
PR #882 检视发现两处遗留，issue #884 立项清理。

## 评估结论（逐项）

### 第 1 项：shimmer 冻结规则——删（双孤儿实证）

`body.modal-open .stream-shimmer::after { animation: none; }`（globals.css 冻结规则）
与 `.stream-shimmer` 类定义：

- **挂载点已消失**：`.stream-shimmer` 在 web/src 组件代码零引用（全仓 grep 仅剩 CSS
  自身与注释）。git 考古（`git log -S "stream-shimmer"`）：挂载点随 **#886**（F20260913ctlv
  对话视图重构，b1d11c5f）删除——StreamingProcess 组件退役，类定义与冻结规则自此双孤儿。
- **backdrop-filter 无其他消费方受影响**：issue 要求「grep 全仓确认 backdrop-filter
  无其他消费方」——实测 globals.css 存在多个装饰性消费面（chrome/panel/card/overlay/
  bubble/form-input 玻璃层），但它们的模糊采样对象是**静态背景**（极光画布），冻结
  shimmer 动画对它们同样无作用（shimmer 已死）。Modal 弹层自身（glass-overlay）在 scrim
  之上、弹窗打开时新建 DOM，不受背景更新影响。故无需保留。

处置：冻结规则 + 孤儿类定义 + keyframes 全删（-14 行 CSS）。

### 第 2 项：冻结链四组件——全拆（数据一致性论证）

srf6 文档 :57 声明「batcher defer / 轮询 gate / deferred ops 对数据一致性（关窗 flush
零丢失）仍有价值」——本轮基于当前真实代码独立论证，**结论：价值不成立，全拆**：

| 组件 | 现状代码 | 论证 | 处置 |
|---|---|---|---|
| batcher defer（getShouldDefer） | MessageBatcher 构造参数，弹窗期跳过 flush | 「零丢失」由**暂存链 + materialize 幂等重放**保证（F20260814qswp 三轮打磨的机制），与 defer 无关——defer 只是推迟 flush 时机。拆除后弹窗期每 50ms 窗口正常产出，内容在 blur 层内更新，无视觉问题 | 删参数、flush 回归无门控 |
| 轮询 gate（!modalOpen） | useConversationListPolling / useScheduledTasks 的 enabled | 采样语义已死，暂停轮询无收益；暂停反而让弹窗期后台列表/任务数据滞后（关窗才追上） | 恢复常轮询，useScheduledTasks 退 enabled 形参 |
| deferred ops（useDeferredOps） | runOrDefer 攒队列、关窗 flush | 延迟的只有视觉收益（防采样闪烁）；参与者 upsert 是 fill-only 幂等、徽标计数是数字递增，直行执行语义不变 | hook 整文件删除（+测试），消费点直行 |
| 关窗 flush effect | `if (!modalOpen) { batcher.flush(); flushDeferredOps() }` | 随 defer 机制消亡失去存在意义 | 删 |

**关键事实**（论证依据）：

1. `app-content-scroll`（AppLayout.tsx:33）包住整个 `<Outlet />`——conversation 页
   左右栏+消息区**全部**在 blur 容器内。弹窗期任何背景 setState 都发生在模糊层内，
   模糊连续跟随内容变化（这正是 srf6 的根治机理），无清晰帧跳变。
2. **冻结链从未冻结过右栏状态**：SSE GET 通道 `invoke.*` 事件（index.tsx L512
   syncInvokeState）无任何门控直行 setState——今天弹窗期右栏就在 blur 层内实时更新。
   冻结链只覆盖 batcher/轮询/参与者/徽标，本就是不完备的白名单（第六源 setElapsed
   漏网正是其结构性缺陷的实证）。
3. TopBar 在 blur 容器外，但其内容（导航标题）不随流式更新，无像素变化源。

### 保留项

- **Modal / body.modal-open class**：现役职责是挂内容自模糊 CSS（`.modal-open
  [data-testid='app-content-scroll']`）——保留，注释更新（原注释仍描述冻结语义）。
- **MessageBatcher 本体**：50ms 合并窗口（减少重渲染频率）是独立价值，与冻结无关。
- **scrim 视觉行为**：零触碰。

## 变更清单

| 文件 | 变更 |
|---|---|
| `web/src/styles/globals.css` | 删 shimmer 冻结规则 + 孤儿类定义/keyframes（-14 行） |
| `web/src/pages/conversation/index.tsx` | 删 modalOpen 派生/ref/关窗 flush effect；batcher 退 defer 参数；双轮询 gate 恢复常行；refreshMessages 守卫删；deferred ops 消费点直行（upsertOtterIfAbsent 去队列化）；依赖数组同步 |
| `web/src/pages/conversation/hooks/useDeferredOps.ts` | **整文件删除** |
| `web/src/pages/conversation/hooks/useDeferredOps.test.tsx` | **整文件删除** |
| `web/src/pages/conversation/hooks/useScheduledTasks.ts` | 退 enabled 形参（两 effect 恒启用） |
| `web/src/lib/batch-update.ts` | 删 getShouldDefer option 与 flush 门控（-7 行） |
| `web/src/lib/batch-update.test.ts` | 删 defer describe 块（4 用例）；新增无门控 flush 契约组（2 用例） |
| `web/src/components/Modal.tsx` | modal-open 注释更新（现役职责：挂内容自模糊） |
| `web/src/styles/scrim-flicker-6.test.ts` | 新增冻结链退役契约组（5 用例） |

## 验证

- web 全量 **575/575**（58 文件，原 567 + 新增 8 契约用例）
- `npx tsc --noEmit` rc=0；`npx eslint src --quiet` rc=0
- 契约测试锁定：stream-shimmer 零残留 / modal-open 规则白名单 / useDeferredOps
  文件不存在 / useScheduledTasks 无 enabled / index.tsx 无冻结链标识 /
  BATCH_WINDOW_MS=50 仍在（流式追上能力未削弱）/ batcher flush 无门控

## 已知边界

- 弹窗期背景恢复实时更新（原被冻结的 batcher/轮询/参与者/徽标）——全部发生在
  blur 层内，无采样失效机理；若未来出现「弹窗期需暂停背景计算」的新需求（如性能），
  应按新语义重新设计，而非恢复旧冻结链（契约测试会拦）。
- `prefers-reduced-transparency: reduce` 下弹窗期内容区不加模糊（srf6 既有语义），
  该模式下背景直行更新可见——与 srf6 前的常态一致，无回归。

## 修法排序声明

③删除（deletion）：失去服务对象的冻结机制整体拆除，零新增机制。
Modification-Class: deletion
