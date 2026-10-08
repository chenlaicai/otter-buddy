---
id: F20261008scpg
title: 对话页滚动治理：scroll-pin 状态机消除贴底停摆竞态与自动上跳
summary: 用户贴底看流式回复时页面周期性自动上跳至滚动条中间位置。根因是 F20260818nscp 迁移原生滚动时关闭浏览器锚定后，手写贴底补偿存在「先检查后补偿」竞态：程序性贴底写入触发 scroll 事件，流式内容持续增长使补偿后的位置瞬间超出 100px 底部阈值，isAtBottomRef 翻 false 后补偿永久停摆；9/29 html-card 高度棘轮解开（280bb4e2）引入上方内容大幅双向突变后，停摆状态下无任何保护，scrollTop 不变而滚动条比例骤降。本特性以单一「是否贴底」事实源（scroll-pin 状态机：pinned / floating + 用户最近意图）替换现有三处独立判断：程序性滚动写入经自证账本（write ledger）登记归因、不污染用户意图状态，无专门事件的手势（滚动条拖动）由位移方向归因覆盖，高度变化统一经 content ResizeObserver 一口补偿；顺带修复跳底按钮 querySelector 找不到容器的死按钮 bug。
change_type: fix
capability_test: "n/a: 滚动几何竞态依赖浏览器滚动事件时序，jsdom 无法模拟 scrollHeight/scrollTop 真实联动，测试用例覆盖判定函数纯逻辑（意图提取、阈值判定、账本归因），几何时序以人工验证清单代替"
created_in_conversation: 27398619-8e0b-4147-8230-93e23f1a01ac
causal_links:
  from:
    - F20260803vmsg
    - F20260805abpp
    - F20260810p7zg
    - F20260811ke4k
    - F20260813scrl
    - F20260904smsj
    - F20260923stsb
  supersedes: []
tags: [conversation, scroll, resize-observer, streaming, race-condition]
modules:
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/index.tsx
created_at: 2026-10-08
---

# 对话页滚动治理：scroll-pin 状态机

## 1. 背景（意图锚）

搭档原话：

> 我今天发现，对话框会突然自己上跳？本来我都是在看最新消息，然后页面突然自己跳了一下，发现跳到滚动条可能是中间位置？你排查下

> 我提醒一点，不要做打补丁行为，要完整分析全链路、要有完整设计视角。你来干

现象：用户贴在底部看最新消息（多为流式回复期间），页面突然自动上跳一下，滚动条停在中间位置。用户没有执行任何滚动操作。

### 1.1 现象复现机理（排查结论，静态代码推理置信度：机制链高，引爆序列中）

停摆竞态全序列（代码锚点见 §2.2）：

1. 用户贴底 → `isAtBottomRef.current === true`
2. 流式内容增长 → content ResizeObserver 触发 → rAF 写入 `scrollTop = scrollHeight` 贴底
3. 该写入触发 scroll 事件 → `handleScroll` 重判 `isNearBottom`（阈值 100px）
4. **竞态点**：流式期间内容持续增长，写入的 scrollTop 在 scroll 事件处理时已「过期」——内容又长高了一截，距离底部瞬间 > 100px → `isAtBottomRef` 翻 false → `onAtBottomChange(false)` → 补偿守卫从此停摆
5. 停摆后视觉上用户仍在底部附近（一两百像素内无感知），但机制认为「用户离开了底部，不打扰」
6. **引爆**：视口上方内容高度突变（html-card 缩矮/撑高、居中插入的 invoke/yield 条目等）→ scrollTop 数值不变但滚动条比例骤降（如 ~95% → ~50%），或 scrollHeight 骤减被浏览器 clamp → 用户看到「突然跳到中间」

### 1.2 历史修复链与本特性的位置

| 轮次 | 特性 | 做了什么 | 结果 |
|------|------|----------|------|
| 1-3 | F20260803vmsg / F20260805abpp / F20260810p7zg | Virtuoso 时代修抖动 | 按下葫芦浮起瓢：followOutput / atBottomStateChange / scrollToIndex 三套滚动指令交叉执行（F20260813scrl 结论） |
| 4 | F20260813scrl | 移除 react-virtuoso → 原生滚动 + `overflow-anchor: 'none'` | 消除指令交叉，但锚定关闭后内容高度变化零保护，全靠手写补偿 |
| 5 | F20260904smsj (#790) | 修「发言时刻未读分隔线」单一路径的高度跳动 | 只修一条路，其余高度变化来源未覆盖（文档自述） |
| 6 | F20260923stsb | 给信号轨迹 chip 加双 ResizeObserver 贴底补偿 | 仍是逐源补偿：每个高度变化源各配一套 observer，源列表继续增长时修补不可持续 |
| — | 280bb4e2（9/29，非滚动专项） | html-card 高度棘轮解开，可撑可缩（含 CSS transition） | 上方内容开始有大幅双向突变的可能，引爆既存停摆竞态 → 本次现象 |

**教训提取**：6 轮修复的共同模式是「对单一来源打补丁」——每次新高度变化源出现就再补一套补偿。本特性不再沿这条路走（搭档原话明示），改为收敛滚动控制的所有权。

## 2. 现状全链路

### 2.1 内容高度变化源盘点（滚动几何的全部扰动输入）

视口上方（影响已浏览内容，停摆时导致上跳/跳变）：

| # | 来源 | 触发时机 | 方向 | 锚点 |
|---|------|----------|------|------|
| S1 | html-card 高度棘轮解开 | 卡片内容渲染完成 / 回执交互 / CSS transition | 双向大幅（实测有 800→74px 级） | 280bb4e2（#1318 谱系） |
| S2 | invoke_start / invoke_end / yield 居中条目插入 | SSE 事件 | 增高 | index.tsx insertCenteredByTs 调用点（636/683/696 一带） |
| S3 | 信号轨迹 chip / 徽标 / GateBanner | 轮询刷新渲染 | 双向小幅 | F20260923stsb，SignalBadge.tsx |
| S4 | 图片加载 | img onLoad | 增高 | MessageList.tsx MessageItem `<img>`（575 一带） |
| S5 | 未读分隔线插入/移除 | 会话打开/已读 | 增高 | unreadSeparatorSeq |
| S6 | SSE 断连补偿合并替换 | refreshMessages 幂等合并 | 高度重排（对象替换引发重渲染） | index.tsx refreshMessages + mergeMessages（message-stream.ts:160） |

视口下方（贴底流式区，正常跟随）：

| # | 来源 | 方向 |
|---|------|------|
| S7 | 流式文本增长 | 持续增高 |
| S8 | 新消息到达 | 增高 |
| S9 | markdown 渐进渲染（代码块、列表结构化） | 阶段性增高 |

视口自身：

| # | 来源 | 方向 |
|---|------|------|
| S10 | 窗口 resize / 面板开合（右栏、左栏） | 视口高度双向变化 |

### 2.2 现有滚动控制机制盘点（写入点与判断点）

| # | 机制 | 位置 | 性质 |
|---|------|------|------|
| W1 | 滚动事件监听 `handleScroll` | MessageList.tsx:313 附近 | **判断点**：isNearBottom(el)（阈值 100px）→ isAtBottomRef + onAtBottomChange；scrollTop===0 触发 onLoadMore（上翻分页，记录 pendingScrollRestoreRef） |
| W2 | messages.length 增量贴底 effect | MessageList.tsx:226-277 | **写入点**：新消息到达且 isAtBottomRef=true 时 scrollToBottom（rAF） |
| W3 | content ResizeObserver 贴底补偿 | MessageList.tsx:279 附近 | **写入点**：内容高度增长且 isAtBottomRef=true → rAF 贴底 |
| W4 | viewport ResizeObserver 贴底补偿 | MessageList.tsx:300-318 | **写入点**：视口缩小时 isAtBottomRef=true → 贴底 |
| W5 | 首次渲染贴底 effect | MessageList.tsx:340-348 | **写入点**：mount 时 scrollToBottom |
| W6 | 跳底按钮 scrollTo | index.tsx:424-426 | **写入点**：`document.querySelector('[data-message-list]')` —— **该属性渲染端不存在，死按钮（已全仓 grep 确认）** |
| W7 | handleJumpToMessage scrollIntoView | index.tsx:465 | 写入点：执行历史弹窗手动跳转（block:'center'） |
| W8 | 上翻加载后位置恢复 | 记录在 MessageList.tsx:330-336（onLoadMore 处），恢复写入在 233-240——与 W2 同一个 useEffect（226-252），处置时须拆分 | 写入点：onLoadMore 后按 pendingScrollRestoreRef 恢复 |

### 2.3 结构性缺陷（三条，互为放大）

**D1 ——「是否贴底」没有单一事实源**。isAtBottomRef 由 W1（几何判断）更新，被 W2/W3/W4（几何写入）消费；但写入本身又触发 W1 重判。检查与行动构成反馈环：程序性贴底写入 → scroll 事件 → 几何重判 → 可能翻转判定 → 后续补偿停摆。流式增长期（S7/S9）判定翻转是必然事件而非偶发——这是「先检查后补偿」（check-then-act）竞态。历史同构：F20260811ke4k 记载 Virtuoso 时代「followOutput 与 newMessagesCount 两套是否在底部状态时序矛盾」，同一问题模式在原生滚动时代转世。

**D2 —— 高度变化保护按来源打补丁**。浏览器锚定在 F20260813scrl 迁移时显式关闭（`overflow-anchor: 'none'`，配合移除 Virtuoso 自控布局的决策），此后所有高度变化对滚动位置都是零保护。F20260904smsj、F20260923stsb 逐源加补偿，§2.1 的来源清单 S1-S10 里每一项都可能成为下一个「补一个漏一个」的轮回入口。

**D3 —— 用户意图与程序意图共用一个通道**。scroll 事件无法区分「用户拖动滚轮」与「代码写入 scrollTop」。W2/W3/W4 的程序写入被 W1 当成用户行为解读，是 D1 的成因；反过来，任何试图在写入期间抑制判定的补丁（如「写入前设 flag、写入后清除」）都会遇到 flag 生命周期与浏览器异步滚动事件时序对不齐的问题（smooth 滚动、rAF、合成线程介入），继续打下去会得到第二套交叉竞态。

## 3. 目标

- T1: 用户贴底期间，无论视口上下方内容如何变化（S1-S10 全集），视口锚定在底部不动——不跳、不漂、不丢
- T2: 用户离开底部（上翻阅读）后，任何内容变化**不改动 scrollTop**（阅读位置不被程序滚动劫持；上方内容自身增高会把在读内容下推出视口——那是内容布局变化而非滚动劫持，与现状一致）；上翻加载历史的位置恢复（W8）行为不变
- T3: 消灭「贴底补偿停摆」——不存在「视觉在底部附近但机制认为不在底部」的状态
- T4: 单一事实源：全组件只有一个「是否贴底 + 用户意图」状态，判定、消费、写入路径全部收敛到一处
- T5: 修复跳底按钮死按钮（W6），被晾在中间时用户有明确自救路径
- T6: 机制可退役：新消息计数（onAtBottomChange 消费方）等既有功能行为保持或更好

## 4. 非目标

- 不恢复 react-virtuoso 或任何虚拟滚动库（F20260813scrl 的方向性结论，历史包袱太重）
- 不恢复浏览器 overflow-anchor 锚定（见 §8 设计取舍——锚定与我们的「贴底跟随」语义不同，且当时关闭有配合移除 Virtuoso 的决策语境；两套锚定并存会引入新的交叉）
- 不改造消息流数据链路（SSE 批量更新、幂等合并等——它们引发的是重渲染，不是滚动写入）
- 不处理 SessionModal / ExecutionHistoryModal 等弹窗内部滚动（各自独立容器，无此症状）
- 不做移动端手势特化（现有 touch 行为不变）

## 5. 未决问题

- U1: Chrome `overflow-anchor` 在本项目 DOM 结构下（flex 嵌套 + 动态列表）的实际锚定表现未实测——本方案不依赖它（见非目标），仅在 §8 记录为被否替代方案。若未来实测证明其与贴底跟随可共存，可作为简化路径再评估（另开特性）。
- U2: handleJumpToMessage（W7）跳转后是否应进入 pinned 状态（跳到底部附近时自动跟随）——本版先维持「跳转即 floating」，观察使用反馈再定。

## 6. 方案设计：scroll-pin 状态机（单一事实源）

### 6.1 核心思想

「是否贴底」从**几何快照判断**（每次 scroll 事件时算 isNearBottom）改为**带滞回的状态机 + 事件语义分类**：

```
状态：pinned（贴底跟随） / floating（自由阅读）
跃迁输入（按语义分类，不再按几何）：
  - 用户主动上滚（wheel / touch 上翻 / 键盘上翻 / 滚动条上拖·位移归因）→ pinned → floating
  - 用户滚至底部附近（含新消息按钮点按）          → floating → pinned
  - 内容/视口高度变化（ResizeObserver）           → 不改状态；
      若 pinned → 统一贴底补偿；若 floating → 不动
  - 程序性写入（首次渲染、恢复、跳转、贴底补偿自身） → 不改状态（自证账本归因，见 6.2B）
```

关键性质：**程序性写入不再参与状态判定**。这从根上拆掉 D1 反馈环——不是「写入时抑制判定」（补丁，flag 时序对不齐），而是「判定只认用户意图」（手势事件 + 经账本归因的位移方向），几何仅用于回锚确认与分页触发。

### 6.2 用户意图的提取（D3 的解）

意图输入分两类：**手势前导事件**（语义直接）与**位移方向归因**（滚动条拖动等无专门事件的手势，经账本归因间接提取）。两者共同保证：pin 状态只被用户意图改变，程序写入几何上可见、语义上不可见。

**A. 手势事件**（capture, passive）：

| 事件 | 语义 | 实现 |
|------|------|------|
| `wheel`（deltaY < 0，向上） | 用户向上滚动 → floating | 容器 capture 监听，`{ passive: true }` |
| `touchstart` 后向上位移累计 >10px 的 `touchmove` | 移动端上翻 → floating | 记录起点，累计阈值 10px（防误触） |
| `keydown`（PageUp/Home/方向键上） | 键盘上翻 → floating | 全局监听 + 目标过滤：仅当事件目标非输入元素（input/textarea/contentEditable）时生效，避免劫持输入框光标移动 |

手势事件到达时：置 floating 并标记所有在途程序注册 interrupted=true（用户接管，程序终态不再覆盖用户意图）。

**B. 程序写入自证账本（write ledger）——滚动条手势与 smooth 滚动的归因基础**：

滚动条拖动/轨道点击没有专门 DOM 事件，唯一可观测签名是 scrollTop 位移方向。为保证位移归因不退化为几何判定（D1 复辟），程序写入必须**自证身份**：

- 每个程序性滚动写入在写入时登记 `{ 期望值, 语义标签(pin/jump/restore/init), interrupted:false }`（组件内存账本，无持久化，过期注册在匹配尝试时惰性清理，不引入定时器）
- onScroll 归因：事件 scrollTop 与某在途注册匹配 → 归因程序；无可匹配注册 → 归因用户。匹配容差按标签区分：pin 类写入取「≥ 期望值−ε」（流式增长下底部目标只升不降）；jump/restore 类取紧 ε；超时过期
- **归因用户的 scroll 事件**：位移向上（相对上次采样）→ floating（滚动条上拖的签名）；isNearBottom → pinned（回锚）；scrollTop===0 → 触发上翻分页（位置检查，非状态判定）
- **归因程序的 scroll 事件**：不改 pin 状态。注册到达期望值时：未 interrupted 且语义=pin → 幂等确认 pinned（W6/W5 平滑滚动的合法终态回锚来源）；interrupted → 不回锚

设计要点：
- **向上才脱锚，到底即回锚**——不对称是特性不是疏漏：用户「看最新消息」的默认意图是跟随（意图锚原话：「我都是在看最新消息」）；floating 只能由「用户滚到底」或「点跳底按钮」解除，高度变化永远无法单方面改变用户状态（T3 的机制保证）
- **滚动条拖动全覆盖**：上拖 → 位移向上且无在途程序注册 → floating；下拖到底 → isNearBottom → pinned；轨道点击翻页同理由位移方向覆盖——V5 两半皆有机制通过
- 100px 阈值保留（`isNearBottom` 现值），仅用于回锚确认，不用于脱锚判定——脱锚由手势事件或位移方向触发
- **已知温和残差**（接受，记录在案）：floating 且距底 <100px 时上方内容收缩 → 浏览器 clamp 触发 scroll → isNearBottom 命中回锚。该路径方向是恢复跟随（默认意图），现状同样存在，不构成回归

### 6.3 状态机实现（伪码）

```ts
type ScrollPin = 'pinned' | 'floating'
const pinRef = useRef<ScrollPin>('pinned')       // 单一事实源（经共享 ref 透传，见 6.4）
const ledger = useRef<LedgerEntry[]>([])          // 程序写入自证账本
const lastScrollTopRef = useRef(0)

// —— 程序写入统一入口（W5/W6/W7/W8/补偿全走这里）——
programScroll(el, target, tag): el.scrollTop = target; ledger.push({ expected: target, tag, interrupted: false })

// —— 手势事件（capture, passive）——
onWheel(e):    if (e.deltaY < 0) takeUserControl()   // → floating + 在途注册置 interrupted
onTouchMove:   向上累计 >10px → takeUserControl()
onKeydown:     PageUp/Home/ArrowUp 且目标非输入元素 → takeUserControl()

// —— onScroll：归因 → 意图提取/回锚/分页 ——
onScroll(el):
  const entry = ledger.match(el.scrollTop)        // ε 匹配在途注册（pin 类取 ≥期望−ε）
  if (entry) {                                     // 归因程序：不改状态
    if (到达期望值) { ledger.remove(entry)
      if (!entry.interrupted && entry.tag === 'pin') pinRef = 'pinned' }  // 幂等确认
  } else {                                         // 归因用户
    if (el.scrollTop < lastScrollTopRef.current) pinRef = 'floating'      // 位移向上（滚动条上拖签名）
    else if (isNearBottom(el)) pinRef = 'pinned'                          // 回锚
    if (el.scrollTop === 0) triggerLoadMore()                              // 上翻分页（保留）
  }
  lastScrollTopRef.current = el.scrollTop

// —— 高度变化统一补偿（W3+W4 合并归一）——
contentResizeObserver / viewportResizeObserver:
  if (pinRef === 'pinned') rAF(() => programScroll(el, el.scrollHeight, 'pin'))
  // floating → 不动（T2：scrollTop 不被程序改动）

// —— 新消息到达（W2 贴底删除）——
// 新消息必然引发内容高度变化，由 contentResizeObserver 统一覆盖
```

W5（首次渲染）、W7（跳转，置 floating）、W8（恢复，经 programScroll 登记 restore 标签）、R0（mount 及 conversationId 切换：programScroll 贴底 + pin='pinned'，替代现「消息减少→贴底」分支——会话切换由 conversationId 变化显式触发，语义更准）保持语义不变：程序写入对状态机语义不可见，状态变更由写入点按自身语义显式声明。

### 6.4 现有代码映射（改动最小化清单）

| 现有机制 | 处置 | 理由 |
|----------|------|------|
| W1 handleScroll 几何判 isAtBottom → isAtBottomRef | **重写**：归因化——账本匹配→程序（不改状态）；未匹配→用户（位移向上脱锚 / isNearBottom 回锚 / scrollTop===0 分页触发） | D1 环壁拆除 + 滚动条手势覆盖（审视严重发现 1） |
| W2 length effect 增量贴底 | **删除**贴底分支与「消息减少→贴底」分支；**注意**：恢复分支（W8）与两者同居同一 effect（MessageList.tsx:226-252），删除时须拆分保留 W8；「消息减少」语义由 R0 的 conversationId 切换接管 | 与 W3 双写重叠；S8 必然触发内容高度变化，由归一 observer 覆盖；会话切换显式化 |
| W3 content observer | **保留**，守卫改为 pinRef，写入经 programScroll('pin') 登记 | 唯一贴底写入通道（渲染后写入不变，渲染前守卫语义化） |
| W4 viewport observer | **并入** W3 同一守卫（视口缩小时 pinned → 贴底） | 同为高度变化补偿，一个状态一个写入 |
| W5 首次渲染贴底 | 保留，mount 后 pinRef 初始化为 pinned，写入经 programScroll('init') 登记 | 行为不变 |
| W6 跳底按钮 | **修复**：ref 直连（经 props/回调传入 index.tsx）+ 锚点存在性守卫；点击即置 pinned 并经 programScroll('pin') 登记；**删除 index.tsx:424 旧 querySelector 路径**——所有滚动写入必须经 programScroll 登记自证，不得存在账本外写入 | T5；登记使 smooth 滚动终态回锚有合法来源；旧路径保留将成为未登记的第二写入通道，破坏账本完备性（delta 审视发现 2） |
| W7 跳转消息 | 保留；跳转后置 floating（U2 暂定），写入经 programScroll('jump') 登记 | 不扩大范围 |
| W8 上翻恢复 | 保留；写入经 programScroll('restore') 登记 | 账本归因需要（写入自证） |
| onAtBottomChange 对外语义 | **现状澄清**（审视建议发现 2）：该 prop 在 MessageListProps 中 dangling（ChatView 未透传、零消费方）；实际跨组件管线是 index.tsx:72 自建 isAtBottomRef 经 ChatView 共享 ref 透传给 MessageList 直接写入，index.tsx:521/:550 新消息计数直接读该 ref，:901 会话切换置 true。迁移：ref 更名 pinRef、共享透传形状不变、语义从几何快照升级为状态机；删除 dangling 的 onAtBottomChange | 保持管线形状，实现者无需在 ChatView 找不存在的 prop |
| 初始化兜底 R0 | mount 时及 conversationId 切换时：programScroll 贴底 + pin='pinned'（替代现「消息减少→贴底」分支） | 滚动条拖动等无 wheel 事件的边界 + 会话切换语义显式化 |

### 6.5 机制识别自查（requirement-analysis 步骤 5）

- [x] 新增状态生命周期：pinned/floating 状态机（含程序写入自证账本——组件内存态，无持久化，过期注册匹配时惰性清理，不引入定时器）—— **命中，四问必答（§7）**

（无新增配置字段、定时任务、信号类型、持久化、决策分支、跨模块调用路径）

## 7. 机制预算四问（作者绑定作答）

**① 谁需要它**：对话页的实时读者——具体是搭档本人在流式回复期间贴底阅读的场景（本次现象的直接受害方），以及未来任何多獭长对话的阅读者。不是「应该有」——现象已发生（意图锚）。

**② 失败后果**：状态机失效回到现状（自动上跳）或劣化（用户上翻时被强行拉回底部，比现状更扰民）。两者都是用户可直接感知的滚动行为异常，无数据损害。

**③ 后续机制可能怎么错、会被怎么修**：
- 回锚阈值（100px）过松/过紧 → 用户上翻一点就被回锚/到底了没恢复 → 调阈值或给回锚加方向性确认（scroll 事件带向上速度才回锚），改动局限在 onScroll 一个函数
- 意图事件漏抓新型输入法/设备的滚动方式（如触控板惯性后的轻扫）→ 新增一种事件监听即可，状态机结构不动——这正是本设计的价值：新增输入源只扩「事件提取」，不动「状态+补偿」
- 未来新增高度变化源（第 11 种卡片形态）→ 无需任何处理，ResizeObserver 天然覆盖（对比 §2.3 D2 的逐源补丁模式）
- 最坏退化路径：所有意图事件全部失效 → 状态恒为 pinned → 行为等于「永远贴底」，用户上翻被拉回——可感知、可报告、可定位（状态机是唯一入口）

**④ 退役条件**：出现以下任一信号时移除或替换本机制——(a) Chrome overflow-anchor 与贴底跟随实测可共存且更简（U1 兑现）；(b) 消息列表因规模问题重回虚拟滚动方案（锚定责任交还滚动库）；(c) 状态机连续两轮修复仍在特定设备上误判，复杂度收益比转负。三条均为结构性变化信号，不是日常调参。

## 8. 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 贴底判定模型 | 语义状态机（意图事件驱动） | A. 修竞态补丁：写入前设 flag 抑制 handleScroll 判定 | A 的 flag 生命周期与浏览器异步滚动时序（rAF/smooth/合成线程）对不齐，会得到第二套竞态（D3 分析）；且不解决 D2 逐源问题——这正是搭档明示拒绝的「打补丁行为」（意图锚） |
| | | B. 恢复浏览器 overflow-anchor | B 锚定的是「最近可见内容」语义，与聊天「贴底跟随最新」语义不同（锚定节点在视口外增删时行为未定义）；且 F20260813scrl 关闭它有配合移除 Virtuoso 的决策语境，重开需实测验证（U1）；锚定+手写贴底两套并存 = 新交叉——F20260813scrl 移除 Virtuoso 的根因正是多套指令交叉 |
| | | C. 重回 react-virtuoso（followOutput） | F20260813scrl 的方向性结论：三套指令交叉是抖动根源；库内滚动状态与业务状态的对齐问题（F20260811ke4k）会原样回归 |
| 高度变化保护 | 单 content observer 全集覆盖（渲染后写入） | 逐源补偿（现状 D2） | 已被 6 轮历史证明不可持续：来源清单 S1-S10 持续增长，每个新源都要一次 bugfix 轮回（F20260904smsj、F20260923stsb 均为实例） |
| 守卫时机 | 渲染后写入（observer 回调内 rAF 贴底，现状 W3 已是） | 渲染前守卫（useLayoutEffect 在 DOM 提交前比对） | 渲染前方案需在 layout effect 里读「渲染前高度」，React 19 下 ref 时序脆弱；渲染后写入在实践中已被 W3/F20260923stsb 验证有效，其唯一缺陷（停摆竞态）由状态机拆除——不为了理论优雅引入新脆弱点 |
| 新消息贴底 | 删 W2 由 observer 统一 | 保留 W2 双写 | 双写重叠是 F20260811ke4k「两套状态时序矛盾」的结构复刻；统一后贴底延迟从「react 提交后」变为「ResizeObserver 回调后」（约 1 帧），流式场景无感知差异 |
| 脱锚不对称（向上才脱锚/到底即回锚） | 采纳 | 对称（滚动事件双向判定） | 对称模型必须依赖几何阈值区分意图——回到 D1/D3；不对称模型把「跟随」设为默认，符合聊天阅读主场景（用户意图锚：「我都是在看最新消息」） |
| 滚动条手势覆盖 | 位移方向归因 + 程序写入自证账本（审视严重发现 1 修复） | 忽略该手势（floating 永不进入，V5 验收不可通过） | 归因保证位移判定不退化为几何判定：程序写入全部自证，未被认领的向上位移只能是用户行为；输入通道完备是「意图驱动」治本性的生效条件（审视重对抗门结论） |

**与被否情形的差异点**（litmus 检验）：本方案与 F20260813scrl 否决的「多套滚动指令」有本质差异——那是否决「多个几何写入者各自判断」，本方案是「一个状态机 + 单一贴底写入通道」，写入点从 4 个（W2/W3/W4/W6）收敛到 2 个（observer 统一补偿 + 手动跳转），判定点从 1 个几何反馈环改为 0（状态只认意图事件）。

**省事声明审计**：本文档避免使用「省事/更简/更快/零成本」自评词；唯一接近表述「改动最小化清单」指改动范围收敛的客观事实（§6.4 表），其省不掉的部分（意图事件提取的平台差异边界）已显式记入 U2/V5，未隐藏成本。

## 9. 影响范围

- **改动**：web/src/pages/conversation/MessageList.tsx（状态机 + 账本 + observer 归一 + 意图监听）、index.tsx（跳底按钮 ref 直连替换 querySelector 路径、点击置 pinned、新消息计数/会话切换对接 pinRef）
- **行为变化**：① 流式期间贴底不再有瞬间停摆（用户不可感知，纯修复）；② 用户轻微上滚（<100px）后到底自动回锚——比现状更宽容（现状 100px 外即永久脱锚直至手动点按钮）；③ 跳底按钮从「无效」变「有效」
- **不受影响**：上翻加载历史与位置恢复、执行历史跳转、消息流数据链、未读计数逻辑（消费方直读 pinRef，语义从几何快照升级为状态机）、移动端布局
- **风险**：意图事件监听的平台差异（触控板惯性、屏幕阅读器滚动）→ V5/V9 验证清单覆盖；如个别平台漏抓，退化行为是「回锚不及时」而非「上跳」，劣化方向安全。账本 ε 容差与过期时长需实测校准（流式增长漂移、smooth 滚动时长跨浏览器差异），退化方向是「归因偶发失误」，行为回到现状级，无数据风险

## 10. 验证

**自动化（可 jsdom 化的纯逻辑）**：
- 状态机单元测试：pinned 下内容高度变化 → 触发贴底写入；floating 下同样变化 → 不写入；wheel 向上 → floating；isNearBottom 的用户 scroll → 回锚；经账本登记的程序写入不改变状态
- 账本归因单测：在途 pin 注册匹配（≥期望−ε）→ 归因程序；jump/restore 紧 ε 匹配；超时过期；interrupted 注册终态不回锚；未登记的向上位移 → floating（滚动条上拖签名）
- 跳底按钮：mock ref 后点击 → scrollTo 被调用到 scrollHeight 且置 pinned

**人工验证清单（几何时序，jsdom 不可模拟）**：
- V1: 贴底看长流式回复（含代码块/表格渐进渲染）3 分钟——零上跳、零漂移
- V2: 流式中向上滚半屏停住——流式继续，视口纹丝不动；滚回底部——恢复跟随
- V3: 流式中 html-card 展开/收起（800px 级双向）×10 次——贴底时零跳动；上翻时位置稳定
- V4: 贴底时另一獭发言（居中条目插入视口上方）——贴底保持
- V5: 滚动条拖动：拖离底部松手——内容变化不拉回；拖到底松手——恢复跟随
- V6: 跳底按钮：任意位置点击——平滑到底并恢复跟随
- V7: 上翻触发加载历史——位置恢复与现状一致
- V8: 移动端 touch：上滑停住不被拉回；滑到底恢复跟随
- V9: 键盘：输入框聚焦时按 PageUp/Home/方向键上不脱锚且不劫持输入框光标操作；焦点在页面（非输入元素）时上翻脱锚 floating

**bugfix 失败证据链**（worktree-isolation 硬规则）：修复前用 V3 场景最小复现——贴底状态下脚本驱动视口上方节点高度骤变，断言 scroll 比例漂移（现状失败输出）；修复后同脚本断言零漂移（通过输出）。

## 11. 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/pages/conversation/MessageList.tsx | 修改 | scroll-pin 状态机（替代 isAtBottomRef）+ 程序写入自证账本；意图事件监听（wheel/touch/key）+ 位移方向归因；W3+W4 归一为单一补偿通道；W2/W8 同居 effect 拆分（保 W8 删贴底）；删除 dangling 的 onAtBottomChange |
| web/src/pages/conversation/index.tsx | 修改 | 跳底按钮 ref 直连 + 锚点存在性守卫 + 点击置 pinned；新消息计数（:521/:550）读 pinRef（形状不变）；会话切换（:901）置 pinned |
| web/src/pages/conversation/ChatView.tsx | 修改 | 共享 ref 透传更名（isAtBottomRef → pinRef，形状不变）；无 onAtBottomChange——该 prop 从未在此透传（dangling，见 §6.4 澄清） |
| web/src/pages/conversation/MessageList.test.tsx | 修改/新增 | 状态机单元测试 + 跳底按钮测试 |
| docs/features/2026/10/08/F20261008scpg-scroll-pin-governor.md | 新增 | 本文档 |
