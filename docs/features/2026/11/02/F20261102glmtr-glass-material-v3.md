---
id: F20261102glmtr
title: 玻璃材质体系 v3.0——分层材质学说落地（根治运行中闪动 + 玻璃占比收敛）
doc_type: feature
summary: |
  按 R20261102glass 分层材质学说重构材质体系：常驻层（顶栏/侧栏/中栏/
  输入框/气泡/卡片）全部改低不透明度实色（保留 --glass-t 滑杆与身份色染），
  去除 backdrop-filter（R=0，运行中像素变化不再引发重采样闪动）；画布层
  Mica 化（自定义图取主色静态着色薄纱，失败回退中性纱）；真玻璃仅保留在
  瞬态小面（浮动助手/下拉菜单）与弹窗 scrim 六轮终局语义。玻璃全局占比
  大降（搭档问题 2 同步收敛）。纯前端 CSS token + 背景偏好模块改造，
  组件类名不动。
change_type: refactor
capability_test: "n/a: web 视觉材质层改造，无 agent 行为或工具轨迹变化"
intent:
  problem: "海獭运行中中间栏色块闪动（backdrop-filter 实时采样 × 运行中像素变化 × 自定义图高反差），弹窗期同族闪烁六轮修复未根治；玻璃全局占比过大（搭档问题 2）"
  expected_effect: "运行中常驻层严格不闪（R=0 结构性免疫）；玻璃仅存于瞬态小面；--glass-t 滑杆、身份色染、reduced-transparency 红线均保留"
  verify_by:
    type: behavior_check
created_in_conversation: 9ae84389-031a-4da1-be13-0238bcdf6a29
created_at: 2026-11-02
causal_links:
  from: [R20261102glass, F20260724glas, F20260909scrf6, F20261027cbgix]
tags: [ui, glass, design-system, css, tokens, mica, flicker, web]
modules:
  - web/src/styles/globals.css
  - web/src/lib/background-preference.ts
  - web/src/styles/*.test.ts
---

# F20261102glmtr 玻璃材质体系 v3.0——分层材质学说落地

## 背景

搭档原话（意图锚，2026-11-02 本对话）：

> 「当有海獭运行中时，我发现中间栏有闪动？……原来背景图是色块看着不明显，现在我改为自定义图片后，非常明显有色块闪动」
> 「顶栏、左侧栏、中间栏、右侧栏，全都是一大块玻璃块。我觉得需要思考下ui设计」
> 「这个问题，不要打补丁，还是要从第一性原理出来，咱们要从源头/本质就做好」
> 「本次核心不是research……你的最终产物应该是一个 改造方案、一个feature、一个pr。你来做完整」

调研（R20261102glass，PR #1730，检视獭两轮审视通过）确立第一性原理：闪动可见度 = 实时重采样(R) × 覆盖面积(C) × 嵌套采样(N)，**R→0（采样源静态/不采样）是唯一严格不闪保证**；业界（Apple HIG / Windows Mica-Acrylic 双材质）一致把大面积常驻表面留给静态材质，实时采样只给小而瞬态的面。现行体系（F20260724glas「画布之上全层玻璃」）在这三点上全部越界，且自定义背景图（F20261027cbgix）的高反差把老病显形——弹窗期六轮修复（F20260824m2345→F20260825scrf→F20260827scrf2→F20260909scrf6→#884）均为补丁，根源在体系。

搭档对调研终审拍板：采纳学说方向，交付完整改造（方案+feature+PR 一条龙）。

## 目标

- T1 **运行中闪动根治**：常驻层（顶栏、侧栏、中栏容器、输入框、气泡、卡片）全部无 backdrop-filter——R=0 结构性免疫，不依赖任何单源归因；真浏览器验收无可见闪动
- T2 **玻璃全局占比收敛**（搭档问题 2）：backdrop-filter 真玻璃仅存于瞬态小面（浮动助手面板、下拉菜单）与弹窗期（六轮终局语义不变）；常驻大面零真玻璃
- T3 **观感保级**：--glass-t 滑杆体系保留且语义不变（越低越透）；水獭身份色染保留；reduced-transparency 无障碍红线不回退；投影/接触线层级语言保留
- T4 **画布 Mica 化**：自定义背景图保持清晰，其上叠主色静态着色薄纱（一次性合成，永不重采样）改善面板文字对比度；提取失败回退中性纱；默认极光画布路径行为不回退
- T5 **回归安全**：既有测试全绿（含 scrim-flicker-6、custom-background 两份 CSS 契约测试），新增 v3 材质契约测试锁定「常驻层无实时采样」

## 非目标

- 深色模式（v2.3 起明确不做，维持）
- 弹窗 scrim 语义改动（六轮终局是最佳实践，本方案原样保留）
- Liquid Glass 折射/透镜效果（web 无官方方案、库生态 demo 级——R20261102glass §2.3，不做）
- 动效体系重设计、默认极光画布重绘
- 新增设置项（主色提取自动进行，无开关——机制预算见设计取舍）

## 未决问题

- 薄纱浓度（veil alpha）与饱和度处理的最终观感参数：实现后由搭档真机验收定档（给出初始值，验收可调）——不影响结构，不阻塞方案

## 方案设计

### 层定义（新语义，避开 v2.3 的 L0-L3 编号撞号——按视觉上下行命名）

> 窄屏特例：conversation/index.tsx:1633,1645 的 .glass-overlay 抽屉开关按钮是 <lg 断点的 fixed 常驻面——违反 T1，改实色小圆钮（实色+投影，无采样），其余 .glass-overlay 消费点均真瞬态进白名单。

| 层 | 表面 | v3 材质 | 对应现有类/token |
|---|---|---|---|
| 画布层 | body.bg-spring（极光）/ body::before（自定义图） | 图保持清晰 + 主色薄纱静态叠加 | .bg-spring / [data-custom-bg]::before |
| 面板层 | 顶栏、左右侧栏、中栏 main、输入框 | 低不透明度实色渐变（α × --glass-t），**无 backdrop-filter** | .glass-strong / .glass / .glass-input（--chrome-bg/--panel-bg） |
| 内容层 | 气泡（.bubble-otter/.bubble-user）、.glass-card | 同上 + 身份色染保留（color-mix 对实色做） | --card-bg / --bubble-blur |
| 瞬态层 | 浮动助手面板、Portal 下拉菜单、悬浮小獭、.glass-overlay 瞬态消费点（HelpIcon/OtterProfileCard/MagicWordHelp/MessageInput 弹层/WorkspacePanel 与 conversation 右键菜单） | **真玻璃保留**（小面+瞬态，业界共识适用位） | AssistantPanel/FloatingOtter 的 backdrop-blur utility；--overlay-blur（保留，瞬态层专用 token） |
| 遮罩层 | 弹窗 scrim + modal-open 内容自模糊；SessionModal 全屏遮罩 | **六轮终局原样保留/对齐**（F20260909scrf6）：SessionModal 摘内联 blur(2px) 改纯静态暗化（其 background rgba 暗化已存在，删 backdropFilter 即可） | .scrim / body.modal-open（globals.css:250-259）；SessionModal.tsx:193-194 |

### 核心改动 1：token 手术（globals.css）

关键洞察：v2.3 的类消费 token（`backdrop-filter: var(--panel-blur)`），**token 层吸收全部改造**，组件类名不动：

- **置 none（常驻层 5 token）**：`--chrome-blur` / `--panel-blur` / `--card-blur` / `--bubble-blur` / **`--form-input-blur`**（globals.css:107，消费于 .form-input globals.css:396、settings/memory/conversation-list/Modals 等 31 处常驻面——首轮方案漏网，检视獭-glmtr S3 补入）
- **保留（瞬态/遮罩层 2 token）**：`--overlay-blur`（.glass-overlay 瞬态消费点真玻璃）、`--scrim-blur`（六轮终局语义不动）——契约测试锁「常驻 token=none + 常驻类无采样」而非全量 token=none，防误伤瞬态层
- `--chrome-bg` / `--panel-bg` / `--card-bg`：从「α × --glass-t 的白渐变」语义不变，但去掉对 blur 的依赖——渐变本身保留（165deg 对角渐变是观感语言）
- reduced-transparency 块已存在（全实色兜底），其值与新常态一致，仅微调注释
- 材质体系头注释改写为 v3.0 分层材质学说（记录学说出处 R20261102glass）
- 嵌套激活态（.conv-active/.nav-pill-active 本就退化为半透纯色）不受影响——v3 等于把「激活态的处理方式」推广为常态，这正是学说说的「业界都这么做」

### 核心改动 2：画布 Mica 化薄纱（globals.css + background-preference.ts）

- **不模糊用户图片**（搭档选的图保持清晰；Mica 的本质是取色着色，不是模糊壁纸——R20261102glass §2.2）
- `background-preference.ts` 应用图片时：离屏 canvas 降采样（→8×8）取平均主色 → 向 stone 系中和（降饱和、亮度钳制）→ 写 `--canvas-tint-rgb`；同一函数内 try/catch，**失败回退中性纱** `250,247,238`
- 薄纱实现（首轮规格经检视獭-glmtr S4 修正）：**静态**纯色叠加——选择器沿用现有规则形态 `:root[data-custom-bg='true'] body::before`（属性挂 documentElement，写 body 选择器永不命中）；语法用 legacy 形式 `rgba(var(--canvas-tint-rgb, 250, 247, 238), 0.32)`（**var 必带 fallback**——无 fallback 时 var 未定义期整条多层声明 invalid，背景图整体消失，破 F20261027cbgix 红线；逗号 legacy 与斜杠现代语法不可混用）；纯 alpha 合成，无 backdrop-filter，像素永不重算
- 主色提取挂 **applyDecodedBackground 单点**（restoreBackgroundPreference 与 selectBackgroundImage 双路径均经此函数，无漏接口）；clearAppliedBackground 同步清 `--canvas-tint-rgb`
- reduced-transparency 下薄纱保留（静态合成与 RT 无冲突），α 随验收可调
- 默认极光画布：已低对比，不叠纱，行为不回退
- 图片更换/清除时重算或清除 `--canvas-tint-rgb`

### 核心改动 3：瞬态层白名单维护

- FloatingAssistant（AssistantPanel/FloatingOtter）与 Portal 菜单的 backdrop-blur utility 保留——它们是小面+瞬态，开在流式内容上的低幅闪动是学说明示接受的残差（R20261102glass §5 已知残差）
- backdrop-blur utility 全集 6 处：白名单 2（AssistantPanel:181、FloatingOtter:50）+ 其余 4（WorkDetailDialog:77、ChainDetailDrawer:50、im:572,604）均属弹层/抽屉瞬态，逐处确认归类保留
- 非测试代码内联 backdropFilter 全仓仅 1 处：SessionModal.tsx:194——按遮罩层处理（摘 blur，见层表）
- CSS 类消费点扫清：.glass-overlay 9 处消费（窄屏常驻按钮 2 处摘除改实色，其余 6 处瞬态白名单 + Modal:122 弹窗面板——弹窗期六轮终局覆盖保留）；.form-input 随 --form-input-blur=none 自动脱采样

### 核心改动 4：契约测试（web/src/styles/material-v3.test.ts）

- 断言 5 个常驻 token（--chrome-blur/--panel-blur/--card-blur/--bubble-blur/--form-input-blur）var 定义为 `none`；.glass/.glass-strong/.glass-card/.bubble-*/.form-input 规则块无实时采样
- 断言薄纱规则存在（选择器 :root[data-custom-bg='true'] body::before、var 带 fallback、不含 backdrop-filter）
- 断言 scrim/modal 六轮终局规则未破坏（与 scrim-flicker-6 互补）
- 断言瞬态白名单闭合：--overlay-blur 在位、AssistantPanel/FloatingOtter 的 backdrop-blur 在位、**窄屏按钮消费点（index.tsx:1633,1645）不再引用 .glass-overlay**——防误伤也防回潮
- **适配既有断言**：custom-background.test.ts:14 的单层 background-image 断言更新为多层形式（薄纱叠加后原断言必破）——T5 措辞相应为「经断言适配后全绿」

### 机制预算自审（识别检查点判定：不涉及净新增机制）

清单逐项核过：无新配置字段/枚举/开关（--canvas-tint-rgb 是 CSS 变量，纯运行时）、无新状态生命周期、无定时任务、无新信号、无持久化存储（主色不落库，每次加载重算）、无被记住的决策分支（纯运行时临时分支）、无新跨模块路径。判定**不涉及**，四问不强制；主色提取虽非「机制」，仍自答备查：

- ① 谁需要：用户——自定义图上面板文字对比度（无纱时高反差图上的白面板可读性下降）
- ② 失败后果：提取失败→中性纱，观感略平庸，无功能损害
- ③ 后续机制：无新状态（一次性计算、CSS var 即弃）；出错模式=颜色难看（可调 alpha）
- ④ 退役条件：若未来 CSS 标准提供稳定的原生材质采样（如规范化的 system material），薄纱与提取一并退役

### 机制提案准入三问（R8.5，同场备查）

① 决策者变了么：否——材质观感决策者仍是搭档（滑杆+验收），无新决策主体；② 靠自觉还是靠守卫：契约测试机械锁定「常驻层无 backdrop-filter」（半机械：CSS 文本断言），观感属异体验收（搭档真机）；③ 深潜成本降了吗：是——闪动从「六轮逐源补丁」收敛为「一条结构规则 + 一份契约测试」，可下钻、可验证。P0 负面清单：未命中（无自动巡检/抽查/限速类环节）。

## 影响范围

- 全部页面的视觉材质（顶栏/侧栏/中栏/输入框/气泡/卡片从「模糊玻璃」变「实色半透」）——**观感变化是本方案的显式目的**，非回归
- 滚动锚定（F20261029repin）：ChatView.tsx:206-209 注释确认已不依赖 backdrop-filter 的 containing-block 副作用，移除后需回归滚动测试验证
- WorkspacePanel.tsx:498 的 Portal 菜单动机（aside 带 backdrop-filter 产生 CB）：移除后 Portal 保留（无害），注释补一句新依据
- 设置页玻璃预览（若 F20260724glas 的预览块渲染旧玻璃观感，同步更新预览样式）
- 性能：GPU 负担大降（常驻层零 backdrop-filter，微软明示其为 GPU 密集）——正向

## 风险与约束

- **观感接受风险**：从「处处磨砂玻璃」到「实色半透」是显著视觉变化——已获搭档方向拍板（「你来做完整」），细节观感由真机验收兜底
- **对比度风险**：无 blur 后画布高频细节直透面板——薄纱是对策；深色复杂图上的极限场景留验收调参
- **契约测试遗漏风险**：首轮方案扫描口径（utility+内联）漏过 CSS 类消费点（.glass-overlay 9 处、.form-input 17 处）——检视獭-glmtr S2/S3 指出后已全量并入层表/手术清单/契约断言；实现 PR 前再跑一次 `grep -rn "glass-overlay\|backdrop-filter" web/src` 终验口径闭合
- **回滚方式**：纯前端 CSS/token + 单模块 TS，git revert 单 PR 即全回滚；无数据迁移

## 不兼容更新

无 API/schema 变更；无 Incompatible 项。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 常驻层材质 | 低不透明度实色（无 blur） | 全改不透明实色（reduced-transparency 式） | 保留 --glass-t 滑杆语义与「透出画布」的层次感（Windows LayerFill 模式）；全实色是 reduced-transparency 的兜底，不是常态 |
| 画布处理 | 主色薄纱（图保持清晰） | 预模糊图 / 静态 backdrop-filter 纱 | 搭档选图应保持清晰；纯 alpha 合成是三层方案中最稳（零采样、零额外合成层）；Mica 本义即取色非模糊 |
| 改造位置 | token 层吸收（类不动） | 逐组件改类名 | diff 最小、组件零改动、契约测试锁 token 即锁全局；reduced-transparency 块证明该路径可行 |
| 瞬态层真玻璃 | 保留 | 一并去玻璃 | 业界共识：小瞬态面是采样材质最佳位（与内容视觉关联）；残差已显式声明 |
| 弹窗 scrim | 原样保留 | 重新设计 | 六轮修复的终局语义（内容自模糊+静态暗化）正是学说要求的形态，不翻案 |

## 验证

- **契约测试**（新增 material-v3.test.ts + 既有两份 CSS 契约测试经断言适配后全绿）
- **全量 web 测试 + 构建**（pre-commit/pre-push 闸门）
- **滚动回归**：F20261029repin 的滚动测试 + **窄屏 <lg 断点布局回归**（窄屏按钮仅该断点渲染，宽屏验收覆盖不到）
- **真机验收**（搭档）：①海獭运行中观察中间栏无闪动（宽屏）；②窄屏抽屉开关观感；③SessionModal 打开场景；④设置页表单（.form-input）；⑤玻璃占比观感；⑥自定义图上文字可读性；⑦滑杆/身份色染/reduced-transparency 正常
- **验收标准**：T1-T5 全满足；观感参数（纱浓度）可微调不阻塞

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| web/src/styles/globals.css | 修改 | token 手术（常驻 5 token blur→none、头注释 v3.0）、薄纱规则、窄屏按钮改实色、弹层注释补依据 |
| web/src/lib/background-preference.ts | 修改 | 主色提取挂 applyDecodedBackground 单点 + --canvas-tint-rgb 注入（带 fallback 语义）+ 清除同步 |
| web/src/styles/material-v3.test.ts | 新增 | v3 材质契约测试（含白名单闭合与窄屏按钮断言） |
| web/src/styles/custom-background.test.ts | 修改 | :14 单层断言适配多层薄纱形式 |
| web/src/pages/conversation/SessionModal.tsx | 修改 | 摘内联 backdropFilter blur(2px)（保留静态暗化背景） |
| web/src/pages/conversation/index.tsx | 修改 | 窄屏 <lg 抽屉开关按钮 .glass-overlay→实色小圆钮（仅类名） |
| web/src/pages/conversation/WorkspacePanel.tsx | 修改 | 仅注释更新（Portal 依据） |
| 设置页预览块 | 视实现核 | 若渲染旧玻璃观感则同步 |
