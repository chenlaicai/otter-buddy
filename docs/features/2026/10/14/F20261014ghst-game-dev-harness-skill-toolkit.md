---
id: F20261014ghst
title: 游戏开发 harness 工程落地：game-dev-harness skill（四层分级指导）+ 原子工具组 + 海藻农场首个验证
summary: |
  把《Your Game Is A Harness》（kylekukshtel.com, 2026-10-10）的行为模式落成 skill+tool：
  skill 承载四层分级指导（第一性原理/底线/必需/建议）+ 规模评估指引，LLM 灵活判断不做强 SOP；
  scripts/game/ 下原子工具组（截图/图像 diff/状态导出）各自独立可用；
  game/ 海藻农场补三个可读性接口（状态导出/种子随机/确定性推进）作为首个端到端验证。
change_type: feature
capability_test: "n/a: skill+脚本属项目级开发工具，无真 LLM 能力面；行为验证走海藻农场端到端 demo（改数值→截图 diff→状态核对）+ 逐工具实跑"
intent:
  problem: "agent 开发游戏缺可复用的行为指导与工具：《Your Game Is A Harness》的工程纪律（确定性/截图 diff/可寻址状态）散落在文章里未成体系，海藻农场等游戏项目靠临时手段（P4 像素取证）做视觉回归，无状态导出接口、随机不可种子化、验证回路靠人肉"
  expected_effect: "game-dev-harness skill 提供四层分级指导（第一性原理/底线/必需/建议）+规模评估指引供 agent 灵活取用（不做强 SOP）；scripts/game/ 三个原子工具（截图/图像 diff/状态导出）文本输出独立可用；海藻农场补四个可读性接口（__gameState/__loadState/?seed/__tick）后，同 seed 同 tick 双截图 similarity=100%、改数值→截图 diff→状态核对循环脚本链路跑通"
  verify_by:
    type: behavior_check
    description: "逐工具实跑 + 海藻农场端到端 demo（含 __loadState 直达终战的确定性截图对）人工验收；npm run lint:skills 通过；同 seed 双跑 similarity=100% 实测"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: "2026-10-14"
doc_type: feature
tags: [skill, gamedev, harness, context-engineering, tooling, playwright]
modules:
  - .pi/skills/game-dev-harness/SKILL.md
  - .pi/skills/game-dev-harness/references/layered-guidance.md
  - scripts/game/game-shot.mjs
  - scripts/game/game-diff.mjs
  - scripts/game/game-state.mjs
  - game/index.html
  - game/baselines/
  - package.json
---

# 游戏开发 harness 工程落地（game-dev-harness skill + 原子工具组）

## 背景

意图锚（搭档原话，2026-10-14）：

> 「咱们把这套行为模式落成一整套skill+tool。至于说规模，我认为说，这套行为模式不要做成强sop那种，agent时代、我认为这些要把握好哪些是底线、必需、建议、第一性原理，然后由llm灵活判断，如你所说的，可能并需要都按照这个来开发、但其中的验证就能用到。如此，大小规模则由agent来评估，系统提供的是一整套偏原子的各种指导和工具」

来源：每日 AI 雷达 10/14 洞察第 6 条《Your Game Is A Harness》深挖（原文 kylekukshtel.com/ai-harness-engineering-game-development-claude-code，2026-10-10，HN 123 分/57 评论）。文章核心主张：「LLM 不会做游戏」是游戏对 agent 不可读（illegible）的上下文工程问题，解法是确定性、可截图、可寻址状态、黑盒仿真等一套工程纪律；作者本人 Postscript 声明小项目不必全上。

前置判断（本对话 10:06 深挖呈报，搭档认可方向）：文章六条纪律对「獭之传说·海藻农场」（game/index.html，单文件 92KB Canvas 游戏）的适配是「便宜的一半可落、贵的一半留给大游戏」；落地形态是 skill+tool 而非完整 agent 系统——文章的 harness 定义（「agent 面对输入应采取的动作模式集合」）与 skill 同构，海獭体系本身就是 agent runtime。

## 目标

- T1: 产出 `game-dev-harness` skill——四层分级指导（第一性原理/底线/必需/建议）+ 规模评估指引，供 agent 开发任意游戏时按需读取、灵活取用；**不做流程式强 SOP**。
- T2: 产出原子工具组（scripts/game/）：截图（game-shot）、图像 diff（game-diff）、状态导出（game-state）——每个工具独立可用、输出文本化（LLM 可消费），可单独调用也可被 skill 的迭代循环编排。
- T3: 海藻农场补四个可读性接口（window.__gameState() / window.__loadState() / ?seed=N / window.__tick(N)），作为首个端到端验证：agent 改数值 → 截图 diff → 状态核对的循环实跑一遍。
- T4: 视觉回归基建：关键场景截图基线（game/baselines/）+ 基线更新/对比的用法约定。关键场景经 __loadState() 状态注入直达（不依赖全程游玩脚本），战斗场景经 tick 派生节拍可确定性定格。

## 非目标

- 不做完整 agent 系统/独立 agent runtime（搭档明确否掉的路径）。
- 不做文章「贵的一半」：Thing fat struct 重构、Command Pattern/回放、独立仿真核心、samply 级性能剖析——留作大游戏的架构纪律，写进 skill 建议层文字即可，不做工具实现。
- 不重构海藻农场玩法/表现（P6 之后的 UI 微调不在本特性内）。
- 不注册 TS 侧 AgentTool（TypeBox schema）——游戏工具走 bash 脚本，不动系统 TS 面。
- 不做 CI 闸门（视觉回归不进 CI 强拦，先当开发期工具用）。

## 未决问题

- Q1 工具目录归属：scripts/game/（跟仓走，通用）vs game/tools/（跟游戏走）——当前按 scripts/game/ 设计，若检视/搭档认为游戏项目应自包含可挪。
- Q2 基线 PNG 是否进 git：当前按进 git 设计（每张 <100KB、约 4-6 张），若体积敏感可改为 gitignore + 本地生成。
- Q3 skill 最终定名（game-dev-harness / harnessed-gamedev / game-harness）——实现时按 writing-skills 规范定稿即可。
- Q4 底线违反的处置：当前设计是 skill 文字约束 + 检视把关，**不加机械拦截**（避免强 SOP 化）；若实际使用中底线失守频繁再议机械拦。

## 方案设计

### 总体架构（三层：指导/工具/接口）

```
.pi/skills/game-dev-harness/          ← 指导层（skill，LLM 按需读）
  SKILL.md                            ← 三段式 description + 四层框架 + 迭代循环工作流
  references/layered-guidance.md      ← 四层内容详情 + 规模评估指引 + 文章脉络出处

scripts/game/                         ← 工具层（原子脚本，bash 调用）
  game-shot.mjs                       ← Playwright 截图（file:// 或 URL，seed/tick/viewport 可控）
  game-diff.mjs                       ← 图像 diff（差异图 PNG + 相似度百分比文本）
  game-state.mjs                      ← 读游戏状态（调约定 hook，输出 JSON 文本）

game/index.html                       ← 接口层（海藻农场首个落地）
  window.__gameState()                ← 状态导出（进度/图鉴/点位/封印门/位置）
  ?seed=N                             ← 种子化 PRNG，替换核心逻辑的 Math.random
  window.__tick(n)                    ← 确定性推进（供截图脚本定格到指定帧）
game/baselines/                       ← 视觉回归基线 PNG（4-6 个关键场景）
```

### skill 内容设计（四层分级，本特性核心）

**第一性原理层（判断锚，一切取舍的依据）**
1. 可读性原理：agent 迭代游戏的瓶颈是「游戏对 agent 不可读」而非模型能力——手段是否有效，看它是否让状态/效果/进度变成 agent 可消费的信号。
2. 验证回路原理：迭代速度=验证速度，验证回路的长度决定「猜测-检验」的吞吐；能秒级验证的改动才敢小步走。
3. 确定性原理：不可复现=不可验证。随机性必须可控（种子化），否则一切验证结论都是噪声。
4. 上下文经济原理：agent 上下文是稀缺资源，验证输出要文本化、量化、最小化；过程性噪音（全量截图、逐帧日志）不进主上下文。

**底线层（must，违反即返工）**
- B1 随机必须可种子化：`?seed` 模式下**全局**（含表现层粒子/抖动）走种子 PRNG，保证同 seed 同 tick 逐像素确定；非 seed 模式下表现层可保留原生随机（B1 豁免仅此情形）。确定性验证一律在 seed 模式下进行。
- B2 每次交付改动必须有至少一条可重复的验证路径（自动化测试 / 截图对比 / 状态核对，任一）。
- B3 游戏状态必须可导出为文本（JSON/摘要），agent 不靠读代码猜运行时状态。

**必需层（should，各规模默认做，实现形式可缩放）**
- S1 视觉回归：关键场景截图基线 + 图像 diff，改动后跑对比、输出相似度文本。
- S2 状态导出接口：debug hook / URL 参数 / 控制台命令任一形式，粒度随规模。
- S3 文本化遥测：关键事件与错误输出成文本流（console/文件），agent 可直接阅读。

**建议层（may，按规模与痛点引入）**
- A1 Command Pattern/输入回放（bug 复现、确定性玩法测试）。
- A2 单一 Thing fat struct/数据模型简化（「A Tree is a Dog」——OOP 继承树终局崩塌，万物组件组合）。
- A3 独立仿真核心（引擎哑、仿真是唯一真相；网络同步/无引擎单测免费得）。
- A4 静态数据外置（数据不是代码，改数值不编译）。
- A5 文本化性能剖析（samply 类工具，capture 转文本）。

**规模评估指引（判断辅助，不是规则）**
- 微型（game jam/单文件 <2k 行）：底线层 + 一条截图回归即可，其余不做。
- 小型（单文件万行级/小团队）：底线 + 必需全做，建议层观望。
- 中大型（多模块/多人/长周期）：必需全做 + 建议层按痛点引入（先 A1/A4，后 A2/A3）。
- 判断信号：改一个数值要重新编译吗？bug 能复现吗？新成员/新 agent 上手要读多少代码？——答案越糟，越该往右靠。最终由 agent 依第一性原理自行裁量，本指引只给先例不给律令。
- **海藻农场定档（检视发现 7 消歧）**：实测 1658 行 <2k，按**微型档**定档；本特性在其上落底线+S1+S2 属「工具组首个验证载体」的超配（T3/T4 需要 S1+S2 才能闭环验证工具本身），S3 遥测不落。实装节奏由 agent 判断——超配因验证载体而起，非因规模需要。

### 工具设计（原子、文本输出）

| 工具 | 输入 | 输出 | 依赖 |
|------|------|------|------|
| game-shot.mjs | 游戏路径/URL、场景名、?seed、推进 tick 数、viewport | PNG 截图（stdout 输出路径与尺寸文本） | playwright（仓内已有 1.63.0） |
| game-diff.mjs | 两张 PNG（或一张 + 基线目录） | 差异图 PNG + 文本报告（`similarity=85.2%` + `mismatchRatio=0.023` + 通过判定） | pixelmatch + pngjs（新增 devDeps） |

（检视发现 1 附带修正：pixelmatch 的 threshold 参数是**单像素色差容忍度**，不控制通过率——通过判定用 `mismatchRatio`（不匹配像素占比）上限，默认 <1%，可在调用时覆盖。）
| game-state.mjs | 游戏路径/URL、?seed、推进 tick 数 | JSON 状态文本（stdout） | playwright |

- 每工具支持 `--help`；纯文本输出原则（相似度、mismatchRatio、路径、状态 JSON），图像文件只写盘不进 stdout。
- game-shot、game-state 共享「加载→seed→（可选 __loadState）→tick 推进→定格」的确定性启动序列（抽 scripts/game/lib/launch.mjs 共享，不引入框架）。**game-load 不单独拆工具**（delta 发现 8 定死归属）：__loadState 注入逻辑收在 lib/launch.mjs，game-shot/game-state 各增 `--state <json文件>` 参数，改动范围表保持三工具。
- diff 依赖选型取舍见「设计取舍」。

### 游戏侧接口（海藻农场，最小侵入）

1. `window.__gameState()`：返回 JSON——`{tick, player:{x,y}, unlocks:[...], codex:[...], gates:{...}, phase}`。实现为读现有全局状态的纯函数，不改玩法。（第 4 条 __loadState 是它的逆操作。）
2. `?seed=N`：页面加载时用 mulberry32（约 10 行）替换 `Math.random` 全部 **7 处**调用点（核心逻辑 5：战斗伤害/浮动 :1528/:1568/:1572/:1591/:1597；表现层 2：烟雾粒子 :590/:1046）——seed 模式下表现层同样确定（检视发现 1：烟雾粒子若保留原生随机，同 seed 双截图 similarity=100% 数学上不可达）。
3. `window.__tick(n)`：手动推进主循环 n 步（暂停 rAF 自驱，供脚本定格截图）。**配套改造**：战斗回合节拍（bTurn 链的 setTimeout，:1525/:1559/:1576-1600，lag 封顶 1200ms）改为 `S.tick` 派生计数，使 __tick 步进能推进战斗（检视发现 2：setTimeout 墙钟驱动使战斗场景既冻结于 __tick、又不可复现于自由跑——而终战恰是 P4 实证的视觉回归痛点）。浮层 DOM 定时移除（:1187/:1270/:1273）在 seed 模式下改由 tick 驱动或截图时隐藏。
4. `window.__loadState(json)`：状态注入——`__gameState` 的逆操作，读档直达任意关键场景（开局/点位/终战/图鉴）（检视发现 3：无注入接口则基线场景只能靠全程游玩脚本或人工到达，T4 不可达）。与导出接口天然对偶，实现为「校验+写回全局状态」的纯函数。

## 影响范围

- 新增 skill 与脚本，不触碰系统 TS 面（src/ 零改动）。
- game/index.html 侵入小（4 个接口 + PRNG 替换 **7 处**调用点〔核心逻辑 5、表现层 2〕〔检视发现 6：原写「约 15 处」有误，grep 实测 7 处，实际侵入面比原文声称更小〕+ 战斗节拍 setTimeout→tick 派生化），玩法逻辑不变；P7 玩法改动不与本特性冲突。
- package.json：+pixelmatch、+pngjs（devDeps），playwright 复用现有依赖。
- 对现有海獭工作流无影响（skill 是按需 read 的资源，不进默认注入面）。

## 风险与约束

- Playwright 浏览器二进制的环境依赖（CI/新机器需 `npx playwright install`）——开发期工具风险低，README/脚本内提示即可。
- 游戏侧 `__tick` 改造需暂停 rAF 自驱，注意别把主循环改坏（端到端 demo 是验证门）。
- skill 内容膨胀风险：SKILL.md 正文控制在精炼框架，细节沉 references/layered-guidance.md。
- 视觉基线的脆弱性：Canvas 游戏分辨率/字体渲染跨机器可能有亚像素差——pixelmatch threshold（单像素色差容忍度）留宽松默认（0.1）吸收亚像素噪声，**通过判定用 mismatchRatio < 1%**（不匹配像素占比上限，两个参数语义不同，检视发现 1 修正）；文档注明「基线同机生成」。

## 不兼容更新

无（纯新增 + 游戏侧加接口，不删不改既有行为）。

## 设计取舍

机制识别检查点判定：**不涉及净新增系统机制**（无配置字段/状态生命周期/定时任务/信号格式/系统持久化/跨模块路径；决策留在 LLM 判断层而非代码分支）——skill 文档、脚本、游戏接口均为交付物本身。故机制预算四问与重对抗门不触发（一行判定，供检视核对）。

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 分层形态 | 四层（第一性原理/底线/必需/建议）+ 规模评估指引 | 强 SOP 流程式 skill | 搭档定调「不要强 SOP……由 llm 灵活判断，大小规模由 agent 来评估」；四层给判断依据不给死规则 |
| skill 边界 | 1 个 skill + references 详情 | 按工具拆多个 skill | 方法论是整体、工具是原子；沿 visual-design「总纲+插件」先例（F 取舍表），避免路由描述互踩 |
| 工具形态 | scripts/game/ 独立 node 脚本（bash 调用） | 注册 TS 侧 AgentTool | 系统机制零新增；AgentTool 适合高频系统能力，游戏工具是项目级可选件；不动 schema/测试面 |
| diff 依赖 | pixelmatch + pngjs（devDeps） | odiff 二进制；零依赖浏览器内 diff | 纯 JS 跨平台免安装二进制；浏览器内 diff 使 diff 工具不原子（必须借截图工具的运行时），违背「偏原子」定调 |
| 截图引擎 | 复用仓内 playwright 1.63.0 | puppeteer；游戏内 canvas.toDataURL | 依赖已在；toDataURL 需页内执行且无法覆盖非 Canvas UI 层，通用性差 |
| 首个验证 | 海藻农场（真实项目） | 另起 demo 游戏 | 真实项目反馈最真，且 P4 像素取证已验证视觉回归是真实痛点 |
| 底线执行 | skill 文字约束 + 检视把关 | lint/工具机械拦截 | 搭档定调反强 SOP；机械拦是「必需」的过度硬化，先观察失守率再议（Q4） |
| 建议层落地 | 只写指导文字，不做工具 | A1-A5 全部工具化 | 搭档定调「可能不需要都按照这个来开发」；工具化是强推信号，留白给 agent 按规模判断 |

## 验证

1. 逐工具实跑：game-shot 对 game/index.html 截图成功；game-diff 对「原图 vs 原图」得 similarity=100% / mismatchRatio=0、「原图 vs 改后」得差异报告（含 mismatchRatio 与通过判定）；game-state 输出含预期字段的 JSON；__loadState 后 __gameState 回读一致。
2. 端到端 demo（验收主门）：改海藻农场一处数值（如作物生长时间）→ game-shot 截图 → game-diff 与基线对比出报告 → game-state 核对状态变化——「改动-验证」循环以脚本链路跑通；并经 __loadState 直达终战场景补一条同链路（覆盖 P4 实证的视觉回归痛点场景）。
3. 确定性验证（修正后口径）：seed 模式下同 seed + 同 tick 两次截图 similarity=100%（含表现层粒子/战斗节拍全程确定）；换 seed 后结果同样可复现（同 seed 双跑两次结果一致）且与基准差异可检出——确定性双向成立。
4. `npm run lint:skills` 通过（skill 文件合规）+ `npm run lint:intent` 通过（intent 块补齐）。
5. 游戏回归：海藻农场人工冒烟（开局、点位、终战、图鉴）无回归。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| .pi/skills/game-dev-harness/SKILL.md | 新增 | skill 主体（三段式 description + 四层框架 + 迭代循环工作流——工作流节加声明「参考流程非强制步骤，何时进入循环由 agent 按第一性原理判断」防 SOP 化回潮，检视发现 5） |
| .pi/skills/game-dev-harness/references/layered-guidance.md | 新增 | 四层详情 + 规模评估指引 + 文章脉络出处 |
| scripts/game/game-shot.mjs | 新增 | Playwright 截图工具 |
| scripts/game/game-diff.mjs | 新增 | 图像 diff 工具 |
| scripts/game/game-state.mjs | 新增 | 状态导出工具 |
| scripts/game/lib/launch.mjs | 新增 | 共享启动序列（加载→seed→tick→定格） |
| game/index.html | 修改 | __gameState() / __loadState() / ?seed=N / __tick(n) 四个接口 + PRNG 全局替换 7 处 + 战斗节拍 tick 派生化 |
| game/baselines/*.png | 新增 | 4-6 张关键场景截图基线 |
| package.json | 修改 | devDeps +pixelmatch +pngjs |
