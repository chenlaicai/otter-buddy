---
id: F20261019cgwd
title: cursor-guard lint 噪声归零——console.warn 补 disable 注释对齐项目豁免惯例
summary: 修复 issue #1537：conversation-repository-mixins.ts:210 的 cursor-guard 单调性拦截 console.warn 是全仓 src/ 下唯一无豁免的 console.*（其余 18 处均带 disable 注释），每轮 CI lint 落 warning annotation 挂所有 PR。排查判定该 warn 属异常分支防御日志（仅真拦截时触发，F20261014czgd 注明「零日志曾致同类事故全靠推断定位」），不可删；归口 logger 需为仓储模块级函数开注入通道属过度工程。修法 = 补 `eslint-disable-next-line no-console` 注释（同 schema.ts:220 sqlite-vec 先例），CI annotation 归零。
change_type: fix
capability_test: "npx eslint src 全量 0 warning（修前 1 warning: no-console @ conversation-repository-mixins.ts:210）；vitest run 396 文件 6199 passed 全绿（含 cursor-zero-guard 7 用例）；npm run check（build+lint+schema+smoke:boot+arg-parse）全过"
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
created_at: 2026-10-19
tags: [bugfix, ci, lint, db, logging]
modules:
  - src/frameworks/db/conversation/conversation-repository-mixins.ts
causal_links:
  - F20261014czgd（噪声来源——cursor-guard 单调性闸引入的拦截日志，其事故溯源价值判定「不可删」的依据）
---

# F20261019cgwd: cursor-guard lint 噪声归零

## 问题（issue #1537）

`src/frameworks/db/conversation/conversation-repository-mixins.ts:210` 的 `console.warn`（cursor-guard 单调性拦截日志，F20261014czgd / PR #1476 引入）每轮 CI check / golden-selftest 落一条 lint warning annotation，挂**所有 PR** 的检查输出，干扰审视者判断新告警（边界獭 2026-10-16 实测报告）。

## 排查结论

### 1. 项目日志纪律：双轨制 + disable 注释豁免惯例

- 架构层有统一日志设施：`src/usecases/ports/logger.ts`（接口）+ `src/frameworks/logger.ts`（PinoLogger 实现，DIP 注入式）。**但仓储层（db/）是模块级导出函数，无 logger 注入通道**。
- ESLint `src/**/*.ts` 全局 `no-console: "warn"`（eslint.config.mjs）；scripts/、web/、web-mahjong/ 分块豁免。
- 全仓 src/ 共 19 处 console.*：修前 18 处均带 `// eslint-disable-next-line no-console -- 理由` 注释，**本案是唯一漏网**——这就是「只有它落 annotation」的根因。同目录先例：`schema.ts:220`（`-- schema 初始化不能依赖 frameworks/logger`）。

### 2. 触发条件判定：异常分支防御日志，非运行时噪声

该 warn 位于 `updateLastReadSeq` 单调性闸的拒绝分支内：仅当 `changes=0` 且回查确认「现值 ≥ 写入值」（真拦截）时输出。正常运行零输出——它不是「每轮都打印」的运行时噪声，而是「每轮都被 lint 静态扫描标红」的 annotation 噪声。F20261014czgd 注释明写「零日志曾致同类事故全靠推断定位」，10-13 三起游标归零爆窗的排查成本是它的存在依据。**结论：不可删。**

## 方案选择

| 方案 | 判定 | 理由 |
|---|---|---|
| ✅ 补 disable 注释 + 理由 | 采纳 | 与全仓 18 处既有惯例一致（尤其同目录 schema.ts 先例）；零侵入；理由留痕说明为何不能用 logger |
| 归口 PinoLogger | 否决 | 仓储模块级函数需改签名注入 logger，侵入所有调用点；schema.ts 先例已确立「db 层初始化/兜底日志不依赖 frameworks/logger」边界 |
| 降 debug 级 | 否决 | 项目无 debug 开关机制；且不解决 lint 静态告警本身 |
| 删除日志 | 否决 | 违背 F20261014czgd 的事故溯源教训（零日志曾致全靠推断定位） |

## 改动

净 +1 行注释（disable 行，含理由）：

```ts
// eslint-disable-next-line no-console -- 仓储层模块级函数无 logger 注入通道（同 schema.ts sqlite-vec 先例）；防御日志有事故溯源价值（F20261014czgd：零日志曾致同类事故全靠推断定位），不能删
```

## 测试证据

- `npx eslint src/frameworks/db/conversation/conversation-repository-mixins.ts` → 0 problem
- `npx eslint src` 全量 → 0 problem（修前 1 warning）
- `npx vitest run` → 396 文件 / 6199 passed + 6 既有 skip，全绿
- `npm run check`（CI 同款：build + lint + lint:schema + smoke:boot + test:script-arg-parse）→ 全过
- web 不在改动面（改动仅 src/ 一行注释），未涉 web 编译

closes #1537

---
🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 日志归口獭
