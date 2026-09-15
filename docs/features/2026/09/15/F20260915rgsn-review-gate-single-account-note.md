---
id: F20260915rgsn
title: review state 决策表单账号降级声明：approve/request-changes 均物理不可达，全量 comment + 正文结论词
summary: F20260915rgte 的实证订正——rgte 已知限制记「REQUEST_CHANGES/COMMENTED 可正常发，仅 APPROVE 物理不可达」，9/15 PR #946 审视现场实证 REQUEST_CHANGES 同样被 GitHub 拒绝（"can not request changes on your own pull request"）。单账号环境下 approve 与 request-changes 均物理不可达，仅 comment 放行。skill 决策表补降级声明：全量 --comment 留痕，严肃结论以正文首行结论词为准，合并拦截靠 CI check + 大獭编排纪律。rgte 历史文档按铁律不改，本钉文档记录订正。
type: fix
created: 2026-09-15
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules: [adversarial-review, review-protocol]
from: [F20260915rgte]
intent:
  goal: 让 skill 决策表与实际物理边界一致，消除「REQUEST_CHANGES 可达」的错误预期
  why: rgte 文档与 skill 暗示 request-changes 在单账号可用，检视獭照表执行必撞墙后临时降级——把临时降级变成明规则，省去每次撞墙的发现成本
  non_goals:
    - 不追求 GitHub App 独立身份（搭档 9/15 终裁，#941 已关闭）
    - 不修改 rgte 历史文档（历史文档不可变铁律）
---

# review state 决策表单账号降级声明

## 背景

F20260915rgte（#940，今天上午合入）引入 review state 决策表，其「已知限制」节记录：

> state 决策表保留：REQUEST_CHANGES/COMMENTED 可正常发，仅 APPROVE 物理不可达

**9/15 PR #946（#544 日期炸弹防线）审视现场实证该记录不完整**：日期检视獭执行 `gh pr review 946 --request-changes` 被 GitHub 拒绝——"can not request changes on your own pull request"，与 approve 同一根因（平台级硬规则，非分支保护配置）。即单账号环境下：

| state | 物理可达性 |
|---|---|
| COMMENT | ✅ 可达 |
| REQUEST_CHANGES | ❌ 物理不可达（9/15 #946 实证） |
| APPROVE | ❌ 物理不可达（rgte r2 实证） |

## 订正内容（本 PR）

1. **adversarial-review skill 步骤 6a**：决策表下新增「单账号环境降级」声明——全量 `--comment`，严肃结论以正文首行结论词为准（「需要修改」/「通过（delta 复核）」），合并拦截靠分支保护 CI check + 大獭编排纪律；bash 示例加注
2. **review-protocol skill 步骤 1**：删除「main 分支保护已开 required reviews」的过期描述（已按搭档终裁回滚），同步降级声明
3. **rgte 历史文档不改**（铁律），本钉文档与其 from 关联

## 边界

- 多账号环境（GitHub App 独立身份等）接入后，rgte 决策表直接生效，无需改 skill——降级声明自动失效
- 单账号下「需要修改」comment 不挡合并：防线 = CI check（分支保护 strict）+ 大獭编排层「未见 delta 通过结论不呈终审」纪律

大獭
