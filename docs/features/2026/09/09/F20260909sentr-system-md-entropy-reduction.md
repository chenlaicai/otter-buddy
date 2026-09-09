---
id: F20260909sentr
title: SYSTEM.md 对抗熵减重构：内容牵引力审查 + 元信息出清 + know-how 就近就业
summary: SYSTEM.md 两周从 11.9KB 膨胀到 20.9KB（+75%，每次 PR 只加不减）。搭档定调判据为「内容对每轮行为的真实牵引力」而非字节数（"为了追求少直接不写就最完美了——要抓核心，审视内容"）。逐句三问审查（①每轮需要吗 ②删掉行为变吗 ③指令还是元信息）后重构：320 行/20.9KB → 110 行/7.9KB，7 处 F 编号/issue 引用清零；元信息与决策史回本特性文档，场景型 know-how 就近就业（单源定为 daily-health-check.md / 工具 description 指针）。经 mimo（米宝）+ kimi（知宝）两轮独立对抗审视，17 条发现采纳 14 驳回 3。
change_type: prompt
capability_test: "n/a: prompt 重构，行为不退化由落地后首轮观察 + 每日 health-check 验证（审视留痕见 §对抗审视处置）"
created_in_conversation: e56d27af-e11a-4406-980c-45e0654ae98d
tags: [prompt, system-prompt, entropy-reduction, refactor]
intent:
  problem: "SYSTEM.md 两周 +75%（11.9KB→20.9KB），典型熵增：每次事故补丁默认落全局纪律层，无人问「这条教训的最小生效面在哪」；自定的双轨 digest 阈值（15KB）已超 39% 但从未触发——阈值是死文本不是活机制；元信息/决策史/出处装饰混入每轮必达的行为指令层"
  expected_effect: "SYSTEM.md 只含每轮有真实行为牵引的指令；元信息/决策史归特性文档与 git 历史；场景型 know-how 在生效场景就近可得（daily prompt / 工具 description）；新增内容有三问判据把关"
  verify_by:
    type: behavior_check
    detail: "落地后首轮观察：R7 溯源行为保持（一行/含锚点/不伪造/不贴原始列表）、Magic Words 拉闸语义不变、issue 创建标签合规率不回退（lint-issue-labels.mjs 每日审计）"
modules:
  - .pi/SYSTEM.md
  - scripts/lint-issue-labels.mjs
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
from: [F20260826mwrd, F20260825hndf, F20260907itri, F20260716t2ab]
supersedes: []
created_at: 2026-09-09
---

# SYSTEM.md 对抗熵减重构

## 背景与判据

搭档发起系统提示词优化（2026-09-09 09:58）：「从现状去分析历史过程，看看现状如何，做对抗熵减」。

**判据（搭档 10:16 定调）**：「阈值就是一个参考，而不是目标。如果为了追求少，那直接不写就最完美了。咱们要抓问题的核心，是审视内容！」——字节数是仪表不是靶子，唯一判据是**每一句内容对执行 LLM 每轮行为有没有真实牵引力**。

**熵增机制（现状归因）**：不是错误累积，而是**正确决策无回收机制的必然产物**——每一次事故后的补丁都默认落在全局纪律层，没有人问「这条教训的最小生效面在哪」。文件内每一个字都是"当时对的事"。

## 审查方法

逐句三问：①执行 LLM 每轮需要它吗？②删掉会真实改变行为吗？③它是行为指令还是元信息/决策史？

原文分层结论：约 40% 行为指令（该留）/ 35% 好内容放错层（该搬家）/ 25% 元信息与决策史（该回本特性文档）。

## 处置明细

### 保留并收紧（留在 SYSTEM.md）

对话环境 / A1-A5 本体 / W1-W2 / R1 红线 / R2 Skill Chain 主体 / R3 弹性约定 / R4 四场景清单 / R5 healing tag 格式 / R6-R7 重写 / Magic Words 两词表 / 獭间信号协议 / 优雅交接约定压缩版 / 「使用中文与搭档交流」。

### 搬家（就近就业）

| 内容 | 去处 | 理由 |
|---|---|---|
| Issue 标签规范全量（枚举释义、模块清单、审计口径） | **单源定为 prompts/scheduled/daily-health-check.md**（规范本在其 96-101 行；LLM 创建 issue 主路径是 daily 任务）；lint-issue-labels.mjs 头部单源声明同步翻转；SYSTEM.md R2 只留一行行为层兜底 | 查表型 know-how，场景上下文就近可得 |
| 交接摘要五段模板 + 谱系模板 + 填写要点 | 本特性文档附录（restart_otter description 加一行指针） | 知宝 S2：工具 description 与 SYSTEM.md 同为每轮常驻注入，「搬进 description = 减负」是错误论证；且 prompt 入代码后迭代须走 PR |
| set_context 用法示例 | set_context 工具 description TIP（体量小，随调用注入场景精度更高） | — |
| Magic Words 已删除词决策史 / 双轨 digest 阈值节（含灰度 A/B 方案） | 本特性文档附录 | 元信息/规划文档，对执行零牵引 |

### 删除

7 处 F 编号/issue 引用（#468、#352、F20260907itri×2、F20260814mbex、F20260826mwrd×3、F20260825hndf）——出处装饰，溯源走 git blame 与本特性文档（#835 三分类同构）；R3 两条 blockquote 注；R4「两层约束」辩护段。

### 新增

SYSTEM.md 末尾新增「本文件的增长纪律」节：三问判据制度化，替代失效的双轨阈值自监。

## 对抗审视处置（两轮独立审视，17 条发现：采纳 14 / 驳回 3）

**米宝（mimo）轮**：S2 采纳（R7 恢复「不贴原始检索结果列表」——防呆非元信息）；S3 部分采纳（A1/A2 根因块含行为锚点——「100x 速度放大偏移」「讨好掩盖问题最终损害搭档利益」改正文表述保留，W2「执行不等于认同」扩写恢复；A3/A5 根因块仍删）；F1-F3 采纳；F4/F5 驳回（lint 反馈回路在位 / 工具 TIP 场景精度更高）。

**知宝（kimi）轮**：S1 采纳（R4 场景 2 路由判据静默删除，恢复）；**S2 采纳并推翻方案机制认知**——「搬家到工具 description = 减负」论证模型错误，description 同为每轮常驻注入（tool-factory.ts:432 核实），交接模板改落特性文档 + 指针；F1 采纳（lint 脚本头部 LLM 读不到，单源定为 daily-health-check.md）；F2/F3/F5/F6/F8/F9 采纳；F7 采纳（阈值节移特性文档 + SYSTEM.md 留增长纪律节）；F4 驳回（R1 preamble 场景枚举属括号补丁式写法，与搭档 UA-3/UA-4 定调冲突）。

完整处置留痕见对话工作区 `system-md-entropy-reduction-v1.md`（conversation e56d27af）。

## 机制认知沉淀（本轮最大教训）

**「搬家到工具 description = 减负」是错误模型**。工具 description 与 SYSTEM.md 同为每轮常驻注入（每请求随 tools 参数上行），位置移动不产生 token 收益。搬家唯一成立的判据是**场景精度**（内容在使用场景就近出现，牵引时机更准），不是体积。以后所有 prompt 瘦身提案先过这一问。

## 附录 A：双轨 digest 阈值节（原文存档）

> 当前 SYSTEM.md 约 8KB ≈ 2000 token，在 200K context 中占 1%。等增长到 ≥ 15KB（≈ 4000 token，占有效上下文 ≥ 2.5%，加上身份文案 + 工具描述 + session 历史接近 10%）时，考虑拆双轨：完整版给维护者读，digest 摘要注入 prompt。
>
> 灰度方案：SYSTEM.md 是全局 SDK base，无法 per-otter 灰度。重组后用隔离实例（独立端口 + DB + 真 LLM）做 A/B 行为对比测试，验证 A1-A5 / W1-W2 / R1-R7 不退化。

处置：该节自 8/24 写入至删除前（20.9KB，超阈值 39%）从未触发任何行动——死文本自监无效，由「本文件的增长纪律」三问判据替代。灰度 A/B 方法论保留于此备查。

## 附录 B：交接摘要模板（restart_otter summary 用）

```markdown
## 交接摘要
{otter名} | {ISO时间} | 触发: 手动

### ① 下一步
- 立即动作：{具体可执行}
- 阻塞于：{无/等谁}

### ② 当前任务
- 任务：{一句话}
- 完成标准：{可判定}
- 状态：{in_progress/awaiting_review/awaiting_user/blocked}

### ③ 关键决策（最多 5 条）
- {决策} ← {理由} 〔锚点: Fxxx/msg/entry_id〕

### ④ 产物与锚点
- PR/文档/记忆/工作区文件/otter_context keys

### ⑤ 协作状态
- 在场成员及状态 / 悬置 yield / 进行中小獭

### ⑥ 交接谱系
- gen1 {session_id 前 8 位}: {一句话干了什么}
```

**填写要点**：锚点优于复制、搭档指令用原话引用、§③④⑤ 是优先级最高的三段；新 session 拿到谱系后下次交接继承并追加。

**滚动状态**：多轮任务中随手用 `set_context` 维护 `task_status` / `next_step` 两个 key——任务状态变化时更新前者，每完成一个子步骤更新后者。

## 附录 C：Magic Words 已删除词决策史（F20260826mwrd）

词表冻结 2 词。已删除：「就这样」（日常语篇词，语义层天然覆盖，行为描述保留在 R3 弹性约定）、「严肃点」（场景频率极低，谈正事直接开始谈）、「星星罐子」（紧急词首要 KPI 是可回忆性，语义并入「停下」）。新需求先走信号通道验证。
