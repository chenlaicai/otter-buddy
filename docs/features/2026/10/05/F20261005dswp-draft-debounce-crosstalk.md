---
id: F20261005dswp
title: debounce 草稿串写修复
summary: 闭包捕获 conversationId 配对写入——300ms 窗口内切换对话不再把旧对话文本写进新对话草稿（#1132）
change_type: fix
capability_test: "n/a: React hook 时序逻辑（确定性），3 新用例含串写场景回归锚 + 11 既有回归全过"
intent:
  problem: "use-draft-cache 的 debounce 回调（300ms）读 conversationIdRef.current——用户在窗口内切换对话后 ref 已指向新对话，旧对话的输入文本被写进 draft:conv-2（串写）。PR #1131 检视发现（检视獭-draft-fix R2），代码追踪确认但当时未实测。"
  expected_effect: "debounce 回调闭包捕获 conversationId（timer 设置时值），text 与 id 配对写入：切对话后旧文本落到旧对话的 draft key；beforeunload/cleanup 读 ref 的「最新值」语义保持不变（两边是不同命题）。"
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

Modification-Class: narrow-fix——单回调闭包化，无新机制。

### Why（未选替代方案）

- **回调里校验 ref 与 timer 设置时一致**：等价于闭包捕获但多一层状态（timer 设置时的 id 仍要存起来）——闭包是语言原生机制，更简
- **切换对话时清 timer**：治标——load effect 已在切换时读新对话草稿，旧 timer 清不清都不影响显示；但清 timer 会丢掉「用户切走前最后 300ms 的输入」的持久化，闭包捕获能保住它（写到旧对话 key，切回来还在）

## 验证

### 测试证据（web/src/hooks/draft-debounce-crosstalk.test.ts，3 新用例）

- **串写场景回归锚**：conv-1 saveDraft → rerender 切 conv-2 → advance 350ms → `draft:conv-1` 有值、`draft:conv-2` 为空
- 正常路径：不切换对话写到当前 key
- debounce 合并：连续输入最后一次生效
- **既有回归**：use-draft-cache.test.ts 11 用例全过（含 R5/S1 历史修复锚）

### Golden Gate

Golden Gate: n/a（verify_by=static_only——React hook 纯前端时序逻辑，无 prompt/skill/协议层软代码变更）

## 后续动作

- issue #1132 随 PR closes
