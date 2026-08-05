---
id: F20260805wfsd
title: proactive-workflow-triggers
doc_type: feature

summary: |
  让 otter 具备"某类任务自动走对应流程"的主动性：方案/PR 完成后自动对抗审视、架构师技术问题自行拍板（worktree 隔离为既有 repo-safety 能力，本特性不改动）。
  核心动机：这些行为此前依赖搭档每次主动提醒，缺的是"何时必须做"的触发，而非"怎么做"的 know-how。
  主机制：SYSTEM.md 只加一条元原则（流程纪律）做委托，职权进身份层，触发与流程步骤全部内置进 skill——消灭"事后触发"，改写成"流程内置步骤"。

status: development
change_type: prompt
tags: [agent, skill, workflow, prompt]
modules:
  - .pi/SYSTEM.md
  - prompts/identity/BIG_OTTER.md
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/code-implementation/references/commit-convention.md
  - .pi/skills/requirement-analysis/SKILL.md
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/report-template.md
  - .pi/skills/otter-summon/references/collaboration-patterns.md
  - .pi/skills/repo-safety/SKILL.md
---

# F20260805wfsd: 主动行为触发——元原则委托 + 流程内置步骤

## 背景与动机

搭档在使用 Claude Code 时沉淀了四条"越用越好用"的主动行为：特性开发自动建 worktree、架构师自行决策技术问题、创建设计文档后自动对抗审视、PR 提交/更新后自动对抗审视。希望在 otter 系统中让 agent 具备同样的主动性——某类事触发对应处理，不需要每次主动提。

分析 Claude Code 侧机制后确认：这四条行为没有一条是工程 hook 实现的，全是"规则常驻上下文 + 模型按场景自觉执行"。因此 otter 侧的主信道也是 prompt 注入，工程触发器只作兜底。

## 关键设计决策

### 决策 1：分层——SYSTEM.md 不放具体规则

初版方案曾把四条触发规则直接塞进 SYSTEM.md，被搭档否决。最终分层：

| 层 | 内容 | 本次改动 |
|---|---|---|
| SYSTEM.md（每轮必达） | 价值观/心智 + **一条元原则** | 新增"流程纪律"：有 skill 覆盖的工作先 read skill 再动手；流程未走完不算完成 |
| 身份文案（首次注入） | 职权与人格 | BIG_OTTER.md 新增"技术决策权"：技术问题自行拍板，搭档只管产品愿景 |
| skill description（常驻索引） | 触发条件 | adversarial-review 增加方案/文档审视触发词 |
| skill 本体（懒加载） | 完整流程 | code-implementation 加 step 8（PR 对抗审视）；requirement-analysis 加 step 6（方案对抗审视） |

依据：system prompt 塞操作性规则会稀释真正铁律的显著性（注意力稀释），且模型容易把流程当人格泛化，出现刻板过度执行。SYSTEM.md 只保留一条元原则做"委托"——宪法只管"遵守既定程序"，程序本身在 skill。

注：SDK 内置指令已含"task matches description 时 read skill"（pi-coding-agent `formatSkillsForPrompt`），元原则前半句与之功能重叠；真正的新增量是后半句"流程未走完，任务不算完成"——把"完成"的定义权从模型自我感觉移交给流程。

### 决策 2：消灭"事后触发"，改写为"流程内置步骤"

触发可靠性不取决于内容类别，取决于**决策时刻 token 是否在场**。两类触发可靠性不同：

- **任务入口触发（可靠）**：用户消息本身与 skill description 匹配，是模型最强的模式识别。worktree、先读 skill 等走这条路。
- **自我动作后触发（脆弱）**："我刚写完文档 → 该审视了"的触发源是模型自己的动作，此刻模型认知状态是"任务快完成了"，最容易漏。

因此文档审视、PR 审视不设计为独立的事后触发规则，而是**写进任务流程的内部步骤**："完成"的定义权在流程里——方案落盘 ≠ 定稿，PR 创建 ≠ 交付完成。模型在任务入口（可靠触发）加载流程后，审视只是它正在执行的流程里的下一步。

### 决策 3：审视者必须独立

两条审视步骤都要求召唤检视獭（独立小獭）执行，而非大獭自审——自己写自己审等于没审。搭档明确说跳过时，记录决策后放行（不阻断搭档的最终决定权）。

### 决策 4：adversarial-review 扩展到方案/文档审视

原 skill 只面向代码变更。新增文档审视的维度适配表（6 维度映射）与"独立核实"的文档版定义（方案中的事实性断言必须对照代码亲验）。description 增加"审查方案/审视文档/评审设计/挑挑毛病"触发词。

## 与既有原则的关系

- **信道分层**（F20260724skch）：本特性是其精细化——硬规则不再一概而论上必达信道，而是拆成"元原则（必达）+ 触发条件（常驻索引）+ 流程全文（懒加载）"三级，token 成本与可靠性各归其位。
- **机制约束优先让 LLM 理解**：本次零代码改动，纯 prompt/skill 层。若观察期发现某条流程反复不走（尤其"流程内置步骤"失效退化为事后触发），再升级到工程兜底（备选挂点：invoke 后置检查 `agent-invoker.ts` `_handlePostInvocation`，或派发层 `DispatchChainEngine.buildMessageWithContext`）。

## 改动清单

1. `.pi/SYSTEM.md`：核心原则新增"流程纪律"一条
2. `prompts/identity/BIG_OTTER.md`：新增"技术决策权"章节
3. `.pi/skills/code-implementation/SKILL.md`：新增 step 8「PR 对抗审视」
4. `.pi/skills/requirement-analysis/SKILL.md`：新增 step 6「对抗审视」
5. `.pi/skills/adversarial-review/SKILL.md`：description 加文档审视触发词；新增"审视对象是方案/设计文档时"维度适配小节；step 3 补无执行权限审视者的降级核实标准；report-template.md 补文档审视适配
6. `.pi/skills/code-implementation/references/commit-convention.md`：PR Workflow 同步新审视流程
7. `.pi/skills/otter-summon/references/collaboration-patterns.md`：循环模式补轮次上限
8. `.pi/skills/repo-safety/SKILL.md`：划界——非方案驱动小改动不强制审视

## 对抗审视记录

### 第 1 轮（2026-08-05，独立审视 agent）

8 项发现（7 项处置 + 1 项不处理），处置如下（本 PR 的审视按惯例由搭档对治理类问题拍板、技术类由架构师处置——这正是本特性要确立的划界）：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 2.1 | 阻断 | 检视獭（小獭）无 bash：拿不到 PR diff、跑不了测试，step 8 指定的执行者无法执行核心步骤 | 已修：step 8 明确召唤时须在 systemPrompt 附 `gh pr diff` 全文或变更文件清单+关键文件内容；adversarial-review 补降级核实标准（无执行权限=逐行静态核验，无法跑测试须如实标注） |
| 3.1 | 阻断 | BIG_OTTER"技术问题自行拍板"与 requirement-analysis step 6"逐条呈搭档拍板"指令冲突 | 已修（搭档拍板划界）：纯技术取舍大獭拍板并记录；涉及产品方向/资源投入/对外承诺的呈搭档。两处文本同步改写 |
| 4.1 | 建议 | PR 审视循环无收敛条件，修→审可无限烧 token | 已采纳：同一 PR 审视不超 2 轮，仍有未决呈搭档裁决 |
| 3.2 | 建议 | step 7.3 "wait for another person" 与 step 8 接缝不清 | 已采纳：删除 7.3，终审并入 step 8.4"审视通过后呈搭档终审" |
| 1.1 | 商榷 | 元原则前半句与 SDK 内置 read-skill 指令冗余 | 已采纳：本文档决策 1 补注说明真正增量是"完成定义权移交"；SYSTEM.md 文本不动（重叠无害，元原则是价值层表述） |
| 2.2 | 建议 | 身份层仅首次注入，session 压缩后"技术决策权"可能衰减丢失 | 记录观察：若观察期发现职权遗忘，再提升进 SYSTEM.md 元原则层 |
| 4.2 | 商榷 | "跳过审视"判定标准模糊，随口一句可能被当成放行 | 已采纳：两处文本写实为"明确表示'跳过审视/不用审'" |

中英混排（3.3）：不处理，repo 已有中文小节先例，不影响模型理解。

### 第 2 轮（2026-08-05，独立审视 agent）

结论"可以合入"。第 1 轮阻断项修复全部确认落实，step 8 流程顺序自洽，2 轮收敛与"unresolved → 需要修改"的权责交互清晰（审查者说问题，搭档说合入与否）。4 项新发现均为建议/商榷，由架构师拍板全部采纳：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 2.1 | 建议 | 方案审视循环无收敛上限，与 PR 审视不对称 | 已修：requirement-analysis step 6.3 对齐为"不超 2 轮，未决呈搭档裁决" |
| 2.2 | 建议 | commit-convention.md 的 PR Workflow 残留旧流程（"another person reviews"），稀释审视步骤存在感 | 已修：PR Workflow 插入"召唤检视獭对抗审视"步骤，终审改为搭档 |
| 2.3 | 建议 | 降级核实是检视獭常态，Test Coverage 维度的独立核实名存实亡 | 已修：step 8.1 要求附上测试/构建运行结果（标注实现者自报）供静态核验 |
| 3.1 | 商榷 | 第 1 轮记录计数不符（7 项 vs 实为 8 项） | 已修：改为"8 项发现（7 项处置 + 1 项不处理）" |

### 第 3 轮（2026-08-05，独立审视 agent，PR 级整体检视）

结论"可以合入"。8 项发现无阻断，全部采纳（架构师拍板）。本轮关键价值是抓到一个根因：**小獭 session 的 cwd 是主仓**（`pi-session-factory.ts:372` `SessionManagerClass.create(process.cwd(), ...)`），read 相对路径拿不到 worktree 文件——第 1 轮"附 diff"只修了这个根因的一半。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | 建议 | requirement-analysis step 6 没把"方案在哪"交给检视獭（与第 1 轮阻断项同型漏洞修了一半） | 已修：step 6.1 明确附方案全文或 worktree 内绝对路径 |
| 2 | 建议 | 检视獭静态核验会读到主仓旧代码，基于错误对象得出"已核实"结论 | 已修：step 8.1 要求附 worktree 绝对路径，静态核验以 worktree 内文件为准 |
| 3 | 建议 | otter-summon reference 残留"循环直到检视通过"，与 2 轮封顶冲突 | 已修：改为"直到通过或达轮次上限，超限呈搭档裁决" |
| 4 | 商榷 | 身份层"技术决策权"与 SYSTEM.md"拿不准先确认"接缝未处理，且必达层注意力权重压过首注层 | 已修：技术决策权补"拿不准的技术问题先自行调研论证，仍无结论再呈搭档，优先于一般确认原则" |
| 5 | 商榷 | diff 塞 systemPrompt 每次 invoke 重发计费且不可更新 | 已修：step 8.1 允许 diff 落盘给路径（大 PR 推荐）；step 8.2 补第 2 轮操作方式（消息带新 diff 或 dissolve 重建） |
| 6 | 商榷 | F 文档 summary 把"自动建 worktree"列为本特性交付，diff 无对应行 | 已修：summary 注明 worktree 为既有能力、本特性不改动 |
| 7 | 建议 | report-template 未适配文档审视（"可以合入一个方案"语义错位） | 已修：模板补文档审视适配（合入→定稿，测试/构建检查项替换） |
| 8 | 商榷 | repo-safety 最小流程无检视獭环节，小改动 PR 是否过审视无制度答案 | 已修：repo-safety 划界——非方案驱动小改动不强制审视，直接呈搭档终审 |

根因观察：小獭 cwd=主仓 这一事实对"召唤小獭处理 worktree 产出"的所有场景都有影响，不仅审视。若后续同类问题再现，可考虑工程层解决（小獭 session cwd 指向 worktree 或注入 worktree 路径上下文），本次以 prompt 层传递绝对路径为准。

### 第 4 轮（2026-08-05，独立审视 agent，修复验证 + 认知负荷盲区扫描）

结论"可以合入"。第 3 轮修复逐项亲验全部落实（含"systemPrompt 不可更新""read 无目录囚禁"两个机制断言亲验属实）；接力链 core-workflow → repo-safety → code-implementation → otter-summon → adversarial-review 构成 DAG 无死结。6 项新发现（0 阻断）全部采纳：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | 建议 | repo-safety"小改动"无判定标准；"非方案驱动的非小改动"三分类空洞；分类裁判是实现者自己（自我服务分类） | 已修：小改动=不改变运行时行为的改动；归属模糊按方案驱动处理走 step 8，默认从严 |
| 2 | 建议 | diff 落盘位置未指定，落进 worktree 会污染 git status | 已修：step 8.1 补"落盘到仓库外如 /tmp" |
| 3 | 商榷 | dissolve 重建检视獭时第 1 轮上下文带不带，上下文传递与 fresh-eyes 两原则方向相反 | 已修：step 8.2 裁决——重建附齐材料，不附第 1 轮发现，保持 fresh eyes |
| 4 | 商榷 | 文档审视适配未覆盖 step 1 与检查单前两项 | 已修：SKILL.md 适配小节补 step 1 读法；report-template 检查单四项全部适配 |
| 5 | 商榷 | step 8.1 病因描述字面不准（相对路径其实读得到，危害是解析到主仓旧代码） | 已修：两处改为"相对路径会解析到主仓旧代码" |
| 6 | 商榷 | PR body 与实际 diff 不同步（Changes 清单缺 3 文件，Test plan 仍写两轮） | 已修：gh pr edit 更新 |

附带观察（非发现）：搭档直接说"帮我审视下这个方案"时，大獭自审与召唤检视獭两条路都匹配，搭档直接指令优先，不构成缺陷。

## 验证

- prompt 类改动无单测；验证方式为行为观察：后续会话中大獭在方案产出、PR 创建后是否自动召唤检视獭
- 若需回归证据：用真实任务走一遍「需求分析 → 方案 → 审视 → 实现 → PR → 审视」全链路
