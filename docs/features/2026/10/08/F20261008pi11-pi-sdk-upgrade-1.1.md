---
id: F20261008pi11
title: pi SDK 升级 0.86.0 → 1.1.0（依赖升级 + 两处行为适配）
change_type: feature-update
capability_test: "n/a: 依赖升级，验证面 = tsc 0 error + 322 文件 4893 测试全绿 + 导出/运行时探针（见「验证矩阵」节）"
status: implemented
created_at: 2026-10-08
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  - F20260904cg77
  - F20260922scwd
summary: 依赖从 ^0.86.0 升到 ^1.1.0（pi-coding-agent + pi-ai 双包），适配两处 1.x 行为变化：steer 返回类型收紧、bash 工具失败语义从 throw 改 resolve isError
intent:
  problem: "pi 上游 9/19 后两周发 13 版冲到 1.1.0（codemode 革命 + 堆内存 -80% + server_busy 重试），我们锁 0.86.0 落后，内存/重试/成本修复收益全吃不到"
  expected_effect: "升级后拿到 1.x 主力收益（transcript 堆内存 -80%、server_busy 重试、session 丢失修复、长 prompt 计费修正），SDK 消费面 100% 兼容"
---

# F20261008pi11 pi SDK 升级 0.86.0 → 1.1.0

## 背景

- 上游 `earendil-works/pi` 9/29 连发 0.99.x RC，10/1 正式 1.0.0，10/7 晚发 1.1.0——12 天 13 版
- 1.0 主线是 codemode（模型写 JS 编排工具，prompt -40%）+ tool_search 按需声明工具；1.1 主线是可观测性（agent_settled 加 aborted 字段、durationMs 进事件流）
- 发版洞察报告：工作区 `pi-agent-release-insight-2026-10.md`（时间线/主题/影响分析全文）
- 搭档 2026-10-08 拍板「做升级，基于真实能力适配新版本」

## 变更清单

### 1. 依赖升级
- `package.json`：`@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 从 `^0.86.0` → `^1.1.0`
- lockfile 同步（pi-coding-agent 1.1.0、pi-ai 1.1.0、pi-telemetry ^1.1.0 新增传递依赖）

### 2. steer 返回类型适配（src/frameworks/agent/pi-session-factory.ts）
- pi 1.x：`steer()/followUp()` 返回 `Promise<QueuedInputDisposition>`（`"handled" | "queued"`，未从包根导出）
- 0.x 期望 `Promise<void>`
- 修法：`activeSessions` map 值类型从 `(text: string) => Promise<void>` 放宽为 `Promise<unknown>`——消费端 `steerSession` 只 `.catch()` 不读 resolve 值，结构兼容且免硬编码 SDK 内部联合类型

### 3. bash 工具失败语义适配（src/frameworks/agent/cwd-awareness.ts + 测试）
- pi 1.x：命令失败（exit 42）从 `throw Error` 改为 resolve `{ isError: true, content: [...] }` 结构化结果（command_response 语义：结果就是给模型看的，不再 throw）
- 影响：cwd-awareness 包装器的「错误路径注入 [cwd:] 前缀」逻辑失效——catch 分支不再走到
- 修法：resolve 结果若 `isError`，同样在 `content[0].text` 注入前缀——「失败命令在哪跑的」感知不丢
- 测试同步更新：`tool-description-overrides.test.ts` 断言从 `rejects.toThrow` 改为 resolve `isError:true` + 前缀匹配

## 排除的疑点（升级中核实）

| 疑点 | 结论 | 证据 |
|---|---|---|
| `createAgentSession` 返回 Promise | 非回归——我们本就 `await` 解构 `{session}`，tsc 0 error 佐证 | probe-shape.mjs 探针 |
| `setThinkingLevel('high')` 后仍 off | 非回归——0.86.0 基线同行为（haiku 模型 thinking 支持面） | 双版本对照探针 |
| `estimateTokens` 口径漂移 | 无漂移——4 组样本（中/英/混合/assistant）delta 全 0 | /tmp 双版本对照探针 |
| Azure provider 改名（1.0.3 breaking） | 无影响——我们不消费 azure provider | release notes |
| fullscreen 默认开启（1.0.0） | 无影响——headless SDK 用法 | release notes |

## 验证矩阵

| 项 | 结果 |
|---|---|
| tsc --noEmit | 0 error |
| vitest 全量 | 322 文件 / 4893 tests 全绿 |
| lint | 通过 |
| build | dist/src/main.js 产出 |
| 14 个值导出探针 | 全部存在且为 function |
| AgentSession 构造 smoke | prompt/steer/abort/dispose/subscribe/setModel 方法面完好 |
| estimateTokens 双版本对照 | 4 样本 delta=0 |

## 设计取舍

- **锁 ^1.1.0 而非报告建议的 1.0.4**：搭档要求「适配新版本」；1.1.0 拿满 aborted/durationMs 观测能力。`^1.0.4` 会因 semver 漂移到 1.1.0（实测装到的就是 1.1.0），与其被动漂移不如显式声明。发布 1 天的抖动风险由 PR 审视 + 测试全绿兜底
- **steer 类型放宽为 Promise<unknown> 而非引入 SDK 联合类型**：QueuedInputDisposition 未从包根导出，硬编码字符串联合类型会引入对 SDK 内部类型的脆弱耦合；消费端不读值，unknown 结构兼容即可
- **bash isError 路径保留前缀注入**：失败命令的 cwd 感知与成功命令同等重要（F20260922scwd 的核心动机——失败命令更需要知道在哪跑的）

## 后续（非本次范围）

- 1.x 的 codemode / tool_search / MCP 内置等 CLI 侧能力与 SDK 消费面正交，暂无接入计划
- `agent_settled` 的 `aborted` 字段、`durationMs` 事件：我们的 sdk-invoke-port 走 prompt 返回值而非事件订阅，接入需改事件监听架构，留待观测器需要时
- pi-telemetry 新传递依赖的允许脚本审批（npm approve-scripts）在部署侧处理
