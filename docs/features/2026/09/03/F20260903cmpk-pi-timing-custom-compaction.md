---
id: F20260903cmpk
title: 上下文管理架构统一——Pi 时机 + 自定义七段压缩算法（session_before_compact 钩子）
summary: 以 Pi 的 session_before_compact 钩子替换压缩算法实现（时机归 Pi、算法归咱们），70% Pre-invoke 自动 handoff 链路退役（手动/熔断重启路径保留）。推翻 F20260825hndf 双机制并存设计，修复其"Pi 压缩不可干预"的过时前提。
change_type: feature
created_in_conversation: 9d326c9d-9818-40a2-9982-898315fe7aa4
capability_test: "tests/capability/compaction-hook.capability.test.ts"
intent:
  problem: "双机制并存（70% handoff + Pi compaction）存在竞争窗口：轮内暴涨时 Pi 的 87% 通用算法抢跑，摘要质量降级；且「Pi 压缩不可干预」的设计前提已被 SDK 钩子证伪"
from:
  - F20260825hndf
  - F20260903lngth
supersedes:
  - F20260825hndf
---

# 上下文管理架构统一：Pi 时机 + 自定义算法

## 决策背景

搭档同事问及 Pi compaction 保存点算法引发的本日讨论链：源码拆解 → 借鉴清单（F20260903lngth 只取了 length-stop 一条）→ 搭档连环追问「轮内暴涨场景谁先压」「为什么不能覆盖 Pi 的压缩」「70% handoff 是否还有必要存在」。

**被推翻的前提**：F20260825hndf 设计文档（及更早 F20260716zq9q）记载「Pi Compaction 触发方为 Pi 内部机制，应用层无法干预」——经 SDK 源码核查（本日），该判断过时：

- `createAgentSession` 接受注入 `settingsManager`（我们已在传，pi-session-factory.ts:589）
- `SettingsManager.setCompactionEnabled(false)` 可整体关闭自动压缩（settings-manager.d.ts:220）
- **`session_before_compact` 扩展钩子**：Pi 每次压缩前 emit，handler 可返回 `{ cancel }` 或 **`{ compaction: 自定义压缩结果 }`**——Pi 官方留给宿主替换压缩算法的口子（extensions/types.d.ts:443-453, 857-860）
- 注册路径：`DefaultResourceLoader` 的 `extensionFactories?: InlineExtension[]`（resource-loader.d.ts:76），我们已持有 resourceLoader

## 统一后的架构

```
上下文管理（唯一机制）：
  时机 = Pi 的 threshold/overflow 检查（每次 LLM 响应前，比轮边界更密）
  算法 = session_before_compact 钩子 → 七段叙事合成（复用 buildSynthesisPrompt + synthesize）
         + 四件套机械数据拼入 + 谱系追加 → 返回自定义 CompactionResult
  降级 = 合成失败/超时 → 返回 undefined → Pi 默认算法兜底（不断链）
  length-stop = #767 防护语义保留（截断摘要拒绝落盘）

handoff 退役范围：
  ✂️ 70% Pre-invoke 检查（HANDOFF_THRESHOLD / shouldTriggerHandoff / recordPostTurnTokens 触发链）
  ✅ 保留：手动重启 / 熔断重启的「重启獭生」路径（异常恢复语义，与压缩无关）
  🔁 复用：四件套 builder、合成函数、metrics 埋点 → 移交压缩钩子
```

设计原则（搭档原话锚定）：

- 「时机由 Pi 自行把控，咱们只把压缩算法处理换成咱们的自定义实现」——钩子的本意用法，不借它触发 handoff
- 「LLM 耗时客观存在」——Pi 默认压缩同样调 LLM（generateSummary → completeSimple）且 await 钩子，等待是压缩固有成本，非自定义方案的额外风险
- 「压了又压」不可能发生——单一机制，算法只跑一道

## 相比旧架构的收益

| 维度 | 旧（双机制） | 新（统一） |
|---|---|---|
| 竞争窗口 | 轮内暴涨 65%→95% 时 Pi 的 87% 线抢跑，摘要质量降级为通用 8 段式 | 不存在——只有一套算法 |
| 触发密度 | 轮边界（粗），单轮暴涨有盲区 | 每次 LLM 响应前（细），无盲区 |
| 摘要质量 | 两条路：七段（handoff）/ 8 段式（Pi 抢跑时） | 恒定七段 + 四件套 |
| 代码面 | handoff 触发链 + 阈值管理 + 状态机 | 删减后净减（四件套/合成/防护全复用） |

## 迁移路径（单 PR，搭档拍板不拆分）——已完成

1. ✅ Spike：inline extension 注册 + 真实触发验证通过（发现 reload() 必要前置）
2. ✅ 单 PR 实现：
   - `compaction-hook.ts`：`handleSessionBeforeCompact`（reason 分流：threshold 替换 / overflow·manual 放行）+ 七段合成 prompt 构建
   - `model-runtime-registry.ts`：otter-hooks factory 注册 `session_before_compact` handler（复用既有 extension 通道）
   - `pi-session-factory.ts`：`setCompactionSynthesis()` 延迟注入（同 setOtterToolClient 模式，解 agentInvoke 循环依赖）
   - `agent-invoker.ts`：70% Pre-invoke 检查退役（注释保留现场）；`buildCompactionSynthesisFn()` 公开方法
   - `bootstrap/platforms.ts`：启动时接线 gateway.setCompactionSynthesis
   - 测试：钩子单测 9 例（分流/降级/超时/谱系）+ capability e2e 1 例（真实 SDK 链路）+ 存量 handoff 测试反转（退役回归防线）

## 开放问题

- compaction 后 session.summary 与 otter_context 四件套的注入衔接（原 handoff 重启后注入，现压缩后同 session，注入路径不同）——spike 确认
- 下周一试点观察任务的原有核对口径需按新机制调整
