---
id: F20261019fito
title: guard-intercept-classify 测试 flaky 根治——动态 import 首载成本移出用例计时窗（超时型偶发失败，非测试隔离互扰）
summary: 检视獭-guard 第三轮 delta 复核发现 guard-intercept-classify.test.ts > buildGuardInterceptContext > 基础字段 偶发失败（全量并发首跑挂、复跑绿、单跑绿）。排查（含预注册）排除 mock 泄漏与共享状态互扰，复现实证为**超时型 flaky**：用例内动态 await import("pi-session-factory") 的模块图首载（数十依赖 + vitest TS transform，负载高时 >5s）恰好顶满 vitest 默认 testTimeout=5000ms，首个用例独扛加载成本故恒为受害者。修复：4 处动态 import 收敛为文件顶层静态 import，加载成本移出用例计时窗，断言零变化。
change_type: fix
created_in_conversation: 9993f9b1-bea7-41b6-9313-bc33ba23f77e
created_at: 2026-10-19
tags: [tests, flaky, vitest, guard-intercept]
modules: [tests/frameworks/agent]
---

## 预注册（排查前冻结，防 HARKing）

- **预期根因方向**：vitest 跨文件并发下模块级共享状态互扰（mock 泄漏/共享注册表），单跑稳定、并发偶红
- **验证标准**：定位到共享状态点（file:line），且隔离跑全绿 + 与嫌疑文件并发跑可复现
- **放弃条件**：若共享状态不存在且两两并发无法复现，转向资源竞争/时序方向（临时目录、时钟、异步残留、超时）

**预期 vs 实际对照**（如实记录方向改变）：
- 「共享状态互扰」→ **偏离**：grep 实证无任何测试 mock pi-session-factory / quoted-text-sanitizer / guard-intercept-classify（mock 泄漏排除）；vitest.config.ts 极简默认（文件隔离，跨文件模块缓存不共享）
- 验证标准「并发可复现」→ **偏离**：单跑亦可复现（与并发无关，与负载/缓存冷热有关）
- **放弃条件触发 → 转向资源竞争分支 → 命中「超时」**：verbose 实测抓到 `× 基础字段 5015ms`（= testTimeout 5000ms 上限，非断言失败）

## 问题现象

- 用例：`tests/frameworks/agent/guard-intercept-classify.test.ts > buildGuardInterceptContext > 基础字段：ruleId/ruleLayer/commandHead/hasWorktreePath 齐全`
- 症状：全量并发首跑偶发 1 failed，复跑绿，单跑 ×3 绿（检视獭-guard 2026-10-19 记录）；本排查单跑复现 1 次（5015ms 超时）
- 恒定性：4 个 buildGuardInterceptContext 用例里**只有「基础字段」挂**——它是第一个执行动态 import 的用例

## 根因分析

`tests/frameworks/agent/guard-intercept-classify.test.ts`（修复前 129/136/142/153 行）：

```ts
const { buildGuardInterceptContext } = await import("@frameworks/agent/pi-session-factory");
```

1. `pi-session-factory` 是巨型模块：`src/frameworks/agent/pi-session-factory.ts:22-52` 顶部 import 链拖起 config、tool-manifest-loader、narrative-synthesis-engine、agent-session-store、session-helpers 等数十个依赖，vitest 首次加载还需 TS transform
2. **首载成本被 4 个用例里的第一个（「基础字段」）独扛**：后 3 个用例走 import 缓存（0-1ms）。verbose 实测：基础字段 5015ms（超时被杀）、hasWorktreePath 673ms（加载竞速余波）、其余 1ms 级
3. 首载成本 ~5s 恰好顶满 vitest 默认 `testTimeout=5000ms`——缓存热/机器闲 → 3s 内跑完=绿；缓存冷（CI 首跑）/机器负载高 → 顶过 5s=挂。**偶发性 = 负载抽奖**，与测试隔离无关

被测函数本身无辜：`buildGuardInterceptContext`（src/frameworks/agent/pi-session-factory.ts:44-60）是纯函数（classifyGuardInterceptReason 查静态 FINGERPRINTS 表 + sanitizeQuotedText 纯文本变换），无共享可变状态。

## 修复（修法决策树①，Modification-Class: narrow-fix）

- 文件顶层静态 import `buildGuardInterceptContext`（与既有 checkBashCommandSafety 静态 import 同款），删除 4 处用例内 `await import`
- it 的 async 修饰保留不动、**断言零变化**——最小 diff（-4 行 +5 行含注释）
- 加载成本移出所有用例计时窗（模块求值发生在文件加载期，vitest 不计入 testTimeout）

**机制识别检查点**：未命中任何净新增机制项（纯测试代码结构调整，无新配置/状态/定时/信号/存储/决策分支/跨模块路径）→ 走走①②③即可，无需四问。

## Verification（bugfix 前后对照硬规则）

**修复前失败输出**（2026-10-19 复现实证）：
```
× tests/frameworks/agent/guard-intercept-classify.test.ts > buildGuardInterceptContext · 落账字段组装 > 基础字段：ruleId/ruleLayer/commandHead/hasWorktreePath 齐全 5015ms
```
（5015ms = vitest testTimeout 5000ms 超时上限）

**修复后通过输出**：
```
单文件 ×3 连跑：Test Files 1 passed (1) / Tests 29 passed (29)（三轮均全绿）
全量子集：Test Files 64 passed (64) / Tests 1745 passed | 6 skipped (1751)（0 failed）
```
（64 文件跑面 = 检视獭当时 flaky 的同一跑面）

## 影响范围

- 仅测试文件 1 个（guard-intercept-classify.test.ts），生产代码零改动
- 消除 CI 偶发假红（此前冷跑高发）；对测试语义零影响（断言未动）
- 同型风险排查建议（不在本 PR 范围）：其他测试文件内 `await import` 重型模块的用例同款隐患——留观即可，无须预防性改造

## 留痕

- matter：M-db8181b9（flaky 排查待办）→ 修复合入后闭环
- 排查由搭档 2026-10-19 指令触发（「把这个flaky测试用例分析下吧，看看是啥情况」）
