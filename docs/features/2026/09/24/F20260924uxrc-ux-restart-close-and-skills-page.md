---
id: F20260924uxrc
title: 交互优化：重启獭生确认即转后台 + 能力库图鉴化改版
doc_type: feature

summary: |
  搭档 2026-09-24 反馈两点体验问题：①点击「重启獭生」确认后弹窗停留在原地、
  啥也干不了——根因是 confirmRestart 在 await api.restartOtter() 完成才关弹窗，
  而合成前世档案耗时 5-15s（最长约 1 分钟），期间 Modal scrim 全屏锁定。②能力库
  界面「乱七八糟」——旧版是「左列表右详情」二分结构，信息密度低且无趣味性。
  修复①：确认即关弹窗 + 即时 toast 告知后台进行中，成功/失败各弹终态 toast。
  修复②：图鉴式分组卡阵改版——skill 三段式 description（Use when/Not for/Output）
  解析成「施展/忌用/产出」三槽秘籍卡，趣味语言借海獭面板装备槽体系（emoji 门派
  徽章/槽位标签/点卡展开全文），不造假数据不加伪游戏属性。

type: Feature Update
domain: web
created: 2026-09-24
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
related_issues: []
related_pr: []
causal_links:
  - F20260920uhuc
  - F20260920srbtn
  - F20260901emps
---

# 交互优化：重启獭生确认即转后台 + 能力库图鉴化改版

## 背景

搭档 2026-09-24 原话：

> 1.海獭的重启獭生点击后，应该自动关闭弹窗，而不是停留在弹窗、啥也干不了
> 2.能力库界面是个啥内容，乱七八糟的，我觉得虽然只是作为展示（目前），但是应该
> 展示效果做好，而且，趣味性上还是可以参考海獭面板中的 技能槽、工具袋 这些

### 问题 1 根因

`web/src/pages/conversation/index.tsx` 的 `confirmRestart`：`await api.restartOtter()`
**完成后**才 `setModal({ type: 'none' })`。F20260920uhuc 引入的前世档案合成使这个
await 达到 5-15s（勾选引擎叙事合成时最长约 1 分钟）。期间：

- Modal 是 `fixed inset-0` 的 scrim + focus trap，全屏锁定
- F20260920uhuc 的 submitting 态把确认/取消按钮全部 disabled（防连点）
- 结果：搭档点确认后界面完全锁死，唯一能做的是等

### 问题 2 现状

`web/src/pages/skills/index.tsx`（#576/F20260901emps 建的只读页）：

- 结构：左 224px skill 列表（分组标题+两项）+ 右详情面板（标题+一段描述）——
  典型「列表-详情」二分，右侧大面积空白
- 信息：每 skill 只显示 name + description 整段，而 skill 描述本身是高度结构化的
  三段式（Use when / Not for / Output），整段平铺 = 信息密度浪费
- 趣味：无。海獭面板已有成熟的装备槽语言（⚔️武器/✨技能槽/🎒工具袋/📜心法 +
  徽章 + 玻璃卡），能力库作为「心法」的天然归属页却完全没有这套语言

## 方案

### 修复 1：确认即转后台交接

语义变更：确认 ≠ 等待完成，确认 = 提交后台任务。

- `confirmRestart`（index.tsx）：同步 `setModal({ type: 'none' })` 关弹窗 →
  `showToast('正在为 X 封装前世档案…', 'info')` 即时反馈 → `void api.restartOtter()`
  后台执行 → then/catch 各弹终态 toast（成功照旧重拉 session 链；失败含忙碌 409
  明确提示）
- `RestartModal`（Modals.tsx）：删除持久 submitting 文案态（「正在封装前世档案…」
  按钮）——弹窗都不在了，锁按钮没意义；保留点击瞬间的防连点窗口（submitting
  一次性 true，组件随 modal 关闭卸载）
- 弹窗关闭由父级落地（modal 状态归 index.tsx），RestartModal 不自作主张 onClose

### 修复 2：能力库图鉴化改版

结构选择（visual-design structure.md：结构先于视觉）：**图鉴式分组卡阵**。

- 为什么不是仪表盘/杂志流：内容是「14 个平行能力的目录」，无主次之分、无叙事
  顺序——分组卡阵（流派 banner + 自适应网格）天然支持扫读比较，一屏见全族
- 层级表：馆藏总览头（H1 级：⛩️ + 名称 + N 门心法·M 大流派统计 + 只读徽章）→
  流派 banner（M 级：门派徽章 + 派名 + 藏品数）→ 秘籍卡（辅级：徽章 + name +
  三槽）→ 展开全文（折叠级：完整 description）

秘籍卡三槽（趣味性来源，全部真实数据）：

- `parseSkillDescription()` 解析三段式 description：Use when → 施展槽、
  Not for → 忌用槽（rose 色标签区分）、Output → 产出槽
- 未识别结构化文案（降级清单等）不装模作样拆槽，整段展示
- 点卡展开秘籍全文（含 Precondition 等未分槽内容），多卡可同时展开

趣味锚点（借海獭面板装备槽语言，不越界）：

- 门派徽章：默认搭档🍃 信息层🔍 开发流程链⚒️ 编排层🎪 元规范📖 其他📦
- 槽位标签 + 「秘籍」徽章 + otter 选中 ring，与海獭面板 ✨技能槽 同语言
- **反假数据立场**：不加等级/经验/星数——能力是静态目录，编数值是 B6 假数据感

降级链保留不变（#576 契约）：API 成功 → 真实清单；失败 → 内置兜底 + 「离线兜底」
徽章（升级为 header 内徽章）；空 → 显式空态文案。

## 设计取舍

**机制识别检查点判定：全部未命中——narrow-fix 路径（既有机制语义内修）。**

- 重启弹窗：交互时序调整（同步关窗 + toast 反馈 + promise 后台化），无新机制、
  无新状态、无新依赖。toast 走既有 showToast 通道，API 不变
- 能力库：纯前端展示层重构（同一数据源 /api/skills、同一降级链），解析函数
  parseSkillDescription 是纯函数（零副作用）。不新增 API、不新增字段
- 为什么不做「全局任务进度中心」（重启进度条常驻右栏之类）：那是 mechanism-addition，
  交互问题的最小修是让弹窗别挡路；未来若多项后台任务并行再议

**能力库视觉质检门（visual-design anti-patterns.md）**：

- A1 结构同构：旧版是列表-详情二分，新版是分组卡阵网格——骨架节奏不同 ✅
- A2 模板换色：组件树重构（article 卡阵/SlotRow 槽位/流派 banner），非仅调色 ✅
- A4 全屏均质：第一视觉锚点 = 馆藏总览头（唯一 ⛩️ 大徽章卡），流派 banner 为
  M 级节奏，卡为辅级 ✅
- B3 图标堆砌：门派徽章有信息增量（分组识别），非装饰 ✅
- B6 假数据感：不加伪游戏数值，三槽内容全部来自真实 description 解析 ✅
- B8 色彩超载：otter 色系 + stone 灰阶 + 单点 rose（忌用），3 色相收敛 ✅

## 变更清单

| 文件 | 变更 |
|---|---|
| `web/src/pages/conversation/index.tsx` | confirmRestart 改同步关窗 + toast 后台化 |
| `web/src/pages/conversation/Modals.tsx` | RestartModal 删持久 submitting 文案态，保留防连点 |
| `web/src/pages/skills/index.tsx` | 图鉴化改版：卡阵 + 三槽解析 + 门派徽章 + 点卡展开 |
| `web/src/pages/conversation/RestartModal.test.tsx` | 适配新语义（同步触发/防连点/勾选透传） |
| `web/src/pages/skills/index.test.tsx` | 新增 parseSkillDescription 4 用例 + 卡阵/展开/降级断言 |

## 验证

**单测**：`npx vitest run`（web）全量 58 文件 542 用例通过，含：

- RestartModal 新语义 4 用例（同步触发/防连点/勾选透传/文案形态）
- parseSkillDescription 4 用例（标准三段式/部分段/非结构化兜底/Precondition 不污染）
- 能力库卡阵冒烟（真实清单/点卡展开收起/降级离线标注/空态）

**tsc**：`npm --prefix web ci && npx tsc --noEmit` exit 0（与 CI 同路径 npm ci）。

**UI 真机自查**（code-implementation 步骤 6 硬规则，alpha 实例 3172 + Playwright
+ 截图存对话工作区）：

- 能力库：馆藏总览头 ✅ / 14 卡图鉴阵 ✅ / 三槽标签 ✅ / 点卡展开收起 ✅
- 几何取证：scrollWidth 1440 = clientWidth（无横向溢出），首屏卡 347×125，6 分区
- 重启流（右栏 hover → 重启 → 确认）：★弹窗 250ms 内关闭（不再锁死）✅ /
  ★toast 即时反馈 ✅ / API 完成终态 toast（前世已封存…）✅
- 截图：`uxrc-skills-page.png` / `uxrc-restart-modal.png` / `uxrc-after-confirm.png` /
  `uxrc-after-api.png`（对话工作区 `data/workspaces/6b8384a6…/`，呈搭档人评——
  本模型无图片输入能力，视觉终审依赖截图 + 几何取证）

**已知 pre-existing（非本次引入）**：worktree pnpm install 环境 `tsc` 报
`MessageList.tsx: Cannot find module 'hast'`——package.json 未声明 `@types/hast`
依赖（主仓 node_modules 有历史残留所以不报）；CI 走 `npm ci`（package-lock）
路径不受影响，worktree npm ci 复跑 tsc exit 0 已验证。已在 PR 描述记录，
建议后续单独补依赖声明。

**Golden Gate**：n/a——纯前端 UI 交互与展示层变更，无 prompt/skill/协议层改动，
vitest.capability 无对应场景（verify_by=human_judge：UI 视觉与交互由搭档人评验收）。

**最简实现检查**：已过——修复 1 复用既有 showToast/api.restartOtter，零新增依赖；
修复 2 的 parseSkillDescription 是 30 行纯函数（regex 锚定三关键词），低于引入
frontmatter 解析库的重量。
