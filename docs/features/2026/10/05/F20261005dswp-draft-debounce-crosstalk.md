---
id: F20261005dswp
title: debounce 草稿串写修复
summary: 闭包捕获 conversationId 配对写入——300ms 窗口内切换对话不再把旧对话文本写进新对话草稿（#1132）
change_type: fix
capability_test: "n/a: React hook 时序逻辑（确定性），7 用例含串写+flush 三形态回归锚 + 11 既有回归全过"
intent:
  problem: "use-draft-cache 的 debounce 回调（300ms）读 conversationIdRef.current——用户在窗口内切换对话后 ref 已指向新对话，旧对话的输入文本被写进 draft:conv-2（串写）。PR #1131 检视发现（检视獭-draft-fix R2），代码追踪确认但当时未实测。"
  expected_effect: "debounce 回调闭包捕获 conversationId（timer 设置时值）保证 text 与 id 配对写入；pending 写入意图（pendingWriteRef）在切换对话时同步 flush 到旧 key（flush-on-switch）——快速切回/新对话输入/beforeunload 三形态竞态下旧对话输入不丢。"
  verify_by:
    type: static_only
    reason: "React hook 时序为确定性逻辑：renderHook + fake timers 的串写场景回归锚（conv-1 输入→切 conv-2→350ms 后断言 draft:conv-1 有值/draft:conv-2 为空）+ 正常路径 + debounce 合并用例；无 LLM 行为面"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [web, draft, debounce, react-hook, race-condition]
modules: [web/src/hooks/]
from: []
causal_links: ["#1132", "#1131"]
created_at: 2026-10-05
---

# debounce 草稿串写修复

## 问题（#1132，来自 PR #1131 检视 R2）

`use-draft-cache.ts` 的 saveDraft 设置 300ms debounce timer，回调里读 `conversationIdRef.current` 决定写到哪个 `draft:{convId}`。ref 的语义是「最新对话 id」——用户在 debounce 窗口内切换对话（conv-1 → conv-2）后，ref 已更新为 conv-2，回调把 **conv-1 的输入文本**写进 `draft:conv-2`。下次打开 conv-2，输入框显示 conv-1 的草稿。

## 根因与修复

**根因**：debounce 回调的写入语义应是「text 与输入发生时的对话配对」，而 ref 给的是「执行时的最新对话」——两者在切换窗口内错位。

**修复**（一行实质改动）：回调改闭包捕获 `conversationId`（saveDraft 的 useCallback deps=[conversationId]，闭包值与调用时同步）。切对话后 timer 触发时写到旧对话的 key——配对正确。

**与 beforeunload/cleanup 的语义区分**（不改动那两处）：它们读 ref 是「页面关闭/组件卸载前把**当前最新**草稿存到**当前最新**对话」——最新值语义正确。debounce 回调是「补写刚才输入的文本」——配对语义才正确。两边刻意不同。

## 设计取舍记录

Modification-Class: narrow-fix——单回调闭包化，无新公开机制（内部新增 pendingWriteRef 状态追踪，但不改变任何对外 API/调用方式/消费方语义，检视 delta Δ3）

### Why（未选替代方案）

- **回调里校验 ref 与 timer 设置时一致**：等价于闭包捕获但多一层状态（timer 设置时的 id 仍要存起来）——闭包是语言原生机制，更简
- **只闭包捕获、不 flush（初版方案，检视獭-1280 证伪后升级）**：闭包保证「写对 key」，但 pending timer 在 300ms 窗口内没落盘时有三形态竞态——A 快速切回读到空（state/storage 分叉）；B beforeunload 时序把 timer 新文本用 draftRef 旧稿覆盖；C 新对话输入 clearTimeout 掉共享句柄，旧对话 pending 永久丢失。**处置升级为 flush-on-switch**：pending 写入意图（convId+text）存 ref 单一真相源，load effect 检测到切换时同步落盘旧 key 并取消 timer——三形态同治，闭包捕获与 flush 互补（前者保 key 配对，后者保不丢）

## 验证

### 测试证据（web/src/hooks/draft-debounce-crosstalk.test.ts，7 用例）

- **串写场景回归锚**：conv-1 saveDraft → rerender 切 conv-2 → advance 350ms → `draft:conv-1` 有值、`draft:conv-2` 为空
- 正常路径：不切换对话写到当前 key
- debounce 合并：连续输入最后一次生效
- **检视处置三形态回归锚**（flush-on-switch）：形态 A 快速切回 pending 已落盘切回能读到；形态 C 新对话输入不清丢旧对话 pending；形态 B 切走+新输入+关页面两对话草稿都不丢不覆盖（delta Δ2 改造：原同对话构造下 pending 与 draftRef 恒等，旧实现也绿——恒真锚；改造后对 1e8e055d 实测红）；形态 D 窗口内清空输入不复活已删草稿（delta Δ1 锚）
- **既有回归**：use-draft-cache.test.ts 11 用例全过（含 R5/S1 历史修复锚）

## 检视处置记录（检视獭-1280 初轮：1 严重；delta 轮：1 严重 fix-regression + 2 建议，全部采纳）

- **严重 1（「切回来草稿还在」被三形态证伪）采纳 flush-on-switch**：初版只有闭包捕获——写对 key 但 pending 不落盘时，快速切回分叉（A）、beforeunload 覆盖（B）、新对话输入清掉共享 timer 句柄致旧输入永久丢失（C）。处置：pendingWriteRef（convId+text）为 pending 写入意图单一真相源——load effect 检测切换即 flush 旧 key 并取消 timer；beforeunload/cleanup 卸载路径 pending 优先落盘；clearDraft 清 pending（发送即终态）。4 新用例锚定三形态+空串边界
- **delta 严重 Δ1（fix-regression，采纳）**：S1 路径 saveDraft('') 漏清 pendingWriteRef——saveDraft('x') 后 300ms 窗口内清空，残留 {convId,'x'} 被三条路径（切换 flush/beforeunload/卸载 cleanup）写回复活已删草稿，破坏「手动清空=立即删除不复活」不变量。修：S1 分支补 `pendingWriteRef.current = null`（与 clearDraft「清空即终态」同构）+ 形态 D 回归锚（修复前实测红）
- **delta 建议 Δ2（采纳）**：4 新用例中 2 个恒真锚——「形态 B」原构造下 saveDraft 已同步 draftRef，pending 与 draftRef 恒等，旧实现也绿；「flush 空串边界」锚的是 S1 同步 removeItem 且 flush else 分支不可达（pending.text 恒非空）。改造：形态 B 改「切走+新输入+关页面」双对话构造（对 1e8e055d 实测红），空串用例改锚 Δ1 本体（形态 D）
- **delta 建议 Δ3（采纳）**：Modification-Class 措辞与机制面变宽的张力——改「无新公开机制」并补论证（内部 pendingWriteRef 不改变对外 API/调用方式/消费方语义）

### Golden Gate

Golden Gate: n/a（verify_by=static_only——React hook 纯前端时序逻辑，无 prompt/skill/协议层软代码变更）

## 后续动作

- issue #1132 随 PR closes
