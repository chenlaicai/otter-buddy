---
id: F20261028evpkg
title: 机制落地第一批：证据化交付协议 + 爆炸半径调制 + 机制提案准入（P0/P1 公理机制化）
doc_type: feature
summary: |
  三视角讨论（R20261028hacab）落地包第一批 A+B+C：①R3 新增证据化交付协议
  （证据二分为机器锚点/agent 陈述标注未复验，锚点即深潜下钻入口）；
  ②R8 新增爆炸半径调制（同档升档，机械锚点判定，禁执行者自报）；
  ③新增 R8.5 机制提案准入（三问 + P0 负面清单防三踩）。
  配套：PR 模板补 Rollback 与证据分层字段、对抗审视基础维度加证据包核验、
  新增 check-pr-evidence.mjs 机械校验（非纯文档 PR 必须含证据段）并挂 CI。
change_type: prompt
capability_test: "n/a: prompt/skill/模板/CI 校验层，无 agent 工具轨迹变化；check-pr-evidence 以 fixture 自测"
intent:
  problem: "搭档的决策边界依赖自由文本交付：证据与叙述混排（agent 陈述可冒充已验证）、深潜成本高（结论到证据无下钻入口）、L0/L1/L2 无同档升档规则（影响面大的决策可被错降级）、被否机制模式无负面清单（同类方案三踩）"
  expected_effect: "改系统状态的交付含分层证据包与回滚信息；决策分级按爆炸半径机械升档；新机制提案必答三问、负面清单提案即驳"
  verify_by:
    type: behavior_check
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: 2026-10-28
causal_links:
  from: [R20261028hacab]
tags: [mechanism, evidence-package, decision-granularity, blast-radius, governance, ci-guard]
modules:
  - .pi/SYSTEM.md
  - .pi/skills/adversarial-review/SKILL.md
  - .github/pull_request_template.md
  - scripts/check-pr-evidence.mjs
  - .github/workflows/ci.yml
---

# F20261028evpkg 机制落地第一批：证据化交付 + 爆炸半径调制 + 机制提案准入

## 背景

搭档意图锚（原话）：

> 「ok。现在感觉方向基本对了。你开工」（2026-10-28 14:18，对三视角讨论落地包第一批 A+B+C 的拍板）

推导链上游：AI 雷达 10/28 第 4 条（R20261028hacab 三方讨论）→ 搭档两条批评定调 P1 公理（深潜=「人对agent产物的把控程度」；「并不能因为我的处理效率在这，你就降级成agent自动审批，那你这不就违反了更本质的 决策边界 吗」）→ 三视角收敛落地包（A 证据化交付+深潜入口 / B 爆炸半径调制 / C 准入三问+负面清单）→ 搭档拍板开工。

被否路径（P0 负面清单的依据，防三踩）：2026-10-23 搭档拍板「但巡检这件事没必要了」（F20261023attn）；2026-10-28 「随机深潜审计」（替人看）与「产出限流」（替人排优先级）被驳——同族模式「系统替人做人的环节」已被否三次。

## 目标

- **T1** 证据化交付协议进 SYSTEM.md R3：证据二分（机器锚点可复验=深潜下钻入口 / agent 陈述显式标「未复验」）、适用边界（改系统状态的交付）、机械校验绑定优先于自觉
- **T2** 爆炸半径调制进 SYSTEM.md R8：同档升档规则 + 机械锚点判定（文件数/路径杠杆/可逆性/影响面）+ 升档示例；风险接受权永远归人
- **T3** 机制提案准入（R8.5）进 SYSTEM.md：准入三问（决策者变了么/靠自觉还是靠守卫/深潜成本降了吗）+ P0 负面清单（提案即驳，含被否记录锚点）
- **T4** 配套落地：PR 模板补 Rollback 与证据分层声明；对抗审视基础维度加「证据包核验」；新增 `scripts/check-pr-evidence.mjs`（非纯文档 PR 的 PR body 必须含 Rollback 段与证据分层声明）挂入 ci.yml

## 非目标

- 把控闭环（第二批 D）与预测校准实验（E）不在本 PR
- 负面清单上的方案一律不做：换皮抽查/智能预审/自动巡检替人盯/产出限速替人排/「同类不用看」自动跳过
- 不做断言级全量索引、基线统计检测（克制清单，R20261028hacab 讨论定调）

## 机制识别检查点判定

逐项打勾（清单见 troubleshooting 修法决策树节）：

- ☐ 新增配置字段/枚举/开关 —— 未命中
- ☐ 新增状态生命周期 —— 未命中
- ☐ 新增定时任务/后台进程 —— 未命中
- ☐ 新增信号类型/消息格式 —— 未命中
- ☐ 新增持久化存储 —— 未命中
- ☐ 新增决策分支（结果被记住并影响后续行为） —— 未命中（check-pr-evidence 的 CI 红绿为运行时判定，不落记忆/配置）
- ☑ 新增跨模块调用路径 —— **命中**：ci.yml → scripts/check-pr-evidence.mjs 新校验链路（验收装置新件，同 check-pr-tests 先例）

判定「涉及净新增机制」→ 四问必答 + 重对抗门必过。据此 commit 声明 `Modification-Class: mechanism-addition`。

## 机制预算四问

① **谁需要它**：搭档（决策者）——风险接受的决策有了分层证据输入，深潜有下钻入口，信息成本下降；大獭/检视獭（核验者）——「机器锚点 vs agent 陈述」显形，核验从通读变抽查锚点；小獭（执行者）——交付契约明文（什么算「验证过」），减少自由发挥。角色具体，非「应该有」。

② **失败后果**：用户可感知损害存在——若证据包被敷衍填充（agent 陈述冒充机器锚点），搭档基于虚假安全感接受风险，**决策质量比无证据包时更糟**（信任错置）。机械校验只护「字段存在」，护不住内容真实性——由异体审（对抗审视 B 维度证据包核验）与「未复验」强制标注护住；伪造锚点可被点开复验戳穿。

③ **后续机制**：check-pr-evidence 创造的新状态是 CI 判定（绿/红），出错形态=误报卡 PR（合法 PR 过不去）或漏放（违规 PR 不带证据段溜过）；修法：误报按退役条件处置，漏放由异体审兜底。PR 模板新字段被填假 → 异体审+锚点复验显形。R8.5 让每个新机制提案多一步（成本），换来被否模式不三踩。加法接受的未来问题类：三件套各自的维护成本 + 与 check-pr-tests 等既有校验的 CI 时长叠加。

④ **退役条件**：出现「证据包字段齐全但搭档决策质量无改善」的可观察证据（对照：待办板 decision 类事项的翻案率/搭档核验单份交付耗时不降反升）→ 收缩字段或删除协议；check-pr-evidence 误报率可观察地高（同一 PR 因格式歧义反复卡）→ 修规则，修不好就下线该校验（协议本身保留人工核验）；负面清单若积累了与在用机制冲突的条目 → 逐条重议。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 证据分层粒度 | 二分（机器锚点 / agent 陈述标未复验） | 三级以上细分 | 分层目的是防「陈述冒充已验证」，二分已足够显形；细分徒增填写成本 |
| 机械校验射程 | 只查字段存在与触发条件（非纯文档 PR） | 查内容质量/锚点密度 | 语义不可机械判定（三视角共识：锚点密度检查明确排除），强行 lint 会误伤 |
| 触发口径 | diff 含非 `docs/` 变更即触发 | 全 PR 一律触发 | 纯文档/纯分析交付不强制证据包（防全量稀释，R20261028hacab glm 修正） |
| 爆炸半径判定 | 机械锚点（文件数/路径杠杆/可逆性/影响面清单） | 执行者自报半径 | 执行者天然低估自身风险（三视角共识）；自报=把裁判权交给利益相关方 |
| 负面清单位置 | SYSTEM.md R8.5 | 记忆库/特性文档 | 防三踩需要「提案时可见」；记忆召回时机晚于提案冲动 |
| 升档示例 | 3 个代表例（单 worktree/批量删分支/改 SYSTEM.md） | 全枚举 | 示例教学即可，规则锚点可推演；全枚举会腐烂 |
| R8.5 命名 | 独立小节挂 R8 后 | 并入 R2/R3 | 提案准入是决策分级的配套（谁能立机制），与 R8 同域；R2/R3 已满载 |

## 实现

| 文件 | 变更 |
|---|---|
| `.pi/SYSTEM.md` | R3 追加证据化交付协议 1 条；R8 追加「爆炸半径调制」段；新增 R8.5 机制提案准入（三问+负面清单） |
| `.github/pull_request_template.md` | Risks 段后新增 Rollback 字段；Verification 加「证据分层已标注」勾选 |
| `.pi/skills/adversarial-review/SKILL.md` | 基础维度表加「证据包核验」行（B 编号顺延为 B9）+ 报告模板表同步 |
| `scripts/check-pr-evidence.mjs` | 新增：diff 触发判定 + PR body 证据段机械检查（先例 check-pr-tests.mjs 模式，PR_BODY 环境变量/文件注入） |
| `.github/workflows/ci.yml` | pull_request 事件新增 check-pr-evidence step（注入 PR_BODY） |

## 验证

- `npm run check` 全绿（build/lint/lint:schema/smoke:boot/script-arg-parse 测试链）；lint:docs / lint:intent / lint:prompt-anchors 独立跑过 exit=0
- check-pr-evidence 判定固化为可持续测试 `tests/scripts/check-pr-evidence.test.ts`（21 断言：豁免集合/NUL 分裂/占位判定/分层两层/假绿回归组），由 `npm run test`（vitest）执行——CI test step 即机器锚点（S3 整改：一次性自述 fixture 升级为可复验测试）
- 重对抗门：**确认治本**（2026-10-28 检视獭-mech 门控，前置核查四问齐全后经记忆脉络（机制托底/巡检拍板/测试弱化声明闸/决策边界）判定），门控结论留痕本段
- 对抗审视：检视獭-mech 首轮 7 严重+1 建议（review 5678885943），逐条处置；delta 复核结论回写本段
- Golden Gate：verify_by=behavior_check（人工行为检查）——seriousness-mode-switch golden 场景采样记录（manualReview）见 PR Verification 节，判定留检视獭 delta 复核
