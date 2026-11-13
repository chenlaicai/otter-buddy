---
id: F20261113wxplo
title: 微信搭档锚遗留三修：去首号兜底错认、拆 forGate/forIdentity、称呼控制字符 sanitize
doc_type: feature
change_type: fix
summary: "#1188（F20260928wxid 三条遗留）收口：①ensureWeixinConfig 停止把首个扫码人 ilinkUserId 回写为全局 partnerUserId——多账号时「第一个扫码的人」会被持久化成搭档、重启后锁死其他线主人命令；门禁锚改为显式 partnerUserId 优先、否则回退线 owner（每线主人自管自线）。②PartnerResolver 构造器私有，拆 forGate（单渠道锚/门禁语义）/ forIdentity（多渠道/身份标注语义）双入口，误用编译期可查。③parseUserName strip 换行与控制字符，防污染注入历史行结构。"
intent:
  problem: "F20260928wxid 落档的三条 tech-debt 长期悬置：多账号 partnerUserId 兜底错认（中优先级）、PartnerResolver 门禁/身份语义仅靠注释维护、称呼含换行污染注入层。"
  why_now: "搭档指示按时间从古到今逐个处理 open issue，#1188 为第 4 件；三条均为既有语义内窄修，可同 PR 一并收口。"
  expected_effect: "多账号下首号不再被误认成搭档；命令门禁锚每线独立（显式配置优先，否则线 owner）；PartnerResolver 误用（跨渠道 ID 塞进门禁）编译期可查；称呼换行被 strip。"
  verify_by:
    type: capability_test
    note: "更新 weixin-cold-start.test.ts（partnerUserId 不回写）+ partner-resolver.test.ts（forGate/forIdentity 语义）；全量 vitest + tsc 覆盖。"
capability_test: "tests/bootstrap/weixin-cold-start.test.ts + tests/usecases/im/partner-resolver.test.ts"
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [weixin, partner-resolver, identity, gate, tech-debt]
modules:
  - src/usecases/im/partner-resolver.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
  - src/interface-adapters/http/controllers/weixin-connection-controller.ts
  - tests/bootstrap/weixin-cold-start.test.ts
  - tests/usecases/im/partner-resolver.test.ts
causal_links:
  - F20260928wxid
---

# F20261113wxplo: 微信搭档锚遗留三修

## 背景

#1188 落档 F20260928wxid 三条遗留（对抗审视 round 1 建议 4 + delta 观察项 + 多账号兜底错认），长期悬置。本次按时间序处理 open issue 时一并收口。

## 修复项

### ① 多账号 partnerUserId 兜底错认

**根因**：`ensureWeixinConfig` 把首个扫码人 `ilinkUserId` 回写为 config 的 `weixin.partnerUserId`（全局持久化）。重启后：

- 渲染链全局 resolver 读该值，把「第一个扫码的人」标注为搭档；
- 所有微信线的命令门禁都锚定首号，其他线主人的命令被当成陌生人拦截。

**修复**：

- `ensureWeixinConfig` 只回写 `stateDir`，不回写 `partnerUserId`（签名去掉 ilinkUserId 参数）。
- 门禁锚（`startWeixinAccount` 装配处）：`PartnerResolver.forGate(weixinConfig.partnerUserId ?? account.ilinkUserId)`——显式配置优先，否则回退线 owner（每线主人自管自线，多账号不串）。
- 渲染链全局 resolver 保持 `forIdentity(undefined, config.weixin?.partnerUserId)`，只认显式配置，不再吃首号兜底。

### ② PartnerResolver 拆 forGate / forIdentity

构造器改 private，新增双静态入口：

- `forGate(...ids)`：单渠道锚，门禁语义（「配置了本渠道搭档锚才拦截」）。
- `forIdentity(...ids)`：多渠道，身份标注语义（飞书 open_id + 微信 ilink_user_id 同一人）。

调用方全部迁移（platforms.ts 三处 + app.ts 一处 + 测试四处）。误用（把跨渠道 ID 塞进门禁）现在编译期可查。

### ③ parseUserName sanitize

`parseUserName` trim 后 strip 控制字符（`\u0000-\u001f`、`\u007f`），防称呼含换行污染注入历史行结构。

## 验证

- `tests/bootstrap/weixin-cold-start.test.ts`：ensureWeixinConfig 三例更新（partnerUserId 不回写）。
- `tests/usecases/im/partner-resolver.test.ts`：迁移 forGate/forIdentity + 新增单渠道锚跨渠道不命中例。
- 全量 vitest + tsc 待 CI。