---
id: F20260824hkdp
title: react-hooks-deps-cleanup
doc_type: feature

summary: |
  清零 web conversation 模块 react-hooks/exhaustive-deps 警告（CI 日志噪音来源；初版 8 条 + rebase 吸收 #368 新增 3 条）。
  根因：useEffect/useCallback 依赖数组缺失或写成复杂表达式，其中 1 条是有意 mount-only 需显式声明。
  做法：安全补 deps 为主、1 条 useCallback 化后补入、1 条 disable 注释写明行为等价理由。

status: development
change_type: fix
tags: [web, cleanup, react-hooks]
modules:
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/ExecutionHistoryModal.tsx
capability_test: "n/a: 纯前端逻辑改动（A 类），无 LLM 参与行为"
---

# F20260824hkdp: conversation 模块 react-hooks 依赖数组警告清零

## 背景与需求

### 问题描述

CI（PR #372 日志）暴露 `eslint react-hooks/exhaustive-deps` 共 8 条 warning，集中在 conversation 三文件：`index.tsx`（5）、`MessageList.tsx`（3，含 1 条复杂表达式）、`ExecutionHistoryModal.tsx`（1）。

### 根因分析

依赖数组三类问题：(a) 漏写稳定依赖（`refreshParticipantsAfterDissolve` 已是 useCallback，补入零成本）；(b) 裸函数入 effect 未 memo（`loadExecutions`）；(c) 有意 mount-only 的 effect 依赖 lint 无法表达（首渲滚底）。

### 数据实锤

`npx eslint src`：8 warning / 0 error，全部 react-hooks/exhaustive-deps。

## 方案设计

逐条裁决（安全 = 补入后触发条件不变，行为等价）：

| 位置 | 警告 | 裁决 | 等价性论证 |
|------|------|------|-----------|
| ExecutionHistoryModal:67 | 缺 `loadExecutions` | 函数包 `useCallback([taskId])` 后入 deps | effect 仍仅随 taskId 变化触发 |
| MessageList:268 | 缺 `messages.length`/`onReachBottom`/`scrollToBottom` | **disable + 理由注释**：有意 mount-only。补 messages.length 会在用户上翻阅读时强拉每条新消息回底部（行为回归）；增量滚动由 :209 effect 按 isAtBottomRef 门控负责 | lint 语义与设计意图冲突，显式豁免 |
| MessageList:501 | 缺 `events` + 复杂表达式 `events[0]?.ts` | deps 改为 `[inFlight, events]` | 事件到达时间隔重启，tick 从 startTs 重算，计时显示连续 |
| index:188 | 缺 `urlConvId` | 补入 | 源自 window.location.pathname，MPA 下 mount 后值恒定 |
| index:607/844/1008 | 缺 `refreshParticipantsAfterDissolve` ×3 | 补入 | useCallback([activeId])，身份仅随 activeId 变，而三处宿主本就依赖 activeId |

### 目标

- T1: `npx eslint src` 零 react-hooks 警告
- T2: 行为零回归（构建 + 既有测试全绿）

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 警告清零 | `cd web && npx eslint src` | 无 react-hooks/exhaustive-deps 警告 |
| AT-2 | 无回归 | `npm run build && npm test` | tsc/vite 通过；17 文件 143 用例全绿 |
| AT-3 | 上翻不强拉 | 发送消息期间上翻阅读历史 | 新消息不把视口拉回底部（mount-only 豁免未改变行为） |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~3 | n/a（纯前端逻辑，A 类，见 frontmatter capability_test） |

## 实现细节

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/pages/conversation/ExecutionHistoryModal.tsx | 修改 | `loadExecutions` useCallback 化 + 入 deps |
| web/src/pages/conversation/MessageList.tsx | 修改 | :268 disable 注释；:501 deps 换 `events` |
| web/src/pages/conversation/index.tsx | 修改 | :188 补 `urlConvId`；三处 handler 补 `refreshParticipantsAfterDissolve`；rebase 吸收 #368（多 speak 气泡）后同三处再补 `clearSegments`/`upsertSegment`（均 useCallback([]) 稳定身份，行为等价） |

## 验收结果

### 测试结果

- `npx eslint src`：0 警告
- `npm run build`（tsc + vite）通过；`npm test` 17 文件 / 143 用例全绿

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 警告清零 | 证明完成（eslint 输出为空） | ✅ |
| T2 无回归 | 证明完成（build + 测试）；AT-3 人工复验待 review 时确认 | ✅/❓ |

## 设计决策

- 修警告优先"真补 deps"而非批量 disable：8 条中 7 条可行为等价补入，仅 1 条 lint 语义与 mount-only 设计意图冲突，豁免并写明理由。
- 本清理与 PR-5（SSE 收敛，将重构 index.tsx 三 handler）目录重叠：机械性 dep 修正先行，降低 PR-5 改造时的 lint 噪音。
