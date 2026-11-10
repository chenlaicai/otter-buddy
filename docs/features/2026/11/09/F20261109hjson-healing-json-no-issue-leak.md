---
id: F20261109hjson
title: healing JSON no_issue 控制块泄漏到聊天正文
summary: speak 清洗器只识别方括号 healing 协议，模型偶尔输出的 JSON no_issue 块未经剥离直接入库并显示。兼容剥离该无载荷控制块，并在工具说明中明确推荐格式；普通 JSON 示例保持不动。
change_type: fix
capability_test: "n/a: speak 入库前纯文本清洗；由解析器回归测试与 prompt golden-selftest 覆盖"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from: [F20260730heal, F20260904hstr]
  supersedes: []
tags: [healing, parser, regression, speak]
modules:
  - src/usecases/healing/healing-report-parser.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/usecases/healing/healing-report-parser.test.ts
created_at: 2026-11-09
intent:
  problem: "海獭发言偶尔显示 <healing>{\"type\":\"no_issue\"}</healing> 控制块，污染搭档可见正文"
  expected_effect: "JSON no_issue 与既有方括号 no_issue 一样在 speak 入库前剥离；正文与卡片保留，非协议 JSON 不误剥"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "新增 JSON no_issue 剥离用例在未修复代码上红，实际正文原样残留"
      - "修复后目标用例绿，周围正文保留；非协议 JSON 示例原样保留"
      - "healing 解析与高危路由相关测试通过，prompt golden-selftest 通过"
    rollback: "git revert 本 PR 合入 commit；无 schema、配置或数据迁移"
    risk_note: "仅识别仅含 type=no_issue 的 JSON 对象，不泛化剥离其他 JSON，控制误剥面"
---

# healing JSON no_issue 控制块泄漏到聊天正文

## 现场与根因

2026-11-09 搭档在海獭发言中偶尔看到 `<healing> {"type":"no_issue"} </healing>`。消息检索确认该控制块已进入存储正文，因此不是前端 Markdown 渲染问题。

`speak` 入库前调用 `stripHealingReport`，但其正则只接受 `<healing>[no_issue]</healing>` / `[issues]` 方括号协议。speak 工具说明只写“附 no_issue 块”，未展示字面格式；模型改写成 JSON 后正则不匹配，控制块便原样进入正文。

## 修复

- `stripHealingReport` 增加精确 JSON `no_issue` 变体剥离，容忍标签、字段冒号及对象周围的空白。
- 只剥离仅含 `type=no_issue` 的无载荷对象；其他 JSON 不泛化匹配，延续 F20260904hstr 的防误吞约束。
- speak 工具说明明确推荐 `<healing>[no_issue]</healing>`，并注明不要使用 JSON，降低后续格式漂移。

## 验证

- 修复前新增用例复现红：正文后完整残留 JSON 控制块。
- 修复后 `healing-report-parser` 与 `healing-alert-registry` 共 41 用例通过；全量 441 文件、5755 用例通过。
- `npm run check` 通过；prompt golden-selftest 命令退出 0（无 LLM 采样按门禁语义跳过）。
- 非协议 JSON 示例保持原文，既有正文引用、防误吞、残缺块行为不变。

## 回滚

单 commit revert 即可；无数据库 schema、配置或数据迁移。
