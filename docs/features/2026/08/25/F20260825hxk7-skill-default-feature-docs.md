---
id: F20260825hxk7
title: skill 产出清单内置特性文档为默认交付物
summary: |
  issue #443：8/25 三个 PR（#434/#435/#436）全被对抗审视抓「B2 特性文档缺失」严重发现，根因是 skill 产出清单未把特性文档列为默认交付物，交付依赖派工简报人工提醒。本 PR 落地 issue 方案 1+2：worktree-isolation 与 code-implementation 两个 skill 的 Output 描述、工作流、产出表同步加入特性文档行；修正 code-implementation 输入表「不存在则跳过」与 B2 硬规则「必须」的矛盾。方案 3（commit-msg/CI 工具层校验）评估为暂缓，结论已评论至 issue。
change_type: feature-update
status: active
capability_test: "n/a: 纯 skill prompt 变更（B 类），行为效果由后续 PR 的对抗审视 B2 检核自然验证"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# skill 产出清单内置特性文档为默认交付物

## 背景与需求

### 问题现象

8/25 三个 daily-review issue（#422/#423/#424）并行修复中，三只开发獭的 PR（#434/#435/#436）**全部**被对抗审视抓到「B2 特性文档缺失」严重发现。三个 PR 同日全中同一发现，证明是系统性缺口而非个案。

### 根因

交付物清单全靠大獭派工简报人工提醒——记忆依赖，必然偶发遗漏。skill 层面：

- `worktree-isolation/SKILL.md` 产出表只列了「worktree + commit + PR 链接」，全文仅步骤 2 顺带提了一句特性文档位置
- `code-implementation/SKILL.md` 步骤 7 有文档要求，但产出表同样只列代码 PR；且输入表写着「特性文档 | 不存在则跳过」——与 adversarial-review 的 B2 硬规则「无论变更类型，特性文档都是必须的」直接矛盾

而审视侧（adversarial-review）早已把 B2 缺失定为不可降级的严重发现——产出侧与之对齐才能形成闭环：**上游默认产出，下游检核验收**。

## 方案设计

issue #443 建议三个方案，本 PR 落地方案 1+2，方案 3 评估不做（结论评论至 issue）。

### 方案 1：worktree-isolation/SKILL.md（3 处）

| 位置 | 改动 |
|------|------|
| frontmatter Output | `worktree + commit（按提交模板）+ 特性文档（docs/features/）+ PR 链接交搭档` |
| 工作流步骤 3 | 追加：「**特性文档（docs/features/F*.md）是默认交付物**（#443）：与改动同 worktree 提交，格式参考 docs/features/ 下已有文档，frontmatter 至少含 id/title/summary/change_type/created_in_conversation，详见 `_shared/SKILL-TEMPLATE.md` 全局约定「特性文档」」 |
| 产出表 | 首行新增：「特性文档（docs/features/F*.md，与改动同 worktree 提交）\| 随 PR 接受对抗审视 B2 文档完整性检核 \| 检视獭」 |

### 方案 2：code-implementation/SKILL.md（4 处）

| 位置 | 改动 |
|------|------|
| frontmatter Output | `代码 PR + 特性文档（含测试、自检通过、对抗审视通过），呈搭档终审` |
| 输入表 | 「不存在则跳过」→「不存在则步骤 7 创建」——修正与 B2 硬规则的矛盾 |
| 工作流步骤 7 | 「追加到特性文档」→「追加（不存在则创建）到特性文档」 |
| 产出表 | 首行新增：「特性文档（docs/features/F*.md，步骤 7）\| 随 PR 对抗审视（B2 文档完整性）\| 当前獭」 |

### 取舍

- **产出表行的「下一步」指向对抗审视而非搭档终审**：特性文档的验收时机是随 PR 的 B2 检核，与审视侧硬规则对齐；issue 建议原文写「搭档终审」，落地时以审视协议实际流程为准。
- **不新建章节、不动其他 skill**：改动最小化，边界严格遵守（不含 skill 结构重构、其他 skill 文件、SYSTEM.md）。
- **修正输入表矛盾属最小必要修复**：若只加产出表行，输入表「不存在则跳过」会与之直接冲突，检视必然打回。

## 影响范围

- 两个 skill 的产出契约增强，无代码逻辑变更
- 后续所有走 worktree-isolation / code-implementation 流程的 PR，产出清单自动包含特性文档，不再依赖派工简报提醒
- 与 adversarial-review B2 硬规则（特性文档缺失 = 严重发现，不可降级）形成产出-检核闭环

## 验证

- 通读改后全文，确认无自相矛盾（输入表、步骤 7、产出表三处语义一致）
- 本 PR 自身以身作则：交付本特性文档，与 skill 改动同 worktree 提交
