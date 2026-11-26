---
id: F20261126msumm
title: "otter-summon 模型建议消费运行时清单：移除固定 mimo 推荐并补文档契约"
summary: "#1996：skill 的「代码/逻辑 → mimo」与 create_otter 当前模型注册表不一致，按文档派工必先触发一次未知别名失败。模型分配流程改为只消费身份注入的可用模型清单与对方 modelAlias，新增契约测试禁止固定任务→别名映射和 mimo 族回潮。"
change_type: fix
capability_test: "tests/lint/otter-summon-model-guidance.test.ts"
intent:
  problem: "运行时 create_otter 通过 ModelPool.hasModel 校验别名并拒绝 mimo，但 otter-summon 仍在模型分配流程硬编码推荐 mimo；静态文档与动态注册表脱节，派工者按 skill 操作会先失败一次。"
  solution: "不在 skill 再维护一份模型注册表。分配流程只引用当前身份注入的「可用模型」清单与 get_active_participants 返回的对方 modelAlias；新增文档契约测试，禁止固定任务→别名映射和已知失效的 mimo 族推荐回潮。"
  expected_effect: "按 skill 选择模型时只使用当前运行时实际可创建的别名；以后模型池调整不再需要同步修改这份文档，固定 mimo 推荐也不会无测试地回归。"
  verify_by:
    type: static_only
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - {type: "fixes", id: "issue#1996", note: "移除与 ModelPool 注册表脱节的 mimo 推荐并补防回归契约"}
tags: [otter-summon, model-routing, documentation-contract, model-alias]
modules: [skill, tests]
---

# otter-summon 模型建议消费运行时清单

## 案发现场与根因

healing `273b6ed5-7f5e-4ac8-b559-9be82bc39733` 记录：`create_otter` 拒绝 skill 推荐的 `mimo`。工具层在 `src/interface-adapters/agent-runtime/tools/tool-factory.ts:617-620` 用 `ctx.modelPool.hasModel(modelAlias)` 校验并返回当前可用别名；skill 却在模型分配流程写死「代码/逻辑 → mimo」。

根因不是配额，而是把动态 ModelPool 清单复制成静态推荐后失去同步。再换一份硬编码别名表只能修当下，不能消除同类漂移。

## 方案

模型分配流程改为：

1. 用 `get_active_participants` 或任务上下文确认对方模型。
2. 从当前身份注入的「可用模型」清单选择不同别名，按清单 strengths 匹配任务；不凭预训练记忆或旧文档写死别名，清单不可见时先查运行时配置。
3. 在任务简报写明双方模型。

`create_otter` 的 ModelPool 校验保持为最终机械闸，不绕过、不复制。

## 失败证据与验证

### 修复前

新增 `tests/lint/otter-summon-model-guidance.test.ts` 后直接运行：

- `npx vitest run tests/lint/otter-summon-model-guidance.test.ts` → **2/2 failed**：缺运行时清单指引，且仍命中 `代码/逻辑 → mimo` 与 mimo 族别名。

### 修复后

- 同一命令 → **2/2 passed**。
- `npm run lint:skills` → 16 skills OK（14 条存量 warning）。
- `git diff --check` → 通过。

契约测试锁两点：模型分配段必须引用运行时清单与 `get_active_participants`；不得再出现固定任务→别名映射和 mimo 族推荐。

锚点重放：n/a——本单只改模型选择资料来源，没有对应 LLM golden 场景；机械防回归由文档契约测试承担。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 模型清单真相源 | 运行时身份注入的 ModelPool 清单 | 在 skill 换一份静态别名表 | 消除文档与注册表再次漂移的根因 |
| 防回归 | 文档契约测试 | 每次人工回查 | CI 能直接抓住固定映射和 mimo 回潮 |
| 生产逻辑 | 不改 | 改 create_otter 校验 | 工具现有校验正确，问题只在文档 |

机制识别七项均未命中：无新增配置、状态生命周期、后台任务、消息格式、持久化、被记住的决策分支或跨模块调用；仅 skill 文本与测试，声明 `Modification-Class: docs-config`。

## 回滚

revert 本 PR 即恢复旧 skill 文本并移除契约测试；不改变模型池、工具校验或任何会话配置。回滚后 #1996 的固定 mimo 推荐与文档漂移风险重新出现，属已知代价。
