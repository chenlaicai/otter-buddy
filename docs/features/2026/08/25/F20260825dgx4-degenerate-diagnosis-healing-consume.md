---
id: F20260825dgx4
title: "issue #424 诊断：退化检测非误报 + healing 消费即处置"
summary: |
  daily-review issue #424 两部分：A 复核「8/24 退化检测疑似误报」——离线诊断脚本重放
  被拦消息完整输出（pi session jsonl），结论为真实退化而非误报：被拦的不是落库的
  1102 字符 speak 正文，而是 speak 之后继续生成的裸 text block（thinking 逐字复制后
  532 字符周期循环 49 遍，累计 26171 字符，与运行时日志精确一致）；该形态为机制 B
  盲区（ratio=0.510>0.3），机制 A 是唯一防线。B 落地「消费即处置」规范进每日健康
  检查模板。附带发现：运行进程自 8/20 起未重启，跑的旧配置 threshold=50（main 已是 20）。
change_type: bugfix
status: active
capability_test: "n/a: 纯脚本/测试/prompt 变更，无 LLM 行为改动"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# issue #424 诊断：退化检测非误报 + healing 消费即处置

## 背景与需求

### 问题描述

issue #424（daily-review）两部分：

- **A（待复核）**：8/24 11:50 UTC，conversation 325ef7b7 的一条「连贯方案文本」在 11:54:03 被判「输出内容异常重复」中断——是否 DegenerateDetector 误伤正常长输出？与 #412 的「3-5KB 阴性夹具零假阳性」结论存在张力
- **B（实锤）**：14 起 open healing events 无一被 resolve/dismiss，无法区分「已分析的」和「未碰过的」

### 关键事实先行（数据实锤）

| 证据 | 来源 | 含义 |
|---|---|---|
| 落库 segment#1 = 1102 字符，11:52:14 落库 | message_segments 表 | speak 完成时刻 |
| 运行日志 `repeat_window, repeated 50, threshold=50, totalLength=26171` | otter-buddy.log @11:54:03.762 | trip 时刻的累积长度与机制 |
| pi session jsonl line 216：text block 26171 字符，时间戳 11:54:03.763 | data/sessions/*.jsonl | **唯一保存完整输出的地方** |
| 26171 = 49 × 532 + 103，49 个周期逐字相同 | 量化分析 | 真实循环 |
| K=20 于 8/20 #342 合入 | git log -S | 运行时 threshold=50 → 进程未重启 |

## 方案设计

### A 部分诊断方法论（可复用）

核心教训：**落库文本 ≠ 检测器累积文本**。message_segments 只落库 speak 的 body；
被拦的是 speak 之后继续生成的裸 text block。诊断必须从 pi session jsonl 取完整输出。

诊断脚本 `scripts/diagnose-degenerate.mjs` 支持两种数据源：

- `--session <jsonl> --ts <timestamp-prefix>`（推荐）：提取该时间戳 assistant 消息的
  thinking/text 各 block，按 OutputGuard 语义（块边界 reset）分块流式重放（默认 37 字符/块模拟 delta）
- `--db <sqlite> --message <id>`：从 message_segments 重放（仅覆盖已落库部分）

输出双机制数值：机制 A 滑窗计数峰值 vs 阈值、机制 B distinct-ratio vs 阈值、触发时的
totalLength。退出码：0=未触发 / 1=触发 / 2=参数错误。与运行时同一份 dist 编译产物。

### A 判定结论：非误报

1. **被拦文本不是落库正文**：落库的 1102 字符重放双机制均未触发（阴性对照 ✅）
2. **真实循环**：thinking（531 字符）被逐字复制进 text block，随后以 532 字符周期循环
   49 遍 + 103 字符尾巴 = 26171 字符，与日志精确一致
3. **机制 B 盲区形态**：周期 532 与分段 100 的 gcd=4，非重叠分段相位错开，
   ratio=0.510 > 0.3——只有机制 A 能捕获。双机制设计的必要性被真实案例验证
4. **#412 结论不受影响**：阴性夹具针对的是「合法长文不误伤」，本案是真实退化，无张力
5. **运行时 threshold=50 之谜**：进程自 #342 合入后未重启，跑的旧构建。main 当前
   K=20 下同类循环 ~10.9K 字符即拦截（提前 2.4 倍）

### B 部分：消费即处置规范

issue 所述「14 起 100% 无处置」在 issue 创建后 1 小时内已被两个任务消化（01:06 批量
resolve 13 起 + 02:02 self-healing 任务 resolve 1 起），但批量 resolve 漏了 1 起——
暴露「消费即处置」未成文的操作随意性。规范写入 `prompts/scheduled/daily-health-check.md`：

- 无需修复的当场批量 resolve（notes 注明判定依据 + issue 编号）
- 需修复的留 open 等 PR 合入后再 resolve（resolutionAction 对应实际修复方式）
- 处置后重跑 query status=open 复查无遗漏（query 默认 50 条 + 单 status，需逐一排查 errorType）

### 夹具设计（对抗审视后修正）

初版声称「保周期/总量不变量」不准确（实际周期 532→569 质数化、总长 26171→27984）。
修正后的不变量声称：**保「机制 B 盲区」结构属性**（匿名前 0.510、匿名后 1.000，
均 > 0.3）+ 保「机制 A 在 K=20 下 <12K 字符触发」。匿名化刻意将周期选为质数 569，
使分段相位完全错开（ratio=1.000），比原始样本（gcd=4，ratio=0.510）更极端的 B 盲区
形态——若未来 distinctRatioThreshold 上调至 0.6 以上，原始样本形态（0.510）反而更先
失去保护，质数形态仍保持 1.000 满格距离。两种形态的边界差异在测试注释中说明。

## 实现

| 文件 | 内容 |
|---|---|
| `scripts/diagnose-degenerate.mjs` | 离线诊断脚本（session jsonl / message_segments 双数据源） |
| `tests/frameworks/agent/degenerate-detector.test.ts` | #424 型回归夹具：thinking 泄漏型循环，B 盲区断言 + 流式触发点断言 |
| `prompts/scheduled/daily-health-check.md` | healing events 消费即处置规范 |

修复提交：补特性文档（本文件）+ 修正夹具不变量声称（测试注释与 PR body 对齐实际数据）。

## 验证

- 诊断脚本复现现场：`repeat_window @totalLength=10212, K=20`（旧构建 26171 触发，新构建提前 2.4 倍）
- 阴性对照：落库正文重放不触发任何机制
- `npm test`：1532 passed（merge main 后）
- healing event 72d87e6b 已带诊断证据链 resolve（替代 02:02 的推测性判定）
- PR #436 CI 绿

## 影响范围与后续

- 不改 DegenerateDetector 阈值/逻辑（检测器按设计工作，无需调参）
- B 工具（batch resolve by filter）方案留 issue #424 评论：需跨 repository/sqlite/tool 三层 ~100 行，建议独立 PR
- 「合入 ≠ 生效」的进程重启问题：已向大獭报告，建议 deploy 流程加提醒（超出本 issue 范围）
- 诊断方法论沉淀：**pi session jsonl 是唯一保存完整输出的事实源**，后续退化类 issue 复核一律从此取数（issue #424 教训）
