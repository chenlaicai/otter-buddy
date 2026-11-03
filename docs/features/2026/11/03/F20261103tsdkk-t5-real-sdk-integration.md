---
id: F20261103tsdkk
title: T5 生效断言集成测试：真实 SDK execute + [cwd:] 前缀注入（#1222）
change_type: fix
status: implemented
created: 2026-11-03
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - tests/frameworks/agent/cwd-prefix-real-sdk.test.ts
summary: "#1222：T5 生效断言补位——现有测试全 mock，SDK 双签名漂移静默退化无防护。新增 4 用例集成测试：真实 createBashToolDefinition execute（真实 spawn/shell/输出累积，仅 sessionManager 身份 stub）+ wrap，断言 [cwd:] 前缀三路径（成功含 ctx.cwd 优先/fallback/失败 isError:true）+ SDK 结构防护锚。开发中真实 SDK 抓到两个 mock 测不出的调用面事实：ctx 需 sessionManager.getSessionId（resolveSpawnContext 暴露 PI_* 用）+ cwd 目录须真实存在（fsAccess 校验）且首参即 cwd——集成测试价值实证。全量 5667 零回归。"
tags: [testing, integration, sdk-drift, cwd-awareness]
intent:
  problem: "cwd 感知对齐（[cwd:] 前缀）的全部测试走 mock——SDK 升级若改 execute 签名/返回结构，防护静默退化无人察觉"
  expected_effect: "SDK 双签名漂移在 CI 第一时间红（结构锚先红点+行为断言三路径）；cwd 前缀注入的生效断言固化"
  verify_by:
    type: capability_test
capability_test: "tests/frameworks/agent/cwd-prefix-real-sdk.test.ts"
---

# T5 生效断言集成测试（#1222）

## 问题

F20260922scwd（cwd 感知对齐）的 wrapBashWithCwdPrefix 无任何测试直接消费（现有 session-cwd-resolver.test.ts 测的是 resolver）；当时 mimo 探针补验过 5 路径全过但无固化。SDK 双签名漂移（harness vs unbundled dist）风险敞口。

## 方案

4 用例集成测试（真实 SDK，mock 点仅 sessionManager 身份——bash 执行本身全真）：

1. **成功路径 + ctx.cwd 优先**：ctx.cwd 与 wrap cwd **差异化取值**（不同目录），断言前缀取 ctx 值——取值来源可区分，`ctx?.cwd || cwd` 的优先语义有判别力
2. **fallback**：ctx **不带** cwd（仅 sessionManager）→ 取值走 fallback 分支，断言前缀取 wrap-time cwd
3. **失败路径**：完整 ctx + `false`（必然 exit 1）→ 当前 SDK（pi 1.x）resolve `isError:true` 结构化结果——resolve 分支显式断言 `isError===true`（语义漂移即红）+ text 前缀；catch 分支锁定「任意 throw 形态」下 message 前缀注入
4. **结构防护锚**：createBashToolDefinition 返回面（name/description/execute）——签名漂移的先红点

### 防护强度的两层声明（声明面 = 断言面）

- **SDK 工厂同源**：`createBashToolDefinition` 与生产 bash 工具同工厂——生产装配走 createAgentSession → SDK `createAllToolDefinitions(cwd)`（agent-session@1.1.0 内部调用本工厂）。SDK execute 签名/返回面漂移在此先红是真的。
- **wrapper 为休眠工具**：`wrapBashWithCwdPrefix` 自 F20261014cwsp（删 override 链）起无生产调用方。本测试固化其行为契约以备复用——[cwd:] 前缀行为本身不是当前生产路径（issue #1222 行动原文授权该范围）。

## 开发中发现（集成测试价值实证）

真实 SDK 立刻抓到两个 mock 测不出的调用面事实：
1. `ctx.sessionManager.getSessionId()` 必需——resolveSpawnContext 暴露 PI_* 环境变量时调用（ctx 只传 cwd 会在命令 spawn 前 TypeError）
2. cwd 目录必须真实存在（exec 内 fsAccess 校验）且 `createBashToolDefinition(cwd)` 首参即 cwd（缺省 undefined → spawn 失败）

这两点说明：ExtensionContext 若结构不完整（缺 sessionManager）会直接炸——测试内手造 ctx 以完整形态传入，正是真实调用面的同款约束。

## 验证

> 豁免记录（bugfix Verification 硬规则）：本 PR 为测试补位（#1222 立项时的缺口是「无测试」而非行为缺陷），无修复前失败态可证，失败用例证据子块不适用。另注：`change_type: tests` 不在 KNOWN_CHANGE_TYPES 枚举（known-values.ts），选它会新增 lint 警告撞破 ratchet 上限——故取 fix + 豁免行路径。

- [x] 4 用例全绿（真实 spawn；mkdtempSync 唯一目录生命周期 beforeAll + afterAll，同机并行无碰撞）
- [x] 判别力反事实实证（防假绿，#1749 教训）：fallback 改 `/WRONG` → 仅 tc-2 红；ctx.cwd 优先分支由差异化值锁定（tc-1 断言 `not.toContain` wrap cwd）；`false`/`true` 探针对照 → `isError:true` vs `undefined`，isError 断言有判别力
- [x] 全量 429 文件 5667 测试零回归；tsc 0；eslint 0
- [x] CI：见 checks（ubuntu runner 真实 bash 环境复验）

## 影响

- SDK 升级漂移防护从「无」到「CI 先红」
- 验证断言（issue 契约：vitest 覆盖真实 execute 路径非 mock，到期 2026-11-29）提前 26 天达成
