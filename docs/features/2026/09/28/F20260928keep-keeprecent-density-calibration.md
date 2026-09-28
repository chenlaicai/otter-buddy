---
id: F20260928keep
title: 保留段密度校准：重启獭生上下文 3 倍超预算修复
summary: 重启獭生后新世首轮 60K token 偏离 20K 预算——切点计量 chars/4 英文假设在中文下低估 ~3 倍。修法：预算线性换算 round(20,000×1.25/4)=6,250（estimateTokens 常数线性→换算等效 divisor=1.25 直计，零移植风险）+ 密度观测锚 + 回放节单条截断。预期面板 ≤40K。
created: 2026-09-28
updated: 2026-09-28
created_in_conversation: f4982c33-edbf-4156-913d-aaac095ff485
fixes_issue: null
modules:
  - src/frameworks/agent/session-slicer.ts
  - src/bootstrap/platforms.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
capability_test:
  - tests/frameworks/agent/session-slicer.test.ts
---

# 保留段密度校准：重启獭生上下文 3 倍超预算修复

## 摘要（summary）

重启獭生后新世首轮上下文 60K token，严重偏离设计预期（保留段预算 20K token）。根因：切点计量用 SDK `estimateTokens`（chars/4，英文假设），中文内容真实密度 ~1.9 chars/token（消息层中位），保留段 80K chars 被计为 20K token、实际 ~42K。修法：**预算线性换算**——`findCutPoint` 的 estimateTokens 是常数线性估计器（chars/4），预算对其单调，故传 `round(20,000 × 1.25 / 4) = 6,250` 即等效「divisor=1.25、预算 20K」停刀（Σchars ≈ 25,000 边界），零移植风险，SDK 全部边界语义自动继承。附差分口径密度观测锚 + 保留段内嵌回放节的单条截断 MVP。预期重启獭生后面板 ≤40K（常态 ~35K）。

## 问题现象（生产实证）

- 2026-09-25 14:49 生产实证（pid 73411）：重启獭生后 UI 面板 60K token；新世首轮注入消息 84,487 chars，服务端实测三项合计 62,666 tokens（input+cacheRead+cacheWrite，不含 output，session jsonl usage 实读）。
- 保留段实测 80K chars（keepRecent=20K 估算 token 预算恰好切满），真实计价 ~42K token（消息层密度）——设计预期 20K，约 2-3 倍偏离（体量随内容形态浮动，见定标节行为表）。
- 搭档原话定调：「现状就是偏离咱们的预期了，那说明这就是问题、是 bug」（2026-09-25 15:46）。

## 根因分析

1. **切点计量失真**：slicer 切点调用 SDK `findCutPoint`（session-slicer.ts:70），其内部 `estimateTokens` = chars/4（compaction.js:188-193 实读）——「4 chars ≈ 1 token」是英文经验值。中文消息层真实密度中位 1.97 chars/token（差分定标，见下节）→ chars/4 低估 token ~2 倍 → 切点后移 → 保留段过胖。
2. **放大器**：保留段机械切片不做内容理解——旧 session 尾部各轮注入自带「## 对话历史」节（检视獭报告原文 11.9K chars 等），与叙事摘要的浓缩版双份携带。
3. **影响面全景**：
   - 中招：重启獭生保留段切点（本 PR 修）；Pi SDK 自动压缩保留段（SDK 内部同款算法，黑盒不可改——当前 glm 1M 窗口几乎无感，kimi-256k 262K 窗口下有同款保留风险，**reserveTokens 需覆盖估算误差以避免压缩后立即再触发**，边界写明不修）。
   - 安全：Pi 压缩触发判定 shouldCompact（真实 usage）、水位交接（真实 usage）、合成预算（#1163 已夹逼定标）。

## 定标过程（差分法，可复现，快照如下）

- **方法**：9/24-9/28 全部 69 个 session jsonl，相邻带 usage 轮差分——Δchars（新增消息 text+toolCall 参数+toolResult 输出）/ Δtokens（三项合计增量，不含 output，脚本 :6/:35 实读）。差分**天然扣除 system+tools 固定基线**，测的就是新增内容本身的真实密度（检视獭-keep 初轮指出前版「全请求分母」污染，此为修正版方法论）。脚本：`data/workspaces/f4982c33.../density_final.py` / `density_layers.py`，可复现。（runtime 观测实现 entryUsageTokens 为四项含 output，宽容 cacheWrite 缺失——与脚本三项口径在告警带宽下无功能影响，代码注释如实标注）
- **总体快照（density_final.py 与 density_layers.py 两脚本独立运行、间隔内样本自然增长放同一节；采集时刻 2026-09-28 09:5x，样本截止 9/28 当日全部既有 session；分层脚本 n 略增 526→538 系采样窗口推进，分位数两者完全一致）**：
  - density(chars/token) 分位：p10=0.45 p25=0.99 **p50=1.89** p75=2.53 p90=3.42 min=0.01 max=25.18
  - **加权总密度（Σ/Σ）= 1.248**（后续复跑随样本累积在 1.23-1.25 区间微漂，属采样窗口效应非口径漂移）
  - 分层：消息层（n=473，toolish chars 占比≤50%）p10=0.50 **p50=1.97** p90=3.42；toolish 层（n=53）p10=0.11 p50=0.81——低密度尾部主要是大 JSON toolResult。
- **校准取值 divisor=1.25**：与加权总密度 ~1.23-1.25 吻合（可解释性最强：「总体平均恰好达标」的常数）；预算语义 = 保留段 Σchars ≤ 20,000 × 1.25 = 25,000 chars。
- **行为表（如实声明方向中性 + 已知尾部风险）**：

| 内容形态 | 真实密度 ρ | 25K chars 真实 token | 相对 20K 预算 |
|---|---|---|---|
| 消息层常态（中文叙事） | 1.9~2.5 | 10-13K | 预算内偏安全 ✓ |
| 总体加权 | 1.25 | 20K | 恰好达标 ✓ |
| 低密度尾部（code/JSON 重） | 0.45 | ~55K | **超 2.8 倍** ⚠️ 已知风险 |

  尾部超预算是**无 tokenizer 的方法论极限**（chars-based 计量对高密度 code/JSON 内容必然低估）——观测锚兜底（改动点 2 密度持续出界即 warn），且即使尾部 55K 相比修复前（80K chars 不设防全保留）仍是改善。如实标注，不宣称「方向安全」。
- **不动态自适应**：密度是内容形态属性而非 session 属性（session 内方差 p10=0.45 / p90=3.42）；固定常数 + 观测锚先红，漂移时再定标。
- **局限**：样本全为中文+GLM/kimi 模型（9/24-9/28 生产数据）；换模型/语言时观测锚先红。

## 方案设计（3 个改动点）

### 改动点 1：预算线性换算（核心，检视獭-keep 严重 2 采纳）

- **位置**：`src/frameworks/agent/session-slicer.ts`（sliceSessionEntries 内）
- **做法**：仍调 SDK `findCutPoint`，但传入换算预算：`sdkBudget = round(keepRecentTokens × OTTER_CHARS_PER_TOKEN / 4)`，即 `round(20,000 × 1.25 / 4) = 6,250`。等效语义：SDK 内部 estimateTokens(chars/4) 累计到 6,250 ⟺ Σchars ≈ 25,000 ⟺ divisor=1.25 下 20K token 预算。差异仅 per-message ceil 舍入（每消息 ≤4 chars，n 条消息 ≤4n chars 上界）。
- **为什么换算而非自研**（检视獭-keep 初轮证明的数学等价）：estimateTokens 是常数线性估计器（chars/4，image 4,800 固定值不影响文本路径），findCutPoint 预算比较对其单调 → 换算后的停刀位置与「自研 divisor=1.25」等价，而 SDK 全部边界语义（零 token 跳过/切点取整/元数据回扫/split turn/预算未满取首切点/compaction entry 跳过）自动继承，**零移植风险**。
- **常数**：`OTTER_CHARS_PER_TOKEN = 1.25`（framework 层常数，注释锚定本节定标快照：n=524、加权 1.248、消息层 p50 1.97、数据源与日期）。
- **机制检查点**：一行算术 + 一个常数，无新决策分支/枚举/config 字段 → narrow-fix 成立。

### 改动点 2：密度观测锚（差分口径，防漂移）

- **位置**：`src/frameworks/agent/session-slicer.ts`（slice 完成处）
- **slice 日志**（每次切点一条，频次低不添噪）：`[keeprecent-slice] cut: {cutIndex}/{total}, keptChars: X, divisor: 1.25, budgetChars: 25000, rule: "linear-convert"`。
- **真实密度告警**（观测点：**旧 session 切片时**，检视獭-keep D1 采纳推荐 b）——sliceSessionEntries 处理旧 session 时，从旧 session jsonl 末尾取相邻两个带 usage 的 assistant 轮，`measuredDensity = Δchars / Δ(四项合计含 output，宽容 cacheWrite 缺失)`（runtime 口径；离线定标脚本为三项不含 output——两口径在告警带宽下无功能影响，如实现注释。同 session 相邻轮差分数学有效，跨重启边界不求值）。数据源：slicer 入参 entries 自带 usage（session jsonl 权威源），无需 invoker 侧改动。
- **告警语义**（定死，可执行）：按 scope（otterId）隔离——滚动窗口最近 5 次观测中 ≥4 次 measuredDensity 落在 **[0.45, 3.5]** 外 → 同 scope 24h 内最多 warn 1 条（含 5 次观测值序列）。区间依据：[p10=0.45, p90=3.42] 分位带（下沿对齐 p10，不再高于 toolish 层正常形态）。实现：sliceSessionEntries 第三参 options.scopeKey（agent-invoker 调用处传 otterId）+ 模块级 Map<scope, {observations, lastWarnAt}>。
- **MVP 边界**：slice 日志 + 差分观测点本 PR 落地（同在 slicer，改动面小）；若观测点实现超预期可拆跟进项，但口径以本节为准。

### 改动点 3：保留段内嵌「对话历史」节单条截断（MVP 收窄）

- **位置**：`src/frameworks/agent/session-slicer.ts`（保留段序列化前，消息 content 层处理——序列化前截，避免 serializeConversation wrapper 混入计数）
- **对象**：只处理注入 user 消息 content 中「## 对话历史（你上次发言后的消息）」节头标记**之后**的行级 sender 消息块（`[sender] 消息体` 形态；节头在同 content 内「## 当前时间」之后，格式锚点 dispatch-chain-engine.ts:827/849）；**正常对话消息一律不截断**。
- **规则**（单条截断，不做窗口级截断）：
  - 单条 sender 块 > 1,500 chars → **头 750 + 尾 750** + 中间单行标记 `…（截断 N chars；原文见前世 session jsonl）`——头尾各半（检视獭报告的结论/署名在尾部，纯保头会恰截掉结论）。
  - 尾注措辞**恒真**（检视獭-keep D3 采纳推荐 c）：只写「原文见前世 session jsonl」——序列化发生在合成成败落定之前（agent-invoker.ts:1009 序列化 vs :1016+ 合成），任何按意图 flag 分支的写法在降级路径都会撒谎；有叙事摘要的场景由摘要本身自明，无需尾注宣称。
- **为什么窗口级截断移出**（检视獭-keep 严重 3 采纳）：被截窗口的消息可能是切点后消息的唯一载体（叙事摘要只覆盖切点前；首代无 previousSummary；机械路径无摘要）——「更早窗口有浓缩副本」的论证不成立。单条截断不依赖任何副本存在性论证，信息保真成立（头尾各半 + 永可回溯 jsonl）。
- **鲁棒性**：节头标记不匹配（注入格式变化）→ 不截断（fail-open），观测锚照常打 slice 日志。

## 验证

### 单元测试（tests/frameworks/agent/session-slicer.test.ts 新建；unified-handoff.test.ts 扩展最终未另立新用例——截断/观测锚端到端由 session-slicer.test.ts 的 serializeKeptWindow 全链段 + agent-invoker scopeKey 传递覆盖，能力面无缺口，如实改口避免承诺与 diff 脱节）

1. **体积预算（chars 紧边界）**：fixture 为**不含「## 对话历史」节**的中文大保留段原料（fixture 隔离——防被改动点 3 掩蔽），断言切点后保留段 Σchars ≤ 25,000 + **maxFixtureMessageChars**（停刀粒度=一条完整消息：累计恰超预算时最后一条整条保留，上界=预算+最老保留消息 chars；检视獭-keep D2 实跑证伪 4n 上界后修正）。度量函数用显式 chars 累计，不引入「token」歧义单位。
2. **换算等效性**：测试内实现参照累加器（divisor=1.25、逐条累计 chars/1.25 至 20K 停刀，只模拟估算与停刀、不复制切点合法性逻辑），断言 SDK findCutPoint(budget=6,250) 的保留集合与参照累加器 kept 集合一致（两 kept 集合允许相差 ≤1 条边界消息，cutIndex 同容差；检视獭-keep 2,000 组随机 fixture 实测 30 例差 1 条，源于 per-message ceil 舍入的边界抖动——4n 等价性容差归位于此）；divisor=4 回退时与现状切点一致（回归锚）。
3. **截断规则**：fixture 含「## 对话历史」节（2 个超长 sender 块 + 正常块），断言：截断标记出现、头尾各 750 保留（首尾内容可识别）、正常块原样、节外消息不受影响。
4. **fail-open**：无节头标记的 fixture → 原样序列化零改动。
5. **低密度行为快照**：code/JSON 重 fixture（模拟 toolish 形态）→ 记录切点位置为快照断言（不做预算断言——尾部超预算是已知风险，快照防无声漂移即可，快照变化必须伴随定标重审）。

### 生产验收

- 搭档重启獭生后面板数字：60K → **≤40K 判达标**（常态预期 ~35K = 保留段 13-20K + system/固定 ~15K；若落在 41-45K 须附密度观测值解释（低密度内容所致），>45K 视为未达标回查）。
- `[keeprecent-slice]` 日志出现，rule=linear-convert。
- 七段叙事档案照常生成（合成通道不受影响）。

## 影响范围

| 表面 | 影响 | 处置 |
|---|---|---|
| 重启獭生保留段 | 常态回到 10-20K token | 本 PR 改动点 1/3 |
| Pi SDK 自动压缩切点 | 黑盒不可改 | 不修（边界写明；reserveTokens 需覆盖估算误差避免压缩后立即再触发） |
| Pi 压缩触发/水位交接 | 真实 usage 口径安全 | 无需调整 |
| 合成预算 | #1163 已修 | 无需调整 |

## 非目标

- 不改 Pi SDK 内部压缩（黑盒）
- 不新增 config 字段（OTTER_CHARS_PER_TOKEN 为代码层常数）
- 不做动态密度自适应（理由见定标节）
- 不做窗口级截断（副本存在性论证不成立，检视獭-keep 严重 3；信息保真靠单条截断 + jsonl 可回溯）
- 不修「yield 交还后已读游标不推进」quirk（另案）
- 不动正常对话消息（只截保留段内嵌回放节的单条超长块）

## 风险与取舍

- **低密度尾部超预算**（行为表 ⚠️ 行）：chars-based 计量的方法论极限，观测锚兜底 + 快照测试防漂移；相比修复前不设防仍是改善。接受为已知风险。
- **1.25 取值模型依赖**：样本全中文+GLM/kimi；换模型观测锚先红（[0.45,3.5] 出界即 warn），再定标。
- **截断初值**（1,500/头尾各半）为初值，生产观测后可调。
- **取舍**：换算 vs 自研移植 → 换算（数学等价 + 零移植风险，检视獭-keep 证明）；单条截断 vs 窗口截断 → 单条（不依赖副本论证）；固定常数 vs 动态自适应 → 固定 + 观测锚（session 内方差过大，动态不稳）。

## 实现记录（2026-09-28，审视通过后）

四改动点全部落地（commit 54d6d831 rebase 后，PR #1183）：① 预算线性换算 round(20,000×1.25/4)=6,250 + OTTER_CHARS_PER_TOKEN=1.25 常数（注释锚定定标快照）；② 观测锚——[keeprecent-slice] cut 日志 + 密度告警按 scope（otterId）隔离（实现轮 S1 处置：Map<scope,{observations,lastWarnAt}> + 24h TTL，agent-invoker 调用处传 scopeKey）；③ 回放节单条截断（头尾各 750+恒真尾注，content 兼容 string/text-block 双形态——数组形态 bug 由端到端用例抓出）；④ 实现轮审视补丁（对称 diff/定点锚/告警 scope 断言/口径注释/文档对齐）。全量 285 文件 4,000 测试通过（+7 新用例）、tsc/eslint 0 error、CI 三绿（run 36371779943）。审视链：方案三轮（初轮 4 严重 6 建议 → delta 3 残留 → v2.1 通过）+ 实现两轮（初轮 1 严重 4 建议 → delta 通过零阻塞）。
