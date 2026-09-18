---
id: F20260917rsta
title: 重启獭生交接摘要可选化：空摘要自动走 LLM handoff 压缩合成
summary: 搭档重启獭生时被 UI 强制要求填交接内容（Modals.tsx 的 if (summary.trim()) 门），而后端 restartSession 的 summary 本就可选。搭档期望：填了按我的，没填用默认压缩 handoff 算法（与优雅上下文交接同一套）。实现：UI 去必填 + AgentInvoker 新增 restartWithAutoHandoffIfBlank（空摘要 → 复用退役 70% 链路的 LLM 合成四件套 → 合成摘要重启；D9 原则任何环节失败降级无摘要重启，永不阻塞 restart）。本特性显式放宽 F20260825hndf 审视 P1 红线「手动路径绝不走 LLM 合成」——该红线针对熔断场景（已陷复读不做优雅交接），手动重启的獭不一定是退化状态，搭档点名开口。
change_type: feature
capability_test: n/a（纯链路接线变更：UI 门放开 + controller 委托 + 既有四件套复用；行为由 8 个单测/API 测试钉住——6 个 restartWithAutoHandoffIfBlank 单测（直透/合成重启/三级降级/D8 补偿删除）+ 2 个 controller 接线测试）
created_in_conversation: c619e648-e98b-4ea0-9b8d-b2a5cea3865d
tags: [restart, handoff, session, web-ui, llm-synthesis]
modules: [src/interface-adapters/agent-runtime/agent-invoker.ts, src/interface-adapters/http/controllers/otter-controller.ts, src/usecases/otter/manage-session.ts, src/bootstrap/controllers.ts, web/src/pages/conversation/Modals.tsx, web/src/pages/conversation/index.tsx, tests/interface-adapters/agent-invoker-restart-auto-handoff.test.ts, tests/api/otter.test.ts]
from: [F20260825hndf, F20260903cmpk, F20260908efmd]
created_at: 2026-09-17
---

# 重启獭生交接摘要可选化

## 背景（意图锚）

搭档原话（2026-09-17，本对话）：

> 现在我来重启獭生，我必须输入内容才可以，但我记得重启獭生底层都是同一个 handoff 机制，跟海獭上下文压缩是同样的，所以，我期望这个交接内容可选，我输入了那就按我的，我没输入就用默认的压缩 handoff 算法

## 现状排查（动手前的事实）

1. **卡点只在 UI**：`Modals.tsx` 确认按钮被 `if (summary.trim())` 挡住；后端 `ManageSession.restartSession(otterId, summary?, modelAlias?)` 的 summary 一直可选（空了 = 新世从零开始）。
2. **「默认压缩 handoff 算法」真实存在但闲置**：F20260825hndf 的优雅交接四件套（件① LLM 叙事合成 + 件②③④机械预取）在 F20260903cmpk 后退役了 70% 阈值自动触发链路（被 session_before_compact 压缩钩子接管），合成设施 `buildSynthesisFunction` / `buildAutoHandoffOptions` 仍在仓内但无生产调用方。本需求让它重新上岗。
3. **历史红线**：F20260825hndf 对抗审视 P1 定的「synthesize 仅允许出现在自动交接路径，手动/熔断路径绝不走 LLM 合成」（agent-invoker.ts buildAutoHandoffOptions/buildManualHandoffOptions 类型隔离），原理由 = 熔断场景「已陷复读不做优雅交接」。

## 设计取舍

| 取舍 | 选择 | 理由 |
|------|------|------|
| 红线放宽范围 | **仅 HTTP 手动重启路径**（搭档在 UI 点重启）；熔断路径、獭自重启（restart_otter 工具）不碰 | 熔断场景的红线理由仍成立（已陷复读的獭做 LLM 合成可能复读出垃圾摘要）；獭自重启时獭自己写叙事是职责。手动重启的獭不一定是退化状态 |
| 合成时机 | **reset 旧 session 之前**（合成原料 = 旧上下文） | 顺序硬约束：先 buildHandoffPackage（含 readOnly invoke 合成）→ 再 restartSession |
| 失败降级 | D9 同源原则：无对话 / 合成异常 / 四件套构建失败 / 依赖未注入 → 全部降级为无摘要重启，**永不阻塞 restart** | restart 是搭档的显式指令，交接摘要是增强不是硬依赖 |
| 件②③④ | 与自动链路同款：写入 otter_context 借用式 key（handoff_file_trail / handoff_recency_window / handoff_state_inventory），首次 invoke 后删除；restart 失败时 D8 补偿删除 | 与既有 handleHandoff/熔断路径语义一致，不发明新机制 |
| 解散弹窗 | 不动（归档摘要维持必填） | 解散是给记忆库留档，性质不同（搭档方案边界） |

## 实现要点

- **`AgentInvoker.restartWithAutoHandoffIfBlank(otterId, summary?, modelAlias?)`**（新增公共方法）：summary 非空直透 `restartSession`；空 → `resolveFirstConversationId`（经 manageSession.conversationQuery 窄接口）→ 复用 `buildAutoHandoffOptionsWithMechanicals`（trigger 覆盖为「手动」）构建四件套 → 件②③④写 context → 合成摘要重启；restart 失败 D8 补偿删除。
- **controller**：`OtterController` 新增可选注入 `agentInvoker?: Pick<AgentInvoker, "restartWithAutoHandoffIfBlank">`——注入即委托，未注入降级原语义（测试/旧装配兼容）。
- **bootstrap**：controllers.ts 接线 `agentInvoker`。
- **ManageSession**：`conversationQuery` 从 private 改为 readonly 暴露（纯查询窄接口，不改写路径）。
- **UI**：RestartModal 去掉 `if (summary.trim())` 门；placeholder 改为「留空将自动生成交接摘要（走 handoff 压缩合成）；填写则按你的来」；index.tsx 空串透传 undefined，toast 区分有无摘要。

## 机制识别检查点（issue 驱动未经 RA，必做）

逐项过：本特性是**复用既有机制**（四件套 + 合成函数 + otter_context 借用式注入 + D8/D9 防线全部是 F20260825hndf 已有设施），新增的只是「手动路径空摘要时的接线」（一条委托链 + 一个 UI 门放开）。**不涉及净新增机制**——合成设施本就存在，本 PR 是它的新调用方。

## 验证

- 新增 6 个单测（tests/interface-adapters/agent-invoker-restart-auto-handoff.test.ts）：有摘要直透 / 合成摘要重启+件②③④写入+trigger=手动 / 无对话降级 / 构建抛错降级 / 依赖未注入降级 / restart 失败 D8 补偿删除。
- 新增 2 个 API 测试（tests/api/otter.test.ts）：注入委托 / 未注入降级原语义。
- 全量：3195 tests passed（264 files）；root + web tsc 0 error；lint 0 error（12 warnings 全部 pre-existing——基线核对：stash 后 lint 同样 12 warnings 0 errors）。
- 最简实现检查：已过——四件套/合成/context 注入全部复用既有设施，新代码仅为接线（agent-invoker +95 行含注释，controller +7 行，UI +9 行）。

## 负面向验收（#962 刹车二）

本变更破坏/绕过的旧契约：
- **绕过 F20260825hndf P1 红线**：手动重启路径接入了 LLM 合成。处置：红线声明写入方法注释（何种场景开口、何种场景仍封闭），熔断/自重启路径的类型隔离（buildManualHandoffOptions 无 synthesize 签名）保持不变。
- 无 DB 迁移、无旧文件删除、无配置变更。
