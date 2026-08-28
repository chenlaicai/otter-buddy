---
id: R20260828pntr
title: ponytail-deep-research
doc_type: research
summary: |
  对 DietrichGebert/ponytail（5 周 114k star 的"最懒资深工程师"AI 编程行为矫正插件）的深度研究。
  核心结论：其真实优势不在 383 行 prompt 本体（人人可抄），也不在跨平台胶水层（1275 行，
  基于 pi 的项目不需要），而在"评测即产品"的工程哲学——为行为级改动建造 4200 行可验证测量
  仪器（selftest-first 元原则、good/bad 参考实现对、四层评测架构），且被证伪过并公开修正
  （#126 批评→agentic benchmark 重构→污染自检）。四条可迁移思想：selftest-first、对照组
  污染隔离、批评→测试用例、SUPERSEDED 不删。考古发现：git 历史在 7/2 被切断，项目 6 月
  有前世，prompt 迭代史不可考。本文同时校准了我们与 F20260825evgl 评测体系的真实差距。

status: draft
exploration_type: technical
tags: [evaluation-methodology, prompt-engineering, benchmark-design, selftest-first, agent-behavior, capability-test, ponytail]
causal_links:
  from:
    - F20260825evgl
---

# R20260828pntr: ponytail 深度研究

> 源起：搭档 2026-08-28 指令——"不能一直只看表层，深入看别人的真实优势是什么……先做 deep
> research，不着急改咱们系统，先把别人吃透"。双视角产出：大獭（prompt 工艺 + 历史考古）×
> mimo-分析獭（benchmark 方法论 + issues 考古），关键断言交叉核实。原始分报告见对话工作区
> `deep-research-prompt-craft.md` 与 `deep-research-benchmark-methodology.md`（447 行）。

## 0. 项目背景与基本盘

Ponytail 是一个塞进 AI 编程 agent 的行为矫正 skill：写码前强制爬 7 级阶梯（YAGNI → 仓库已有
→ stdlib → 平台原生 → 已装依赖 → 一行 → 才写最小实现），在第一个能站住的台阶停下。解决
LLM 训练偏差导致的过度建设（"我要一个函数，它给我一个框架"：date picker 404 行 vs
`<input type="date">` 23 行）。

**规模事实**（均已直接核实）：

| 层 | 行数 | 性质 |
|---|---|---|
| skills/（7 个 SKILL.md） | 383 | 价值核心——prompt 本体 |
| benchmarks/ | 4077 | 评测体系（本文主角） |
| tests/ | 1709 | 胶水层 UT（15 个测试文件） |
| hooks/ + pi-extension/ | 1275 | 20 个 agent 平台适配胶水（README 徽章自称 20；行数只计 .js/.md/.py/.ts，含 json 等全文件为 1413） |
| ponytail-mcp/ | 146 | MCP 封装 |

README 声称 -54% LOC / -20% cost / -27% faster / 100% safe。数字有水分但方法论扎实
（§2-3 展开）：-54% 被前端任务（原生 input 替代组件）拉低，后端 CRUD ≈0；n=4、单模型
（Haiku 4.5）、单仓库；“100% safe” 的 Wilson 95% CI 下界仅 83%，与 yagni 臂 19/20
无统计显著差异（Fisher exact p≈0.3。注：区间与检验为我们基于其公开
20/20、19/20 数据的估算，非 ponytail 原文）。

## 1. 历史考古：git 历史是被切断的

三条独立证据互证：

1. 根 commit b8f20b8（2026-07-02）无父提交，但 commit message 关闭 issue #437/#438
2. `benchmarks/results/2026-06-22-issue-245-217-comprehension.md`——6/22 的文件引用
   issue #245/#217
3. benchmark 结果文件日期从 6/12 起，全部早于根 commit

**结论**：项目 6 月有完整前世（约 3 周积累 400+ issues 活跃度），7/2 做 history cut 后重新
发布。影响：(a) 114k star 含前世积累，读增长曲线要打折；(b) prompt 迭代史（草稿→成型）
在前世，可见历史里核心 SKILL.md 仅 2 个 commit 触碰（其一为 #120→#577 收窄标记规则）——
我们看到的是成品不是演化。

## 2. 评测方法论：真实优势所在

### 2.1 四层架构，每层 selftest

```
L0 基础设施   run.py（471行）——每 cell 独立 tmp repo + 独立 agent context；
              开局强制 --selftest（零 API 花费先验仪器）；--rescore 离线重算不重花钱
L1 确定性检测  loc.js / behavior.js / correctness.js / robustness-audit.js（零 LLM）
              ——评分函数直接 import 执行产出代码、用对抗输入攻击
L2 LLM Judge  judge.py（过度建设 0-3 分）/ complete.py（完整度 0-3 分）
              ——Sonnet 4.6 + temperature=0；rubric 逼 judge 说出
              "最不必要的构造"/"缺失的最重要一块"
L3 结果呈现   results/*.md 完整公开 + summary.json 可重算
```

### 2.2 good/bad 参考实现对：体系的灵魂

每个任务配两版参考答案：good（正确实现）+ bad（"懒但合理"版：happy path 通过、对抗输入
失败）。selftest 强制 good 必过 + bad 必拦——**仪器先证明判别力，才被允许花钱测量**。

关键洞察：bad 参考正是"旧评测会漏掉的那类代码"。只测正确性的评测无法区分"懒对了"和
"懒错了"，good/bad 对把这个区别变成了机械可验证的事实。

### 2.3 完整度 judge 防指标作弊

LOC 降了但功能没做完 = 赢指标输任务。complete.py 三层防护：judge 自身 selftest / 离线
gate 逻辑验证 / FLAG_AT≤1 的 cell 列入 under-delivered 清单。

### 2.4 污染自检：差点发布错误结论的自救

baseline 臂曾被 ponytail 自己的 SessionStart hook 暗中激活（差距只剩 4%，差点当成
"效果甚微"发布）→ 发现 → `--setting-sources project,local` + `--plugin-dir` 隔离 →
旧报告标 SUPERSEDED **保留不删** → 修正后诚实重发。

对照组污染是所有 A/B 评测的暗坑；隔离运行时配置源是通用解法。

### 2.5 #126：批评者变成测试用例

Colin Eberhardt 四点批评（单次生成不公平 / 基线是话痨模型 / 安全未测 / "7 个词的 prompt
就够了"）→ 作者承认 → 建 agentic benchmark 逐点回应（四臂对照正是回应"7 个词够吗"——
答案：能省 33% 但掉 5% 安全分）→ 批评者的 email 验证例子被转化为永久的 `critic-email`
测试任务。

**把尖锐批评转化为永久测试场景，比十篇反驳文章有价值。**

### 2.6 评测要能证伪自己：“The fix that wasn't”

最典型的案例是 `results/2026-06-16-robustness-audit.md` 记录的“失败的修复”：email 验证在
OpenAI 模型上 ~4-5% 失败（模型偏爱 `parseaddr` 而非 regex），作者尝试了 **8 种不同的
SKILL.md 编辑**（counter-pressure 措辞、check-mandate、few-shot 示例、三种放置位置……），
结果每一次得分都 ≤ 当前版本，有一次崩到 78%，且全部推高中位 LOC。最终决策：**一个都
不发布**——“添加不起作用的 skill 文本是 ponytail 自己所反对的 cargo-cult 行为”。

agentic benchmark 的 README 说得更直白：“It is built to be able to disprove the skill's
value, not only to confirm it.” benchmark 的价值在于能证伪，不在宣传。加上
SUPERSEDED 保留旧结论（§2.4）与公开修正史（correctness gate bug → 污染 → 质量轴，
至少 3 次重大方法论修正），这套评测的“不装哲学”贯穿始终。

## 3. Prompt 工艺：383 行里的 know-how

- **失败模式预防性命名**："dresses up as efficiency and ships a confident wrong fix"（跳过
  理解的懒）、"complexity smuggled back in as prose"（解释文字是走私回来的复杂度）。
  给失败模式起名字 > 禁令。
- **双重安全阀**："a reflex, not a research project"（防形式主义走阶梯）+ "The ladder
  shortens the solution, never the reading"（防跳过理解）。同一约束正反两面写，各出现
  两次——说明 LLM 两个方向都会翻车。
- **利益一致设计**："one guard in the shared function is a smaller diff than a guard in
  every caller"——把 root-cause 正确性和最小 diff 统一成一个动机，不靠道德靠算术。
- **社区信号收紧**（#120→#577）：`ponytail:` 标记被滥用到琐碎代码 → 规则收窄为"只标真
  砍角"→ helpers.test.js 加测试 pin 住前缀——prompt 约定被当作 API contract 用 UT 保护。
- **配套观测器**：行为 skill（ponytail 本体）+ 一圈观测 skill（debt 扫描标记成 ledger /
  gain 展示战绩且明令禁止编造 per-repo 节省数字——"the unbuilt version was never
  written"）。**行为改了之后效果不可见等于没改。**

## 4. 与我们评测体系（F20260825evgl）的差距校准

我们已有：capability tests（真系统 + 真 LLM，统计采样）、golden 伤疤场景、verify_by 三值
门禁、采样协议。差距按重要度排序：

| # | 差距 | 现状 | ponytail 的答案 |
|---|---|---|---|
| 1 | **对照组设计** | 只有守底线（纵向），无量提升（横向 A/B） | 四臂对照 + 混淆变量隔离臂（caveman） |
| 2 | **good/bad 自检层** | 伤疤场景有 bad（真实翻车），无系统化"good 必过 + bad 必拦"自检 | selftest-first：仪器先证明判别力（run.py 强制 --selftest，零 API 花费） |
| 3 | **完整度 judge** | 断言轨迹/信号词，无整体质量裁判 | complete.py 式 LLM judge（rubric 逼问"缺失的最重要一块"）+ judge 自身 selftest + under-delivered 清单 |
| 4 | 可复现性 | 需起整个 runtime，结果只活在内部文档 | promptfoo 可复跑 + 结果公开 |

## 5. 可迁移思想（记录，不着急做）

1. **selftest-first 元原则**：任何评测工具必须先用已知 good/bad 案例证明判别力，才允许
   进 gate。适用对象：capability tests / golden 场景 / 未来的 LLM judge。
2. **污染隔离意识**：prompt A/B 时改前臂必须隔离运行时配置源，否则测的是配置泄漏不是
   prompt 效果。
3. **批评→测试用例**：把尖锐批评（我们收到的检视意见、issue 批评）转化为永久测试场景。
4. **SUPERSEDED 不删**：被修正的旧结论保留标记，让方法论演化可追溯——比"悄悄改对"诚实
   一个量级。

## 6. 边界：不迁移的东西

- ladder 人格化叙事——传播策略非技术策略
- 三档 intensity（lite/full/ultra）——A4/A5 弹性约定是更贴我们的内置版本
- "100% safe" 式绝对说法——我们已有更严格的表述纪律
- 跨平台胶水层——基于 pi 单平台，外生复杂度不存在

## 7. 证据与可复现

- 仓库 clone：/tmp/ponytail（shallow，可见历史 7/2-8/8，v4.9.0）
- 分报告：对话工作区 deep-research-prompt-craft.md（大獭）、
  deep-research-benchmark-methodology.md（mimo，447 行，含逐文件 file:line 证据）
- 关键文件：benchmarks/agentic/run.py、tasks.py、judge.py、complete.py、
  results/2026-06-18-agentic.md、results/2026-06-17-agentic-safety.md（SUPERSEDED 样本）
