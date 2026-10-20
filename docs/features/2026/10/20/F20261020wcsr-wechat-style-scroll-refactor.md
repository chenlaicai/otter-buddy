---
id: F20261020wcsr
title: 消息加载机制微信式重构：哨兵分页 + 原生视觉锚定 + 自研机制退役
doc_type: feature

summary: |
  消息历史加载与滚动稳定机制按微信/Telegram 标准模式重构。专项研究结论：当初的抖动/跳底问题不是标准机制的漏洞，而是「关掉浏览器 scroll anchoring + 枚举高度源打补丁」自研路线的结构性产出（三大根因逐项对照标准机制全部空集化）。本特性：①顶部 IntersectionObserver 哨兵分页替掉手写多通道触发；②启用浏览器原生 scroll anchoring（删 overflow-anchor:'none'），prepend 位置保持交给浏览器；③自研机制大规模退役（pendingScrollRestore 手写恢复链、write ledger 账本、五通道意图监听——scroll-pin 状态机收敛为极简「到底才跟随」）；④每批 20→50 条。四锚 e2e 护栏护回归。

causal_links:
  from:
    - F20260813scrl   # 弃 virtuoso 迁原生滚动（overflow-anchor:'none' 出处，本特性回退该决策的锚定部分）
    - F20261008scpg   # scroll-pin 状态机（本特性将其收敛为极简版，账本/五通道退役）
    - F20261010vwst   # 视口稳定优先（R3 备选牌=本特性；§3.3 要求专项 e2e 验证后启用）
    - F20261020lmld   # 死锁修复（近顶带/可见按钮多通道触发，本特性以哨兵统一替代）
    - F20261008w8lt   # 距顶恢复语义（pendingScrollRestore 手写恢复链，本特性退役）
  to: []

change_type: feature
capability_test: n/a（web 前端交互机制，capability 测试体系覆盖后端獭行为；验证走 web 单测 + e2e 逐帧护栏，见「验证」节）
tags: [web, conversation, message, scroll, pagination, scroll-anchoring, refactor]
modules:
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/MessageList.test.tsx
  - web/e2e/scroll-pin-frame-guard.spec.ts
created: 2026-10-20
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
---

# 消息加载机制微信式重构：哨兵分页 + 原生视觉锚定 + 自研机制退役

## 背景

搭档原话（意图锚，2026-10-20）：

> 「微信他们这种生产级产品逻辑一定是完整的，所以如果你能拿到真正的实现，那么你需要额外分析下咱们当初的抖动问题是否真的还存在，是否微信机制真的有这个漏洞？」

立项决策（M-857dfc1f，已拍板）：消息加载机制按微信/Slack/Telegram 标准模式重构——①哨兵分页（顶部 IntersectionObserver sentinel）；②原生视觉锚定（启用浏览器 scroll anchoring）；③删自研机制（贴底跟随账本/位置恢复逻辑大部分退役，只留「到底部才跟随新消息」一条判断）；④每批 20→50 条。

**前置专项研究结论**（工作区 research-wechat-scroll-refactor.md，证据：Telegram Android 一手源码 ChatActivity.java + W3C CSS Scroll Anchoring 规范 2026-09-30 草案 + 本仓 9 轮补丁史文档链）：

- 我们抖动的三个根因——G1 三套滚动指令交叉（Virtuoso 时代，已随 F20260813scrl 消除）、G2 关锚定后枚举高度源打补丁（F20261008scpg/F20261010vwst）、G3 贴底几何判定反馈环（F20261008scpg）——在微信/Telegram 标准实现下全部不存在：原生列表组件自带 prepend 位置保持；用户意图由 scrollState 事件语义判定（触屏才算），程序/用户写入天然分通道；不关闭任何原生保护。
- Web 栈等价物 = 原生滚动 + scroll anchoring 开着。规范 §1 原话即为我们的症状而写（「视口上方内容变化导致用户阅读中页面移动……本规范提出机制缓解」）；`overflow-anchor` 初始值 `auto`——开是标准，关是例外（我们在 MessageList.tsx:634 显式关着）。
- 当年关锚定的原始理由是 Virtuoso 时代的通用防抖（F20260813scrl:70；F20261010vwst §3.3 归因订正），前提已随 Virtuoso 移除消失。**抖动不是标准机制的漏洞，搭档直觉成立。**

## 目标

T1：上翻加载历史的触发统一为顶部 IntersectionObserver 哨兵（进入视口即加载），替代 F20261020lmld 的五通道手写触发（scroll 近顶带/wheel/touch/keyDown/按钮中除按钮外的四条）。

T2：prepend 历史后的阅读位置保持交给浏览器 scroll anchoring（删除 `overflow-anchor:'none'`），手写 pendingScrollRestore 恢复链退役；仅保留 scrollTop=0 边界兜底（规范 §2.1：锚点不选「未离开原点」的容器——绝对顶部触发时锚定不工作，需极简手写补偿）。

T3：贴底跟随收敛为「新内容到达且 pinned 时滚到底」单语义；scroll-pin 意图状态机保留（已验证有效，服务贴底跟随），但其配套自证账本（write ledger）与五通道意图监听中服务于 restore 的部分退役。

T4：每批加载 20→50 条（index.tsx loadMoreBefore，与 Telegram 一致：ChatActivity.java:13913 loadMessages 50 条/批）。

T5：回归护栏——四锚不回归（F20261010vwst §3.3 要求）+ 原始抖动不重现，e2e 逐帧取证。

## 非目标

- 不改消息渲染层（MessageItem/MarkdownContent/HtmlCard 等）。
- 不改后端分页协议（before 游标、hasMore 语义不变）。
- 不恢复 react-virtuoso 或任何虚拟列表（原生滚动是既定方向）。
- 不做跨浏览器兼容承诺（面向 Chrome/桌面，与 F20260803vmsg「不考虑浏览器兼容性」前提一致；Firefox/Safari 不阻断不承诺）。
- 不处理 A3 遗留（loadMoreBefore 失败无用户反馈）——独立待办，不搭车。

## 未决问题

- U1：html-card 高度 transition 等主动样式变更命中 scroll anchoring suppression trigger（规范 §2.2.2：对 anchor→scroller 路径元素的 position/margin/padding/width/height 修改抑制调整）的实际命中面——规范明文可枚举，但我们 DOM 结构的实测覆盖度只能在实现期 e2e 确认（F20261008scpg U1 同源）。若关键场景被抑制，降级方案见「设计取舍」T2 行。
- U2：scroll anchoring 与我们 pinned 贴底写入（programScroll）在同帧的交互次序（浏览器调整时机 = style/layout 后、paint 前；我们的 useLayoutEffect 写入在 React commit 后）——理论上正交（锚定只补偿 anchor 上方变化，贴底写入是视口下方目标），实测确认。

## 方案设计

### 改动总览

| 机制 | 现状 | 重构后 |
|------|------|--------|
| 加载触发 | 五通道手写（scroll 近顶带 8px / wheel / touch / keyDown / 可见按钮） | 顶部哨兵 div + IntersectionObserver（rootMargin 预触发）；可见按钮保留为 fallback/可发现入口 |
| prepend 位置保持 | pendingScrollRestoreRef 手写距顶恢复链（fireLoadMore 武装→useLayoutEffect 消费） | scroll anchoring 原生保持；scrollTop=0 边界留极简手写兜底 |
| 视觉稳定 | overflow-anchor:'none' + contentObserver 枚举补偿 | overflow-anchor 默认（auto）；contentObserver 保留但只服务 pinned 贴底 |
| 贴底跟随 | scroll-pin 状态机 + write ledger 账本 + 位移归因 | 状态机保留（pinned/floating + 用户手势脱锚/到底回锚）；账本退役——见下「账本退役论证」 |
| 批大小 | 20 条/批 | 50 条/批 |

### 哨兵分页（T1）

- contentRef 顶部渲染 `<div ref={sentinelRef} />`（高度 1px，aria-hidden）。
- IntersectionObserver：`root: scrollRef.current`，`threshold: 0`，`rootMargin: '200px 0px 0px 0px'`（提前 200px 预触发——等哨兵进视口才拉会让用户等加载，微信式手感是「还没到顶就已备好」；200px ≈ 2-4 条消息高）。
- 触发条件：哨兵 intersecting && hasMoreBefore && !loadingMore（父层 loadingMoreRef 同步硬闸保留）。
- 哨兵替代通道：handleScroll 的近顶带触发、onWheel/onTouchMove/onKeyDown 内的 fireLoadMore 调用全部删除；这些监听中**服务于脱锚意图的部分保留**（见 T3）。
- 可见按钮（「加载更早消息」）保留：哨兵是自动通道，按钮是可发现性/自动失效时的手动通道；微信同样有「点击加载更多」入口。
- 防连拉：IntersectionObserver 在 loading 完成后若哨兵仍在视口（用户停顶部）会再次触发——取微信语义 + 限幅：单轮停留内连拉上限 3 批（150 条），超过后哨兵冷却（停止自动触发）。理由：无限制的自动连拉违背用户「停在顶部」的阅读意图，但完全禁连拉要求用户反复操作——3 批折中（与 F20261020lmld「一口气拉完全量不可接受」注释口径一致）。
  - **冷却解除通道**（落点明确）：handleScroll 内检测向下位移（scrollTop 增大）时重置连拉计数/冷却标志——向下位移=用户离开顶部的明确信号。已核：向下位移不触发脱锚（MessageList.tsx:506 movedUp 才脱锚），与 wheel/touch 脱锚监听（:570-600，向上方向）不打架。
  - **冷却与可见按钮的语义**：冷却只约束自动通道，「加载更早消息」手动按钮不受限（微信同构：自动停了仍可手点）——冷却实现不得做成全局闸。
  - **冷却的故障模式**（机制四问补）：①谁需要：防无限连拉；②失败后果：冷却解除失败 = 哨兵永久静默，形态同 F20261020lmld 死锁——逃生口 = 可见按钮（手动通道不受限）+ 重新进会话；③后续机制：无；④退役条件：无（常驻限幅）。
- **哨兵生命周期**：hasMoreBefore 翻 false 时哨兵 unmount + observer disconnect（与可见按钮「防假入口」对称处理）；conversationId 切换时连拉计数/冷却重置。

### 原生锚定与手写恢复退役（T2）

- 删除 MessageList.tsx:634 `style={{ overflowAnchor: 'none' }}` 及 399 行背景注释（注释引用的 F20260818nscp 编号在 docs/ 不存在，真实文档为 F20260813scrl——顺带订正）。
- 删除 pendingScrollRestoreRef 武装-消费链：fireLoadMore 内的 `pendingScrollRestoreRef.current = el?.scrollTop`、useLayoutEffect 的 restore 消费分支（W8 重写段）、[messages] effect 的采样维护中 restore 相关部分。
- **scrollTop=0 兜底**（规范边界）：scroll anchoring 的 anchor node selection（§2.1 第 2 条）要求容器「scrolled away from the origin」才选锚——用户在绝对顶部（scrollTop=0）时 prepend 无锚可用，浏览器不补偿，视口会被顶下去。保留极简兜底，触发条件与写入约束如下（镜澜审视修订）：
  - **触发条件（三取全真）**：①`conversationId 未变`（防 key remount 采样陷阱——切会话时容器 remount，scrollTop=0 语义从「用户在顶部」漂移为「新容器刚 mount」，ref 采样跨容器产生垃圾写入；以 conversationId 比较为守卫，不依赖 reset effect 时序）；②上一轮采样 scrollTop===0；③本轮头部消息 id 变化（确认为 prepend 而非其他消息流变化）。
  - **写入约束（方向构造性封闭）**：`scrollTop = max(el.scrollTop + delta, 0)`，其中 `delta = 新 scrollHeight − 旧 scrollHeight`。**位移增量式写入，不做绝对值赋值**——增量天然非负（prepend 只增高度；若同帧有收缩源导致 delta 为负，max 钳到 0 = 原地不动，绝不产生向上位移），写入方向构造性封闭，不依赖「同帧无收缩」前提。弱前提声明（镜澜 delta-D1 修订）：条件②的采样一致性依赖任务排序——**实现期已加固**：兜底采样三件套（scrollTop/scrollHeight/首 id/conversationId）收进 useLayoutEffect 顶部推进（读本轮 commit 前 DOM 真实值），滞后窗口从「scroll 事件派发任务 vs React commit」收窄到「同帧多次 commit 内的边界」（详见「实现期发现」节）；破坏后果为兜底幂等抢跑一次锚定本可完成的调整（位移仍向下），无位置错乱。
  - 该兜底是 floating 态唯一的程序写入，方向受限（只增不减），与账本退役论证的衔接见「账本退役论证」修订版。
  - lastFirstIdRef / prevMessagesLenRef 头部采样保留（兜底与 pinned 判定都需要）；切会话 reset effect 照旧不同步 lastFirstIdRef——conversationId 守卫已封死跨容器消费，无需改现状 reset 时序。

### 贴底跟随极简版（T3）

- **保留**：pinRef 状态（pinned/floating 单一事实源）；wheel 上滚/touch 上翻/键盘上翻脱锚监听（事件语义，F20261008scpg 已验证）；到底回锚（handleScroll 近底判定）；contentObserver pinned 贴底补偿（流式跟随）；useLayoutEffect pinned 贴底；mount 贴底；跳底按钮。
- **退役**：write ledger（pinWritesRef/programScroll 账本登记/LEDGER_TTL/EPS 常量）与 handleScroll 的账本归因分支。

### 账本退役论证（关键设计决策，需重点审视）

账本的存在理由（F20261008scpg §2.3-D3）：web scroll 事件不区分程序/用户写入，程序性贴底写入会触发 scroll 事件被误判为用户上滚→脱锚→补偿停摆。账本是「程序写入自证身份」的模拟。

退役后这个问题如何处理——先枚举本特性落地后**全部**程序写入路径，再逐条证明无误判通道：

1. **pin 写入**（contentObserver 补偿/useLayoutEffect 贴底/mount 贴底/跳底按钮，现状 MessageList.tsx:400/:459/:544/:722）：目标恒为 `scrollTop = scrollHeight`（或 smooth 等价的向下滚动），位移方向向下或为零——脱锚条件是「向上位移且非收缩」（F20261016inbs，movedUp && !shrank），**向下位移几何上不可能命中**。smooth 滚动（跳底按钮）中间帧 scrollTop 递增，同样向下，安全。
2. **scrollTop=0 兜底写入**（本特性新增，floating 态唯一程序写入——镜澜发现 1 修订：退役论证必须覆盖它）：写入约束为位移增量式 `max(scrollTop + delta, 0)`（见 T2 兜底节），对任意基线 scrollTop 位移均向下（delta>0 时）或钳零（delta≤0 时）——不可能命中 movedUp。条件①的 conversationId 守卫封死切会话跨容器垃圾写入（镜澜发现 2）；条件②采样滞后窗口的后果为幂等抢跑（镜澜 delta-D1，见 T2 弱前提声明）。
3. **scroll anchoring 浏览器调整**：浏览器在 layout 层补偿，不产生 scroll 事件的用户意图语义（即便产生，其方向是「保持锚点」= prepend 时向下，亦不命中 movedUp）。
4. **handleJumpToMessage 的 scrollIntoView**（index.tsx:507）：现状代码本就账本外写入（从未走 programScroll）；向上跳转的「误判」= 正判（跳转即用户意图，F20261008scpg U2 口径），账本退役后行为逐位一致。

结论：**全部程序写入路径的方向均构造性向下（或钳零），「程序写入污染用户意图」通道被几何方向封闭，账本退役安全。** 若 e2e 实测出现意外回弹，账本可回滚（git 历史在）。

### 批大小（T4）

index.tsx:482 `api.listEntries(activeId, 20, oldest.id)` → 50。timeline 窗口注释同步。

## 影响范围

- **直接影响**：MessageList.tsx（滚动/触发/恢复三大块重写）、index.tsx（loadMoreBefore 批大小）、MessageList.test.tsx（scroll-pin/restore/lmld 相关 describe 块重写）、scroll-pin-frame-guard.spec.ts（e2e 四锚）。
- **间接影响**：F20261020lmld 的修复面（近顶带/五通道/可见按钮）被哨兵统一替代——死锁问题由哨兵机制结构性免疫（IO 不依赖滚动事件，到顶静止后哨兵 intersecting 状态变化仍触发回调）；其测试改写为哨兵语义。
- **行为变化（用户可感知）**：
  - 上翻到接近顶部（200px 预触发带）即自动加载，无需滚到绝对顶——手感提前。
  - 停在顶部自动连拉最多 3 批后暂停（下滚任意距离解除）。
  - prepend 后阅读位置由浏览器保持（手感目标：零跳变）。
  - 每批 50 条，上翻更少次。

## 风险与约束

- **R1（U1 同源）**：suppression trigger 抑制锚定调整 → prepend 位置保持失效的局部场景。缓解：e2e 逐帧实测 prepend 场景（含 html-card 在场）；若关键场景被抑制，降级 = 恢复极简手写补偿只补该类（不回到枚举老路——只补被证实的抑制类）。
- **R2**：哨兵连拉与 pinned 贴底的交互——pinned 用户（贴底看流式）时哨兵远在视口外，不触发；哨兵只在用户上翻到近顶时才进入 rootMargin 带。逻辑上互斥，e2e 验证。
- **R3**：账本退役的回归风险——「程序写入误判」通道的几何封闭性论证（上节）若被实测推翻，账本回滚。e2e 四锚中的「贴底流式跟随不脱锚」用例直接覆盖。
- **约束**：Chrome 为目标浏览器；jsdom 不支持 IntersectionObserver/scroll anchoring 真实行为——单测需 mock IO，锚定行为只能 e2e 验证（与 F20261010vwst 的 jsdom 局限同口径）。

## 不兼容更新

无（纯前端交互机制替换，API/协议/数据结构不变）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 触发机制 | IntersectionObserver 哨兵 | 保留手写多通道 | IO 不依赖滚动事件（F20261020lmld 死锁根因结构性免疫）、浏览器原生节流、代码量 -4 通道 |
| 位置保持 | 浏览器 scroll anchoring + scrollTop=0 兜底 | 保留手写恢复链 | 规范为此设计（§1 原话）；手写链是枚举源补丁路线（F20261010vwst 判死刑）；兜底覆盖规范 §2.1 不选锚边界 |
| 连拉语义 | 自动连拉限 3 批 + 冷却 | 完全不连拉（每批都需手势）/ 无限连拉 | 停在顶部=阅读意图，连拉 3 批（150 条）覆盖常见回溯深度；冷却防「一口气拉完全量」（F20261020lmld 注释口径） |
| 账本 | 退役 | 保留 | 向上位移脱锚规则（F20261016inbs）几何封闭误判通道；floating 无程序写入；论证见「账本退役论证」节，e2e 兜底 |
| 状态机 | 保留收敛版 | 全删重来 | F20261008scpg 状态机本体已验证有效（贴底跟随语义正确），要删的是它的配套补丁（账本/枚举），不是状态机 |
| 批大小 | 50 | 保持 20 / 100 | Telegram 一手证据 50/批；50 条 ≈ 2-3 屏，兼顾请求数与 prepend 高度稳定性 |
| 可见按钮 | 保留 | 删除 | 可发现性（搭档 10-20「没有加载更多功能」报告的根因之一）+ 哨兵失效时手动通道 |
| rootMargin | 200px 预触发 | 0（进视口才触发） | 等进视口才拉=用户等加载；200px≈2-4 条消息，「还没到顶就备好」的微信手感 |

**机制识别检查点判定**：逐项核对——□ 配置字段：无；□ 状态生命周期：无新增（哨兵 observe/disconnect 是 DOM 生命周期，非应用状态）；□ 定时任务：无；□ 信号类型：无；□ 持久化：无；□ 决策分支被记忆：无（连拉计数是会话内临时 ref）；□ 跨模块调用：无（组件内闭环）。**全部未命中 → 不涉及净新增机制**（本特性净效果是机制删除：账本/恢复链/四通道退役 vs 哨兵一个原生 API 调用），四问与重对抗门跳过，判定结果留此供检视核对。

## 验证

### 单测（MessageList.test.tsx，jsdom + mock IntersectionObserver）——已落地 25/25 绿

- 哨兵触发：mock IO fire intersecting → onLoadMore 被调；hasMoreBefore=false / loadingMore 时不调；连拉 3 批后冷却；handleScroll 向下位移解除；冷却中手动按钮仍可触发（冷却非全局闸）；hasMoreBefore=false 后哨兵不渲染。
- 结构断言：`overflowAnchor` 不为 'none'（浏览器锚定启用）。
- scrollTop=0 兜底：绝对顶部 prepend → 增量写入（写入值 = 原 scrollTop + delta）；切会话/非顶部/尾部追加三场景兜底不触发（conversationId 守卫回归锚，镜澜严重发现 2）。
- 保留回归锚：wheel/touch/键盘脱锚、到底回锚、跳底按钮、内容收缩 clamp 保护、近底小幅上滚脱锚（F20261016inbs 弹回 bug 回归锚）、切会话重置——既有用例适配（删账本断言，保留几何方向语义）。

### e2e（web/e2e/scroll-restore-guard.spec.ts 改写 + scroll-pin-frame-guard.spec.ts 保留）

五锚（F20261010vwst §3.3 要求）：
1. 贴底流式跟随不脱锚（账本退役回归锚）：scroll-pin-frame-guard A/B 用例保留覆盖（贴底注入/卡片突变不闪跳）。
2. 中部阅读 prepend 零跳变（锚定核心验收）：scroll-restore-guard 锚 2——prepend 帧前后 scrollTop 增量 ≈ 高度增量，无 >500px 甩位帧。
3. 输入多行视口稳定：scroll-pin-frame-guard C 用例保留（F20261010vwst 场景）。
4. 哨兵触发 + 连拉限幅：scroll-restore-guard 锚 4——顶部自动连拉 ≤3 批，下滚解除再触发。
5. 绝对顶部 prepend 兜底：scroll-restore-guard 锚 5——原顶部消息视口位置偏移 ≤5px（jsdom 无法模拟规范 §2.1 边界，只能真实浏览器验证）。

原始抖动不重现：锚 1/3 即当年抖动的两个现场（贴底上跳、输入顶起）。

**实现期验证状态（2026-10-20）**：单测 25/25 绿；web 全套件 720/720 绿；tsc 无错；eslint 无警告；build 成功。e2e 门控正确 skip（无 E2E_REPLICA_DATA 不假绿）——真实浏览器五锚验证待 alpha 复刻环境执行（合并前手动跑一轮）。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/pages/conversation/MessageList.tsx | M | 哨兵+锚定启用+恢复链/账本/四通道退役+状态机收敛 |
| web/src/pages/conversation/index.tsx | M | 批大小 20→50 + 注释同步 |
| web/src/pages/conversation/MessageList.test.tsx | M | 用例重写（25/25 绿） |
| web/src/pages/conversation/stale-restore-mine.test.tsx | D | 退役机制专项复现（场景由新兜底守卫测试接管） |
| web/e2e/scroll-restore-guard.spec.ts | M | 改写为 wcsr 三用例（锚 2/4/5） |
| docs/features/2026/10/20/F20261020wcsr-*.md | A | 本文档 |

## 决策史（审视循环留痕）

### 第 1 轮（2026-10-20，检视獭：镜澜/glm）

- **严重发现 1（账本退役论证与兜底自相矛盾，floating 态程序零写入前提为假）→ 已修订**：兜底写入改为位移增量式 `max(scrollTop + delta, 0)`，方向构造性封闭（增量非负由 max 保证，不依赖同帧无收缩/采样无错位前提）；账本退役论证重写为「枚举全部程序写入路径逐条方向证明」（pin 写入/兜底写入/浏览器锚定调整/handleJumpToMessage 四类），兜底显式纳入。镜澜焦点核验确认 pin 写入方向封闭核心命题为真（全部调用点 :400/:459/:544/:722 核对）。
- **严重发现 2（兜底未定义会话切换排除，key remount 采样跨容器垃圾写入）→ 已修订**：兜底触发条件加「conversationId 未变」守卫（条件①），明确不依赖 reset effect 时序；主场景（旧会话顶部读历史→切会话）的垃圾写入路径封死。
- 建议 1（连拉冷却机制四问）→ 已补（T1 防连拉节：谁需要/失败后果含死锁形态对照+可见按钮逃生口/后续机制/退役条件）。
- 建议 2（冷却与按钮交互）→ 已写明：冷却只约束自动通道，手动按钮不受限，不得做成全局闸。
- 建议 3（冷却解除落点）→ 已指明：handleScroll 内检测向下位移解除（已核与脱锚监听不打架）。
- 建议 4（哨兵生命周期）→ 已补：hasMoreBefore=false 时哨兵 unmount + disconnect；切会话时计数/冷却重置。
- 建议 5（绝对顶部 prepend e2e 用例缺失）→ 已补：e2e 用例 5，逐帧断言 ≤4px。
- B4 路径错（web/tests/e2e → web/e2e）→ 已订正（frontmatter modules + 改动范围表）。
- 镜澜焦点四问回执要点：哨兵×状态机互斥成立（pinned 用户到不了哨兵）；加载途中离开顶部的竞态缝隙不存在（锚定接管）；遗漏面（windowFloor/unreadSeparatorSeq/handleJumpToMessage/ImageLightbox）逐项核验无交互冲突，unreadSeparatorSeq 在锚定下语义改善。

### delta 复审（2026-10-20，镜澜）：approve，7/7 处置核验落实

- delta-D1（「不依赖任何隐含前提」表述过强——方向构造封闭为真，但条件②采样一致性是未声明弱前提，破坏后果幂等）→ 已采纳收窄：T2 写入约束与账本论证第 2 条均补弱前提声明（采样更新点、任务排序窗口、幂等抢跑后果），删除过强声明。

## 实现期发现（2026-10-20，大獭自测）

- **采样时点修正**（实现与方案的一处偏差，效果为增强）：方案写「上一轮 scrollTop」采样放 handleScroll 末尾（沿用现状位移归因采样点）。实现中发现该时点滞后：scroll 事件在 commit 前任务里派发，prepend commit 时采样还是旧值；scrollHeight 采样若同事先经 handleScroll 推进会在 prepend 前漏采（自测：兜底条件链全命中但 prevSh=0/陈旧值，增量写入不触发）。修正：兜底采样三件套（scrollTop/scrollHeight/首 id/conversationId）全部收进 useLayoutEffect 顶部推进——读本轮 commit 前 DOM 真实值（commit 阶段程序写入尚未执行，恰是「上轮 commit 后、本轮 commit 前」的用户停留位置与内容高度），语义比方案更精确，镜澜 delta-D1 的弱前提窗口随之收窄。handleScroll 末尾的位移归因采样保留（服务 movedUp/shrank 判定，与兜底采样各司其职）。
- **lastFirstIdRef 维护点同步内收**：原 [messages] effect（paint 后）维护头部 id 采样，同帧两次 commit 时第二次会读到已更新值漏判——一并收进 useLayoutEffect（paint 前推进）。prevMessagesLenRef 随恢复链退役删除（无任何逻辑引用）。
- **stale-restore-mine.test.tsx 删除**：该文件是 F20261008w8lt 陈旧 restore 地雷的专项复现，断言对象（W8 恢复公式/武装-消费链）已随机制退役不存在；其覆盖的两个场景（loadMore 无内容后新消息不甩位 / prepend 后位置保持）已由 MessageList.test.tsx 的兜底守卫三场景与结构测试接管。
- **scroll-restore-guard.spec.ts 改写**：旧 spec 断言「loadMore 恢复不甩位」（恢复链语义），改写为 F20261020wcsr 三用例（锚 2 中部 prepend 零跳变 / 锚 4 哨兵连拉限幅 / 锚 5 绝对顶部兜底），环境门控不变（无复刻数据显式 skip）。

### 代码审视（2026-10-20，镜川/glm，PR #1575 review 留痕）

- **严重 1（e2e 断言结构缺陷，4 子项全采纳）**：
  ① 锚 2 findIndex 命中首屏渲染帧（SAMPLER 从 addInitScript 起跑，msgs 0→50 先于滚动）→ 改为「锚点消息视口 y 前后对比」直测判据（prepend 后滚回锚点消息，断言视口 y 偏移 ≤4px）——scroll anchoring 失效时必红，判据与验收对象对齐；
  ② 锚 2 原判据只防过度下移、锚定失效时恒绿 → 同上，anchorBefore 采样接入判据；
  ③ 锚 4 首屏帧计入批次（恰在 3 批上限边界误红）→ 基线采样移到滚动操作前（msgsAtStart），批次按 (差值/50) 计算；
  ④ 锚 5 默认时序落 else 只 console.log（核心断言形同虚设）→ 显式冷却解除循环（最多 4 轮下滚-上滚），expect(msgsAfter > msgsBefore) 硬断言必达，位置断言 pos!==null 硬断言。
- **严重 2（文档缺「实现期发现」节 + delta-D1 采样点描述滞后）→ 已补本节 + 订正 T2 弱前提段**（handleScroll 末尾 → useLayoutEffect 顶部，并说明加固后的窗口形态）。
- **严重 3（CI FAILURE：分支落后 main，check job 未跑）→ 已 rebase origin/main（35b001cf），推后等 CI 复绿**。
- 建议 1（兜底×锚定双补偿叠加窗口）→ 不预防性加层，alpha 跑锚 5 时如见超限先核对此叠加（镜川原判，采纳为观察项）。
- 通过面留档：账本退役论证代码级核验成立（全仓唯一直接 scrollTop 写入在 programScroll，五调用点方向全向下）；哨兵 effect 重挂语义正确；T1-T4 + 镜澜三处修订逐一落地。

（delta 复审结论待回填）
