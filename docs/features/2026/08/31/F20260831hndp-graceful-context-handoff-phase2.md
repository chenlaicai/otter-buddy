---
id: F20260831hndp
title: "优雅上下文交接 Phase 2：LLM 叙事合成 + 手动/熔断统一四件套"
summary: |
  Phase 1 交付了触发链路 + 机械四件套（PR #461，F20260825hndf）。Phase 2 将件①摘要从机械转储
  升级为 LLM 叙事合成（readOnly invocation + kimi 六分区模板），并将件②③④注入扩展到手动重启
  和熔断重启路径。摘要合成失败时降级为机械转储，永不阻塞 restart。
change_type: feature
status: active
capability_test: "n/a: LLM叙事合成链路改动，测试覆盖见 tests/frameworks/agent/synthesis-prompt-builder.test.ts + handoff-package-synthesis.test.ts + agent-invoker-handoff.test.ts"
created_in_conversation: 9d326c9d-9818-40a2-9982-898315fe7aa4
from: F20260825hndf
---
# F20260831hndp 优雅上下文交接 Phase 2

> 状态：实现完成，待审视
> 作者：mimo2（实现）
> 日期：2026-08-31
> 前置：F20260825hndf Phase 1（PR #461 已合入）

---

## 0. 摘要

Phase 1 交付了 70% token 阈值触发 + 机械四件套（摘要/文件轨迹/近期原文/活状态盘点），
但件①摘要只是机械转储（均值 250 字符），叙事信息全靠件②③④撑着。

Phase 2 做两件事：
1. **件①升级**：LLM 叙事合成（readOnly invocation + kimi 六分区模板），机械转储降级为防线②
2. **三条路径统一**：手动重启和熔断重启也带上件②③④

## 1. LLM 叙事合成（防线①）

### 1.1 架构

```
handleHandoff
  ├── collectStateInventory (件④机械数据)
  ├── buildSynthesisPrompt (六分区模板 + 件④注入)
  ├── buildSynthesisFunction → sdkInvoke.invoke(readOnly: true)
  │   └── prompt 约束 + 工具白名单（只保留 read 工具）
  ├── [成功] → summary = LLM 输出
  └── [失败/超时/空] → summary = buildMechanicalDump (防线②)
```

### 1.2 关键设计决策

- **readOnly 模式**：Pi SDK 无原生 read-only 支持，靠 prompt 约束 + 工具白名单（只保留 read）实现
- **件④注入合成 prompt**：§⑤ 协作状态不许 LLM 回忆，先跑 collectStateInventory 注入机械数据
- **超时预算 60s**：超时走防线②机械转储，永不阻塞 restart
- **降级链**：合成失败/超时/空 → 机械转储 → 空 summary 硬重启（防线③，复用 Phase 1）

### 1.3 kimi 六分区模板

①下一步 ②当前任务与完成标准 ③关键决策与理由含已排除路径 ④产物与锚点 ⑤协作状态 ⑥搭档上下文 ⑦交接谱系

## 2. 手动/熔断重启统一四件套

### 2.1 三条路径对比

| 路径 | 件①摘要来源 | 件②③④ | readOnly |
|------|------------|--------|----------|
| 自动交接（70%） | LLM 叙事合成 | ✅ | ✅ |
| 手动重启 | 獭自己写的叙事 | ✅ | N/A |
| 熔断重启 | 机械转储 | ✅ | ❌ |

### 2.2 熔断路径特殊处理

- **绝不走 LLM 合成**：已陷复读的 session 不做优雅交接（F20260824srst 教训）
- **四件套注入失败不影响熔断重启**：非致命，catch 后继续
- **D8 补偿删除**：restart 失败时清理已写入的 context，防幽灵上下文泄漏

## 3. 代码变更清单

| 文件 | 变更 | 内容 |
|------|------|------|
| `synthesis-prompt-builder.ts` | 新增 | LLM 合成 prompt 构建器（六分区模板 + 件④注入） |
| `handoff-package-builder.ts` | 修改 | 支持 SynthesisFunction 参数，防线①→②降级链 |
| `agent-invoker.ts` | 修改 | buildSynthesisFunction + 熔断/手动路径四件套注入 |
| `sdk-invoke-port.ts` | 修改 | InvokeOptions.readOnly 新增 |
| `pi-session-factory.ts` | 修改 | readOnly 模式工具过滤（只保留 read） |

## 4. 测试

| 测试文件 | 覆盖内容 |
|----------|---------|
| `synthesis-prompt-builder.test.ts` | 六分区模板生成、件④注入、降级摘要构建 |
| `handoff-package-synthesis.test.ts` | 防线①成功、防线②降级（空/异常/超时）、无 synthesize |
| `agent-invoker-handoff.test.ts` | Phase 2 扩展：readOnly invoke、四件套注入、触发链路 |

## 5. 质量门

- tsc: 0 errors ✅
- eslint: 0 errors ✅
- vitest: 2320 tests pass ✅

## 6. 试点数据输入

Phase 1 试点（99 次自动交接）的关键发现：
- 机械摘要均值 250 字符 → Phase 2 LLM 合成直接解决
- 包中位 3k tokens → 远低于 10.7k 预算，叙事摘要放得下
- 70% 阈值无病理性触发 → 不动
- Pi compaction 从未被触发 → 分层设计生效

## 7. 与 Phase 1 的关系

Phase 1 的机械四件套代码保留为防线②。Phase 2 在其上叠加 LLM 合成层，
不改变触发链路、不改变借用式消费模式、不改变70%阈值。
