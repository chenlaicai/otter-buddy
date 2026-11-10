---
id: F20261110hjfnx
title: healing 代码围栏 no_issue 控制块泄漏到聊天正文
summary: 既有清洗只识别 XML 形态 healing 块，模型新输出的 Markdown healing/no_issue 代码围栏原样入库并显示。精确剥离无载荷 no_issue 围栏，同时保留普通 JSON 示例。
change_type: fix
capability_test: "n/a: speak 入库前纯文本清洗；由解析器红绿回归与既有防误剥测试覆盖"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from: [F20261109hjson, F20260904hstr]
  supersedes: []
tags: [healing, parser, regression, speak]
modules:
  - src/usecases/healing/healing-report-parser.ts
  - tests/usecases/healing/healing-report-parser.test.ts
created_at: 2026-11-10
intent:
  problem: "海獭发言在 #1800 合入后仍新增显示 ```healing {\"no_issue\":true} ``` 控制块，说明上一修复只覆盖 XML 包裹形态"
  expected_effect: "healing 围栏中的两种无载荷 no_issue JSON 与空 no_issue 围栏在 speak 入库前剥离；正文、卡片和普通 JSON 示例保留"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "新增围栏用例在未修复代码上红，完整复现生产残留"
      - "修复后解析器目标与防误剥用例全绿"
      - "相关 healing 测试、类型检查、lint 与全量测试通过"
    rollback: "git revert 本 PR 合入 commit；无 schema、配置或数据迁移"
    risk_note: "只匹配 healing/no_issue 围栏及精确无载荷对象，不匹配普通 json 围栏或其他 JSON"
---

# healing 代码围栏 no_issue 控制块泄漏到聊天正文

## 现场与根因

2026-11-10 18:58，搭档再次报告海獭发言带有 `{"no_issue": true}`。生产库确认这不是历史消息回显：对话 `0401284f` 在 18:51:47 与 18:52:53 新增两条 speak，正文尾部均为 ```` ```healing ```` 包裹的 `{"no_issue": true}`。

#1800 已于当日 08:01 合入，但其清洗器只支持 `<healing>{"type":"no_issue"}</healing>`。本次变体改用 Markdown 代码围栏且对象字段为 `no_issue: true`，两处均不匹配既有正则，因此原样入库。根因是上一修复的协议形态覆盖不完整，不是部署缺失或前端渲染异常。

## 修复

- 在既有 speak 入库清洗面 `stripHealingReport` 内增加精确围栏剥离：
  - ```` ```healing ```` 中的 `{"no_issue": true}`；
  - 同围栏中的 `{"type":"no_issue"}`；
  - 空 ```` ```no_issue ```` 控制块。
- XML 形态同步兼容 `no_issue: true`，保持两种包裹形式的语义一致。
- 不匹配普通 `json` 围栏，也不匹配 `healing` 围栏内的非协议 JSON；延续 F20260904hstr 的防误吞约束。

## Verification

### 失败用例证据（bugfix）

修复前运行：

```bash
npx vitest run tests/usecases/healing/healing-report-parser.test.ts
```

结果：**2 failed / 31 passed**。新增「fenced healing JSON no_issue variants」与「empty fenced no_issue control block」均完整残留控制块。原始输出：`healing-fenced-before.log`（对话工作区）。

修复后同一命令：**33/33 通过**。原始输出：`healing-fenced-after.log`。防误剥用例证明普通 `json` 示例和 `healing` 内非协议 JSON 原样保留。

其他验证：

- healing 相关 4 文件 **53/53 通过**。
- `npm run build`、`npx tsc --noEmit`、变更文件 ESLint、`lint:docs`、`lint:intent` 与 `git diff --check` 通过。
- `npm test` 全量 **456 文件 / 5851 用例通过**，原始输出：`healing-fenced-full-test.log`（对话工作区）。

## 回滚

单 commit revert 即可；无数据库 schema、配置或数据迁移。历史已入库消息不回刷，本修复防止新增泄漏。
