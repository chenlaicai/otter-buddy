---
id: F20260915cfgt
doc_type: feature
change_type: feature
capability_test: "n/a: 纯 A 类代码逻辑（config 解析/装配门控/seed）无 LLM 行为变化；行为由 tests/frameworks/config/features-config.test.ts（13 用例：三态归一化/gateOn 短路/存量推断/双通道/显式压过推断）+ 全量 vitest 2960 用例回归覆盖；新增 daily-review prompt 无既有行为可退化（golden 场景均不覆盖本改动域）"
title: "定时任务 seed 配置门 v2：按「系统优化 vs 工作优化」分类重构默认格局（推广前治理）"
summary: "新环境启动时 3 对话 + 4 任务被硬编码 seed。按搭档分类原则重构：默认只开「每日复盘」（昨日对话/工作复核，通用价值），系统自身优化（self-healing）与个人场景（paper-trading/recruiting）默认 off；未配置时按 DB 存量任务自动推断兼容老部署；作者运维三任务（健康检查/issue 处理/依赖升级）不 seed 化，未来走任务模板。"
feature_id: F20260915cfgt
created_in_conversation: 30e95eac-fd3a-46dc-a19a-6b8786377287
created_at: 2026-09-15
intent:
  problem: "新环境启动硬编码 seed 3 对话+4 定时任务（含个人场景与系统运维类），无法区分产品能力与部署者个人配置，推广受阻"
  expected_effect: "新环境默认只 seed 每日复盘（1 对话 1 任务）；老部署升级后行为不变（存量推断）；显式配置永远优先"
  verify_by:
    type: capability_test
modules:
  - config
  - bootstrap
  - paper-trading
  - recruiting
  - healing
  - scheduler
tags:
  - config
  - feature-gate
  - scheduled-task
  - seed
  - distribution
---

> **v2 修订（2026-09-15，搭档定调后重写）**：v1 方向是「self-healing 默认 on 的系统刚需」，搭档给出分类原则后翻转——判定轴从「系统自检是否刚需」改为「**系统优化 vs 工作内容优化**」。v2 新增 `dailyReview`（每日复盘 seed，默认 on）、selfHealing 缺省翻转为 off、兼容策略从「本地配置一行」升级为「存量任务自动推断」。第 1 轮审视记录保留在文末。

## 背景

搭档原话（2026-09-15，意图锚）：

> "你整理下，当前本系统如果换个新环境启动，会有哪些定时对话和任务会默认开启，我在确认如果我推广本系统，那感觉有些定时任务不应该持久化到代码仓中"

> "你出个方案"

> "我认为原则是这样子的，如果是只是针对海獭系统自身的定时任务，那就不能默认开放；如果是对昨天一天对话内容的复核、昨天一天干的活的复核，那可以默认打开，这个确实也是对工作的复习。本质上，就是区分好，什么是海獭系统的优化（这个除了我（作者），其他用户是不需要关心的），什么是工作内容的优化。你再梳理一下，咱们可以直接按照最终理想效果来做好本次这件事，不需要考虑太短了"

**分类原则（判定轴）**：

| 类别 | 定义 | 默认 |
|---|---|---|
| **工作内容优化** | 对昨日对话/工作的复核——任何用户都有价值的「工作复习」 | **开** |
| **海獭系统优化** | 针对 otter-buddy 自身的问题发现/修复（healing 分析、issue 处理、依赖升级、健康检查）——除作者外无人关心 | **关** |
| **个人场景应用** | 特定领域的功能应用（纸面交易、招聘桥接）——用户按需启用 | **关** |

前置盘点结论（同对话已完成）：

| 类别 | 内容 | 按新原则归类 |
|---|---|---|
| 代码硬编码 seed | Self-Healing 对话 + `self-healing-analysis`（每日 10:00，分析 healing events/工具故障/根因聚类） | **海獭系统优化** → 默认关 |
| 代码硬编码 seed | 纸面交易对话 + `paper-trading-match-orders`（工作日 15:05）/ `paper-trading-daily-trading`（15:30） | **个人场景** → 默认关 |
| 代码硬编码 seed | 求职助手对话 + `recruiting-daily-summary`（每日 9:07） | **个人场景** → 默认关 |
| 仅存本地 DB | 每日对话健康检查（9:00）/ 每日 issue 处理 / 依赖升级自动化 | **海獭系统优化**（作者私有运维）→ 不 seed 化，未来走任务模板 |
| 不存在 | **每日复盘**（昨日对话与工作复核）——分类原则下的默认体验，当前缺失 | **工作内容优化** → 需新增 seed |

## 目标

T1: 新环境默认启动**只有**「每日复盘」一个对话一个任务（8:30 昨日工作简报）——系统优化类与个人场景类任务零默认出现
T2: 开关读取三态语义清晰：显式 `true`/`false` 永远优先；未配置时按「DB 存量 active 任务」自动推断（老部署行为不变），新库走缺省值
T3: 已部署环境（当前生产库）行为不变——升级后 self-healing / paper-trading / recruiting 照常运行（存量推断兜底），无需手工迁移
T4: 作者运维三任务（健康检查/issue 处理/依赖升级）维持 DB 私有，本次不做 seed 化（留给任务模板终态），作者环境零影响
T5: 每日复盘与作者已有健康检查并存不冲突：复盘=工作总结向（不查系统数据源、不建 issue），健康检查=系统体检向

## 非目标

- 不做定时任务导入/导出（跨环境迁移任务属任务模板终态）
- 不迁移/清理 prompts/scheduled/ 既有模板（#416 治理方向正确）
- 不 seed 化作者运维三任务（T4；避免与 DB 现存同名任务双触发）
- 不做运行时动态开关（改配置需重启）
- 复盘任务不做跨项目边界判定（回顾的是本系统全部对话，与健康检查的「#778 范围约束」不同职责）

## 方案设计

### 核心思路

判定轴落地为 `config.yaml` 顶层 `features:` 段（4 个开关）+ 一个新的 seed（每日复盘）+ 统一的三态门控逻辑（显式配置 > 存量推断 > 缺省值）。

### 配置设计

```yaml
# config.yaml（新增段，示例同步进 config.yaml.example）
features:
  dailyReview: true    # 每日复盘：昨日对话/工作复核。缺省 true——工作复习是通用默认体验
  selfHealing: false   # self-healing 分析：海獭系统自检。缺省 false——系统优化除作者外无人关心
  paperTrading: false  # 纸面交易撮合+操盘。缺省 false——个人场景显式启用
  recruiting: false    # 招聘桥接（webhook+摘要整子系统）。缺省 false
```

### 新增 seed：每日复盘（dailyReview）

仿 healing 先例（ensure 对话 → ensure 任务，settings 缓存幂等）：

- **对话**：`📖 每日复盘`（新建，ensureDailyReviewConversation）
- **并发防护**：与 healing 同款 `acquireDistributedLock`（发现 7 修订：保持先例一致性，不引入第二种无锁 ensure 模式）
- **pin**：对话创建后 pin 到列表顶部（发现 9 修订，L1 拍板：复盘是默认体验中日常频次最高的对话，新用户第一眼要看到；与 healing pin 行为一致）
- **任务**：`daily-review`，cron `30 8 * * *`（每日 8:30，早于作者 9:00 健康检查，两份报告节奏清晰），timezone Asia/Shanghai，executorType `agent`，`restartBeforeInvoke: true`（每日新 session 防污染），`timeoutMinutes: 30`（跨对话检索耗时余量）
- **prompt**：`prompts/scheduled/daily-review.md`（新增，git 真相源）。seed 时读文件存 body（paper-trading 模式），后续 prompt 迭代走 `update-scheduled-task-body.mjs` 同步（#416 工具链，复用）
- **prompt 内容要点**：
  1. 昨天干了什么：按对话/主题归纳——聊了什么、做了什么决策、产出了什么（文档/PR/结论）
  2. 未闭环事项：开了头没做完的、待跟进的决策
  3. 今日建议：基于未闭环给出当日工作建议
  4. 数据源：`search_memory`（created_after=昨日 0 点）跨对话检索为主，必要时翻对话历史
  5. **边界（与系统体检的分界线，T5）**：不查 healing events、不查 RHI/signal_events、不建 GitHub issue——发现系统问题在简报末尾提一句即可，不展开处理。这是工作复盘，不是系统体检

### 门控逻辑：三态统一规则

### 层职责边界（第 2 轮审视发现 6/8 修订：显式声明，杜绝误读）

- **配置层（`buildFeaturesConfig`）**：纯函数，只读自身段 `raw.features`，只做归一化（`norm()`）——显式 true/false 原样保留，null/未配置/非法值返回 `undefined`（非法值 warn）。**不读 `raw.inbound`、不碰 DB、不做任何推断**（v1 曾在配置层做 apiKey 推断，v2 已全部移出）
- **装配层（platforms.ts `gateOn`）**：唯一推断发生地。`gateOn(explicit, infer)` —— explicit 非 undefined 直接短路；undefined 时执行 infer 回调，回调内可查 DB 存量任务与 `config.inbound.recruiting.apiKey`
- **recruiting 双通道**：两个通道都在装配层 infer 回调内，`or` 语义（apiKey 命中或存量任务命中，任一即 on），无层间优先级问题

```typescript
// 配置层：纯归一化，三态输出
function buildFeaturesConfig(raw: RawConfig, logger?): AppConfig["features"] {
  const norm = (v: unknown): boolean | undefined => typeof v === 'boolean' ? v : undefined;
  return {
    dailyReview: norm(raw.features?.dailyReview),
    selfHealing: norm(raw.features?.selfHealing),
    paperTrading: norm(raw.features?.paperTrading),
    recruiting: norm(raw.features?.recruiting),
  };
}

// 装配层：统一门控 helper，唯一推断发生地
async function gateOn(
  explicit: boolean | undefined,
  infer: () => Promise<boolean>,   // 存量推断：DB 有该功能域 active 任务？
): Promise<boolean> {
  if (explicit !== undefined) return explicit;        // 显式配置永远优先，短路不查 DB
  return await infer();                                // 未配置 → 存量推断
}
```

存量推断实现：`repos.scheduledTask.getAllActive()`（已存在）按功能域任务名匹配：

| 开关 | 推断条件（未配置时） | 推断命中动作 |
|---|---|---|
| `dailyReview` | 无存量可推断（新功能） | 缺省 `true` 直接 on |
| `selfHealing` | DB 有 active `self-healing-analysis` | on + warn「由存量任务推断，建议显式配置」 |
| `paperTrading` | DB 有 active `paper-trading-match-orders` 或 `paper-trading-daily-trading` | 同上 |
| `recruiting` | `inbound.recruiting.apiKey` 存在 **或** DB 有 active `recruiting-daily-summary` | 同上（apiKey 是更强的意图信号，双通道） |

推断放装配层而非配置层的理由（检视獭发现 5 的延伸）：配置解析是纯函数不该碰 DB；platforms 阶段 DB 已就绪，`getAllActive()` 一次查询供三处推断共用，顺序安全。

**兼容效果**：当前生产库（三个功能域都有 active 任务）升级后全部推断 on，行为与升级前一致（T3 达成）；显式 `false` 是唯一的真关闭动作（尊重显式意愿，不触发推断）。

### 涉及模块/文件

| 文件 | 改动 |
|---|---|
| `src/frameworks/config-service.ts` | `RawConfig` 加 `features?: { dailyReview?: boolean; selfHealing?: boolean; paperTrading?: boolean; recruiting?: boolean }`（输入类型）；`AppConfig` 加 `features` 段（输出类型，字段 `boolean | undefined`——保留三态供装配层推断）；`buildFeaturesConfig(raw)` 归一化解析 |
| `src/bootstrap/platforms.ts` | ① `gateOn` helper + 存量推断（getAllActive 一次查询）；② healingInit 受门（gateOn(features.selfHealing, 存量 self-healing-analysis)）；③ recruiting 整个 `if (apiKey)` 块叠加门（**门控边界=整个子系统**：webhook 处理器/桥接状态/seed 三对象，controllers.ts:182-189 自动降级 NoopInboundController，装配侧零改动）；④ seedPaperTradingTasks 调用点受门（appConfig 透传链 app.ts:280 → platforms.ts:209 已核实）；⑤ 新增 ensureDailyReview 调用（gateOn(features.dailyReview, () => true)，缺省 on） |
| `src/usecases/daily-review/ensure-daily-review-scheduler.ts` | 新增：ensure 对话（settings 缓存幂等）+ ensure 任务（读 prompt 文件存 body） |
| `src/usecases/daily-review/constants.ts` | 新增：settings key / 任务名 / cron / 对话标题 |
| `prompts/scheduled/daily-review.md` | 新增：复盘 prompt（git 真相源，内容要点见上） |
| `config/config.yaml.example` | 新增 features 段示例 + 每开关注释（管什么/缺省/关掉不清理存量/三态推断语义） |

### 行为矩阵

| 场景 | dailyReview | selfHealing | paperTrading | recruiting |
|---|---|---|---|---|
| 新环境（空库）+ 全默认 | ✅ 8:30 复盘 | ❌ | ❌ | ❌（webhook 也不挂） |
| 当前生产（三域有存量任务、features 未写） | ✅（新 seed） | ✅ 装配层存量推断 | ✅ 装配层存量推断 | ✅ 装配层双通道（apiKey 或存量任务，任一命中即 on） |
| 任何环境显式 `selfHealing: false` | — | ❌ 不 seed（存量任务 warn 提示） | — | — |
| apiKey 存在 + 显式 `recruiting: false` | — | — | — | ❌ **整子系统关**：webhook Noop、无摘要 |
| 新环境 + `features: {paperTrading: true}` | ✅ | ❌ | ✅ | ❌ |

### 新增 schema 字段消费方声明

不涉及数据库 schema 变更。配置字段消费方：platforms.ts 门控点（唯一读取）。settings 新 key（daily-review-conversation-id / daily-review-big-otter-id）消费方：ensureDailyReviewConversation 幂等检查。

## 影响范围

- **新环境部署**：默认只有「📖 每日复盘」对话 + 8:30 任务（T1）；纸面交易/求职助手/自愈对话均不出现
- **当前生产**：三功能域存量推断 on，行为不变（T3）；新增每日复盘任务（作者环境 8:30 复盘 + 9:00 健康检查并存，内容分工见 prompt 边界）
- **`seedPaperTradingTasks` 函数**：调用点加门，本体不动；`registerPaperTradingFunctions` 与交易日历同步保持原样（进程内注册随重启重建，无窗口；改动面最小——审视发现 3 修正后的表述）
- **config 加载**：features 段可选，老配置零迁移

## 风险与约束

**R1：存量推断的误判面**。
推断依据「active 任务存在」——理论上存在「任务已停用但用户还想开」的反例（此时推断 off，用户需显式 true）。这是保守方向：误关有 warn 提示 + 一行配置可纠正，优于误开（凭空多任务）。显式配置永远优先的规则保证推断不会覆盖用户意愿。

**R2：关掉开关不清理存量**。
开关 false / 推断 off 只是「不再 seed」，已存在任务继续调度（scheduler 独立读取任务表）。有意为之：清理是破坏性操作不该由配置隐式触发。缓解：显式 false 且 DB 有该域 active 任务时 warn 一行提示。example 注释写明。

**R3：recruiting 双通道推断的认知成本**。
两个通道（apiKey / 存量任务）都在装配层 infer 回调内，or 语义任一命中即 on；用户可能困惑「配了 apiKey 怎么没启动」（显式 false 压过一切时）。缓解：warn + example 注释。另注意 `features.recruiting: false` 连带关闭 webhook——扩展端推送收不到响应，这是有意行为（收消息与摘要是同一功能两环节，「消息照收、堆积无人处理」的中间态不成立）。

**R4：YAML 解析边界**。
归一化规则：显式 `true`/`false` 原样保留；`null`（YAML 空值占位）→ 未配置且**不 warn**（合法占位）；其他非布尔值 → 未配置 + warn。测试覆盖三字段各自 true/false/null/字符串四种输入 + 推断分支。

**R5：每日复盘的 token 消耗**。
每天一次跨对话检索 invoke，长对话日可能消耗可观 token。缓解：timeoutMinutes=30 硬上限；prompt 写明「检索为主、不逐条翻对话全文」；用户嫌吵显式 false 即关。

**R6：复盘与作者健康检查的内容分工漂移**。
两任务都「回顾昨天」，prompt 演化中边界可能模糊（复盘开始建 issue / 健康检查开始写工作总结）。缓解：两边 prompt 各自写死边界条款（复盘：不建 issue 不查系统数据源；健康检查已有的 #778 范围约束不动），审视时把边界条款列为检核点。

## 不兼容更新

- **[Incompatible-soft]** 新环境默认 seed 集合从「3 对话 4 任务」变为「1 对话 1 任务」（每日复盘）——这正是本方案目的
- **[Incompatible-soft]** `features.recruiting: false` 时整个 recruiting 子系统关闭（含 webhook），不再是「只停摘要任务」
- **[Incompatible-soft]** selfHealing 缺省从（v1 方案的）on 翻转为 off——仅影响「features 未写且 DB 无存量任务」的环境，即新环境（正是目标行为）；有存量的老环境靠推断保持 on

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 分类轴 | 系统优化 vs 工作优化（搭档定调） | v1 的「系统刚需 vs 个人场景」二元 | 搭档原则：系统优化除作者外无人关心，工作复习人人需要——判定轴外置到用户视角而非系统视角 |
| 默认体验 | 每日复盘 on（新 seed） | 只做减法（全关） | 「对昨天对话/工作的复核可以默认打开，这确实也是对工作的复习」（搭档原话）——默认体验是产品价值主张，不是空的 |
| 兼容策略 | 装配层存量任务推断 | ① 本地 yaml 手工加行（v1 方案）② 配置层读 DB | ① 要求部署动作、忘了会静默断（v1 R1 缺陷）；② 破坏配置解析纯函数性。装配层一次 getAllActive 共用，顺序安全 |
| selfHealing 缺省 | off | on（v1） | 按新原则 healing events 分析是系统内部事务；推断保证老环境不断 |
| 作者三任务 | 不 seed 化 | developerOps 开关 seed 化 | seed 化会与 DB 现存同名任务双触发；作者任务 body 已多轮演化偏离 git 模板，重新注入有覆盖风险；任务模板终态（可自助安装）才是正解 |
| 复盘 prompt 分发 | body 固化 + #416 脚本同步 | [daily-review] 拦截标记动态读模板（healing 模式） | 拦截标记要动 scheduler-service 模板解析段；脚本同步零 scheduler 改动且已有工具链 |
| 开关粒度 | 按功能域 4 个布尔 | 每任务一开关 | 功能域稳定任务会增减；任务级=seed 清单复制进配置双份维护 |

**机制识别检查点 v2**（逐项）：
- ✅ 新增配置字段/枚举/开关 → **命中**（features 4 字段）
- ✅ 新增定时任务/后台进程 → **命中**（daily-review seed，每日 8:30 agent invoke）
- □ 新增状态生命周期 → 否（scheduled_task/conversation 均既有模型）
- □ 新增信号类型/消息格式 → 否
- □ 新增持久化存储 → 否（零表零字段；settings 新 key 属既有 KV 模式使用）
- □ 新增决策分支被记住并影响后续行为 → 否（三态门每次启动重算，不落库）
- □ 新增跨模块调用路径 → 否（features 读取集中 platforms.ts）

命中 2 项 → 涉及净新增机制 → 机制预算四问必答（v2 重答，覆盖新增的 dailyReview）：

1. **谁需要它**：新部署用户——每日复盘是开箱即用的工作复习价值（「这确实也是对工作的复习」，搭档原话），这是产品的默认体验主张；作者——一份配置恢复全套环境（显式开 selfHealing/paperTrading，运维三任务未来走模板）。两个角色都有可指认场景，非「应该有」。
2. **失败后果**：复盘任务静默不触发或质量差 → 用户可感知（早上没简报），scheduler 日志可查，无数据损坏；门控误判 → warn 日志 + 一行配置可纠正；复盘 token 超预期 → R5 缓解。全部可逆。
3. **后续机制**：可能出错的新状态：①复盘 prompt 与健康检查边界漂移（R6，prompt 边界条款+审视检核）；②推断与真实意愿不一致（R1，保守方向+显式优先）；③dailyReview 任务本体故障（既有 scheduled_task 运维范畴，无新机制类）。修法都在配置/prompt 层，不繁殖机制。
4. **退役条件**：任务模板市场成熟（用户自助安装/卸载任务）时，本配置门与全部 ensure seed（含 dailyReview）被安装状态取代；「每日复盘」从 seed 默认变为官方模板之一。

**重对抗门结论（v1，检视獭-配置门 mimo 异模型）**：`确认治本`。v2 机制变化（新增 dailyReview seed、缺省翻转、推断策略）→ 第 2 轮审查：机制设计（三态 gateOn + 装配层推断）获认可，发现 6 的层职责矛盾经核实属误读（v2 文档不存在「配置层 apiKey 推断」描述——grep 佐证，检视獭疑似读到记忆库 v1 残留 chunk），但其关切（层职责显式声明）已按建议补「层职责边界」段；发现 7/8/9 均已修订。**门控结论：确认治本**。

## 验证

- **单元测试**（`tests/frameworks/config/features-config.test.ts` 新增 + `tests/bootstrap/feature-gates.test.ts` 新增）：
  1. 未配置 features 段 → 四字段均 undefined（缺省逻辑在装配层）
  2. 显式 true/false 原样保留；非法值（字符串 "yes"）→ undefined + warn；null → undefined 不 warn
  3. gateOn：显式 true/false 短路不查 DB；undefined 时走推断
  4. 存量推断：DB mock 含 active self-healing-analysis → selfHealing 推断 on + warn；含 paper-trading 任务 → paperTrading on；apiKey + 无存量 → recruiting on
  5. 显式 `recruiting: false` + apiKey 存在 → off（显式压过推断）
  6. ensureDailyReview 幂等：已有同名 active 任务不重复建
- **集成验证**（手动，升级路径）：
  1. 当前生产 config.yaml 不动 → 重启 → 三域推断 on（日志 warn 建议 explicit），每日复盘新 seed，8:30 触发一次出简报
  2. 显式 `features: {selfHealing: false}` 重启 → 自愈不再 seed，存量任务 warn 提示（任务仍在调度——R2 语义验证）
  3. 空库 + example 默认配置启动 → 只有「📖 每日复盘」对话与任务（T1 验收）
- **验收标准**：三场景与行为矩阵一致；`npx tsc --noEmit` 通过；现有测试全绿

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/frameworks/config-service.ts` | 修改 | RawConfig/AppConfig features（4 字段三态）+ buildFeaturesConfig 归一化 |
| `src/bootstrap/platforms.ts` | 修改 | gateOn helper + 存量推断（getAllActive 一次共用）+ 三处既有 seed 受门 + ensureDailyReview 调用 |
| `src/usecases/daily-review/ensure-daily-review-scheduler.ts` | 新增 | 复盘对话 + 任务 ensure（settings 幂等，prompt 文件存 body） |
| `src/usecases/daily-review/constants.ts` | 新增 | key/任务名/cron/标题常量 |
| `prompts/scheduled/daily-review.md` | 新增 | 复盘 prompt（含系统体检边界条款） |
| `config/config.yaml.example` | 修改 | features 段示例 + 四开关注释（含三态推断与不清理存量语义） |
| `tests/frameworks/config/features-config.test.ts` | 新增 | 解析层 + gateOn 用例（上述 1-5） |
| `tests/bootstrap/feature-gates.test.ts` | 新增 | 装配层门控与推断用例（可并入上文件，实现时定） |
| `docs/features/2026/09/15/F20260915cfgt-*.md` | 修改 | 本文档 v2 |

---

## 附：对抗审视记录

### 第 1 轮（v1 方案，检视獭-配置门 / mimo / 2026-09-15）

| # | 严重度 | 发现 | 处置 | 修订 |
|---|---|---|---|---|
| 1 | 严重 | RawConfig 接口遗漏（只改 AppConfig 会编译报错/as any 绕过） | 接受并修订 | 涉及模块表 + 改动范围表补 RawConfig |
| 2 | 严重 | features.recruiting 只门 seed 不门 webhook，行为不对称未声明 | 接受并修订（语义升级） | 门控边界改为整个子系统：if 块内三对象统一受门，controllers.ts 侧自动降级 Noop（核实 182-189 行）；行为矩阵补 webhook 行为 |
| 3 | 建议 | registerPaperTradingFunctions 保留理由（时序窗口）与代码事实矛盾 | 接受并修订 | 理由修正为「进程内注册随重启重建，无窗口；改动面最小」 |
| 4 | 建议 | `null` 走 `!== false` 依赖 JS coercion，测试未覆盖 | 接受并修订 | 归一化规则明确 null 语义（未配置、不 warn）；测试用例覆盖 |
| 5 | 建议 | buildFeaturesConfig 跨段读取与现有模式不同 | v2 已消解 | v1 的 apiKey 推断移入装配层（gateOn），配置层恢复纯函数只读自身段 |

v1 delta 复核：通过（5/5 修订到位）。

### 第 2 轮（v2 方案，检视獭-配置门 / mimo / 2026-09-15）
| # | 严重度 | 发现 | 处置 | 修订 |
|---|---|---|---|---|
| 6 | 严重 | apiKey 推断层归属矛盾（文档自相矛盾） | **反驳 + 部分接受**：grep 佐证 v2 文档不存在「配置层做 apiKey 推断」描述（解析层行明确「不碰 DB」），检视獭引用原句「视为 true 并 warn」在 v2 无匹配，疑似读到记忆库 v1 残留 chunk；但「层职责边界不够显式」的关切成立，按建议补「层职责边界」段 + 配置层/装配层双伪代码 | 新增「层职责边界」段；R3 补通道归属说明 |
| 7 | 建议 | dailyReview ensure 缺分布式锁声明 | 接受并修订 | 明确采用与 healing 同款 acquireDistributedLock |
| 8 | 建议 | 行为矩阵 recruiting 推断通道合并写法有歧义 | 接受并修订 | 拆为「装配层双通道（apiKey 或存量任务，任一命中即 on）」 |
| 9 | 建议 | dailyReview 是否 pin 未声明 | 接受并修订（L1 拍板：pin） | 补 pin 决策及理由 |

v2 相对 v1 的变化点（供 delta 审视聚焦）：
1. 分类轴翻转：selfHealing 缺省 on → off；新增 dailyReview（默认 on）seed
2. 兼容策略：本地配置行 → 装配层存量任务推断（getAllActive）
3. 新增文件：daily-review ensure/constants/prompt + 测试
4. 四问重答（新增定时任务命中）；重对抗门重审：确认治本

---

## 实现记录（2026-09-15，大獭）

### 实现落点（与方案一致，无方案外变更）

| 文件 | 操作 | 要点 |
|---|---|---|
| `src/frameworks/config-service.ts` | 修改 | RawConfig/AppConfig features（4 字段三态 boolean\|undefined）+ buildFeaturesConfig 纯归一化（null 不 warn / 非法值 warn）；applyDefaults/loadConfig 透传 logger |
| `src/bootstrap/feature-gates.ts` | 新增 | gateOn 三态门 + resolveFeatureGates（一次 getAllActive 共用，DOMAIN_TASK_NAMES 按域匹配，recruiting 双通道 apiKey\|\|存量） |
| `src/bootstrap/platforms.ts` | 修改 | initPlatforms 开头 await gates 解析 → dailyReviewInit（新）+ healingInit 受门 + recruiting 整块受门；initAgentAndScheduler 内 seedPaperTradingTasks 受门（appConfig?.features.paperTrading） |
| `src/usecases/daily-review/constants.ts` | 新增 | key/任务名/cron(30 8 * * *)/标题常量 |
| `src/usecases/daily-review/ensure-daily-review-scheduler.ts` | 新增 | ensure 对话（分布式锁+pin+welcome entry，healing 同款容错）+ ensure 任务（读 prompt 模板存 body，fail loud，restartBeforeInvoke=true，timeoutMinutes=30） |
| `prompts/scheduled/daily-review.md` | 新增 | 复盘 prompt（三段简报结构 + 边界条款：不查系统数据源/不建 issue/无副作用） |
| `config/config.yaml.example` | 修改 | features 段示例（三态规则 + 不清理存量 + recruiting 关闭连带 webhook 的说明） |
| `tests/frameworks/config/features-config.test.ts` | 新增 | 13 用例：配置层归一化 4 + gateOn 2 + resolveFeatureGates 7 |
| `src/app.ts` | 修改 | Promise.allSettled 补 dailyReviewInit（scheduler start 前） |

### 自检报告

- `npx tsc --noEmit`：通过（0 error）
- `npx vitest run`：250 files / 2960 tests 全绿（含新增 13）
- 废弃资源四查：本次无旧路径/旧文件/旧默认值迁移（新增功能，未替换任何旧路径）——①旧引用清零 N/A；②无孤儿文件；③无配置迁移；④无 DB 真相源同步需求
- pre-existing 声明：无（全部测试通过）
- **最简实现检查**：已过——无新依赖、无新表、无 scheduler 内核改动；gateOn 复用「显式优先」的既有三态思想，ensure 镜像 healing 既有模式而非新发明；prompt 走既有 git 模板模式（#416 工具链）。确认已最简
- 软代码变更：新增 prompts/scheduled/daily-review.md → intent 块已加（verify_by: capability_test）；golden gate 处置：**不适用留痕**——4 个 golden 场景（r4 召唤/seriousness/yield 协议/发言石路由）均为 agent 对话行为场景，与本改动的 config/bootstrap/seed 层零交集；本次为新增 prompt（无既有行为可退化），golden 采样验证对象不存在，跑全量 capability 套件为空转（真 LLM 串行 20+ 分钟），理由写入 PR 描述

### 验证补充（手动验收路径，合并后执行）

1. 生产重启 → 日志应有 `Feature gates resolved` + 三域推断 info + daily-review seed 日志
2. 空库启动（临时 data 目录）→ 对话列表只有「📖 每日复盘」+ 8:30 任务

### 代码审视记录（PR #936，检视獭-936 / mimo / 2026-09-15）

| # | 严重度 | 发现 | 处置 | 修复 |
|---|---|---|---|---|
| S1 | 严重 | initAgentAndScheduler 内 paperTrading 门用 raw 三态值（undefined=未配置直接当 false），与 initPlatforms 的 gates 不同源——老部署存量推断场景（未写配置+DB 有任务）seed 失效，违反 T3 | 接受并修复（更好：保住兼容目标；不修则日志误导+任务丢失） | feature-gates.ts 导出 inferDomainActive 单域推断 helper；initAgentAndScheduler 改走 gateOn(appConfig?.features.paperTrading, infer) 完整三态门；补 3 条 S1 回归测试（16 用例全绿） |
| A1 | 建议 | 缺 platforms.ts 级装配层集成测试（S1 型接线 bug 单测拦不住） | 建账号跟进 | issue #937（四 seed 点 × 三态断言方案已写入） |
| A2 | 建议 | ensureDailyReviewScheduler 幂等只查 active，disabled/error 不 warn | 不改（与 healing 先例一致，改了引入不一致反而变差） | 无 |
