---
id: R20260821supp
title: tutu-vessel-distillation-supplement
doc_type: research
summary: |
  R20260821tutv 的补充分档。修正一处事实错误（测试文件数 402→346），补充四个研究维度
  （需求结晶相变点、工程运营面、记忆归因修正、对比框架修正），新增 otter 吸收优先级矩阵。
  核心补正：记忆系统"缺陷"是 v0.3 愿景换代的主动取舍而非能力不足；tutu 与 otter 差异 70%
  在设计哲学层（让人离场 vs 让人不想离场），不是优劣；需求结晶五问是 otter 最缺的防呆门。

status: draft
exploration_type: technical
tags: [multi-agent, agent-society, pi-sdk, supplement, phase-transition, engineering-ops, memory-attribution]
causal_links:
  from:
    - R20260821tutv
---

# R20260821supp: tutu-vessel 蒸馏补充分档

## 0. 背景

本研究是 [R20260821tutv](R20260821tutv-tutu-vessel-distillation.md) 的补充分档。原文对 tutu-vessel 做了五路并行深度代码分析蒸馏，质量整体扎实，但存在：

1. **一处事实错误**需修正
2. **四个研究维度**需补充
3. **对比框架**需校准

补充基于以下来源的独立交叉验证：
- tutu-vessel 真实代码仓库（[terrenceeLeung/tutu-vessel](https://github.com/terrenceeLeung/tutu-vessel)，浅克隆至 /tmp/tutu-vessel）
- tutu-vessel 设计文档体系（vision.md / ADR / SYSTEM-MAP / CONTEXT.md / AGENTS.md / PLAYBOOK / 反思胶囊 / 砍单审计）
- 多獭协作分析（kimi 战略洞察 + 大獭技术验证）

---

## 1. 事实修正

### 1.1 测试文件数量

| 项目 | 原文声称 | 实测 | 说明 |
|------|---------|------|------|
| 测试文件数 | 402 | **346**（`find -name "*.test.ts" -o -name "*.spec.ts"`） | 统计口径差异（可能含配置文件/fixture），同量级不影响结论 |

其他数据点经验证无误：~5.6 万行 TS ✅（实测 56,368 行）；419 PR 无法本地核验（浅克隆 git log 仅 1 条），以原文为准。

---

## 2. 补充洞察 A：需求结晶是"相变点"设计

> 原文将结晶流程作为"组织协作模型"的注脚一笔带过，未识别为独立设计模式。

### 2.1 机制描述

tutu-vessel 把"从讨论到交付"设计成一个**显式的、有门槛的、需要人类确认的不连续事件**（Phase Transition Gate）：

```
主题 DM grill（私聊，永久保留 = 项目监督线）
  → 结晶预览五问
  → captain 明确说"开工"
  → 立卡、建专属施工群、显式 start
```

五问结构（`vision.md` §3 + `CONTEXT.md` "Crystallize Handoff" 词条）：

| 问题 | 含义 | 强制性 |
|------|------|--------|
| What 清单 | 要做什么 | 是 |
| Why 背景 | 为什么做 | 是 |
| **Tradeoff 砍了什么** | 不做什么、砍掉了什么 | **强制** |
| **Open 未决** | 还没想清什么 | **强制** |
| Next 首卡派谁 | 第一张卡发给谁 | 是 |

关键设计：Tradeoff 和 Open 是**强制项**——结晶不是总结"我们要做什么"，而是先逼 FM 交代"我们不做什么、还没想清什么"。

### 2.2 为什么这是独立设计模式

多数多智能体系统把"讨论→交付"当成**连续滑坡**，agent 顺着对话惯性就开始干活。tutu 把它做成**不连续事件**，用五问清单 + 人类显式确认作为相变门槛。

类比物理：水→冰不是渐变，是在 0°C 发生的相变。需求结晶就是这个 0°C 点——讨论是液态（自由流动），施工群是固态（有结构、有 SOP、有验收），五问是相变潜热。

### 2.3 对 otter 的启示（P0）

otter 当前的 `requirement-analysis` → `code-implementation` 之间**没有强制确认门**。agent 可能顺对话惯性开工——搭档说"做个方案"，方案产出后 agent 直接开始写代码，没有"砍了什么/未决什么/你确认开工吗"的显式门槛。

**建议**：在 `code-implementation` skill 入口前插一个确认 checklist（纯 skill 改动，零代码），要求搭档显式确认后才进入实现阶段。

---

## 3. 补充洞察 B：工程运营面（原文完全未覆盖）

> 原文聚焦协作机制与设计哲学，遗漏了"一人公司如何让 AI 施工队安全、可审计、成本可控地运转"的完整运营设计。

### 3.1 token 用量日历 + 历史导入器

**证据**：`src/application/observability/token-usage-queries.ts` / `daily-token-usage-queries.ts` / `token-usage-aggregation.ts`（一整个子模块）；`PLAYBOOK.md` "Token Usage" 章节 + `usage:import-history` 脚本。

tutu 把**每个 run 花了多少 token、多少命中了缓存、按会话/按天的聚合**做成一等可观测数据。连"历史 session JSONL 回填用量"都有显式运维命令（先备份→导入→校验→幂等重跑报 imported:0）。明确标注"这是 Pi 报告的运行证据，**不是供应商账单**"。

**为什么重要**：一人公司的生命线是 LLM 成本。tutu 把成本当成**运行时数据**而非月底账单——这让它能做"缓存命中率优化""哪个会话烧钱"这类运营决策。

### 3.2 alpha 隔离环境 + 端口宪法

**证据**：`AGENTS.md` "Vessel Port Allocation" + `scripts/alpha.sh`（F019）+ `.vessel-alpha.json`。

tutu 的运营纪律：
- 7700/7701 是 **Captain 的活运行时**——任何 crew **永不许碰**
- crew 要测试自己的 build，用 `scripts/alpha.sh start` 起一个**完全隔离的 alpha 实例**（独立端口 7720-7798 + 独立数据根 `~/.vessel-alpha-<hash>`）

**为什么重要**：这解决了多 agent 自举开发最危险的问题——**AI 施工队改的就是 AI 施工队正在跑的系统**。tutu 的答案是物理隔离：活的归活、试验归试验。tutu 能用 419 个 PR 自我开发而不炸掉自己，靠的就是这个隔离模型。

### 3.3 git 提交归属 trailer

**证据**：`crew-capabilities/identity/commit-attribution.md`："git commit 一律以 `Co-Authored-By: {{display_name}} <{{crew_id}}@vessel.local>` trailer 结尾……git Author 保持宿主 git 用户"。

tutu 强制每个 AI crew 的提交带 Co-Authored-By trailer，Author 保持人类宿主。**法律/审计上作者是人，功劳簿上记着 AI**。419 个 PR 每个都能追溯到具体哪只 AI。

---

## 4. 补充洞察 C：记忆归因修正

> 原文将记忆系统的"死字段/中文 FTS/裸 bm25"作为缺陷罗列，但缺少根因分析。

### 4.1 缺陷是愿景换代的主动取舍

2026-07-02 砍单审计（`docs/` 目录）给出了更深刻的归因：v0.2 愿景的记忆上层建筑（Dispatch 调度、冥想核验、危险象限、向量检索）被 v0.3 **主动砍掉**，只留工程地基（三层存储/溯源/幂等/重建）。

砍单审计结论原文佐证："这一个月的代码几乎零浪费"——过度设计集中在**承诺面**而非代码面。那两个月的记忆上层建筑零行代码，处决零成本。

### 4.2 修正后的评估

| 原文评语 | 修正后评语 |
|---------|-----------|
| "记忆智能很弱" | 记忆智能**被主动搁置**——不是做不到，是 v0.3 把资源导向了一人公司形态（球权/Task/施工群），记忆智能是 v0.2 的遗产但不是 v0.3 的优先级 |
| "缺陷罗列" | 应理解为**"已选的路"和"未选的路"**——评估任何系统要先问"它的愿景把资源导向哪里" |

### 4.3 对 otter 的启示

otter 的记忆系统（link_memory 关系图 + jieba 分词 + hybrid 检索 + 加权 RRF 重排）恰好补上了 tutu 的两个死穴（related_refs 死字段、中文 FTS 坏）。这是 otter **真实领先**的维度，但不是 otter 比 tutu"好"，而是 otter 的愿景把资源导向了记忆——**资源分配反映优先级，优先级反映愿景**。

---

## 5. 补充洞察 D：反思胶囊 + Rule Update Target

> 原文提到"反思胶囊"但未分析其机制精髓。

### 5.1 机制描述

**证据**：`project-reflections/` 三篇胶囊（F021/F026/F029），结构固定为：

| 节 | 内容 |
|---|---|
| What Worked | 做对了什么 |
| What Failed | 做错了什么 |
| Trigger Missed | 错过了什么触发条件 |
| Doc Links | 相关文档 |
| **Rule Update Target** | **什么规则该改（强制/候选）** |

F026 胶囊示例："前端 Phase 的 AC 应包含 i18n/IME 场景检查——加入 Phase plan 模板 checklist（候选，不强制）"。

### 5.2 为什么重要

多数团队的 retro 止步于"下次注意"。tutu 把它接到规则库上：**反思不止于记录教训，而是显式产出"流程规则修订提案"**，且标注强制/候选。这与 review metrics（度量自身流程）合起来，构成**流程的 PDCA 闭环**。

otter 的 skill 目前沉淀 know-how，但缺少"每次用完 skill 后强制问一句这个 skill 该不该改"的触发器。

---

## 6. 补充洞察 E：值班室隐私围栏

> 原文未提及会话隐私分级。

### 6.1 机制描述

**证据**：`vision.md` §2 + `CONTEXT.md` "Duty Room（值班室）" 词条："captain↔FM DM……**永不结晶为施工群——隐私围栏**"；`CONTEXT.md`："New plain (untyped) DMs are Captain↔FM only: any other roster is rejected at creation"。

tutu 在**域层**硬性规定：captain 与大副的日常私聊（值班室）永远不能变成施工群。这不是约定俗成，是**服务端创建时拒绝其他花名册**。

### 6.2 对 otter 的启示

多 agent 系统的一个隐性风险是"工作上下文污染私人上下文"。otter 目前没有"会话隐私分级"——所有对话对在场海獭默认可见。当 otter 走向多用户/多项目时，值得借鉴。

---

## 7. 对比框架修正

### 7.1 根本前提

原文第六节的对比表格个别维度隐含**以 tutu 为标杆**的偏差。正确的前提是：**两个产品的组织形态根本不同**，多数机制差异是这个前提的自然推论，不是优劣。

| 维度 | tutu-vessel | otter-buddy | 差异性质 |
|------|-------------|-------------|---------|
| 北极星 | **让人可以离场**（captain 在场从义务变自由） | **让人不想离场**（伙伴关系） | 设计哲学，不可通约 |
| 组织形态 | 放射状科层（captain→FM→workers） | 平权海獭社会 | 设计哲学 |
| 信任模型 | 用制度替代信任（版本门/对账/验收链） | 用校准建立信任（R6 信任校准协议） | 设计哲学 |
| 成本敏感度 | 极高（一人承担全部 LLM 成本） | 中（伙伴模式对单轮成本不敏感） | 暂时性/生态位差异 |

### 7.2 "不同"而非"高下"

| 维度 | 原文措辞 | 修正 |
|------|---------|------|
| 制度工程 | tutu"极致" vs otter"轻量" | "极致"在 tutu 是 necessity（419 PR 自我狗粮逼出来的）；otter 的轻量是**与自身规模匹配的恰当**，不是"tutu 的简化版" |
| 验证 | tutu"分档 smoke" vs otter"真 LLM 更强调" | tutu 的 real-Pi 档同样是真模型验收，且三档分层更成熟。应判**平手或 tutu 略优** |
| 哲学自觉 | tutu"名存实亡" vs otter"执行更彻底" | ✅ 原文此条准确且深刻——这是全篇最见功力的一行 |

### 7.3 各自真实领先的维度

- **otter 真实领先**：记忆系统（关系图 + 中文检索 + hybrid RRF 重排）
- **tutu 真实领先**：能力文本治理（版本门 + tool teaching 三信道 + response 即教学）
- **其余大多是"不同"而非"高下"**

---

## 8. otter 吸收优先级矩阵

> 原文第七节列了 6 个方向但缺优先级。结合 ROI / 实施难度 / otter 现有架构，排序如下：

| 优先级 | 方向 | ROI | 难度 | 理由 |
|--------|------|-----|------|------|
| **P0** | 需求结晶门（§2） | ★★★★★ | 低（纯 skill 改动） | 防 agent 顺惯性开工，零代码，即时止血 |
| **P0** | git 提交归属 trailer（§3.3） | ★★★★☆ | 极低（一行模板 + 一条规则） | 零成本让 otter 自我开发可审计 |
| **P1** | 能力文本版本锚 | ★★★★☆ | 中 | 解决"行为变了不知是哪版 prompt"的真实痛点 |
| **P1** | tool teaching 三信道 | ★★★★☆ | 中 | 用最高频信道塑造行为，比堆 prompt 划算 |
| **P1** | 反思胶囊规则修订扳机（§5） | ★★★★☆ | 低 | 补上 skill 系统 PDCA 的"Act"一环 |
| **P1** | ARC 软熔断 | ★★★☆☆ | 中 | 比 session reset 更温和的中间形态 |
| **P2** | 架构规则可测试化 | ★★★☆☆ | 高 | 等批次 3 启动时再评估 |
| **P2** | token 可观测（§3.1） | ★★★☆☆ | 中 | 非当前瓶颈 |
| **P2** | alpha 隔离（§3.2） | ★★☆☆☆ | 中 | R1 红线已等价兜底 |
| **P2** | 值班室隐私围栏（§6） | ★★☆☆☆ | 中 | 当前非痛点，多用户时回读 |

---

## 9. 系统性教训：自我狗粮的五个发现

从砍单审计、反思胶囊、ADR-022 提炼的系统教训：

1. **"承诺面"比代码面先烂**：AI 生成文档成本趋零，导致"想象中的系统"膨胀速度远超真实系统。教训：把"承诺面审计"当例行动作。
2. **宪法是方向感不是不变量**：机制每次长大都披着 ADR 合法外衣，但宪法文本没同步修订。教训：宪法级宣言要么配"违宪检测"，要么定期自我修订。
3. **重流程的前提是执行者几乎免费**：31 ADR + 架构门能运转，唯一原因是施工队是 LLM。otter 同理可承受重流程——但要警惕"人肉瓶颈"。
4. **AI 碰活运行时必须物理隔离**：alpha 环境 + 端口宪法是 tutu 不自爆的关键。
5. **度量自身流程才能改进**：review metrics + 反思胶囊 = PDCA 闭环。没有运行时数据的流程改进是拍脑袋。

---

## 参考文件

### 本文补正的原文

- R20260821tutv — tutu-vessel 多智能体社会运行时蒸馏

### tutu-vessel 仓库关键路径

- `src/domain/communication/episode-policy.ts` — ARC budget
- `src/domain/task/task.ts` — Task 状态机
- `src/domain/identity/harness-assemble.ts` — 身份组装纯函数
- `src/domain/scheduling/dispatch-policy.ts` — 调度器
- `src/domain/scheduling/invocation-job.ts` — 唤醒分级与合并去抖
- `src/application/observability/token-usage-*.ts` — token 可观测
- `crew-capabilities/identity/commit-attribution.md` — 提交归属
- `project-reflections/` — 反思胶囊
- `vision.md` — 愿景宪法（含砍单审计引用）
- `AGENTS.md` — 端口宪法 + alpha 隔离纪律
- `CONTEXT.md` — 通用语言（含 Crystallize Handoff / Duty Room 词条）
