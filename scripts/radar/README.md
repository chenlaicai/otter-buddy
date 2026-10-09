# 每日 AI 雷达（AI Radar）

> 每日自动扫描 AI/agent 领域热点，产出聚合简报到「外部洞察」对话，供搭档点菜深挖。
> 本文件是雷达管线的**真相源文档**：查询语句、过滤规则、产物规范都在这里，改这里为准。
> 2026-10-09 入库：脚本与规则从「外部洞察」对话工作区迁入本仓，
> 消除「定时任务依赖 gitignore 区文件」的持久化孤儿；运行时数据仍留在对话工作区。

## 流程（四层管线）

```
定时触发(8:30) → ①scan.mjs 确定性抓取 → ②LLM 分拣 → ③跨源结合排序 → ④简报发对话
                                                    （②③④由被唤醒的大獭执行）
```

## 第①层 · 确定性抓取（`scripts/radar/scan.mjs`，零 LLM，~30s）

用法：`node scripts/radar/scan.mjs <工作区data目录>`（缺省写脚本旁 data/，生产用法见任务模板 `prompts/scheduled/daily-ai-radar.md`）。

| 源 | 查询 | 说明 |
|---|---|---|
| Hacker News | topstories 前 60 → 逐条 item 详情 → 正则粗筛 | **串行 + 150ms 间隔**（实测并发会被 ECONNRESET） |
| GitHub search | `topic:ai-agent` / `topic:llm` / `topic:mcp` + `created:>7天前`，按 star 降序各前 10 | 未认证限 60 请求/时，查询间隔 400ms；单 topic 前 10 共 ≤30 项 |
| Anthropic news | `https://www.anthropic.com/news` HTML → `href="/news/{slug}"` 正则 | 尽力而为源：改版/反爬则跳过并注明，不阻塞 |

- 产物：`<工作区data>/raw/YYYY-MM-DD.json`（原始数据日档，永不删除，可追溯）
- stdout 打印摘要，供 LLM 分拣层直接消费
- 关键字正则（改动需同步 README 此处）：
  `/\b(AI|AGI|LLM|LLMs|GPT|Claude|Gemini|OpenAI|Anthropic|agent|agents|agentic|MCP|RAG|inference|prompt|reasoning|fine-tun\w*|diffusion|transformer|tokenizer|embedding|vector database|copilot|cursor)\b/i`

## 第②层 · LLM 分拣（被唤醒的大獭执行）

输入：当日 raw JSON + `<工作区data>/last-report.json`（昨日简报，去重基准）。
对每条打四维：

1. **领域相关性**：AI/agent 核心话题（模型发布、agent 工程、框架、基准、安全）；蹭热点假 AI 剔除
2. **热度**：HN 分数/评论数、GitHub star 增速，跨源归一化
3. **新颖性**：与昨日对比；旧闻续集降级，连报 3 天合并成一句话
4. **领域权重**：agent 工程、多智能体协作、上下文工程、工具协议（MCP）类是 AI/agent 领域核心议题，排序加权——纯领域视角，与使用者所在项目无关

## 第③层 · 跨源结合

同事件多源命中合并为一条「多源印证」事件（如 HN 讨论的文章 + GitHub 同主题新项目），标注来源，可信度高于单源。
综合分 = 热度 × 新颖性 × 洞察价值，取 top 3-5。

## 第④层 · 简报规范

- **形式（搭档 2026-09-21 定调）**：汇报场景用图表达，不用裸 md——简报以 html-card 汇报卡发出。结构：顶部概览条（源状态/原始条数/呈报数）+ 逐条话题块（徽章：来源·热度·新或续报；「这是什么」段讲具体内容；「为什么值得注意」段；数据用条形图等图形化呈现）+ 尾注「洞察第 N 条」提示
- **内容深度（同日定调）**：每条话题必须讲清「这是个什么东西」让人能看懂，有干货——入选条目发简报前逐一抓取原文（curl 正文/GitHub README），不能只报标题光说有这个事
- **技术点段（搭档 2026-09-21 增补）**：每条话题含「核心技术 / 亮点 / 为什么火」三小段——核心技术点是什么、亮点在哪、走红原因、出彩的点，用标签行式排版呈现
- 格式：标题「📡 AI 雷达 · M月D日」；同日多轮时标注并降级合并已报条目
- **边界（硬约束，2026-09-21 搭档定）**：简报只陈述外部事实与技术分析（是什么、为什么热、技术脉络、领域影响），**禁止任何与海獭系统/使用者项目的结合分析**（如「与我们的选型相关」「咱们可以借鉴」类表述一律不出现）。结合分析与落地评估由搭档显式发起后另行进行，不由雷达或洞察流程自动产出
- **平淡日处理**：不足 3 条就如实说平淡，不硬凑
- **源故障降级**：某源失败则简报注明「今日 X 源故障未覆盖」，不阻塞其他源
- 简报发到「外部洞察」对话后，更新 `<工作区data>/last-report.json`（条目标题+链接+日期）

## 深挖流程（被动触发，不占定时任务）

搭档说「洞察第 N 条」→ 反查 arXiv API（`https://export.arxiv.org/api/query?search_query=all:{关键词}&max_results=10`）+ HN 高赞评论 + GitHub 源码 → 产出 R 研究文档入 `docs/research/`。**R 文档同样只做纯外部技术分析，不含与海獭系统的结合建议**；若搭档想讨论落地，那是另一个由他发起的流程。
深挖辅助：`scripts/radar/fetch_anthropic.py <slug>` 抓 Anthropic 文章正文（Python 3 标准库，零依赖）。

## 运维备忘

- 时间：每日 8:30（cron `30 8 * * *`）；搭档若觉得节奏不对可改双跑（8:30+20:30）
- 手动触发：对话里说「扫描一下」，大獭直接 `node scripts/radar/scan.mjs <工作区data目录>` 跑全管线
- 历史决策：Reddit（真不通）、机器之心（RSS 停服）、OpenAI news（403 反爬）、DeepMind/HuggingFace（不通）已淘汰；GitHub trending 页被 api.github.com search 替代（更可编程）

## 复用部署（给同事/其他环境）

1. 克隆本仓后脚本零依赖可跑：`node scripts/radar/scan.mjs <任意输出目录>`（Node ≥ 18，内置 fetch）
2. 配定时任务：以 `prompts/scheduled/daily-ai-radar.md` 为指令模板，把其中工作区路径换成自己的输出目录；分拣层规则即本 README 第②③④层，任意 LLM 可执行
3. 首跑无 `last-report.json` 属正常（去重基准首日跳过），次日起自动去重
