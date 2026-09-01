---
id: F20260901mbfx
title: 交接摘要机械/LLM 分工边界修复：预取供料 + 谱系接线 + readOnly 白名单
summary: 基于「必然准确的给机制，需要总结思考的给 LLM」审计判据，修复合成链路 5 处枚举型事实仍依赖 LLM 自觉的残余
change_type: fix
created_in_conversation: 9d326c9d-9818-40a2-9982-898315fe7aa4
---

# 交接摘要机械/LLM 分工边界修复

## 背景

搭档审阅七段交接摘要时提出设计判据：**枚举型事实（必然准确的）应给机制，判断型压缩（需要总结思考的）才给 LLM**。据此对合成链路做正反双向审计（boundary/mimo 独立审计 + 大獭独立分析，报告见工作区 `boundary-audit-report.md`），发现 5 处「设计写了、实现没跟上」的残余——全部集中在该边界上。

审计结论：Phase 2 主线（合成链路+降级链+B1/B6 注入）已通，但设计文档（kimi 件④ §3.3）规划的机械供料散件未接完；反向（机制硬编码了本该 LLM 判断的）未发现显著问题。

## 修复内容（5 项）

### #1 §④ 产物锚点机械预取（审计 F1）

- **问题**：合成 prompt 规则区明写「使用 get_context / 使用 list_artifacts」，让合成 LLM 自己调工具查产物清单和 context keys——枚举型事实依赖 LLM 自觉调用，可能漏调/调失败
- **修复**：`agent-invoker.ts` 新增 `buildSynthesisPrefetch()`——`Promise.allSettled` 并行拉取 context keys / active 产物 / 最近搭档消息，注入 `buildSynthesisPrompt` 新参数 `prefetch`；prompt 规则区改为「机械预取数据已在下方提供，不要自行调工具重查」
- **配套**：`handoff-package-builder.ts` 透传 prefetch 参数

### #2 sessionId + lineage 真接线（审计 F2/F3）

- **问题**：`buildAutoHandoffOptions` 不设 `oldSessionId`，builder 里 `oldSessionId ?? otterId` 兜底——谱系行的 session ID 永远是 otter UUID 前 8 位（本对话顶部 meta 行的 `fefd2c06` 即是）；lineage 从未接线，`gen N` 代数字段模板缺失，跨代永远 gen1 重建
- **修复**：新增 `resolveHandoffLineage()`——从 active session 取真实 ID + 从旧 summary 提取 `- genN xxx:` 谱系行；`synthesis-prompt-builder.ts` 机械推导 `genN = lineage 行数 + 1`，meta 行补 `gen N` 字段，§⑦ 继承谱系并追加新代占位
- **历史兼容**：旧 summary 无 gen 标记时视为谱系断档，新代从 gen1 重建（不误挂）

### #3 readOnly 合成自定义工具白名单（审计 F5）

- **问题**：`pi-session-factory.ts` 的 readOnly 过滤只作用于 coding 工具（write/edit/bash），speak/yield/create_otter 等自定义工具原样进 session——合成獭理论上可在摘要生成路径越权发言/交棒/建獭
- **修复**：新增 `SYNTHESIS_READ_ONLY_TOOL_WHITELIST`（正道白名单：只列安全项，新注册工具默认不进），readOnly 模式下 customTools 同样过滤，与 otterType manifest 白名单双重求交
- **白名单内容**：read/workspace 查询/get_context/list_artifacts/memory 检索/消息查询/get_active_participants——纯只读

### #4 §⑤ 注入全量 B1-B6（审计 F4）

- **问题**：件④机械数据中 B2-B5（调度任务/工作区/产物/healing）只渲染进给新 session 的 otter_context，合成 LLM 看不见
- **修复**：`formatStateInventoryForPrompt` 优先注入 `renderStateInventory` 全量渲染文本（裁标题行），与件④一次聚合两用、同源无竞态；无渲染文本时降级旧逻辑（B1/B6 结构化数据）

### #5 §⑥ 搭档消息机械预取（大獭补充）

- **问题**：合成 LLM 需要自己从上下文里翻找搭档原话做引用
- **修复**：`fetchRecentUserMessages()`——`getMessages` 原生 `senderType: 'user'` 过滤最近 6 条，正序注入 prompt §⑥，LLM 只负责挑选哪句是指令
- **边界设计**：候选枚举（机械）+ 指令挑选（LLM）——混合字段的判据应用

## 改动文件

- `src/frameworks/agent/synthesis-prompt-builder.ts`：prefetch 接口 + gen N 推导 + §④/§⑥ 预取渲染 + §⑤ 全量注入 + 白名单常量
- `src/frameworks/agent/handoff-package-builder.ts`：prefetch 透传
- `src/interface-adapters/agent-runtime/agent-invoker.ts`：`resolveHandoffLineage` / `buildSynthesisPrefetch` / `fetchRecentUserMessages` / `buildAutoHandoffOptionsWithMechanicals`
- `src/frameworks/agent/pi-session-factory.ts`：readOnly 自定义工具白名单过滤
- `tests/frameworks/agent/synthesis-prompt-prefetch.test.ts`：新增 10 测试（预取渲染/gen 推导/全量注入/白名单安全断言）
- `tests/interface-adapters/agent-invoker-handoff-prefetch.test.ts`：新增 4 测试（谱系提取/预取聚合经 handleHandoff 路径）

## 设计原则（审计判据，两条）

1. **枚举型事实**（有唯一权威源、可数、可查）→ 机制。LLM 回忆必漏必编
2. **判断型压缩**（价值在于选择/取舍/表达）→ LLM。没有权威源，「写什么」本身就是答案

推论：**交接摘要的最小核 = 不可再生信息**——凡新獭事后可重查的不占预算，锚一下就行。

## 验证

- tsc 0 错误 / eslint 0 错误
- 新增 14 测试全绿（预取注入、谱系代数、B1-B6 可见性、白名单不含写工具、handleHandoff 集成路径）
- 全量 2443/2443 通过（196 文件，基线 2405 + 新增 38 = 2443，无回归）

## 后续观察

- 下周一（09-08）定时观察任务自然核对：触发频率 + 摘要质量 + 谱系行是否真实 session ID
- 已知遗留：B2-B5 的 stateInventoryText 依赖调用方注入，prefetch 空结果与「没查」的区分已按「查过没有」语义传递
