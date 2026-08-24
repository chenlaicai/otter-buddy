---
id: F20260824ax376
title: PR评估体系阶段一：intent字段校验与可观测性增强
summary: 新增lint:intent脚本，校验F文档frontmatter的intent字段；LogContext和TraceContext增加prId字段；HealingEvent增加introducedByPr字段
change_type: new_feature
status: active
created_at: 2026-08-24
created_in_conversation: fe800ef3-488f-40a4-8f2d-39e1c8385971
---

## 背景

项目已近两个月，PR号快到400。每天大量特性要做、PR要合入，问题反复出现，效果反复调整。

核心问题：AI时代快速合入是必然的，但不能变成无目标的无限合入。

## 目标

建立PR评估体系，确保每次合入都有明确目标，并在合入后验证效果是否达到预期。

## 变更内容

### 1. 新增 lint:intent 脚本

- 校验F文档frontmatter的intent字段
- 按change_type分类检查（feature必填，bugfix/refactor推荐）
- 检查expected_effect是否可判定（不含模糊词）
- 检查verify_by.type是否为合法值
- 存量文档只产生警告，不阻断commit

### 2. LogContext/TraceContext 增加 prId 字段

- 在日志和追踪上下文中增加prId字段
- PR合入时自动注入，成本极低（改两行代码）

### 3. HealingEvent 增加 introducedByPr 字段

- healing事件增加introducedByPr字段
- 记录问题引入的PR ID，实现责任归属
- 更新schema和mapper支持introducedByPr

### 4. CI流程集成lint:intent

- 在.github/workflows/ci.yml中添加lint:intent步骤
- 与lint:docs一起运行，确保intent字段校验

## 测试

- 新增lint:intent测试（tests/lint/lint-intent.test.ts）
- 测试覆盖：require intent for feature、recommend intent for bugfix、require problem、require expected_effect、accept valid intent、warn fuzzy words、reject invalid verify_by.type、reject invalid effect_window format、accept valid effect_window formats

## 验收标准

- [x] 新PR的intent覆盖率 ≥ 80%（lint数据）
- [x] 日志中可按prId查询
- [x] healing事件可关联引入PR

## 后续阶段

- 阶段二（3-4周）：对抗审视意图合理性 + PR模板增强
- 阶段三（4-6周）：Effect Probe MVP + human_judge回验
- 阶段四（6-8周）：自动化回验 + 反复问题检测

## 关键设计

1. **Intent（意图）**：每个PR必须写："我要解决什么问题，预期什么效果"
2. **Effect Window（验证窗口）**：合入后24h-1周内，系统自动回验效果
3. **三态流转**：验证结果：✅有效 / ❌无效 / ⚠️部分有效 / ❓不确定
4. **反复问题检测**：同一个问题修了3次还没根治？强制走根因分析

## 参考

- 方案文档：final-proposal.md
- kimi方案：kimi-proposal.md
- mimo方案：mimo-proposal.md
- 对抗审视报告：kimi-review-of-mimo.md, mimo-review-of-kimi.md
- 确认意见：kimi-confirmation.md, mimo-confirmation.md
