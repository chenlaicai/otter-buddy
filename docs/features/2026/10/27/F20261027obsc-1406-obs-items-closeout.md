---
id: F20261027obsc
title: 审视观察项收口：装配缺失错误码统一 501 + 密度定标措辞订正（#1406 遗留，#1417）
summary: 两观察项落地——①restart 装配缺失 500→501（与 getProfile 同码，语义＝能力未实现）；②narrative-synthesis-engine「227,110 密度被证伪」订正为「最小失败下界被证伪」（证伪的是下界样本，非密度本身）。均不改变行为语义。
doc_type: feature
change_type: fix
capability_test: "vitest restart-flow.integration.test.ts 5/5（含 501 断言更新）+ narrative-synthesis-engine 相邻预算测试无回归"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - "#1417（立案：PR #1406 delta 复核两观察项，搭档终审定调合入+留 issue 追踪）"
  - "F20261009s6ej6（被收口的 PR 对应特性文档）"
tags: [http-api, error-semantics, docs-hygiene]
modules: [interface-adapters]
created_at: 2026-10-27
---

# PR #1406 审视观察项收口（#1417）

## 背景与核实

PR #1406（F20261009s6ej6，10-10 合入）对抗审视 delta 复核留两个不阻断观察项（搭档终审拍板：合入 + 留 issue 追踪）。10-27 实查两处现场均属实：

1. **500/501 分裂**：`otter-controller.ts:133` restart 装配缺失 throw HttpError **500**，而同控制器 `getProfile`（:151）缺配置返 **501**——同为「服务端装配缺失」语义，码不同。检视獭判 501 Not Implemented 对装配缺失更精确
2. **措辞微瑕**：`narrative-synthesis-engine.ts:29`「227,110 密度被 10-09 更小失败样本 173,485 证伪」——被证伪的是「227,110 是最小失败样本」这一**下界断言**，不是密度本身

## 变更

| 文件 | 变更 |
|---|---|
| `src/interface-adapters/http/controllers/otter-controller.ts` | restart 装配缺失 500→**501**，注释同步（标注 F20261027obsc/#1417） |
| `src/frameworks/agent/narrative-synthesis-engine.ts` | 措辞订正：旧「227,110 密度被证伪」→「旧『最小失败 227,110』**下界**被证伪（证伪的是下界样本，非密度本身）」 |
| `tests/usecases/otter/restart-flow.integration.test.ts` | 裸 controller 测试断言 500→501 |

## 语义论证

- 501 Not Implemented＝「服务器不支持该功能（装配缺失）」，与 getProfile 的 `Profile endpoint not configured` 同口径；500 Internal Error 留给真正的未预期异常
- API 兼容性：错误码 500→501 是行为面微变——消费方按 5xx 统一处理的场景无感；按精确码分支的场景（如有）从误导（把装配缺失当服务故障排查）转为正确语义。检索确认该错误路径仅此一处抛出，无其他消费方按 500 分支

## 验证

- vitest `restart-flow.integration.test.ts` **5/5 绿**（含更新的 501 断言）
- narrative-synthesis-engine 改动为纯注释，无行为面（预算常量未动，tsc 覆盖）

## 关联

- #1417 关闭；PR #1406 审视遗留清零（该 PR 的建议项 A1-A6 中观察项即 A1 后续，其余已在 #1406 处置）
