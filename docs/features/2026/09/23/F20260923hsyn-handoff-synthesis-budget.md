---
id: F20260923hsyn
title: 压缩死亡链根治：合成 prompt 预算裁剪 + 超时兜底语义 + 失败熔断 + 守卫工作区豁免
doc_type: feature
change_type: fix
created: 2026-09-23
created_in_conversation: fcb57dbe-22c5-4286-9239-7261fbc369fe
modules:
  - src/frameworks/agent/narrative-synthesis-engine.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/handoff-support.ts
  - src/usecases/ports/otter-context-window-provider.ts
  - src/bootstrap/platforms.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - web/src/pages/conversation/Modals.tsx
  - tests/frameworks/agent/handoff-synthesis-budget.test.ts
  - web/src/pages/conversation/RestartModal.test.tsx
summary: "9/23 压缩死亡链实爆（#1123 残留疑点）：合成请求 = 全量历史 + prompt 从不裁剪，ctx 超「模型窗口 − prompt 开销」临界点后 compaction/narrative synthesis 全部数学性失效（kimi-256k 实测 prompt 362k-956k chars vs 262k 窗口必 400），失败后 continuing with current session → ctx 继续涨 → 死循环。修复四件套：①trimMessagesToBudget 预算裁剪（方案 A 丢最老保最近，搭档拍板）；②超时 60s→300s 改兜底异常语义（实证分布 20-65s、最大 146s，60s 是质量闸门误杀）；③HandoffState 连续失败 ≥2 次熔断强制机械档案断死循环；④bash 守卫重定向豁免补 data/workspaces/（主仓树下合法工作区）。顺手修 RestartModal 提交中文案不按勾选区分的误导（不勾也显示「正在封装前世档案」）。"
tags: [handoff, compaction, synthesis, circuit-breaker, bash-safety-guard, reliability]
capability_test: "n/a: narrow-fix 修复既有交接管线参数与裁剪语义，回归用例固化于 tests/frameworks/agent/handoff-synthesis-budget.test.ts（15 例）与 RestartModal.test.tsx"
causal_links:
  from:
    - F20260920uhuc
    - F20260922wbfx
    - F20260923qbsw
---

# F20260923hsyn：压缩死亡链根治

## 背景：9/23 压缩死亡链实爆

9/23 早《紧急修复》/《压缩交接紧急修复》对话现场（本对话 fcb57dbe 排查实证 + 场外 Claude 独立分析互证）：

**死亡链三环节**（日志锚点）：
1. **SDK compaction 数学性必败**：ctx 涨到 ~212k（reserveTokens 50k 按 1M 窗口调的错配）才触发，压缩请求 = 全量 ctx + 摘要 prompt ≈ 386k chars > k3-256k 窗口 262144 → 必 400（08:08 起 3 次）
2. **水位交接合成同样必败**：kimi-256k prompt 362k chars > 262k 必 400（08:10/08:16 两次）；kimi 1M prompt 956k chars 实测 146s 才返回，60s 固定超时误判 → 白跑 + 降级机械档案（08:15）
3. **死循环**：失败后 continuing with current session → ctx 继续涨 → 再触发再失败；锁竞争放大（Lock acquire timeout 120s ×3 + handoff already in progress ×2，08:12-08:25）

**临界点公式**（场外 Claude 表述，与我方实证一致）：ctx > 模型窗口 − 摘要 prompt 开销时，所有自愈路径数学性失效。

## 修复四件套

### ① 预算裁剪（根治死亡链，方案 A 丢最老保最近）

`trimMessagesToBudget`（narrative-synthesis-engine.ts）：

- 历史段预算 = `contextWindow − SYNTHESIS_OUTPUT_RESERVE_TOKENS(8192) − SYNTHESIS_FIXED_OVERHEAD_TOKENS(10000)`，chars 按 tokens×4 估算（与 archiveTokens 口径一致）
- 从最老消息整条丢弃（保持消息边界完整不切半条），增量估算避免 O(n²) 重序列化
- **不裁的**：previousSummary 谱系摘要、§④⑤⑥ 机械供料——它们已是压缩过的全局信息；交接场景「最近正在干什么」远比「开头聊了啥」重要
- 裁剪发生时 prompt 内注入标注行（告知合成 LLM 有丢弃、全局脉络看摘要与盘点）
- 窗口过小连固定段都装不下 → 保底空历史（机械供料仍在，合成仍可产出）

接线：`buildNarrativeSynthesisPrompt` 新增可选 `contextWindowTokens`；agent-invoker 经 `resolveSynthesisContextWindow` 解析——重启换模型时按**目标模型**窗口（`getContextWindowByAlias` 新端口方法），否则按该獭当前配置。缺省 undefined 不裁剪（向后兼容）。

**方案取舍记录**：搭档 9/23 拍板方案 A（丢最老）。方案 B 分段递归摘要被否——Pi SDK 无原生分段能力（`generateSummary` 是一次性全量请求，曾误称"Pi 原生"已收回），自实现需多次串行 LLM 调用，耗时翻倍、失败面 ×n、递归摘要质量退化，当前无实证需求。

### ② 超时兜底语义（搭档 9/23 原则：兜底异常而非限制质量）

`NARRATIVE_SYNTHESIS_TIMEOUT_MS` 60s → **300s**。

实证依据（9/23 日志配对统计 shadow channel starting→completed）：正常 20-65s，最大真实案例 146s（956k chars）。60s 把大 session 正常合成误判超时，且 `Promise.race` 超时后迟到的合成结果被丢弃（2676 字符优质叙事档案白跑）。300s 覆盖全部正常场景，真卡死时仍有兜底。注释写清语义防未来回调。

### ③ 失败熔断（断死循环）

`HandoffState` 新增连续失败计数：合成失败 / 降级裸重启均 +1，交接成功清零。**连续 ≥2 次失败 → 跳过合成直接机械档案交接**（warn 留痕 `synthesis circuit breaker open`）。机械档案不依赖 LLM，必然成功，断「再试一次同样超窗」的循环。

### ④ bash 守卫工作区豁免（场外 Claude 发现的残余缺口）

`checkMainCheckoutWrite` 绝对路径豁免不认主仓树下路径，但 `data/workspaces/` 是獭的合法 sandbox（9/23 排查实证：`tail log > data/workspaces/<id>/morning.log` 被误拦）。补豁免前缀。安全面：`data/logs/`、`data/metrics/`、`src/` 等仍拦；DATA_DESTRUCTIVE 层另有 rm/mv 防线。

### 顺手修：RestartModal 提交中文案误导（搭档补充排查项）

搭档实证：不勾「前世总结」仍看到「正在封装前世档案…」文案。排查结论（置信度：高）：勾选链路本身生效（后端 synthesizePast=false 跳过合成），但 ①按钮文案只看 submitting 不看勾选状态（视觉误导）；②失败降级裸重启路径不留痕 synthesizePast 原值。修复：按钮文案按勾选区分（不勾显示「正在重启…（秒级）」）；降级路径日志带原值。

## 验证

- 新增 `tests/frameworks/agent/handoff-synthesis-budget.test.ts` 15 例：预算裁剪（5）+ prompt 集成裁剪（3）+ 超时语义（1）+ 熔断状态机（2）+ 守卫工作区豁免含安全面回归（4）
- RestartModal 新增提交中文案区分测试（4 例全绿）
- agent 框架 + unified-handoff 全量 649 tests 全绿

## 影响范围

- 交接合成 prompt 体积封顶于目标模型窗口内——kimi-256k 交接不再数学性必败
- 大 session 交接不再被 60s 误杀（最长可等 300s）
- 连续失败场景 2 次后强制机械档案，交接总能完成
- bash 守卫对工作区重定向放行
- RestartModal 文案与勾选状态一致

## 机制判定前置四问（Modification-Class 依据，审视建议4补录）

1. **这属于哪类工作？** 事故修复（9/23 压缩死亡链实爆，issue 驱动直接修复）
2. **现有机制/防线清单里有没有同职责的？** 有——交接合成管线（F20260920uhuc 统一引擎）、NARRATIVE_SYNTHESIS_TIMEOUT_MS、HandoffState、bash 守卫重定向豁免，全部为既有机制
3. **它在哪个环节失效/缺失？** 合成引擎缺预算裁剪（历史段无界）、超时值语义错配（质量闸门 vs 兜底异常）、失败计数缺失（无熔断）、守卫豁免清单缺 data/workspaces/
4. **修法决策树**：①既有机制语义内修复——裁剪是合成引擎职责内的输入整形、超时是参数修正、熔断是 HandoffState 职责内的状态补全、豁免是守卫清单补全。无新增机制/抽象层/通道。

结论：Modification-Class: narrow-fix 成立（变更全部落在既有机制语义内，新增 trimMessagesToBudget 为合成引擎内部纯函数非新机制）。

## 对抗审视处置记录（检视獭-hsyn，kimi-k28）

- **严重1 熔断失效**（采纳，已修）：清零从「交接成功」（restartSession 后无条件）改挂「合成成功」（narrativeSummary 非空）。死亡链场景「合成失败→机械档案→restart 成功→清零」会让计数永远到不了 2 熔断形同虚设——检视推演正确。回归测试固化状态机语义（机械档案交接不清零）。
- **建议1 中文口径**（采纳，已修）：chars/4 → chars/3（中文 token 化接近 1.5 chars/token，chars/4 低估 2.6 倍致大中文 session 裁剪不足；chars/3 仍偏保守方向安全）。
- **建议2 固定开销 10k 可能低估 §⑤⑥**（不采纳，记录理由）：动态实测 overhead 需先构建 prompt 再测量，鸡生蛋循环；10k 为保守估计（实证机械供料典型 2-6k chars ≈ 1-4k tokens），叠加输出预留 8k 共 18k 余量， chars/3 口径下等效再打折——三重保守叠加后实测 956k chars 案例在 1M 窗口不裁、262k 窗口裁后 700k chars 远低于窗口。若未来实证不足再调。
- **建议3 裁剪标注加标签**（采纳，已修）：标注行包 `<trim-note>` 标签防 LLM 误读为对话内容。
- **建议4 Modification-Class 四问**（采纳，本节补录）。
- **守卫豁免安全面（焦点3）**：检视确认干净——豁免仅在重定向分支，DATA_DESTRUCTIVE 层 rm/mv data/workspaces/ 仍拦，路径归一化后前缀比较无穿越绕过。
- **300s 超时（焦点4）**：检视确认无新风险——影子通道不占 invoke 锁，冻结窗口变长是设计意图。
- **模型多样性**：实现者 kimi（k3），检视方 kimi-k28——同家不同代，思考路径有差异但训练数据同源，审视降級标注留痕。

## 已知边界

- 裁剪丢最老消息属信息损失：早期对话原始细节不在合成视野内。谱系摘要 + 机械盘点 + 最近原文足够新世接续；若未来实证需要早期细节，再升级分段递归摘要（方案 B 取舍记录见上）
- token 估算 chars/4 对中文偏保守（中文实际更接近 chars/1.5/token）——保守方向安全（裁更多不会更糟）
