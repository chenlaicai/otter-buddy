---
id: F20261109rtcnt
title: 海獭-基座 runtime 契约文档化（#1791 降级执行）
summary: '#1791「边界协议契约化」经需求分析后按降级口径执行：基座更换低频（搭档定调），双基座前提已消失（durable 是唯一执行 runtime），契约测试大头已在 #1783 修 bug 时自发落成——本特性只做剩余增量：docs/designs/runtime-contract.md 一页契约文档（三条边界约定 + 14 行能力对接清单 + 16 场景契约测试索引 + 已知债显式缓做记录），顺手修订两处过时「换 SDK 时需修订」注释。不做事件类型自有化（缓到 pi-coding-agent 退役）。'
change_type: feature
intent:
  problem: "#1791 原案「双基座契约测试+事件自有化」前提已消失，但 16 场景契约测试与能力清单散落在 PR 评论/测试文件，pi-durable 升级（Experimental API 无通知变更）时无对照清单"
  expected_effect: "单页 runtime 契约文档存在：升级时按 14 行能力表逐行核对 + 16 场景测试回归；两处「换 SDK 时需修订」过时注释替换为现状说明"
  verify_by:
    type: static_only
capability_test: 'n/a: 纯文档 + 注释修订，无行为变更（详见 Verification 节）'
created_in_conversation: b4e05359-7a17-4478-8774-162360569279
doc_type: feature
tags: [runtime-contract, pi-durable, documentation]
modules: [docs/designs, usecases/ports]
causal_links:
  - F20261109pidrx-pi-durable-runtime-migration.md
created_at: 2026-11-09
---

# 海獭-基座 runtime 契约文档化（#1791 降级执行）

## 背景与决策链

issue #1791 立项时设想三件套：AgentRuntimePort 显性化 + 双基座契约测试套件 + 三条契约条目。2026-11-09 搭档定调（原话）：「咱们不会天天改变底层的agent组件，这次从pi coding agent改为pi durable也是正好而已」——基座更换是低频事件，契约化价值须重估。

需求分析（本对话 2026-11-09）核账结论：

1. **双基座前提已消失**：迁移合入后 durable 是唯一执行 runtime（pi-session-factory.ts 注释明示），pi-coding-agent 仅剩工具性借用（ResourceLoader 只读 / ModelRuntime 注册表 / 类型 re-export）。「双基座跑同一套契约测试」的前提不复存在。
2. **契约测试大头已事实落成**：#1783 修 bug 过程中自发沉淀 16 个场景测试（durable-runtime.test.ts 14 + durable-create-persist.test.ts 2），含真实 SIGKILL 恢复、压缩/auto_retry 边沿感知、同事务落库、看门狗——issue 设想的「语义契约结晶成测试」已经存在，只是没挂契约之名。
3. **事件类型自有化细算不划算**：旧注释（2026-08）自认「换 SDK 时需修订」的债，已被 durable-event-stream 转换层结构性吸收（这次真换了 SDK 它没炸）。自有化 = 大范围改类型代码，治一行注释的债——缓到 pi-coding-agent 退役时顺手做。

搭档拍板（2026-11-09 14:31 原话）：「契约测试套件的思路很不错，确实没必要做到代码中，但测试代码中可以留存。你开工吧」——降级执行，测试留存在测试代码中，不做代码级抽象。

## 交付物

1. **docs/designs/runtime-contract.md**（新增）：一页 runtime 契约。定位 = pi-durable **升级**（Experimental，API 版本间无通知变更）时的对照清单。四节：
   - 边界约定三条（单主人归部署层 launchd，代码不做跨进程锁；基座事件只在 durable-event-stream 翻译，上层不直接 import 基座事件类型，状态类信号靠 pi.live 边沿检测；launchd 托管单进程不自启不拉起）
   - 14 行能力对接清单（底稿 = PR #1783 评论 6729856852 的对照表，修订第 6/12/14 行反映退役与现状）
   - 16 场景契约测试索引（语义 ↔ 测试场景 ↔ 能力行三列映射）
   - 已知债显式缓做记录（AgentSessionEvent 自有化 + pi-coding-agent 当前角色说明）
2. **两处过时注释修订**：
   - `src/usecases/ports/sdk-invoke-port.ts`：「⚠️ 换 SDK 时需修订」→ 指向 runtime-contract.md 的现状说明（SDK 已换，转换层已吸收，自有化缓做）
   - `src/usecases/ports/agent-tools.ts`：同款「换 SDK 时需修订本 port」→ 工厂侧适配已落、边界见契约文档

## 非目标

- 不做 AgentRuntimePort 接口显性化（前提消失：无第二执行基座）
- 不做事件类型自有化（缓到 pi-coding-agent 退役；见 runtime-contract.md 第四节）
- 不迁移/重命名现有契约测试（它们已在正确位置，文档只做索引）
- 不动 deploy/launchd/（单实例门闩模板已就位）

## 设计取舍

- **文档落点选 docs/designs/ 而非 docs/features/**：这是活文档（随升级维护的对照清单），不是单次特性的档案。designs 目录已有同类先例（bash-guard-constitution.md 等）。
- **capability_test 标 n/a**：纯文档 + 注释修订，无行为变更；16 场景契约测试是本文档**索引**的对象（它们自身的验证记录在 F20261109pidrx），不是本特性新增的验证。
- **issue #1791 收窄口径更新**（评论形式）：三件套按「已完成/收进文档/缓做」三项归位，issue 关闭。

## 验证

### 验证方式

- 纯文档交付，验证 = 事实核对：文档中每条断言对照源码/PR 评论核实（能力表 14 行逐行核对承载文件存在、16 场景测试名逐个对照测试文件、三条边界的定调出处见 F20261109pidrx）。
- 注释修订经 tsc 编译验证（仅注释改动，无行为变更）。

### 自检

- [x] 契约测试索引与实际测试一一对应（16 场景，两文件）
- [x] 能力表 14 行承载文件全部存在
- [x] 已知债写明缓做条件与触发时机（pi-coding-agent 退役）
- [x] 两处注释修订不改变任何类型/行为（纯注释）

## 影响范围与风险

- 影响面：docs/ 一份新文档 + 两处注释。零行为变更，零运行时风险。
- 风险：文档腐化（pi-durable 升级后忘记更新清单）——缓解：契约测试是机器守卫，文档是人的对照清单，测试红 = 文档该更新；升级 SOP 属后续（不在本特性）。

## 后续

- issue #1791 按收窄口径关闭（本 PR 附评论）
- pi-coding-agent 退役时：14 处旧 SDK import 收编 + AgentSessionEvent 自有化（触发条件已写进 runtime-contract.md 第四节）

---
