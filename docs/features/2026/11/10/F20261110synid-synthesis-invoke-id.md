---
id: F20261110synid
title: 合成影子通道补 invokeId（修叙事合成在 durable 上从未执行）
summary: "#1783 迁移后 runCompactionSynthesis 影子通道开会话不带 invokeId 且不在任何 invoke ALS 作用域内，被 prompt() 首行的轮归属守卫（Durable prompt requires currentInvokeId）当场拒绝——叙事合成在 durable 上从未成功过：上午被 R2 读取失败掩盖，#1814 修好读取器后暴露（15:08/15:46 两场水位交接 degradeReason=synthesis-error）。修复：合成会话自带 synthesis-<uuid> 合成 id（与真实 invoke 命名空间隔离）。"
change_type: bugfix
capability_test: "tests/frameworks/agent/synthesis-invoke-id.test.ts 2 例：守卫回归锁定（无 id 来源 prompt 被拒，守卫不可静默弱化）+ 修复回归（runCompactionSynthesis 完成出文）"
created_in_conversation: b4e05359-7a17-4478-8774-162360569279
causal_links:
  from: [F20261109pidrx, F20261110genrs, F20261110dursl]
  supersedes: []
tags: [session, durable, handoff, narrative-synthesis]
modules:
  - src/frameworks/agent/pi-session-factory.ts
---

# 合成影子通道补 invokeId（F20261110synid）

## 问题（M-9b24be04 晨检前哨战，生产 15:08/15:46 实证）

搭档 16:00 报告：有换世了但仍机械转储。取证：degradeReason 从「前世 session 文件
读取失败」（R2 域，#1814 已修）变为 `synthesis-error`，真实错误
`Durable prompt requires currentInvokeId`——合成影子通道 3ms 内被守卫拒绝。

## 根因

durable-session.prompt() 首行要求轮有主（watch/admission/settlement/usage 归属
边界）。影子通道（runCompactionSynthesis）的三个 id 来源全部为空：不在 invoke
ALS 作用域、开会话不传 invokeId、fresh register 无 currentInvokeId → 恒拒绝。
#1783 迁移把影子通道从 inMemory session 换成 durable session 时未适配该守卫——
叙事合成在 durable 上从未成功过（上午被读取失败掩盖，读取修好后暴露）。

## 修复

合成会话自带 `invokeId: synthesis-<uuid>`：满足轮归属守卫；与真实 invoke 命名
空间隔离（synthesis- 前缀），事件归因不串轮；影子通道无工具无 speak，合成 id
仅用于记账边界，无副作用面。

## 观察项（不属本 PR）

合成 prompt 量级：ea924fef 场景 725K chars（trim 后）——若合成模型窗口不足
（如 glm 200K）仍可能 synthesis-error。晨检 16:00 后首场换世若再报
synthesis-error，看 [compaction-synthesis] 日志的错误字段区分（no_model/429/
length）。预算按模型窗口收窄是后续项。

## 验收

2 例回归：守卫锁定（防静默弱化）+ 合成端到端出文（faux 真链路，含
registerModelSource 真模型目录注入）。
