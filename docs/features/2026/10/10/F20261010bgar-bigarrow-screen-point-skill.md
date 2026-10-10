---
id: F20261010bgar
title: bigarrow 屏幕标注能力集成（screen-point skill）
summary: 将 HN 热门开源工具 big-arrow-on-the-screen 以薄 skill 形态接入海獭系统——獭获得「在搭档屏幕上画箭头/框/文字」的空间指引输出通道，用于引导点击、指认界面元素、远程指导操作。零代码改动，纯 skill 层集成。
change_type: feature
capability_test: n/a（纯 skill 文件 + 外部二进制，无代码路径；Golden Gate 豁免见验证节）
intent:
  problem: 獭的「给人看的输出」只有聊天室文字单通道——碰到只有人能干的步骤（授权弹窗、2FA、多 tab 指认、设置深处的开关），獭只能文字描述位置，搭档自己找，沟通成本高且易错
  expected_effect: 獭可在搭档物理屏幕上绘制箭头/框/文字指引（自动消失、点击穿透），「做什么」用文字说、「在哪里」用箭头指，双通道输出
  verify_by: human_judge（端到端真机演示：獭响应「帮我指一下 X」，箭头出现在正确位置且自动消失——见验证节第 4 步）
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
tags: [skill, tool, ux, agent-output, external-dep]
modules: [.pi/skills/, prompts/skills/manifest.yaml]
---

# bigarrow 屏幕标注能力集成（screen-point skill）

## 背景

搭档原话（意图锚）：

> 「big-arrow-on-the-screen 这个东西，有点意思，你看看，咱们能集成进来吗，我感觉有点意思哦」
> 「你先给我介绍下，这是个啥、然后咱们要如何集成，干啥用，全链路要先分析设计清楚再动手」

外部背景：big-arrow-on-the-screen（下称 bigarrow）2026-10-08 发布，Show HN 单日 368 分，MIT 开源，macOS 单二进制。

## bigarrow 是什么（外部事实，源：官方 README 全文 2026-10-10 抓取，flag 语义经对抗审视逐条核验修正）

- **形态**：macOS 命令行工具（一个 Swift 二进制，无守护进程/无菜单栏/无遥测），另附 Claude Code 与 Codex 的 skill 定义
- **能力**：在所有窗口之上绘制大箭头、方框、圆圈、大字牌子——**点击穿透、不抢键盘焦点、箭头自动消失**
- **定位方式**（按 README Target 语法，权限分级）：
  1. 坐标级（零权限）：`--at X,Y` / `--rect X,Y,W,H` / `--mouse`
  2. UI 元素级（需宿主 App 有 Accessibility 权限）：`--element "Label" --app App`，可加 `--role` 细化（如 `--role textfield`）；`bigarrow elements --app X` 可列出当前可匹配元素
  3. 窗口/tab 级：`--window App[:title]` / `--app "App:tab 标题"`——先 raise 到前台再指；权限分档：**无标题匹配（`--window App` / `--app App`）零权限；带标题匹配（含 Chrome tab 选择 `--app "App:title"`）需 Accessibility；macOS 26 上带标题的 window 匹配另需 Screen Recording**
  4. 辅助：`--peekaboo ID --snapshot see.json`（Peekaboo 快照定位）；`--display N` 多显示器切换坐标参照
- **画箭头本身零权限**（坐标/矩形/鼠标位置定位均零权限）；macOS 把 Accessibility 权限授给启动 bigarrow 的宿主 App（Terminal/iTerm2 等），不是 bigarrow 本身，`bigarrow doctor` 会指名该给谁开
- **权限矩阵**（README 原表）：`--at`/`--rect`/`--mouse` 零权限；`--element`/`elements`/`--until-click`/`--app App:title` 需 Accessibility；`--window App:title` 在 macOS 26+ 需 Screen Recording（+ Accessibility 才能raise）
- **安全设计**：框/圈是空心轮廓不挡视线，点击一下即消，进程死箭头跟着消失（duration 兜底：`point` 默认 8s、`start` 默认 300s、`0` 为不限）；作者 FAQ 专门论述「agent 能否用箭头骗人点错按钮」并配有自动化测试
- **工程纪律**：104 个自动化测试 + 18 项真机行为验证 + CI 矩阵，两天近 400 星
- **已知边界**：Chrome 页面内元素默认不可 AX 定位（需 `--force-renderer-accessibility` 或 VoiceOver；Chrome 自家工具栏始终可）；Electron 应用可正常 `--element`

## 目标

T1: 獭获得屏幕空间标注输出通道——在搭档的物理屏幕上绘制箭头/框/文字指引
T2: 以薄 skill 形态集成，零 src/ 代码改动、零系统机制新增
T3: 全链路（安装→skill 注册→真机调用→自动消失）验证可用

## 非目标

- 不做输入注入——只画指引，不让獭替人点击（bigarrow 本身也不点击）
- 不改 src/ 任何代码、不新增系统配置/schema
- 不支持 Windows/Linux（bigarrow 是 macOS-only，本机环境为 macOS）
- V1 不面向小獭——skill 是懒加载机制（F20260724skch：小獭无 read 工具，SKILL.md 全文对其物理不可达），等小獭具备 skill 消费通道再扩展
- 不使用 bigarrow 的 `install-skill`（那是给 Claude Code/Codex 的，我们的 skill 自建）也不引入自动更新/版本锁定机制（brew 管理即可）

## 未决问题

1. brew 安装由大獭执行还是搭档手动执行（涉及搭档开发机系统级变更，呈报时确认）
2. Accessibility 权限何时授予：建议首次需要 `--element` 定位时再开（坐标级零权限即可满足多数指路场景，`--element` 是增强）；`bigarrow doctor` 可指名待授权 App
3. skill 命名：本方案定 `screen-point`（能力导向），搭档可改

## 方案设计

### 集成链路三层

**L1 二进制层（搭档机器）**
- `brew install franzenzenhofer/tap/bigarrow`；验证用 `bigarrow doctor`（README 明确记载：输出权限状态与显示器诊断；`--version` 未在 README 记载不依赖）
- 回退干净：`brew uninstall` 即净；前提是不执行过 `bigarrow install-skill`（该命令会写 `~/.claude/skills` 与 `~/.agents/skills`——本方案不用它，若误执行需删对应目录）

**L2 skill 层（仓库，走 worktree + PR）**
- 新增 `.pi/skills/screen-point/SKILL.md`（category: technique，≤200 行）
- description 三段式（≤500 字符，铁律：只写触发条件不写流程），**核心纪律一句话上提 description 层**（每轮注入恒可见，弥补懒加载正文不可达的空窗）：
  - Use when: 獭需要向搭档指出屏幕上的具体位置/按钮/区域时——引导点击、指认界面元素（「哪个 tab」「哪个按钮」）、指导操作路径、需要搭档注意力落到物理屏幕某处
  - Not for: 獭自主操作输入（只画不点）；非 macOS 环境；小獭使用（懒加载不可达）
  - Output: 屏幕上的箭头/框/文字标注（自动消失）+ 配套 speak 说明
  - **纪律句（写进 description 尾部）：画之前必须先 speak 说明要指什么及为什么；敏感界面（密码/支付）不画**
- 工作流骨架：判定场景（搭档请求 or 协助流程中的指引点）→ 选定位方式 → 构造 bigarrow 命令 → bash 执行 → speak 告知搭档看哪里、为什么
- 安全纪律写入 skill 正文（细节层）：牌子 `--text` 写完整短句；默认短 `--duration`；被 bash 守卫拦截时不重试变体，speak 文字指路兜底
- manifest 同步（`prompts/skills/manifest.yaml`：name/category/next/not_for）+ `npm run lint:skills` 0 error

**L3 调用层（运行时语义）**
- 消费者：大獭（唯一）
- 触发场景：a) 搭档显式请求（「在哪」「哪个」「帮我指」）b) 大獭协助流程中遇到只有人能干的步骤（授权弹窗、2FA、设置深处的开关）c) 多 tab/多窗口指认
- 输出模态升级：獭的「给人看的输出」从单通道（聊天室 speak）变为双通道（speak 文字 + 屏幕空间标注）——文字说「做什么」，箭头指「在哪里」
- **降级路径**：bash 守卫拦截命令（`--text`/`--say` 内容撞守卫词表，如「点击 Delete」「停止进程」类操作语境）→ 不变体重试，直接 speak 文字描述位置（「窗口右上角蓝色按钮」）——指路不缺席，箭头是增强不是依赖

### 命令语法速查（README 提炼，写进 skill 正文）

```
# 坐标级（零权限）：
bigarrow point --at 640,400 --text "看这里" --duration 5
bigarrow box --rect 100,200,300,150 --text "在这个区域"
# UI 元素级（需宿主 App 有 Accessibility）：
bigarrow start --element "Allow" --app "System Settings" --text "点这个 Allow" --from right
bigarrow elements --app Safari        # 先列出可匹配的元素标签
# 窗口/tab 级：
bigarrow point --window "System Settings" --text "在这个窗口"
bigarrow start --app "Google Chrome:Wikipedia" --element "Sourdough - Wikipedia" --text "是这个 tab"  # 注意：带标题匹配需 Accessibility 权限
# 常用修饰：--from 方向 / --color / --style / --size / --shape / --say 朗读 / --until-click 点掉才消
# 诊断：bigarrow doctor（权限+显示器）；--dry-run --json 预览指向不真画
```

### 机制识别检查点（逐项判定）

- 新增配置字段/枚举/开关：否
- 新增状态生命周期：否（箭头自灭，无持久状态）
- 新增定时任务/后台进程：否（bigarrow 按需拉起、画完即退）
- 新增信号类型/消息格式：否
- 新增持久化存储：否
- 新增决策分支（被记住影响后续行为）：否
- 新增跨模块调用路径：否——read skill → bash → 外部二进制，全部走既有通道；系统内无新模块边界；manifest.yaml 修改是「注册既有机制的新条目」而非新机制

**判定：不涉及净新增机制**（skill 是内容非机制，注入面成本见影响范围；外部二进制经既有 bash 通道使用）。经检视獭独立核验认可（审视报告 2026-10-10）。

## 影响范围

| 影响面 | 内容 | 量级 |
|---|---|---|
| 系统提示注入面 | 所有对话所有獭每轮 +1 条 skill description | 预算上限 ~400 token（上游英文实测 182 token；中文 description 密度约 1 字≈1 token，三段式+纪律句若 300 字可达 300-400 token——skill 落地时以 tokenizer 实测数字回填本表） |
| 搭档机器 | brew 安装一个 Swift 二进制 | 几 MB，无守护进程 |
| 代码/schema/配置 | 零改动 | — |

## 风险与约束

1. **上游项目仅 2 天大**，CLI 参数可能变化。缓解：MIT 无状态、skill 正文集中维护命令模板、完全回退 = 删 skill + brew uninstall
2. **箭头误指/滥用**（獭画着玩、指错位置）。缓解：description 层纪律句（每轮可见）+ skill 工作流限定触发场景；箭头点击即消天然止损
3. **Accessibility 权限**（仅 `--element` 族定位需要）：给宿主终端 App 开权限是搭档的一次性手动操作。缓解：坐标级定位零权限即可覆盖多数指路场景，`--element` 按需开通，`bigarrow doctor` 指名待授权 App
4. **环境耦合**：仅 macOS、仅本机有屏场景（远端会话/无头不可用）；Chrome 页面内元素默认不可 AX 定位（需 `--force-renderer-accessibility`），Chrome 场景降级用坐标/窗口级。skill description 显式声明
5. **上游投毒**：brew tap 跟 formula git HEAD 走，不固定版本，tap 本身是传播通道——「tap 固定源」不构成缓解。如实声明：接受 tap 跟随 HEAD 的风险，影响面限于视觉干扰（工具只画图不碰数据、无守护进程）；若要收紧可后续 pin formula 版本或 release 直下+checksum（本期不做）
6. **bash 守卫拦截**（新增，审视发现 5）：獭生成的 `--text`/`--say` 内容可能撞守卫词表（操作语境词元），命令被拦箭头不出。缓解：skill 工作流写明「被拦不变体重试，直接 speak 文字指路」降级路径

## 不兼容更新

无。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 集成形态 | 薄 skill（LLM 直拼命令） | 封装为系统 Tool（ts 代码） | Tool 要动 src + SDK 注册流程重；bigarrow 语法简单，LLM 拼命令足够灵活；skill 零代码、删了即回退 |
| skill 命名 | screen-point（能力导向） | bigarrow（工具名） | skill 描述能力而非绑定实现——上游换实现 skill 名不变 |
| V1 消费者 | 仅大獭 | 含小獭 | 小獭无 read 工具，skill 全文不可达是已知机制约束（F20260724skch），不做死路设计 |
| 定位默认序 | 元素级（准）> 窗口/tab 级 > 坐标级（稳） | 坐标优先 | 精度即价值——指错地方的箭头比不指更糟；但权限按需开：零权限场景（未授权 Accessibility）坐标/窗口降级可用，`--element` 需一次性授权——skill 工作流写明「有权限用元素级，无权限用坐标级」的双路 |
| 纪律位置 | description 层一句 + 正文细节 | 全部写正文 | description 每轮注入恒可见；正文懒加载，獭未 read 时正文纪律不可见（审视发现 4） |
| 安装通道 | brew tap | release 直下/源码编译 | 标准包管理、可审计、卸载干净；tap 跟 HEAD 的风险已如实声明（风险 5） |
| 机制判定 | 不涉及净新增机制 | 判「涉及」走四问 | 清单七项全否；skill=内容注入非机制（SDK 懒加载机制既存）；检视獭独立核验认可 |

## 验证

1. 安装验证：`bigarrow doctor` 正常输出权限与显示器诊断（README 记载的显式命令；顺带确认宿主 App 权限状态）
2. 能力验证：手动 `bigarrow point --at 640,400 --text "集成测试" --duration 3`——箭头出现并于 3 秒后消失（零权限路径，无需授权即可跑）
3. skill 合规：`npm run lint:skills` 0 error
4. 端到端（真机演示，呈搭档验收/human_judge）：新对话中让獭响应「帮我指一下 Safari 的地址栏」——正确加载 skill、构造命令、箭头出现在地址栏位置、speak 同步说明、自动消失
5. 回退验证（不执行，路径确认）：删 skill + `brew uninstall` 后系统回到基线，无残留（前提：未执行过 `bigarrow install-skill`）

**Golden Gate 豁免声明：n/a——纯 skill 文件 + 外部二进制集成，无代码路径可跑 gate（verify_by=human_judge，见 frontmatter intent 块）。**

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `.pi/skills/screen-point/SKILL.md` | 新增 | skill 主文件（≤200 行） |
| `prompts/skills/manifest.yaml` | 修改 | 注册 name/category/next/not_for |
| `docs/features/2026/10/10/F20261010bgar-bigarrow-screen-point-skill.md` | 新增 | 本文档 |

## 审视记录

- 2026-10-10 检视獭-bgar（kimi）对抗审视：3 严重 + 3 建议，全部采纳处置——严重 1（intent 块 + Golden Gate 豁免）已补；严重 2（CLI 事实错误：`--at`/`--element` 写反、`--sign`/`--timeout`/`--tab` 不存在，实为 `--text`/`--duration`/`--app "Chrome:标题"`）已按 README 全量修正；严重 3（doctor 验证命令 / install-skill 残留 / tap 不固定版本）已修正；建议 4（纪律上提 description）、5（守卫拦截降级路径）、6（token 口径改预算上限+实测回填）已并入方案
- 2026-10-10 检视獭-bgar delta 复核：6/6 处置核验通过、修正准确性抽查通过、机制判定维持认可，结论「方案可收敛呈搭档终审」；delta 新发现 D-1（窗口/tab 级权限注记不完整：无标题匹配零权限 / 带标题匹配需 Accessibility / macOS 26 另需 Screen Recording）已补全，命令速查 Chrome tab 例补权限注记

## 封存裁决（2026-10-10，终审后）

搭档终审质疑（原话）：

> 「海獭要画箭头的前提是，海獭看到了界面，然后可以准确告诉我看哪里、动哪里，所以你考虑到"海獭先看到"这一点了吗；以及，当前海獭系统，说实话我还真不清楚，啥具体场景会用到这个能力。授权什么的是指中间栏的html卡片吧，那这个也不适合箭头吧、没必要」

核实结论：两点质疑均成立——
1. **感知层缺失**：獭零视觉能力（无截屏/屏幕读取通道），只装输出层不装感知层是半吊子设计；完整闭环（截屏→多模态读图→定位→画箭头）是新工程，超出本方案量级
2. **场景空缺**：本系统协作模式为终端+聊天室，授权走聊天室 html 卡片，与系统弹窗无关；方案所举「授权弹窗/2FA」场景是把通用叙事错误套用（作者已认错）

裁决：**封存**（搭档 2026-10-10「ok」确认）。本文档 commit 至 feat/bigarrow-skill 分支留档，不合入 main、不安装二进制。

重启条件：未来出现「獭指导人操作 GUI」的真实工作流时启封，且须连同感知层（截屏+读图）一起设计，不再做纯输出层方案。

## 关联

- F20260724skch（Skill/Tool 信道治理）——skill 懒加载机制事实，V1 不面向小獭的依据
