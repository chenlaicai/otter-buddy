---
id: F20260903rpds
title: "右侧栏参与者卡变形真凶：时间戳长字符串换行（truncate 防护补齐）"
created: 2026-09-03
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
change_type: fix
modules:
  - web/src/pages/conversation
tags:
  - web-ui
  - bugfix
  - right-panel
  - layout
from:
  - F20260903bdhp
status: implemented
capability_test: "n/a: 纯 CSS class 变更（truncate/whitespace-nowrap），无 LLM 行为；由 RightPanel.test.tsx 断言覆盖"
intent:
  problem: "#756 修了 model badge 的换行（whitespace-nowrap shrink-0），但《对话中invoke机制》右侧栏大獭卡仍变形（118px vs 其他卡 61px）——真凶是另一行：活跃会话时间戳「第6世 · 2026-09-02 09:32:06」19 字符在窄卡内换行成两行（实测高 54px vs 常规 16px），副行「大獭 · 持久」同样换行（30px）。badge 不是唯一长文本源。"
  expected_effect: "大獭卡高度回落到与其他卡一致（约 61px，探针实测基线）；副行与时间行任何长字符串不再撑高卡片；badge 防护维持 #756 不变"
  verify_by:
    type: static_only
    reason: "CSS class 防护 + 组件测试断言（RightPanel 23 用例全绿），无 LLM 行为可采样"
supersedes: []
summary: "搭档实测 #756 合入后右侧栏仍变形。大獭 CDP 探针（headless chrome + 几何量测）定位真凶：不是 badge（#756 已修好，59×18 一行）而是会话时间戳长字符串换行——「第6世 · 2026-09-02 09:32:06」19 字符在 min-w-0 flex 容器内被压成两行。补 truncate+whitespace-nowrap 到副行与时间行。"

---

# 右侧栏参与者卡变形真凶：时间戳长字符串换行

## 背景（意图锚）

> chen 2026-09-03 11:56：「你可以去看下《对话中invoke机制》中的右侧栏，大獭glm-flash还是变形了（如果你看不到真实页面，你就让glm flash来看！）」

#756（F20260903bdhp，另一条线今早合入）修的是 model badge 换行。合入后搭档实测仍变形——修复没打全。

## 排查过程（CDP 探针实测）

headless chrome 打开 `localhost:3000/conversation.html` → 点击《对话中invoke机制》→ 量所有参与者卡几何：

| 卡 | 高度 | badge | 诊断 |
|---|---|---|---|
| 大獭（glm-flash） | **118px** | 59×18 一行 ✓ | badge 正常，高在其他行 |
| mimo | 61px | 41×18 ✓ | 正常基准 |
| flash（glm-flash） | 61px | 59×18 ✓ | **同款 badge 不变形**——排除 badge 假设 |

大獭卡逐行高度：名字 16px / 副行「大獭 · 持久」**30px（换行）** / 时间行「第6世 · 2026-09-02 09:32:06」**54px（三行）** / badge 18px。

**根因**：`fmtTime` 输出完整时间戳（`2026-09-02 09:32:06`，utils.ts:16 无短格式），加上「第6世 · 」前缀共 19 字符，在 `min-w-0` flex 子容器（宽约 130px）内必然换行。#756 只给 badge 加了 nowrap，漏了同容器的其他两个文本行。

## 修复

RightPanel.tsx 副行与时间行加 `whitespace-nowrap truncate`（与 #756 的 badge 防护同款哲学：行内内容再长也不换行，超出截断显示）。

## 验证

- RightPanel.test.tsx 23 用例全绿（含新增断言：副行含 truncate+whitespace-nowrap）
- web tsc 0 error
- 探针基线：修复前大獭卡 118px / mimo 卡 61px；修复后预期回落 61px 量级

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 换行 vs 截断 | truncate 截断 | A) 时间戳改短格式（fmtTime 相对时间） | 截断改动面最小（2 行 class）；短格式是更彻底的方案但动 utils 公共函数，影响面大，留给独立优化 |
| 大獭副行「大獭 · 持久」 | 同样 truncate | 保持原样 | 副行 5 字符理论不换行，但防护成本为零，一次补齐防未来加长 |

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| web/src/pages/conversation/RightPanel.tsx | 改 | 副行+时间行加 whitespace-nowrap truncate |
| web/src/pages/conversation/RightPanel.test.tsx | 改 | +1 断言（副行 truncate 防护） |
