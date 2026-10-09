---
id: F20261009csf3
title: "协作现场收尾：右栏「关键资源」tab 退役——产物展示归位中间栏时间轴"
summary: "协作现场世界观落地收尾（F20261008csfw 分期最后一项）：右栏「关键资源」tab 整体退役——产物展示已由中间栏时间轴混排承接（P1 摘要卡 + P2 活类登记），清单视图成冗余；手动登记/标旗/删除三个管理入口随之移除，操作改走对话通道（搭档拍板方案 A：平时主要是海獭间使用）。右栏回归 4 tab（参与者/定时任务/工作区/待办）。"
change_type: refactor
capability_test: "n/a: 纯 UI 退役改动（删 tab + 调用链 + 测试同步），行为面验证 = RightPanel/Modals/RestartModal/OtterProfileCard 49 用例 + web 全量 670 绿——普通 vitest 套件；golden 豁免（沿 #1318 先例：golden 场景集无右栏交互路径）"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  - "F20261008csfw"
  - "F20261008csf1"
  - "F20261009csp2"
modules:
  - web/src/pages/conversation/RightPanel.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/Modals.tsx
tags:
  - conversation-view
  - right-panel
  - artifact
  - product-form
created_at: "2026-10-09T10:50:00+08:00"
intent:
  problem: "P1/P2 落地后产物已按时间轴混排进中间栏（摘要卡/活类登记卡），右栏「关键资源」tab 变成同一数据的重复清单展示；且其挂载的手动登记/标旗/删除三个管理入口搭档日常几乎不使用（主要海獭间通过工具调用操作）——视图冗余 + 管理面低频。"
  expected_effect: "① 右栏 4 tab（参与者/定时任务/工作区/待办），关键资源 tab 及 FactItem/LinkedResourceItem/ResourceHoverCard/内联表单/LinkResourceModal 全链路移除；② index.tsx 的 addFact/toggleResourceFlag/deleteLinkedResource/confirmLinkResource 四个管理函数移除（无 UI 调用方）；③ API 层（linkResource/flagResource/deleteLinkedResource）保留——服务端工具与时间轴数据源仍消费。"
  verify_by:
    type: static_only
    reason: "纯删除型 UI 退役：tsc 零错 + 4 个受影响测试文件 49 用例（含新增『resources tab 不存在』回归钉）+ web 全量 670 绿。golden 场景集无右栏路径（#1318 先例豁免）。"
---

# 协作现场收尾：右栏「关键资源」tab 退役

> 宪法 F20261008csfw 分期收尾。P0 宪法 ✅ → P1 图/链/文 ✅（#1362）→ P2 活类 ✅（#1377）→ 本文：清单视图退役。

## 背景与决策

P1/P2 合入后，产物在中间栏时间轴有了形态化展示（fact 全文卡/file 摘要卡/PR 直达卡/活类自动登记卡）。右栏「关键资源」tab 的清单视图成为**同一数据的降维重复**——且它独占的三个管理入口（手动添加事实表单、⭐星标、逐条删除）搭档日常几乎不用（产物管理实际走海獭工具调用：create_linked_resource / superseded 流转）。

**搭档拍板（M-4608a9f8，方案 A）**：「a 即可，我平时也不咋用这个关键资源，主要还是你们海獭间用」——彻底退役，不做能力下沉。

## 改动清单

| 层 | 删除内容 | 说明 |
|---|---|---|
| RightPanel.tsx | resources tab + FactItem + LinkedResourceItem + ResourceHoverCard + legacyCopy + useResourceHover + kf 表单 state/handlers + 5 个 props | 组件与交互全链路 |
| index.tsx | linkedResources 传参 + addFact/toggleResourceFlag/deleteLinkedResource/confirmLinkResource + link-resource modal 触发 | 调用侧 |
| Modals.tsx | ModalState 的 link-resource 分支 + LinkResourceModal + onConfirmLinkResource prop | 弹窗层 |
| 测试 | FactItem/LinkedResourceItem/ResourceHoverCard describe 块；tab 用例改 4-tab 期望 + 新增「resources tab 不存在」断言 | 同步退役 |

**保留不动**：API 层（`api.linkResource/flagResource/deleteLinkedResource`）——服务端工具（create_linked_resource 等）与中间栏时间轴数据源（getKeyResources → ChatView.linkedResources）仍消费；`activeLinkedRes` 数据流保留（ChatView 消费）。

## 排查记录

- 删除过程中手滑引入过两个自伤：① ModalsProps 误删重写造成 RestartModal 双实例渲染（双 fetch 抢状态，RestartModal 测试 4 例全挂）——定位 diff 后修；② ctxAction 函数体残留半截。两者均被测试当场抓住，全量回归后干净。
- guard-intercept-classify 全量跑偶发 1 例失败、单跑全过——已知 flaky（P1 期间同现象），非本 PR 域。

## 取舍与已知限制

- **⭐星标（userFlagged）UI 入口随 tab 消失**：字段与 API 保留，如未来需要可由时间轴卡补挂（P2 拍板时搭档已知晓此取舍）
- **手动添加产物走对话**：搭档侧要记事直接说（海獭 create_linked_resource），与「协作现场=对话+形态化产物」的世界观一致
- **清理性删除约 300 行**（组件+表单+弹窗+测试），右栏信息密度下降，符合「个体运行态」定位（F20260913ctlv）

## 后续

- P3 产物链视图（宪法「需要时再上」，当前缓行）
- 世界观 P0-P2 + 退役全部落地，协作现场形态闭环
