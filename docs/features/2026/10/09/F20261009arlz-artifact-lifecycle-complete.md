---
id: F20261009arlz
title: 产物清单生命周期完整修复：类型终态矩阵 + 机械兜底 + 注入瘦身
summary: 产物清单机制完整重构——三混杂（生命周期/场景/系统）分层修复：L1 类型×终态矩阵定义「什么叫活着」、L2 每日机械兜底自动归档机械可判死物、L3 合成 LLM 注入从全量列表瘦身到计数+最近5标题；配套存量33个active大清账
change_type: feature
capability_test: n/a（Golden Gate 豁免——behavior_check 人工核验型，非自动 gate 类）
intent:
  problem: "产物清单三混杂：生命周期（33 active 里 11 个已合入 PR + 2 个已删实体仍 active）、场景（合成 LLM §④ 注入全量 33 条僵尸列表挤上下文）、系统（archived 不影响记忆是有意设计但语义未显式化，无人归档）"
  expected_effect: "L1 类型×终态矩阵定义活死边界；L2 daily-health-check 产物对账段机械归档可判死物；L3 注入瘦身到计数+最近5标题，合成 prompt 减负；存量 33 active 清账"
  verify_by:
    type: behavior_check
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  from:
    - F20260720k3m7   # artifact-lifecycle-management（原始生命周期模型）
    - F20260901mbfx   # 机械预取供料（合成 LLM §④ 全量列表的来源）
    - F20261009csf3   # 关键资源 tab 退役（留下「双轨冗余待整合」尾巴）
---

# 产物清单生命周期完整修复

## 背景与实证（全链路调查结论）

搭档三连问（「为什么注入/每轮都注入吗/与平时上下文通用吗」）逼出产物清单机制的**三个混杂维度**。实证锚点全部为本次调查实际工具调用返回：

### 混杂 1：生命周期——33 个 active 里僵尸过半

本对话（325ef7b7）`list_artifacts(status: active)` 实返 33 个，抽查分类：

| 类别 | 数量（约） | 实例 |
|---|---|---|
| 已合入 PR 仍 active | 11 | #997/#1018/#1021/#1022/#1023/#1024/#1027/#1362/#1377/#1380/#1352 |
| 已删实体仍 active | 2 | selftest worktree（目录已删）、collab-scene-forms 分支（已删） |
| 任务已闭环的方案文档 | ~8 | 冲突解决机制、信任校准、版本门评估×2、kimi 记忆可见性提案等 |
| 「合入事实」类 fact | ~10 | 「PR #1362 合入」「PR #1377 合入」等完成通知 |
| 真活着的 | ~5 | 本对话近期工作区草稿 |

**根因**：生命周期管理只有制度没有机制。post-merge-cleanup skill 步骤 7 明写「PR 已合入且 pr/worktree/branch 类仍 active → archived」，但该 skill 只在「善后」触发时执行——搭档手动合入（本对话主流形态：「已合入」一句话）后无人跑清理，状态就永远挂着。原始生命周期模型（F20260720k3m7:49 `active → superseded → archived`）定义了状态机，但没有定义**各类型什么时候该迁**。

### 混杂 2：场景——同一份清单，三个消费者三种需求

| 消费者 | 现状 | 真实需求 | 判定 |
|---|---|---|---|
| 常态獭上下文 | **零注入**（buildMessageWithContext 只注入 roster+时间+未读消息，dispatch-chain-engine.ts:864-870） | 不需要（消息流+主动调 list_artifacts 足够） | ✅ 无问题 |
| restart 交接档案 §⑤（新 session 起始注入） | 计数+最新标题一行（state-inventory.ts:230-233：「产物：33 active｜ 最近：PR #1380」） | 一行级现场地图 | ✅ 形态合理，但计数被僵尸污染 |
| 交接**合成 LLM** §④（写前世叙事摘要用） | **全量标题列表**（synthesis-prompt-builder.ts:166-167，33 条全列） | 只需「最近几个活着的」写摘要句 | ❌ 信噪比崩坏：从过半僵尸的垃圾堆里挑「最近」 |

混杂 2 的核心：§④ 的全量列表是 F20260901mbfx 为「合成 LLM 别漏调工具」做的机械供料——解决了「漏查」，没解决「33 个里哪些值得交接」。两个消费者的诉求被同一份未过滤清单糊在一起。

### 混杂 3：系统——产物 vs 记忆双轨语义不一致

- 产物登记时同步 seed 进记忆（manage-key-info.ts:101——fact 类进 fact 记忆，其他进 linked_resource 记忆）
- **但 archived 不影响记忆**：产物归档后记忆条目仍在、search_memory 照常命中
- 这本身是对的（历史可检索是记忆系统的职责），但语义要显式化：「产物系统的 archived ≠ 消失，= 退出活跃清单，记忆侧永久保留」。F20261009csf3 留下的「双轨冗余待整合」尾巴即此。

## 目标

1. 产物清单的 active 集合 = 真活着的产物（误差可机械审计）
2. 每个产物类型有显式的终态判定规则（机械可判的机械判，不可判的纪律判）
3. 交接链路的注入面只承载「活着的」，且形态与各消费者真实需求匹配
4. 存量 33 个 active 一次性清账

## 非目标

- **不动**产物 → 记忆的 seed 管道（历史可检索性是有意设计，不破坏）
- **不做**产物链血缘可视化（P3，搭档已拍板缓行）
- **不改** buildMessageWithContext 常态注入（实证无问题，不为改而改）
- **不引入**新的运行时组件（衰减判断寄生在既有 daily-health-check 定时任务，零新基建）

## 方案设计

### L1：类型 × 终态矩阵（定义「什么叫活着」）

| 类型 | 终态判定 | 判定方式 | 目标终态 |
|---|---|---|---|
| pr | 对应 GitHub PR merged/closed | **机械**（gh api 可查） | merged → archived |
| worktree | 路径已不存在 / PR 已合入 | **机械**（fs.existsSync + PR 状态） | → archived |
| branch | 远程分支已删 / PR 已合入 | **机械**（git ls-remote + PR 状态） | → archived |
| file | 无机械终态 | **纪律**：feature 收尾时随清理流程归档 | 不变（维持 active 直至人工） |
| fact（决策/教训类） | 无机械终态 | **纪律**：同上 | 不变 |
| fact（「合入事实」类完成通知） | PR 合入即完成 | **机械**：这类 fact 的归宿是记忆系统（已 seed），产物侧随对应 PR 归档 | → archived |
| url | 无机械终态 | **纪律** | 不变 |

关键取舍：**file/fact/url 不做自动过期**——无法机械判定一份方案文档是否「还有用」，误归档比不清理更糟（会把活着的地图撤掉）。这三类靠 post-merge-cleanup 纪律 + 每日提醒兜底。

### L2：机械兜底（把死的挪走，寄生既有定时任务）

在 `prompts/scheduled/daily-health-check.md` 的「必须检查的数据源」节后新增**产物清单对账段**（不改 scheduler 代码，纯 prompt 层）：

1. **机械可判自动归档**（本任务直接执行，不开 issue）：
   - pr 类 active 产物：`gh pr view <N> --json state` 返回 MERGED/CLOSED → `update_artifact_status` → archived。解析不出 PR 号的**跳过不判**（fail-safe：漏判留 active，不误杀）
   - worktree 类 active 产物：url 路径 `test -d` 不存在 → archived；存在但对应 PR 已合入 → archived
   - branch 类 active 产物：对应 PR 已合入 → archived（git ls-remote 判定分支删除成本高于收益，不做）
   - 「合入事实」类 fact（title 含「合入」且关联 PR 已合入）→ archived（其长期载体是记忆系统——登记时已 seed，产物侧只是完成通知的临时展位）
2. **纪律类提醒**（不自动动）：file/fact/url 类 active 产物单对话 > 10 → 在日报中列出清单，提醒大獭走一轮人工归档判断
3. **报告格式**（产出表固定行）：`产物对账: 归档 N ｜ 存量 active M ｜ 待人工 K`

### L3：注入瘦身（活着的才进注入面）

**合成 LLM §④**（synthesis-prompt-builder.ts formatPrefetchSection）：
- 现状：全量标题列表一行流（33 条约 1.5-2KB）
- 改为：`active 产物（N 个，最近 5 个）: <最近5条，按 createdAt 倒序>`
- N > 15 时追加一行警示：`（active 产物超 15 个，清单可能含僵尸，建议走产物对账）`——让计数本身成为健康信号
- 数据源不变（仍是 buildSynthesisPrefetch），只在渲染层截断 + 排序；prefetch 类型补 createdAt 字段

**交接档案 §⑤**（state-inventory.ts）：
- 维持一行现状（「产物：N active｜ 最近：title」），不动——L2 兜底后 N 回归真实，本行自动恢复信息量

### 存量清账（随本 PR 一次性执行）

按 L1 矩阵对当前 33 个 active 逐个判定，机械可判的全部归档（预计 ~23 个），纪律类保留（预计 ~10 个工作区草稿/方案文档）。清账在 worktree 内用 alpha 隔离实例**演练一遍产出清单**，对**主库**的实际归档操作在 PR 合入后由大獭当场执行（产物数据是运行时状态非 git 资产，不进 PR diff；操作明细写入 PR 描述供终审核对）。

## 影响范围

| 文件 | 改动 | 性质 |
|---|---|---|
| `prompts/scheduled/daily-health-check.md` | 新增「产物清单对账」段（~14 行）+ 出清存量冗余保持预算内 | prompt 层，主交付 |
| `src/frameworks/agent/synthesis-prompt-builder.ts` | formatPrefetchSection 截断+排序+超量警示；SynthesisPrefetch 类型补 createdAt | 代码，L3 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | buildSynthesisPrefetch map 补 createdAt 透传 | 代码，L3 |
| `tests/frameworks/agent/synthesis-prompt-prefetch.test.ts` | 新增截断/排序/警示用例 | 测试 |
| 特性文档 | 本文档 | 文档 |

明确不改：state-inventory.ts、manage-key-info.ts、buildMessageWithContext、post-merge-cleanup skill（其步骤 7 纪律保留，L2 是它的机械兜底而非替代）。

## 取舍与风险

| 取舍 | 选择 | 理由 |
|---|---|---|
| 衰减机制寄生 daily-health-check vs 独立定时任务 | 寄生 | 零新基建；每日一次频率对产物清理足够 |
| file/fact/url 自动过期 | **不做** | 误归档 > 不清理；机械判不了的给纪律 |
| 存量清账走 PR diff vs 运行时操作 | 运行时操作 | 产物状态是 DB 数据非 git 资产；明细进 PR 描述供审 |
| 「合入事实」fact 归档 | 归档（记忆侧保留） | 它的长期载体是记忆系统，产物侧只是完成通知的临时展位 |
| §④ 全量 → 最近 5 个 | 截断 | 合成 LLM 只需写一句「最近：XXX」，5 个足够取材；全量 33 个纯噪音 |
| daily-health-check 体积 | 出清存量冗余换空间 | budget_bytes=9600 硬闸（F20260917pbgg 体积预算闸），加一减一纪律 |

风险：
1. **机械误判**：pr 类产物与 PR 号的关联靠登记时的 url/title 解析，解析失败的跳过不判（fail-safe 方向：漏判留 active，不误杀）
2. **L2 与 post-merge-cleanup 双执行**：同一产物可能被两处归档——update_artifact_status 对已 archived 的再操作会 conflict 报错（非幂等，`src/entities/conversation/conversation.ts:124`），但 L2 对账段仅对 active 产物操作（list 过滤 active），双执行安全靠「只动 active」的入口过滤而非幂等性，无冲突
3. **体积出清误删活规则**：出清对象是与 SYSTEM.md A1 重复的指针段、括号内冗余注记等纯冗余；行为指令/操作法不动（对抗审视发现出清曾误删 5 处操作法——golden 软代码 PR 识别法/healing query 50 条上限/hook fallback 计入异常/双链不一致提 issue/分组 batch_bind，已全部恢复）

## 验证

1. 单测：formatPrefetchSection 截断/排序/警示逻辑用例全绿
2. alpha 实例演练存量清账：对 33 个 active 跑 L1 判定逻辑，产出「归档清单」与人工抽查一致
3. daily-health-check 下次执行时产物对账段正常产出（合入后观察）
4. 全量测试 + build 绿
