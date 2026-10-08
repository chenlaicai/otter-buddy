---
id: F20261008w8lt
title: 对话页自动上跳真凶修复：W8 历史加载恢复的三重缺陷（距底公式错位 + 武装无闭环 + 恢复不脱锚）
summary: 10/8 下午用户报告 #1344（scroll-pin 状态机）合入后仍自动上跳。二轮排查经 alpha 帧级取证定位真凶：上翻加载历史的滚动恢复（W8）存在三重缺陷——①记录 scrollHeight 而非距顶距离，恢复公式 scrollTop=新sh−旧sh 把「保持距顶」错算成「保持距底」量级错位，长会话把用户从阅读位置甩到滚动条中部；②loadMoreBefore 早退时武装永不解除，之后任何消息条数增长（新消息/SSE 刷新）引爆陈旧 restore；③恢复不脱锚 pin，随后内容高度变化经 RO 链把用户从历史位置拉回底部。修复：距顶语义 + 双守卫（仅头部追加消费 + 用户仍在顶部才写入）+ 恢复即脱锚 + restore 判定搬入 useLayoutEffect（先于贴底写入，消除「贴底先写→判定误读」竞态）。附零间隙贴底（useLayoutEffect 每 commit 同步写）与逐帧 e2e 护栏。取证方法论沉淀：帧级采样 + 真实会话复刻 + 确定性 jsdom 复现三层。
change_type: fix
capability_test: "单测：stale-restore-mine.test.tsx（地雷复现+正常路径双用例）+ MessageList.test.tsx 22 例（全量 652 绿）；e2e：scroll-restore-guard.spec.ts 真实浏览器逐帧断言（修复前 top 0→3634 甩出，修复后 0→0 保持）"
created_in_conversation: 27398619-8e0b-4147-8230-93e23f1a01ac
causal_links:
  from:
    - F20261008scpg
  supersedes: []
tags: [conversation, scroll, restore, loadMore, race-condition, forensics]
modules:
  - web/src/pages/conversation/MessageList.tsx
created_at: 2026-10-08
---

# W8 历史加载恢复三重缺陷修复

## 1. 意图锚

> 我更新代码重启系统，现在还是会往上跳一下，感觉你没修复对呀？你拉上kimi再分析下？

> 是我正在看，可能在打字，好像是有卡片展开（没有切对话）

> 不是新对话的，我感觉是历史对话更容易出现。

## 2. 取证过程（方法论沉淀）

### 2.1 静态分析失效点

一轮（F20260808scpg，#1344）修的停摆竞态真实存在（单测锚定），但线上现象未消——静态推理两轮均未命中真凶。本轮换打法：不猜，取证。

### 2.2 数据库现场取证

跳变时刻（用户 14:53 报告「刚才跳了一次」）：主库快照显示《reseach》会话最后 entry 是 14:44:04——**跳的时刻没有任何流式/新消息**。排除流式驱动，锁定静态长会话（1032 条 / 24.8 万字符 / 23 张 html-card）。

### 2.3 复刻 + 帧级采样

《reseach》全量复刻进 alpha（sqlite 注入），Playwright 逐帧采样（scrollTop/scrollHeight/DOM 条数）。

**关键教训**：`.overflow-y-auto` 选择器在页面有 5 个匹配（左侧栏/右栏/输入框等）——v4-v6 取证采的是左侧栏（sh 恒 660），全部无效。修正为「[data-message-id] 向上找滚动祖先」后立即命中。

### 2.4 铁证帧序列（v8）

```
t=6281-6766  top 3572→0   msgs=50   用户滚轮上翻（平滑步进 ~300px/16ms）
t=6766       top=0                  触顶 → loadMore 武装（旧：记 scrollHeight=8248）
t=6859       top=3634    msgs=70   sh=8248→11882  恢复写入 11882−8248=3634（甩到 31% 位置）❌
t=6883-7282  top 3634→934          用户惯性滚动继续（视口已不在用户控制的位置）
```

用户感知：正在顶部看历史 → 页面突然跳到中间。

## 3. 根因：W8 恢复逻辑三重缺陷

| # | 缺陷 | 机制 | 用户感知 |
|---|------|------|----------|
| D1 | 记录值语义错位 | 记「触发时刻 scrollHeight」，恢复算 `新sh − 旧sh`——用户在顶部触发时距顶=0，与 scrollHeight 无关；公式把「保持距顶」算成「保持距底」量级错位 | 上翻看历史时被甩到中部（主凶） |
| D2 | 武装无闭环 | `handleScroll` 顶部武装 pendingScrollRestore，但 `loadMoreBefore` 早退（hasMoreBefore=false）时永不消费；地雷埋下，之后任何 length 增长（新消息/SSE/聚焦刷新）引爆 | 贴底看最新消息时突然跳到中间（次凶，与用户主诉场景完全吻合） |
| D3 | 恢复不脱锚 | restore 写入后 pin 仍 true，随后加载的历史条目渲染撑高内容 → RO 链「贴底补偿」把用户从历史位置拉回底部 | 刚看到历史又弹回底部 |

为什么一轮二轮都没抓到：W8 在 F20260907sgpt 之前就存在（上翻分页特性带入），六轮滚动修复全部视其为「正确行为」原样保留——它是「无害被信任的旧代码」里藏的地雷。

为什么历史对话更容易：只有上翻加载过（或触发过 loadMore 武装）的长会话才有 D1/D2 路径。

## 4. 修复设计

### 4.1 距顶语义 + 双守卫 + 恢复即脱锚（MessageList.tsx useLayoutEffect）

```
武装（handleScroll 触顶）：pendingScrollRestore = el.scrollTop   // 距顶距离（D1 修复）
消费（useLayoutEffect，commit 期，先于 pin 写入）：
  仅当 ①头部追加（messages[0].id 变化——上翻加载语义，D2 修复）
     ②用户仍在顶部（el.scrollTop < clientHeight——离开则静默丢弃，D2 修复）
  写入：scrollTop += pending；且 pinRef=false（D3 修复——读历史即脱锚）
  消费即闭环：pending 置 null 先于守卫判定——陈旧武装最多存活到下一次 commit
采样维护（useEffect）：prevMessagesLenRef / lastFirstIdRef 更新
```

### 4.2 判定时序：restore 先于 pin（消灭自竞态）

修复中间态发现：f1fx 的每-commit 贴底（useLayoutEffect）会先写底部，W8 判定读到贴底后的 top 而「误判已离开顶部」。修复：restore 消费分支放进同一个 useLayoutEffect 且在 pin 之前——两者共享 commit 期时序，不再竞争。

### 4.3 零间隙贴底（同 PR 顺带，f1fx）

useLayoutEffect 每 commit 同步贴底（pinned 时）——消灭 RO→rAF 的 1-2 帧间隙（H1 闪跳，kimi 二轮对抗分析的贡献）。RO 链保留兜 CSS transition/iframe 驱动的高度变化。

## 5. 验证

- **确定性复现**：stale-restore-mine.test.tsx——jsdom 固化 D2 地雷序列（武装→无内容→滚回底→新消息），修复前红（top=0 甩出）修复后绿
- **正常路径**：上翻加载后恢复写入「原距顶+新增量」，贴顶保持
- **真实浏览器**：scroll-restore-guard.spec.ts 逐帧断言——修复前 `top 0→3634 甩出`，修复后 `0→0 保持`（同一场景重放）
- 全量 62 文件 652 用例绿；tsc/eslint 干净

## 6. 遗留

- 监测卡（跳变标记器）仍可用——用户主系统若再现跳变，console 帧数据可继续对时
- e2e 护栏依赖 alpha + 复刻会话数据，CI 集成待定（本地护栏价值已兑现）
- 一轮 F20261008scpg 的价值重申：状态机/账本机制正确且必要（本轮 D3 修复依赖 pinRef），只是没覆盖 W8 这颗旧雷
