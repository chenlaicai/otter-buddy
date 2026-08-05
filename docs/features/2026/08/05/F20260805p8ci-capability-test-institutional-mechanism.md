---
id: F20260805p8ci
title: capability-test-institutional-mechanism
doc_type: feature

summary: |
  测试体系重构的制度收口：F 文档 frontmatter 新增 capability_test 约定，
  change_type=feature/prompt 的文档必须声明能力测试路径或 n/a 理由。
  动机：P3-P5 建成的能力测试层只能防"当下"的能力缺失；防"以后"再退化需要机制而非自觉——
  每个涉及 LLM 行为的改动在 commit 时就被提醒配套能力验证。
  机制：scripts/lint-capability-docs.mjs（缺字段警告、路径不存在报错）接入 pre-commit；
  约定写入 docs/README.md 与 CONTRIBUTING.md；本批次 3 个 feature 文档已率先声明。

causal_links:
  from:
    - F20260805capt   # 能力测试层（本机制约束的对象）
  to: []

status: implemented
change_type: feature
capability_test: "n/a: 制度脚本本身为纯代码逻辑（A 类），其正确性由合成文档正反路径手工验证"
tags: [test, convention, lint, githooks, docs]
modules:
  - scripts/lint-capability-docs.mjs
  - docs/README.md
  - CONTRIBUTING.md
  - .githooks/pre-commit
  - package.json
---

# F20260805p8ci: 能力测试制度机制

## 约定（docs/README.md「能力测试约定」）

`change_type` 为 `feature` 或 `prompt` 的 F 文档，frontmatter 应声明：

```yaml
capability_test: tests/capability/xxx.capability.test.ts   # 或 "n/a: 纯代码逻辑改动（A 类）"
```

判别标准与测试分层一致：改动涉及 LLM 参与的行为（B 类）→ 必须有能力测试；
纯软件边界内代码逻辑（A 类）→ 声明 n/a。

## 机制

- `scripts/lint-capability-docs.mjs`（npm run lint:capability）：
  缺字段 → 警告（过渡期不阻断，当前 62 个存量警告）；
  声明了路径但文件不存在 → 错误（说了就要有，exit 1）。
- 接入 `.githooks/pre-commit`（lint:docs 之后）。
- CONTRIBUTING.md PR 清单加一行。
- 以身作则：F20260805capt / F20260805olc4 / F20260805p5bt 三个 feature 文档已声明。

## 验证

- 合成坏文档（路径不存在）→ 报错 ✓；删除后恢复 OK ✓
- 存量 119 文档 frontmatter 校验（lint:docs）不受影响 ✓
