---
id: F20260805p6dl
title: test-suite-padding-deletion
doc_type: feature

summary: |
  删除测试套件的覆盖填充：6 个文件 + 4 处文件内冗余，共 71 个用例、约 1500 行。
  判别标准：断言是否验证行为——mapper 字段拷贝（已被真 sqlite 仓库往返测试覆盖）、
  DTO 字段拷贝（已被 tests/api HTTP 层覆盖）、pass-through 透传（QueryOtter.getById 零逻辑）、
  schema 表名清单（与 schema 锁步编辑的抄写）、重复空列表断言、工具数量断言、
  以及一个反向锁死验证缺失的测试（"passes undefined fields" 把"控制器不校验"固化为预期）。
  删除前逐一 grep 验证断言已被存活测试覆盖。1045 → 974 用例，全绿。

causal_links:
  from:
    - F20260805rsto   # 测试体系重构缘起
  to: []

status: implemented
change_type: refactor
tags: [test, cleanup, coverage-padding, deletion]
modules:
  - tests/usecases/otter/query-otter.test.ts
  - tests/interface-adapters/dto.test.ts
  - tests/interface-adapters/http/dto/scheduled-task-dto.test.ts
  - tests/frameworks/db/conversation/conversation-mapper.test.ts
  - tests/frameworks/db/otter/otter-mapper.test.ts
  - tests/frameworks/db/scheduled-task/scheduled-task-mapper.test.ts
  - tests/frameworks/db/schema.test.ts
  - tests/api/conversation.test.ts
  - tests/api/otter.test.ts
  - tests/interface-adapters/html-card-tool.test.ts
---

# F20260805p6dl: 删除测试覆盖填充

## 判别标准

一个测试值得存在的唯一理由：它断言的**行为**失败时，用户或调用方能感知。
以下形态是覆盖填充——数字繁荣但零验证价值：

| 删除对象 | 形态 | 存活覆盖 |
|---|---|---|
| 3 个 mapper 测试（~950 行） | 字段抄送断言 | sqlite 仓库测试经真 DB 往返同样字段 |
| 2 个 DTO 测试 | 字段抄送断言 | tests/api 在 HTTP 层断言同样 DTO |
| query-otter.test.ts | pass-through（mock 进啥出啥） | 无逻辑可测 |
| schema 表名清单 | 与 schema 锁步编辑的抄写 | 保幂等性/CHECK/外键三个行为用例 |
| conversation 重复空列表 | 同一用例写两遍 | 保留其一 |
| html-card toHaveLength(20) | 工具数量实现细节 | 工具行为各有专测 |
| otter "passes undefined fields" | 反向锁死：把验证缺失固化为预期 | 删除即解锁（将来加校验时无需先改测试） |

## 结果

- 文件 85 → 79，用例 1045 → 974（-71），全绿
- 套件总数字下降是**收益**：剩余每个用例都与可感知行为挂钩
