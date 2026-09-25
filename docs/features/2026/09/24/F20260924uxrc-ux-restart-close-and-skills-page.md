---
id: F20260924uxrc
title: 交互优化：重启獭生确认即转后台 + 能力库书式改版
doc_type: feature

summary: |
  搭档 2026-09-24 反馈两点体验问题：①点击「重启獭生」确认后弹窗停留在原地、
  啥也干不了——根因是 confirmRestart 在 await api.restartOtter() 完成才关弹窗，
  而合成前世档案耗时 5-15s（最长约 1 分钟），期间 Modal scrim 全屏锁定。②能力库
  界面「乱七八糟」——旧版是「左列表右详情」二分结构，信息密度低且无趣味性。
  修复①：确认即关弹窗 + 即时 toast 告知后台进行中，成功/失败各弹终态 toast。
  修复②：书式改版（双页摊开 spread）——封面→章目录→秘籍页，连续性三件套
  （双页同框/厚度堆/章节耳），三段式 description 解析成施展/忌用/产出三槽。
  搭档三轮反馈驱动定稿，两个渲染 bug（左侧白边/翻页闪字）一并修复。

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

# 交互优化：重启獭生确认即转后台 + 能力库书式改版

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

### 修复 2：能力库书式改版（双页摊开秘籍书，搭档拍板定案）

结构选择（visual-design structure.md：结构先于视觉）：**双页摊开（spread）秘籍书**。

- 封面态：书体半宽居中（合上的书）；摊开后书体展为全宽——修复首版左侧白边
  （根因：厚度堆公式反了 + 封面纸未占满书体）
- 摊开：左页+右页同框（sheet 正反面），纸张 3D 掠过中线 rotateY(-118deg)；
  翻页中段全书压暗 22%（修复纸张背面文字「一闪而过看不清」——压暗后掠过的
  是暗影非清晰文字）
- 连续性三件套：双页同框（视野永不断档）/ 书脊两侧厚度堆（已翻|未翻，进度
  可感知）/ 章节索引耳（书缘五色耳，点耳直达章）
- 内页：章目录页（竖排章号+流派徽章+条目）与技能秘籍页（施展/忌用/产出三槽）
  交替；末尾后记+封底凑双（sheet 数 = ceil((内容页+1)/2)）

秘籍卡三槽（趣味性来源，全部真实数据）：

- `parseSkillDescription()` 解析三段式 description：Use when → 施展槽、
  Not for → 忌用槽（rose 色标签区分）、Output → 产出槽
- 未识别结构化文案（降级清单等）不装模作样拆槽，整段展示
- 点卡展开秘籍全文（含 Precondition 等未分槽内容），多卡可同时展开

趣味锚点（书式隐喻，全部真实数据）：

- 章号（壹贰叁…）/ 中文序数（第N门）/ 印章式槽位标签（忌用朱砂红）
- 章节索引耳：五色耳点达章，翻过的章耳移左缘（导航即进度）
- **反假数据立场**：不加等级/经验/星数——能力是静态目录，编数值是 B6 假数据感

演进补记（搭档三轮反馈驱动）：v1 卡片阵 → 「像本书翻开、不要固定框」→ 单页翻原型
→ 「每页孤立、没有连续性」→ 双页摊开原型 → 拍板采用 + 两个渲染 bug（左侧白边、
翻页闪字）→ 定稿。其他内容（非 skill）搭档明确后续另做展示效果。

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

- A1 结构同构：旧版是列表-详情二分，新版是双页摊开书（sheet 正反面 + 翻页引擎）——骨架完全不同 ✅
- A2 模板换色：组件树重构（sheet/PageFace/TOCPage/SkillPage/Slot），非仅调色 ✅
- A4 全屏均质：封面态唯一锚点 = 居中合上的书；摊开态左右页主次分明（目录|秘籍） ✅
- B3 图标堆砌：章耳/徽章有导航与分组信息增量，非装饰 ✅
- B6 假数据感：不加伪游戏数值，三槽内容全部来自真实 description 解析 ✅
- B8 色彩超载：暖纸/墨/烫金 + 五章色耳（低饱和），色相收敛 ✅

## 变更清单

| 文件 | 变更 |
|---|---|
| `web/src/pages/conversation/index.tsx` | confirmRestart 改同步关窗 + toast 后台化 |
| `web/src/pages/conversation/Modals.tsx` | RestartModal 删持久 submitting 文案态，保留防连点 |
| `web/src/pages/skills/index.tsx` | 书式改版：双页摊开 + 翻页引擎 + 三槽解析 + 章节耳 |
| `web/src/pages/conversation/RestartModal.test.tsx` | 适配新语义（同步触发/防连点/勾选透传） |
| `web/src/pages/skills/index.test.tsx` | parseSkillDescription 4 用例 + 封面/摊开/三槽/耳/降级断言 |

## 验证

**单测**：`npx vitest run`（web）全量 58 文件 543 用例通过，含：

- RestartModal 新语义 4 用例（同步触发/防连点/勾选透传/文案形态）
- parseSkillDescription 4 用例（标准三段式/部分段/非结构化兜底/Precondition 不污染）
- 能力库书式 5 用例（封面统计/摊开双页同框+三槽/章节耳直达/降级离线标注/空态）

**tsc/lint**：`npm --prefix web ci && npx tsc --noEmit` exit 0（与 CI 同路径 npm ci）；eslint 0 error 0 warning（skills 页）。

**原型验证**（v2 spread，Playwright）：翻页/连击消化/目录直达/无溢出全绿；顺手修三个交互 bug：连击丢步（步进排队+clamp 消化）、叠放页拦截点击（pointer-events 穿透）、章节耳被热区遮挡（z-index）。

**UI 真机自查**（code-implementation 步骤 6 硬规则，alpha 实例 3172 + Playwright
+ 截图存对话工作区）：

- 能力库：封面态书体半宽居中（无左白边）✅ / 封面书名+统计 ✅ / 摊开壹目录+companion 同框 ✅ / 三槽标签 ✅ / 五章节耳+点耳直达 ✅ / 无横向溢出 ✅
- 重启流（右栏 hover → 重启 → 确认）：★弹窗 250ms 内关闭（不再锁死）✅ /
  ★toast 即时反馈 ✅ / API 完成终态 toast（前世已封存…）✅
- 截图：`book-final-1-cover.png` / `book-final-2-open.png` / `book-final-3-ear.png` /
  `uxrc-restart-modal.png` / `uxrc-after-confirm.png`（对话工作区，呈搭档人评——
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

## 对抗审视三轮收口（检视獭-uxrc2，mimo-pro）

初轮（4 严重 + 3 建议）→ 二轮保留 1 + 新发现 2 → 三轮新回归 1 → 终轮全部归零，
delta 复核通过。发现与处置：

| # | 发现 | 处置 commit |
|---|---|---|
| S1 | PR 标题缺 [模块] CI 红 | gh pr edit（标题两步） |
| S2 | 翻页队列回放 off-by-one（双击丢步/反向超调） | cc920e6d：回放基准改 viewRef |
| S3 | 奇数内容页末页不可达（最后一门翻不到） | cc920e6d：maxView=sheetCount + 底衬页 |
| S4 | 文档承诺跑在代码前（TOC 幻影条目/不可点/全文丢段） | cc920e6d：TOC 真实化+直达+全文展开 |
| D1 | 动画中直达跳转被 Math.sign 压成 ±1 步（claim 纠偏） | 7294bca4：队列绝对目标 |
| D2 | 外典章号回归（cnNum 算出「五」撞伍章） | 7294bca4：恢复字面量 '陆' |
| N3 | last-wins 绝对目标吞同向连击（三连击落 2） | 8176483c：两全排队（步进累计+跳转覆盖） |
| 附 | 书体 preserve-3d 平面拦截点击（真机复验发现） | cc920e6d：pointerEvents 分层 |

方法论沉淀（检视獭提醒，已践行）：原型绿证 ≠ 落码绿证——后续断言必须打在落码
页面上；连击/奇偶/动画中跳转等边界形态均补了回归用例（最终 15 用例钉翻页引擎）。

终验取证：CI run 35980744728 三 job 全绿；19/19 复跑绿；11 形态模拟全绿
（双击/反向/动画中耳/三连击/四连击/跳转覆盖/异向对消/回封面/顶格 clamp）。
