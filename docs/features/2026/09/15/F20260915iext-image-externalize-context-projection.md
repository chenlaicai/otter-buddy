---
id: F20260915iext
title: 历史图片外置：context 钩子发送层投影 + LLM 读图笔记就地摘录
summary: 实现 #779——多模态 read 的图片 toolResult 以 base64 堆积在 session 上下文直到结束（现场 29.6MB session 97% 是 9 张截图）。复用 model-runtime-registry 的 pi.on("context") 管线（stripHistoricalThinking 同构扩展），新增 externalizeHistoricalImages 纯函数：当前 turn 图片保留、上一 turn 及更早的 image 块投影为三段式文本占位符（所见摘录 | 来源路径 | 尺寸）。存储不动（session jsonl base64 原样保留），只投影发给 LLM 的消息数组。
change_type: feature
capability_test: "n/a: 纯运行时投影逻辑（非 prompt/skill/协议层软代码），13 个单测锁定全部行为契约（历史文本化/当轮保留/摘录缺失兜底/多图/多参数形态/compactionSummary 边界/真实 session 结构对照）"
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
created_at: 2026-09-15
intent:
  problem: "多模态 read 的图片 toolResult 以 base64 堆积在 session 上下文直到结束（现场 29.6MB session 97% 是 9 张截图），每轮全量重复参与注意力计算，价值集中在读图当轮之后趋零"
  expected_effect: "上一 turn 及更早的 image 块在发给 LLM 的消息数组中被投影为三段式文本占位符（所见摘录|来源路径|尺寸），当前 turn 图片原样保留，session jsonl 存储不变；历史图片不再重复参与上下文"
  verify_by:
    type: behavior_check
tags: [ctx-quality, agent, multimodal, context-projection]
modules:
  - src/frameworks/agent/image-externalizer.ts
  - src/frameworks/agent/model-runtime-registry.ts
  - tests/frameworks/agent/image-externalizer.test.ts
---

# 历史图片外置（#779）

## 背景

2026-09-04 排查上下文膨胀（对话《系统优化》）发现的第二膨胀源（第一是 bash 堆积，#776）：多模态 read 的图片 toolResult 以 base64 原文堆积在 session 上下文中，直到 session 结束不清理。现场：《健康面板404》对话的 session 文件 29.6MB，其中 97% 是 9 张 ~3.5MB base64 截图（1440×2400 UI 验收截图，部分为同一界面重复读取 3-4 遍）。图片按图块计价约 3-5K tokens/张，每轮请求全量重复参与注意力计算，价值集中在读图当轮，之后趋近于零。

方案由搭档在 issue #779 正文拍板，本文档为实施记录。

## 设计（issue #779 拍板版）

**所有图片统一外置**，不是限额降级：字节（base64）只在「正在使用的当轮」存在，历史图片一律变成关键信息（文本占位符）进入上下文。

- **实现路径**：复用 `model-runtime-registry.ts` 现有 `pi.on("context")` 管线（`stripHistoricalThinking` 先例，同构扩展），新增 `externalizeHistoricalImages(msgs)` 纯函数
- **保留窗口**：当前 turn 中的图片原样保留（视觉验收进行中模型必须看得见）；上一 turn 及更早全部文本化
- **存储不动**：session jsonl 里 base64 原样保留（UI 回放、审计、compaction 摘要均有原始素材），只有发给 LLM 的消息数组被投影
- **纯函数无状态**：每次请求实时计算，无回写无并发问题

## 实施要点

### Turn 边界判定

以最后一条「非 assistant/toolResult」的消息（user / compactionSummary 等）为界，该位置及之后视为当前 turn。理由：一个 invoke 内连续多步工具调用（assistant→toolResult 链）属同一 turn——模型在链中还可能回看刚读的图继续操作，只有跨 turn 后价值才趋零。无边界消息（全链 assistant/toolResult）时保守全部保留。

### 占位符三段式

```
[图片已外置 | 所见: {assistant text 首句, ~150字截断} | {来源路径} {MIME} {尺寸}]
```

- **所见**：该 image toolResult 之后首条非空 assistant text 的首句（LLM 读图后天然会写分析文字，就地摘录，不需要额外 LLM 调用）。首句边界取第一个句末标点（。！？!?；；）或换行——不含英文句点（避免 `mock. 查` 这类中英混排被一切两半）；无标点时 150 字硬截断加省略号。**不限紧邻**：读图后隔着一个工具调用对（如读图→bash→分析）也能摘到
- **来源路径**：回溯同 toolCallId 的 toolCall input，read 类工具取 `arguments.file_path` 或 `arguments.path`（两种参数形态都支持）
- **尺寸**：base64 字符数 × 3/4 的解码字节近似，人类可读（KB/MB）
- **兜底**：读图后无 assistant text（现场未观察到）→ 退化为纯元数据占位符（`[图片已外置 | {路径} {MIME} {尺寸}]`），不阻塞；无配对 toolCall 的孤儿 toolResult 同样只缺路径段

### 意外收益（issue 原话）

摘录把「图和结论」的配对关系钉死在原位——现状下翻历史时分析文字和图片隔着几十条工具调用对不上号。

## 影响范围

- `src/frameworks/agent/model-runtime-registry.ts`：context 钩子内串联 `externalizeHistoricalImages(stripHistoricalThinking(msgs))`（+1 import，+1 行调用）；stripHistoricalThinking 逻辑零改动
- `src/frameworks/agent/image-externalizer.ts`（新）：纯函数，可独立测试
- `tests/frameworks/agent/image-externalizer.test.ts`（新）：13 用例

## 验证

- 13 新用例全绿：历史图片文本化（三段式完整断言）/ 当轮保留（原引用）/ 同 invoke 多步链属当轮 / 摘录缺失兜底（纯元数据）/ 非紧邻摘录 / 多图（同 toolResult 双 image + 多历史 toolResult）/ file_path 参数形态 + 孤儿 toolCall / 150 字截断 / 无图零拷贝 / 空数组与无边界 / compactionSummary 边界 / 真实 session 结构对照（issue 现场 9 图结构：9 张历史全部文本化、当轮第 10 张保留）/ 空白 text 跳过
- thinking-strip.test.ts 11 用例零回归（同钩子串联验证）
- 全量 252 文件 / 2996 测试全绿；tsc 0 error；eslint 0 error
- **已过最简检查**：复用现有 context 钩子管线（无新机制）、占位符纯字符串拼接（无模板引擎）、来源路径回溯走 Map 单遍收集（O(n)）。无可再简项

## 不做（边界声明）

- #776（bash→专用工具）：同属上下文质量主线但独立 issue
- compaction 阈值修正（200-256K）：issue 明列另行开单
- 历史 user 消息内联图片（attachment 注入路径）：issue 方案只覆盖 toolResult 图片——现场证据（29.6MB session）全部来自 read 截图，user 附件图未观察到堆积；若后续发现同样问题，同函数扩展 content 扫描范围即可

## 关联

- #779（本实现）、#776（bash 上下文质量主线）、F20260903cmpk（compaction 钩子先例）、stripHistoricalThinking（context 钩子先例，同文件内）
