# 同型审计（prose-audit）

> 机械检测文本「同型/结构同构/密度异常」，把「感觉文风很固定」变成数据清单。零 LLM、纯启发式、stdlib-only。
> 背景与反泔水清单真相源：`docs/research/2026/10/30/R20261030lvtap-llm-voice-text-antipatterns.md`（下称 R 文档）。
> 命中项 = 需人眼复核的候选，非定罪——机械先行、人工定性。

## 用法

```bash
node scripts/prose-audit/audit.mjs <章节目录或文件> [--json] [--top N] [--out 报告路径]
```

- `<章节目录或文件>`：目录则读其下 `.md`/`.txt`/`.markdown`（按名排序），或单个文件
- `--json`：机器可读输出（默认人读 Markdown 报告）
- `--top N`：每类最多报 N 条（默认 10）
- `--out`：报告写入文件（默认 stdout）

示例：`node scripts/prose-audit/audit.mjs /path/to/novel-volumes --top 20 --out audit.md`

## 五维检测与反泔水清单映射

| 维度 | 函数 | 命中清单条目 | 说明 |
|---|---|---|---|
| 开头句式签名聚类 | `clusterBySignature` + `sentenceSignature` | T1 结构同构 / T2 公文式开头 | 前 6 字字符类别序列 + 时间词旗 + 引语旗 + 长度桶 → 同签名多章 = 同型 |
| 收尾句式签名聚类 | 同上（取末句） | T1 / T6 收尾升华 | 同型收尾 = 每章结尾同款拔高 |
| 跨章 n-gram 重复 | `crossChapterNGrams` | T3 同型情节/句式 | 4 字 n-gram 分布 ≥2 章即报（如 152/177「桌子太窄」类）；全虚词串与 markdown 标记已过滤 |
| 连接词 tics 率 | `measureConnectiveTics` | T5「不是X而是Y」/ T8 连接词套话 | 计数 + 率（/千字）；「不是X而是Y」>0.5/千字才报 flag |
| 节奏均匀度 + 比喻密度 | `measureSentenceRhythm` / `measureMetaphorDensity` | T7 语调恒定 / T4 堆砌意象 | 句长变异系数 < 0.35 = 均匀；比喻 > 6/千字 = 偏高 |

## 签名算法（sentenceSignature）

签名 = `分句结构游程 | 时间词旗 | 引语旗 | 长度桶`
- 结构游程：把连续同类字符压成一个标记（C=汉字段 P=标点段 D=数字段 L=拉丁段），捕分句/模板结构——如公文式「X，X，X」→ `CPCPC`（含 2 标点隔断 3 子句），对子句长短不敏感
- 时间词旗：开头 12 字含腊月/正月/清晨/黄昏/年/月/日 等（捕「公文式日期开头」）
- 长度桶：short(<12) / mid(≤30) / long(>30)

同签名聚类 ≥2 章才报（单章不成同型）。**短句（<8 字）且无标记者不入聚类**（签名太粗、巧合多）——故极短开头/收尾的同型不检测。

## 阈值说明（启发式，非定罪）

- `metaphorDensity.high`：> 6 次/千字
- `sentenceRhythm.uniformity`：句长变异系数 < 0.35
- `crossChapterNGrams`：分布 ≥ 2 章
- `不是X而是Y`（connectiveTics）：> 0.5 次/千字才报 flag
- 内置虚词 n-gram 停用（isFunctionGram 全虚词串过滤）+ markdown 标记（# * ` >）排除

阈值可按语料校准（R 文档第七节：tell 会失效，清单需随时间校准）。

### 已知局限（候选非定罪，务必人眼复核）

- **签名粒度**：结构游程对子句长短不敏感，两种不同语义但分句结构相同的开头可能被聚为同型（候选）；短句（<8 字）无标记者不入聚类，极短开头/收尾同型不检测
- **比喻单字噪声**：「像」已排除复合词（影像/画像/雕像等），但中文无词边界，残余噪声仍存；裸「般/一般」已剔除
- **节奏均匀度**：句长 CV 是粗指标，短文本样本少时不稳定

## 测试

`tests/scripts/prose-audit.test.ts`（vitest）：构造含已知同型的合成章节（同公文式开头 + 重复短语 + 高比喻密度）断言命中；构造多变章节断言不误报。跑 `npx vitest run tests/scripts/prose-audit.test.ts`。

## 用在哪

- **小说正文**（另一对话）：对全量章节跑审计，输出 top 重复模式，据数据定性「固定文风」是好是坏（R 文档 5.1）
- **长文/报告**：交付前抽查同型与密度
- 与 `SYSTEM.md`「你怎么说话」纪律互补：脚本管可量化维度，纪律管每轮说话的语感
