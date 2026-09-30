---
id: F20260930brcb
title: bug_recurrence 检测器口径修订
summary: 同 PR 去重 + 非逻辑载体排除 + evidence 语义澄清——修正 42 条 critical 里约 9 成假聚集（#1214，承接 #1012 根因分析）
change_type: fix
capability_test: "n/a: 检测器纯函数逻辑（全确定性无 LLM），34 用例单测覆盖三处口径修订全分支"
intent:
  problem: "bug_recurrence 按文件级统计 30 天窗口 bugfix commit（≥3 触发 critical），两类误报致 9 成假聚集：①同 PR 连锁——一个系统性修复 PR 触碰 7-9 文件/squash 前链式 commit 计多次「复发」；②非逻辑载体污染——types/组装/测试文件被被动触碰计为「复发」载体。critical 常态化（44 条=默认值）淹没真复发信号，每日处置成本爆炸且事实上无人做。"
  expected_effect: "①载体排除即时生效：非逻辑载体信号（实测 45 条存量中 17 条：13 测试 + 3 bootstrap + 1 types）合入后首次扫描即 auto-resolve（resolveStaleSignals 机制，非窗口滑出）；②同 PR 去重为多 commit PR/rebase 形态的口径正确性保障（squash 惯例下当前 0 例适用，如实声明非主要收益）；③同一根因跨 PR 系列展开的聚集（实测 28/45 仍触发，如 conversation/index.tsx 11 事件）本 PR 不解决——信号本身不算冤杜（真实热点文件被反复触碰），由 severity 分级/系列归因后续 issue 承载；④evidence 语义澄清后面板可区分修复事件与 commit 计数。"
  verify_by:
    type: static_only
    reason: "检测器为全确定性纯函数（detectSignals 输入 commit 流输出信号），34 用例覆盖同 PR 去重/无 PR 号 sha 计数/非逻辑载体排除/混合载体不误伤/新 evidence 口径全分支；行为面由存量信号 auto-resolve 速度回查（issue #1214 验证断言，#1012 容器型关闭标准：绑定信号全终态且 14 天无新增，预计 10 月中下旬）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [rhi, bug-recurrence, detector, signal-quality, daily-review]
modules: [src/usecases/health/]
from: []
causal_links: ["#1214", "#1012", "#406"]
created_at: 2026-09-30
---

# bug_recurrence 检测器口径修订

## 问题（#1214，来自 #1012 根因分析）

bug_recurrence 检测器按文件级统计 30 天窗口内 bugfix commit（≥3 次触发 critical），产生两类误报，42 条 critical 里约 9 成是假聚集：

1. **同 PR 连锁计数**：系统性修复 PR 触碰 7-9 个文件 = 一次性产生 7-9 条「文件复发」信号（同一修复事件的展开被计成多处复发）；squash 合入前的链式修复 commit 同理
2. **非逻辑文件污染**：types.ts / platforms.ts / usecases.ts（组装）/ 测试文件被计为「复发」载体——它们是被多特性被动触碰的架构节点，不是「同一根因反复修」的载体
3. **occurrences 语义误导**：面板大数字（1005 等）实为「条件持续满足的小时数」（worker 每小时刷新），非修复次数

**后果**：critical 常态化 → 真复发被淹没；每日健康检查按 #406 被迫逐条处置 44 条，成本爆炸事实上无人做（first_seen 多为 9/2 起，两周无认领）。

## 方案设计（三处口径修订，单文件 detect-signals.ts）

### 1. 同 PR 去重（核心）

触发判据从「bugfix commit 次数 ≥3」改为「**不同修复事件数 ≥3**」：
- 有 PR 号的 commit：同 PR 号去重计 1 个事件（`prs: Set<number>`）
- 无 PR 号的 commit（本地修复链）：按 sha 去重计（`noPrShas: Set<string>`）

效果：`c1/c2/c3` 三个 commit 若同属 PR #500 → 1 个事件不触发；跨 3 个不同 PR → 3 个事件触发。系统性修复 PR 展开 7-9 文件不再连锁报警。

### 2. 非逻辑载体排除（isNonLogicCarrier）

```ts
tests 文件（isTestFile 复用）
/^types?.[cm]?[jt]s$/     // types.ts / type.ts（类型被动扩散）
/^index.[cm]?[jt]s$/      // 转发桶
/^(platforms|usecases|main).[cm]?[jt]s$/  // 组装/入口
/(^|/)bootstrap//         // 启动装配目录
```

排除理由：类型修改必然扩散（架构使然），组装/测试文件是多特性被动触碰面——计入只稀释区分度。同批 commit 里的逻辑文件不受影响（逐文件判定）。

### 3. evidence 语义澄清

旧：`窗口 30 天内 bugfix 10 次（sha, sha, …）`——「次」与面板 occurrences（小时数）混用误导
新：`窗口 30 天内 3 个不同修复事件（PR #501, #502, #503；bugfix commit 4 个，首末修复 2026-08-16→2026-08-22）`——独立 PR 数（触发判据）+ 原始 commit 数（保留展示）+ 首末日期，面板可区分「修复事件」与「commit 计数」。

## 设计取舍记录（机制判定）

Modification-Class: narrow-fix——检测器内部口径修订（判据/排除/文案），无新机制、无 schema 变更、无新依赖。信号消费方（面板/aging worker/triage）读 evidence 字符串与 detail 结构，两者兼容不变。

### Why（未选替代方案）

- **阈值动态化（占窗口 bugfix 总数 %）**：#1012 建议方向之一，但分母随迭代节奏漂移——高密度期阈值实际抬高，低密度期又过于敏感；事件级去重直接对准「同一修复事件被展开计数」，语义更准
- **按文件 LOC 归一化**：LOC 采集需额外管道（git log + cloc），成本高且大文件本来就该更受关注（复发风险与 LOC 正相关是合理先验）
- **同根因聚类（相似 message/相邻行号）**：语义聚类不可靠（commit message 质量参差），PR 号是现成的「同一修复事件」显式边界——squash 工作流下天然成立

### 残留接受项

- 无 PR 号的本地修复链按 sha 计数，理论上同一修复拆 N 个 commit（无 PR）仍会触发——但本项目流程要求 PR-only 交付（R1），无 PR 的 bugfix commit 属违规形态，触发报警反而是正确行为
- 非逻辑载体清单是白名单式枚举，新形态的组装文件（如未来新增 barrel）需人工补充——量小可控，不为预见不了的形态过度设计

## 验证

### 测试证据（tests/usecases/health/detect-signals.test.ts，34 用例）

新增 5 用例（#1214 首版标注）+ 检视处置补 3 用例（混合计数文案/bootstrap+index+main 三类排除/weixin runtime 载体回归锚）：
- 同 PR 3 commit → 1 事件不触发（连锁报 7-9 条的形态根治）
- 4 commit 跨 3 PR → 3 事件触发，evidence 含 `#501` PR 清单 + 首末修复日期
- 无 PR 号 3 commit → 触发，evidence 含「无 PR 号」
- types.ts ×3 PR / platforms.ts ×3 PR / usecases.ts ×3 PR → 全不触发
- 混合载体（types.ts + invoker.ts 同批）→ invoker.ts 照常触发（排除不误伤）

更新 2 用例（旧「3 次」断言 → 新「3 个不同修复事件」口径）。

回归：health 域 22 文件 297 用例全过；tsc 0 错。

### Golden Gate

Golden Gate: n/a（verify_by=static_only——检测器为全确定性纯函数，无 prompt/skill/协议层软代码变更；信号面板消费的 evidence 是数据展示文案非模型可见行为面）

### 验证断言（issue #1214 回查口径，检视处置后实测口径）

断言分两类时间模型（检视发现 7：resolveStaleSignals 每扫描即消解未检出 open 信号，非等窗口滑出）：
- **即时类**：17 条载体排除信号（13 测试 + 3 bootstrap + 1 src 根 types）合入后首次扫描即 auto-resolve——回查 sqlite signals 表 bug_recurrence open 计数应降 17
- **衰减类**：28 条仍触发信号随各自 bugfix commit 衰减出窗（30 天窗）逐步消解，预计 10 月中下旬归零；期间新 evidence（含「N 个不同修复事件」）随扫描 UPDATE 落到存量行
- **存续声明**：同一根因跨 PR 系列的聚集（conversation/index.tsx 型）本 PR 后仍会触发——这是真实热点信号非误报，severity 分级/系列归因由后续 issue 承载（见检视处置记录）

到期：随 #1012 容器型关闭标准（绑定信号全终态且 14 天无新增）一并回查。

## 检视处置记录（检视獭-1259 初轮：1 严重 + 6 建议）

- **严重 1（同 PR 去重对真实数据零作用）采纳「路径②+范围声明」而非路径①**：实测 322 条 BugFix 中 PR 号全不重复（squash 下 1 PR = 1 commit），同 PR 去重 0 压缩；假聚集主形态是同一根因跨 PR 系列展开（28/45 仍触发）。大獭裁决不走系列级归因（issue 引用聚类实测覆盖率仅 51/322 = 16%，裸 #N 多指向 bug 单非系列键，拿 16% 覆盖的归因键当主判据会把 84% commit 归到回落键，治不了根因反增解释成本）——改为：①expected_effect/验证断言改为实测可达口径（17 即时 + 28 衰减 + 系列存续声明）；②同 PR 去重保留为多 commit PR/rebase 形态的口径正确性保障（注释如实声明适用面，不称「对准根因」）；③severity 分级（热点活跃 vs 真腐烂）+ 系列归因重开 issue 承载（见后续动作）
- **建议 2（PR 号首匹配错认）采纳**：PR_NUMBER_REGEX 改行尾匹配 `.*\(#(\d+)\)\s*$`（squash 追加位恒在行尾；实测 320/322 行尾带号、12 条双号形态全取尾号、0 条丢失）；补 3 个 parser 用例
- **建议 3（文案冗余）采纳**：evidence 三分支各自不冗余（纯 PR / 纯无 PR「N 个无 PR 号 commit」/ 混合「PR #a + M 个无 PR 号」）+ 断言锚
- **建议 4（types 误伤）采纳收窄版**：排除面收窄为「src 根 types.ts + bootstrap/ 目录」——实测 weixin/types.ts 含 6 个 runtime 导出（WEIXIN_* 常量）不该排除，orchestrator/types.ts 纯类型但深层域不达阈无信号；.tsx/.jsx 转发桶边界定调（index 规则含 tsx）；补 weixin 回归锚用例
- **建议 5（注释前提失实）采纳**：noPrShas 注释改「各计 1 事件」（sha 唯一 Set 恒等数组）；squash/rebase 前提显式化（merge-commit 流中间 commit 无 PR 号会各计事件，当前 321/322 成立）
- **建议 6（用例计数与覆盖缺口）采纳**：声明改「新增 8」（5 首版 + 3 检视补）；补 bootstrap/index/main 三类排除用例 + 混合 PR/无 PR 计数文案用例
- **建议 7（时间模型）采纳**：验证断言区分即时类（17 条首次扫描消解）与衰减类（28 条出窗）——见上方验证断言段

结论词口径：检视獭用了 skill 机械决策表的「需要修改」（严重↔request-changes 对应），与派工措辞「存在以下问题（决策者判断）」同语义，接受不要求统一。

## 后续动作

- issue #1214 随 PR closes；#1012 按容器型标准等待关闭
- **重开 issue**：severity 分级（热点活跃 vs 真腐烂）+ 系列归因（16% issue 引用覆盖不足的解法探索：featureId 链/时间窗聚类）——本 PR 明确不承载，避免窄 PR 塞大机制
- weixin/message-processor.ts 真复发观察继续（#1012 每轮动作）
