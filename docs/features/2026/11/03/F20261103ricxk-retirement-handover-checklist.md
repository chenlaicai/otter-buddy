---
id: F20261103ricxk
title: 删旧机制前保护接管四栏检查表
summary: 案例回看发现删除保护只证单向安全、重写机制漏观测消费者；在既有负向验收与捷径审查中挂同一份四栏表，枚举不变量全集、原消费者和新机制接管，不新增审批人、决策权或常驻任务。
change_type: prompt
capability_test: "n/a：复用既有删除/替换流程的检查对象具体化，无独立 LLM 场景；锚点重放由异体检视獭评审"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: 2026-11-03T14:22:20+08:00
causal_links:
  from: [F20261103repro, F20261020wcsr, F20261029repin, F20261030gblkv, F20261030gcfbx]
tags: [process, review, retirement, invariants, handover]
modules:
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/code-implementation/references/retirement-handover-checklist.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
intent:
  problem: "删除/替换旧机制时，已有旧契约与捷径两问仍可能漏掉反向不变量和观测/测试消费者"
  expected_effect: "涉及删除或替换既有机制、保护、默认路径的 PR，作者交付四栏接管表，检视者据此核对双向状态迁移、异常路径和四类消费者；缺表或原约束答不出时报严重发现"
  verify_by:
    type: behavior_check
---

# 预注册

- 预期：唯一新文件 `retirement-handover-checklist.md` 含四栏表与填写纪律；`code-implementation` 的负向验收、`review-dimensions` 的正确性捷径审查各有一处指回该表。
- 行为变化：删除/替换旧机制不能只给单向安全证明；检视须核对运行时、观测、测试、文档消费者的接管。
- 非目标：不新增方向审查机制、审批人、机械闸、定时任务或决策归属；不重审已合入案例；不要求纯文档措辞调整填表。

# 背景与证据

- 2026-11-03 案例回看（本对话工作区 `direction-global-mechanism-case-review.md`，文件资源 `8444eb49-2fab-4314-a98b-a638c2f7a64e`）结论：既有机制有效，不新增方向审查机制，只具体化现有条款。
- #1575 / F20261020wcsr 删除账本时只证脱锚方向，#1703 / F20261029repin 后续纠正回锚保护裸奔；四栏表须显式列出双向状态迁移。
- #1711 / F20261030gblkv 重写 guard-v4 漏 `guard-intercept-classify` 等外部消费者，#1638 / F20261030gcfbx 后续重对齐；四栏表须覆盖观测/分类器与 mock 文案测试。
- 派工指定 `review-dimensions.md:90` 为「原路径」条款，但当前最新 main 的该行属 B9；实际语义锚点是正确性维度的「捷径审查」（实现时约 :107），按语义挂接。

# 方案与变更范围

| 文件 | 变更 | 目的 |
|---|---|---|
| `.pi/skills/code-implementation/references/retirement-handover-checklist.md` | 新增 | 四栏表唯一真相源与填写纪律 |
| `.pi/skills/code-implementation/SKILL.md` | 两处小改 | 负向验收挂表 + 参考索引挂表 |
| `.pi/skills/adversarial-review/references/review-dimensions.md` | 一处小改 | 正确性捷径审查挂同一表 |

四栏：被删/替换物；原保护的不变量全集（双向状态迁移、异常路径）；原消费者（运行时/观测/测试/文档）；新机制如何接管或不接管的显式风险接受。

## 设计取舍

- 机制识别：具体化已有负向验收与捷径审查，不设独立流程；不含新配置、状态、存储、信号或常驻任务。
- 机制预算：即使将「检查表」视作新检查对象，四问为——①删除/替换旧机制的实现者与对应检视者；②漏掉反向保护或观测消费者会在后续 PR/线上故障才暴露；③表格形式化填写由四栏具体内容、diff 对照与「证据不足」口径纠正，不新设自动审计；④连续真实 PR 显示表格重复且不改变枚举行为时，可收回为既有两问的一句补充，退役不新增机制。
- 决策者不变：作者填写，异体检视核对，风险接受仍归人；无审批权迁移。
- 守卫边界：只机械验证文件/引用/条款存在性与既有 lint，语义完整性标「半机械+异体审」，不假称有内容托底。
- 深潜：被删物→不变量→消费者→接管路径一表可下钻；残余风险必须显式写。
- 最简实现：新增一份短 reference + 两处引用，不复制三份表，不新增依赖或测试装置。

# 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 四栏定义 | 读取新 reference | 四栏标题完整，含双向迁移、异常路径、四类消费者与显式风险接受 |
| 作者接线 | 读取 code-implementation 步骤 6 与参考索引 | 删除/替换条款与参考索引均指向新 reference |
| 检视接线 | 读取 review-dimensions 正确性捷径审查 | 指向同一 reference，缺表/未答原约束为严重发现，不以有表代替核对 |
| 最小实现 | `git diff --stat` / `git diff --check` | 仅 3 个预期文件 + 本 F 文档，无方案外变更或 whitespace error |
| 既有规则兼容 | 跑 skills/docs/intent lint 与构建 | exit 0；本特性无 error |
| 锚点重放 | 交异体模型按核心 prompt 改动流程抽样评审 | 检视獭给出 VERDICT 与理由；实现者不自行宣称通过 |

# 验证记录

- `npm run build`：通过。
- `npm run lint:skills`：15 skills OK，14 个存量 warning；`npm run lint:docs`：972 docs OK，3 个存量 warning；`npm run lint:intent`：954 docs OK，本特性 intent / verify_by 均 1/1。
- `git diff --check`：通过；改动限定为 2 个既有 skill 文件、1 个新 reference 与本 F 文档。
- 首次 docs lint 因新 worktree 尚无 `dist/` 失败，构建后复跑通过，不掩盖初始失败。
- CI 与异体检视结果待填。
- Golden Gate：`verify_by=behavior_check`，本次无新增独立 LLM 场景；如仅 selftest 基建运行，记录为基建自检而非本特性执行记录。

# 风险

- 表格可能形式化：用逐行枚举、检索依据、具体接管路径与异体核对缓解；不承诺彻底消除共同盲区。
- 高杠杆 skill 文本改动：虽仅数行，仍走完整对抗审视与 CI；不能因「小 PR」降为纯文档免审。
- 案例回看为目的性抽样，只证明两类真实漏检，不证明检查表能降低总体缺陷率；后续真实 PR 才能验证效果。
