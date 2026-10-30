---
id: F20261030lvgov
title: LLM-Voice 治理——同型审计脚本 + 文本反泔水清单 + 说话纪律
summary: 把 AI 写作「诡异谷」的诊断落成三产出：机械同型审计脚本（prose-audit）、文本反泔水清单（R 文档）、BIG_OTTER 说话纪律。用于优化海獭日常说话与小说正文两处文本产出的「一眼 AI」感。
change_type: prompt
capability_test: "n/a: 新增独立脚本与文档，无 capability 评测场景覆盖；脚本正确性由 tests/scripts/prose-audit.test.ts 单测保障（14 用例）"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
tags: [llm-voice, prose-audit, 文风, 反泔水, 说话技巧, prompt]
modules: [scripts/prose-audit, prompts/identity, docs/research]
created_at: 2026-10-30
intent:
  problem: "海獭（日常对话 + 另一对话的小说正文，200+ 章）文本产出存在固定文风 = LLM 指纹，读者产生 AI 写作「诡异谷」反感；缺乏可判定的反 LLM 腔纪律与机械检测手段"
  expected_effect: "①给出可机械统计的同型审计（把「感觉很固定」变成数据清单）②BIG_OTTER 说话纪律补充反 LLM 腔禁忌，降低日常说话的 AI 腔③小说正文可据脚本数据定性并治理"
  verify_by:
    type: human_judge
---

## 一、背景与来源

2026-10-30 每日 AI 雷达第 1 条（Fowler《LLM Voice》，HN 50290177）的结合分析。搭档 11:45 拍板「你来开干」，做三产出。诊断与清单真相源：`docs/research/2026/10/30/R20261030lvtap-llm-voice-text-antipatterns.md`（下称 R 文档）。

## 二、变更清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/prose-audit/audit.mjs` | 新增（feature） | 同型审计脚本，5 维机械检测，导出可测函数 |
| `scripts/prose-audit/README.md` | 新增 | 用法 + 签名算法 + 阈值 + 清单映射（真相源） |
| `tests/scripts/prose-audit.test.ts` | 新增（feature） | 14 vitest 用例，覆盖 5 维判定命中/不误报 |
| `docs/research/2026/10/30/R20261030lvtap-*.md` | 新增 | 文本反泔水清单 + LLM-Voice 诊断（研究交付） |
| `prompts/identity/BIG_OTTER.md` | 修改（prompt） | 「你怎么说话」加一条反 LLM 腔纪律（外科手术级最小增量） |
| `docs/features/2026/10/30/F20261030lvgov-*.md` | 新增 | 本实现记录 |

## 三、设计取舍（设计面确认：模块/接口/数据结构）

**模块切分**：单文件 `audit.mjs` + README + test，不建框架（最简检查：无需依赖、无需多文件拆分）。

**关键接口**（导出供单测）：
- `loadChapters(path)` → `[{name, text}]`
- `splitSentences(text)` / `sentenceSignature(s)` / `clusterBySignature(items, getSentences)`
- `crossChapterNGrams(chapters, n=4, minChapters=2)`
- `measureConnectiveTics(text)` / `measureSentenceRhythm(text)` / `measureMetaphorDensity(text)`
- `auditChapters(chapters, opts)` → 报告对象；`formatReport(report)` → 人读 Markdown
- CLI：`node audit.mjs <路径> [--json] [--top N] [--out 报告]`

**核心数据结构**（报告对象）：
```
{ meta:{chapterCount,totalChars,generatedAt},
  openingPatterns[], closingPatterns[],   // 签名聚类
  crossChapterNGrams[], connectiveTics[], // 重复/套话
  sentenceRhythm{}, metaphorDensity{},    // 节奏/密度
  flags[] }                               // 人眼速览
```

**签名算法**：`前6非标点字字符类别序列|时间词旗|引语旗|长度桶`——把「像不像」转成可比对的 key，同签名 ≥2 章 = 同型（T1/T2）。这是把主观判断机械化的关键设计。

**阈值启发式而非定罪**：所有判定给「需人眼复核的候选」，fail-safe 方向是宁多报不漏报（比喻密度、句长变异系数、n-gram 分布阈值，均可按语料校准——R 文档第七节）。

**Mechanism 判定**：本特性未经 RA（雷达深挖直产），命中机制识别检查点——**新增检测机制（prose-audit）**。四问：①要解决什么——同型靠人工零星发现（152/177 实证），规模化不足；②为何是机制不是一次性——200+ 章持续产出需持续审计；③后续机制——阈值随语料校准，清单随 tell 演化更新；④退役条件——当模型不再产出可辨识 LLM 腔（Fowler 前瞻），机械维度仍有效、语义维度退役。结论记于此。

## 四、验证

**测试**：`npx vitest run tests/scripts/prose-audit.test.ts` → **14 passed**。覆盖：签名聚类（公文式开头命中/多变不误报）、跨章 n-gram（「桌子太窄」命中 + 虚词停用）、连接词 tics、节奏均匀度、比喻密度、端到端 auditChapters/loadChapters。

**CLI 冒烟**（合成同型语料）：2 章公文式开头 + 重复短语 + 高比喻 → 报告命中「公文式时间开头同构 / 收尾句式同构 / 跨章 n-gram 重复 / 比喻密度偏高」4 项 flag，符合预期。

**Golden Gate**：n/a（verify_by=human_judge，说话纪律类，golden 无场景可跑）——豁免声明。

**Intent lint**：`npm run lint:intent`（frontmatter verify_by.type=human_judge 合法枚举）。

**锚点重放评审**：豁免（纯写作纪律/说话风格增量，不改变獭「什么时候做什么」的行为触发语义，落在 code-implementation 锚点重放的「纯润色/写作纪律」豁免面）。若检视判为触达行为语义边界，补跑重放。

**最简检查**：已过——stdlib-only 单文件达成 5 维检测；无更简同等效果方案（visual-design 反泔水清单是文档、非机械，互补不重复）。

**pre-existing 声明**：无——本次全绿，无既有失败需声明。

## 五、负面向验收（本次变更破坏了什么旧契约 / 绕过了什么保护）

- 未绕过任何既有保护：prose-audit 是纯新增独立脚本，不接入 CI/守卫，不影响现有行为。
- BIG_OTTER.md 增量为**追加一条纪律**，不删除/改写既有说话规则，不破坏既有行为契约。
- 潜在风险：反 LLM 腔纪律若被过度解读为「处处设限」，可能让说话变得生硬——已在纪律里写明「允许不完美/留白」，方向是去 AI 腔不是加镣铐。

## 六、影响面当场自检

- 新增文档 2（R + F）、脚本 2（audit + README）、测试 1、prompt 增量 1 行级——无既有文档失效。
- R 文档第五节引用 scripts/prose-audit/ 与 SYSTEM.md「你怎么说话」——实际落点是 prompts/identity/BIG_OTTER.md（「你怎么说话」段所在），索引一致。

## 七、产物索引

- 脚本：`scripts/prose-audit/audit.mjs` + `README.md`
- 测试：`tests/scripts/prose-audit.test.ts`（14 用例绿）
- 清单真相源：`docs/research/2026/10/30/R20261030lvtap-llm-voice-text-antipatterns.md`
- 说话纪律落点：`prompts/identity/BIG_OTTER.md`「你怎么说话」
