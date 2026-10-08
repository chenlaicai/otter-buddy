---
id: F20261008ctxo
title: "kimi-256k 注入超窗可观测 + create_otter 召唤前置拦截（#1247）"
summary: "400 上下文超长错误配专属 healing 类型 context_overflow（orchestrator api_error 汇聚点识别落账 + C3 高警 + 会话告警）；create_otter 按模型窗口做注入体积预算硬拦（密度上限 1.5 tok/char + 固定注入底线 30K vs 窗口×0.8）"
change_type: fix
capability_test: "n/a: 识别器/预算检查均为纯函数+工具层单测覆盖（17 例），无 prompt 行为变更"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - "#1247"
  - "#543"
  - "#1230"
  - "F20260929czi0"
  - "F20260923hsyn"
modules:
  - src/usecases/conversation/agent-turn-orchestrator/context-overflow-error.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/entities/healing/healing-event.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/ports/agent-tools.ts
tags:
  - healing
  - observability
  - create_otter
  - context-window
  - token-budget
created_at: "2026-10-08T10:40:00+08:00"
---

# kimi-256k 注入超窗可观测 + create_otter 召唤前置拦截（#1247）

## 问题（issue #1247）

拉 kimi-256k 小獭时首条请求即因注入上下文超 k3-256k 的 256K 窗口被 API 直接 400 拒（非 429 配额）——小獭首条即死，错误只在对话层出现一次：

- **无观测**：400 超窗类错误无专属 healing 事件类型，被归为 generic/静默失败，体检不可见
- **无前置拦截**：create_otter 召唤阶段不检查注入体积 vs 模型窗口，超窗组合「生下来就死」

实证文本（2026-09-29 现场，issue 原文）：`kimi-256k API error (400): "Your request exceeded k3-256k model token limit: 273412 > 262144"`

## 根因与边界

- **原发根因已修**：F20260929czi0（进场游标零点修正，PR #1221）修掉了「新獭首请求背全历史未读」的结构性注入爆炸——那是 9/29 事故的主因。
- **本 PR 是纵深防御层**：为残余病理（超长 systemPrompt 派工 + 小窗口模型组合）补上观测 + 前置拦截。与 #1230（注入面裁剪 27K 工具定义）同根因族，#1247 聚焦「超限时的可观测 + 前置拦截」。

## 方案设计

### 1. 可观测：context_overflow healing 类型（#543 同骨架）

**识别器**（新模块 `context-overflow-error.ts`，与 rate-limit-error.ts 同模式）：

- 正则词族：kimi 实证形态 / OpenAI maximum context length / Anthropic prompt is too long / SDK Context overflow recovery / 中文「上下文超限」「输入超长」变体
- **与限流词族互斥**：限流词族（quota/usage/429/rate limit）由 matchRateLimitError 先判；超窗词族不含这些词。orchestrator 按先限流后超窗串行调用，两个 matcher 互斥性有测试锄定
- 数字提取三段式（尽力提取非硬保证）：kimi `N > M` 形态 → OpenAI `maximum context length is M ... you requested N` 倒序形态 → Anthropic `prompt is too long: N ... maximum is M`；均不中返回空对象（词族命中即落账，不依赖数字）

**落账链**（orchestrator handleApiError，api_error 终态汇聚点）：

- healing errorType `context_overflow`，severity:high（体积超窗是终态，重试无意义——与配额耗尽同级处置）
- 归 environment 类（HEALING_ENVIRONMENT_TYPES 登记——窗口容量是环境给定，非獭能力失败；漏登记会被 classifyHealingErrorType 兜底归 capability，体检误读）
- C3 高警队列（healingAlertRegistry.enqueue）——大獭不在场时 sendSystem 错过，下次 invoke 补送达
- 会话内告警（sendSystem）：含模型名、实测数字（有则）、处置建议（缩注入/换大窗口模型，重试无意义）

### 2. 前置拦截：create_otter 注入体积预算（#1247 改进点 2）

估算式：`systemPrompt 字符数 × 1.5 + 30_000 ≥ 窗口 × 0.8 → 硬拦`

| 常量 | 值 | 依据 |
|---|---|---|
| CTX_DENSITY_TOK_PER_CHAR | 1.5 | F20260923hsyn 夹逼定标实测中文密度 ~1.443 tok/char 取整为上限值——低估 token 会漏拦，宁可高估少量误拦 |
| BASE_INJECTION_TOKENS | 30_000 | 工具定义 #1230 实测 27K + 身份段余量；首请求 = 工具定义 + 身份段 + systemPrompt + 首条 user 消息 |
| WINDOW_SAFETY_RATIO | 0.8 | 留输出 token 空间（窗口含输入+输出），沿用 F20260923hsyn 同值 |
| MIN_SENSIBLE_WINDOW | 8_000 | 窗口配置异常小视为配置错误跳过（不误拦），与 otter-context-window-provider.ts 同值 |

- **Why 硬拦而非提示**：与配额不同（checkModelQuotaHint 是提示——配额可能已恢复，硬拦误伤），注入体积是创建时点的确定事实（prompt 长度可测），不随时间恢复——超窗组合首请求必死，硬拦是帮獭避免僵尸产出
- **Why fail-soft**：窗口未配置（getContextWindow undefined）时跳过——不硬依赖装配完整（同 quota hint 先例）；ToolModelPool 窄接口的 getContextWindow 声明为可选成员，旧装配/测试桩自动跳过
- **拦截点在创建前**：不产生僵尸参与者记录（对照：创建后再拦会留下孤儿 participant）
- **拦截文案**：报估算值（prompt K 字符 × 密度 + 底线）、目标模型窗口、字符预算上限（换算给獭可直接执行）、换模型建议

## 机制判定（troubleshooting 修法决策树）

命中机制识别清单（新枚举 context_overflow + 新决策分支）→ 但走 **①narrow-fix（既有语义内修）**，论证：

- 与 #543 rate_limit（F20260908rlcp）、F20260922txes timeout_retry_exhausted 同族同骨架——三者都是「api_error 终态分类链」的实例化扩展：识别器纯函数 + orchestrator 落账 + 告警文案，模式完全复用，零新框架
- create_otter 侧同理：#543 的 checkModelQuotaHint 已建立「召唤前检查目标模型状态」的语义槽位，本 PR 在同一校验链上并列一个检查点
- 无新状态生命周期、无新持久化存储、无新跨模块路径（healing_events 表结构不变，errorType 是自由文本列）

Modification-Class: `narrow-fix`

## 变更清单

| 文件 | 变更 |
|---|---|
| src/usecases/conversation/agent-turn-orchestrator/context-overflow-error.ts | 新增：超窗识别器 + 告警/description 文案（#543 同骨架） |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | handleApiError 挂超窗识别分支 + recordContextOverflowHealingEvent（C3 高警）+ notifyContextOverflow |
| src/usecases/conversation/agent-turn-orchestrator/types.ts | HealingEventInput.errorType 联合类型补 context_overflow |
| src/entities/healing/healing-event.ts | HealingErrorType 枚举 + HEALING_ENVIRONMENT_TYPES 登记 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | checkCtxOverflowBudget 预算检查 + create_otter 校验链挂载（创建前硬拦） |
| src/usecases/ports/agent-tools.ts | ToolModelPool 窄接口补可选 getContextWindow |
| tests/.../context-overflow-error.test.ts | 新增 9 例：词族识别/互斥性/数字提取三段式/文案 |
| tests/.../create-otter-ctx-budget.test.ts | 新增 6 例：超拦/放行/fail-soft/小窗口/默认模型/未知别名 |
| tests/entities/healing/healing-event-classify.test.ts | 全枚举覆盖 14→15 |

## 验证

### 测试

- 新增 17 例全绿（识别器 9 + 预算检查 6 + 枚举覆盖 2 断言更新）
- 全量 vitest：4935 passed / 2 failed——**2 失败为 pre-existing**（tool-description-overrides，与本次改动文件零交集），基线对照证据：origin/main @ 77792893 上同样 2 例失败（git stash -u 后基线复跑输出），已建 issue #1345 跟踪
- tsc --noEmit 零错误

### 最简实现检查

已过最简检查——零新依赖、零 schema 变更、识别器是纯函数、预算检查是同步纯函数；最小实现面（一个新模块 + 既有链路两处挂载点）。本可以用更少代码吗？不能：识别器独立模块是 #543 先例确立的模式（纯函数可单测），并入 orchestrator 会让已 1000+ 行的文件更臃肿。

### Golden Gate / Intent

软代码改动检查：本次变更不含 prompt/skill/协议层字符串——create_otter 工具 description 未改（拦截文案是 errorResponse 运行时输出，非注入面 description）。Golden Gate: n/a（无 prompt 行为变更场景可跑）。

### 失败证据链（bugfix 硬规则）

- **修复前失败形态**：issue #1247 实证——kimi-256k 小獭首条请求 400 拒，healing_events 无专属类型（grep 'context_overflow' 零命中），create_otter 对 12 万字符 systemPrompt + kimi-256k 组合无任何拦截直接创建
- **修复后通过形态**：`create-otter-ctx-budget.test.ts` 用例 1（kimi-256k + 超预算 prompt → [错误] 注入体积超预算 + 不创建）与用例 5（默认模型同样受检）；识别器用例 1（kimi 实证文本识别 + 273412>262144 提取）
- 失败用例在修复代码前先写好并确认失败（TDD 顺序：测试先写，识别器数字提取正则两次迭代修 bug 时用例锁死断言）

## 影响范围

- **行为变化**：① api_error 终态若为超窗词族 → 新增 healing 事件 + 会话告警（此前静默）② create_otter 对超预算注入组合硬拦（此前直接创建后首条即死）
- **兼容性**：healing mapper errorType 是自由文本列无迁移；ToolModelPool.getContextWindow 可选——旧测试桩/装配不实现也不报错（fail-soft）；#998 二维分账自动归 environment
- **不改变**：rate_limit 识别路径（词族互斥有测试）、配额提示（quotaHint 照旧）、restart 路径（已有 over-window 降级守卫 F20260930hsfx，不重复覆盖）

## 设计取舍

- **弃「精确 token 计数」**：不调 tokenizer 精确计数，用密度上限估算。理由：token 预算估算路线在对话切片场景已被 F20260929kws1 三度返工否定（「预算弹性」是结构性出错源）；但本场景不同——创建时点一次性粗测，只需保守上界（宁可高估少量误拦，误拦可换模型绕开），不需精确预算。密度 1.5 是实测 1.443 的取整上界。
- **弃「拦截首请求注入全量体积」**：只测 systemPrompt，不测首条 user 消息（派工简报）。理由：首条消息在 yield 时才产生，create_otter 时点不可得；且 BASE_INJECTION_TOKENS 30K 底线已为简报留了空间（27K 工具定义 + 简报余量）——按 issue 验证断言「create_otter 对 kimi-256k 模型在注入体积超预算时报前置错误」的口径实现。
- **restart 路径不覆盖**：restart_otter 的合成档案已有 over-window 降级枚举守卫（F20260930hsfx），语义是「合成材料超窗时降级机械档案」——与本 PR「召唤拦截」不同环节不同语义，不重复。
- **worst case 接受**：估算误拦（实际 token 低于估算但超 0.8 线）时獭被要求缩 prompt 或换模型——成本是一次重写，远低于「生下来就死」+ 僵尸参与者清理成本。

## 与 #1230 的关系

#1230（注入面裁剪）处理「常量注入面太大」的根因；本 PR 处理「残余组合超窗」的观测+拦截。若 #1230 落地把工具定义从 27K 降到 10K，BASE_INJECTION_TOKENS 应同步下调——常量含义已注释标明来源，改一处即可。

## 后续

- issue #1247 修复后关闭，验证断言（healing 专属 errorType + create_otter 前置错误）均已由测试锄定
- #1345（tool-description-overrides 2 例 pre-existing 失败）另行跟踪，与本 PR 无关
