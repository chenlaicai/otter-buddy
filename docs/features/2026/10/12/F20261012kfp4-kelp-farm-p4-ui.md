---
id: F20261012kfp4
title: "獭之传说·海藻农场 P4：像素可读性根治（内部分辨率翻倍）+ visual-design 全面视觉打磨"
summary: "P4 视觉层交付（用户反馈「pixel 太大了，种子库这些字都看不清」）：① 可读性根治——canvas 内部分辨率 480×270→960×540（setTransform(2,2)，逻辑坐标系与绘制代码零改动，烘焙层同步），标签 7px→bold 10px（物理像素×2）+ 3px 描边光晕 + CJK 字体栈，✓ 改 measureText 定位；显示层去 pixelated 改平滑缩放（960 backing 对 754 CSS 为降采样，nearest-neighbor 会抽行）。② HTML UI 按 visual-design redesign 重做（硬边游戏面板：硬投影画布→teal 铭牌 tag→实心 CTA 按压反馈→分段 HP 条→背包 chips），修复 hint-chip 元素选择器 bug（样式全失效：浮牌形态与定位丢失）。③ 场景光影：天空 4 色带→13 级量化渐变、月晕方块→径向渐变、暗角、镜湖三边暗沿+岸牌让位。机制/文案/数值零改动。验证以 p2-selftest.mjs 实跑输出为准 + 死锁探针 + DPR2 前后对比截图。"
change_type: feature
capability_tags: [game, readme-growth]
capability_test: "n/a: game/ 为纯静态内容产品（零运行时依赖、不进主系统构建/测试面），验证 = 工作区 p2-selftest.mjs 全量实跑 PASS（含新增「种子库标签物理像素存在」像素取证用例，用例总数不减，以实跑输出为准）+ pr1435 死锁探针回归 ✓ 未死锁 + DPR2 前后对比截图人工验收；CI 面为 lint 无新增（game/ 已入 eslint ignores）"
intent:
  problem: "上线后搭档带回用户反馈（原话）：「1.用户反馈 pixel 太大了，里面的『种子库』这些字都看不清。像素必须再优化一下 2.……现在咱们能力已上线，现在全力来优化 ui 和游戏体验这些」。根因（可复核）：canvas 内部分辨率仅 480×270（game/index.html canvas 属性）+ image-rendering:pixelated 拉伸显示，场景标签 ctx.font 7px monospace 中文在任何显示尺寸下都糊；HTML UI 层（.dialog/.btn/.hpbar/.statusbar）为无层级默认样式，且 hint-chip 选择器 bug 导致提示牌样式全失效（浮牌形态与定位丢失，提示语退化为画布下沿裸文本行——检视实测 base 版裸文本可见，原「全程不可见」归因不实，已订正）。"
  expected_effect: "① 场景标签（种子库/荒田/试验田等）在同视角对比下清晰可读：物理像素翻倍（bold 10px×RS2）+ 描边光晕拉平草地纹理上的对比度；② 画布渲染告别 nearest-neighbor 粗块：内部 2× 采样 + 平滑缩放；③ HTML UI 层有明确视觉动线（画布主视觉→对话铭牌→实心 CTA→状态栏降噪），hint-chip 正常显示；④ 场景光影有纵深（量化渐变天空/柔月晕/暗角/湖岸）；⑤ 机制零改动：点位/三段式/五段式战斗/封印门状态机语义不变，3 秒反馈约束不变。"
  verify_by:
    type: human_judge
    reason: "视觉/可读性验收类，判定主体 = 搭档（chen）+ 对抗审视检视獭。验收清单：T1 同视角前后对比截图（DPR2，对话工作区 p4-before-*/p4-after-*）中『种子库』等场景标签清晰可读；T2 HTML UI 视觉层级与 hint-chip 显示正常（全页+战斗态截图）；T3 全流程可玩——p2-selftest.mjs 全量实跑 PASS、pr1435-deadlock-probe 未死锁（以实跑输出为准，文档不落活数字）；T4 机制零改动——diff 仅渲染/样式/演出层，无状态机、点位数值、文案语义变更；T5 零 pageerror、file:// 直开零外部请求。"
created: 2026-10-12
created_in_conversation: cb80d695-bce9-4b83-9f2a-98618242acd0
causal_links:
  - F20261009oqtd   # 方案 v2（§7 分期，P3 收尾预判的「场景精绘/视觉优化」批次）
  - F20261012kfp2   # P2 镜湖终战（游戏本体前驱，#1435）
---

# 獭之传说·海藻农场 P4：像素可读性根治 + visual-design 全面视觉打磨

## 背景

P0-P3（#1422/#1427/#1435/#1442）游戏上线后，搭档带回两条用户/自身反馈（原话见 intent.problem）：

1. 「pixel 太大了，种子库这些字都看不清」——可读性根因见下；
2. 「全力来优化 ui 和游戏体验」——按 visual-design skill（redesign 动词：保文案+信息架构+品牌色，只换视觉结构层）全面打磨。

### 可读性根因（复核锚点）

| 根因 | 位置 | 机制 |
|---|---|---|
| 内部分辨率仅 480×270 | canvas width/height 属性 | 480 backing 被拉到 ~754 CSS px，image-rendering:pixelated 做 nearest-neighbor 不规则放大（1/2 CSS px 混排，块状感） |
| 标签 7px monospace 中文 | `ctx.font = "7px monospace"` | 7px 中文字形信息量不足，任何放大都是马赛克 |
| 提示牌样式失效 | CSS 选择器 `hint-chip`（元素选择器） vs HTML `class="hint-chip"` | 选择器匹配不到，样式全失效：无浮牌形态、无定位，提示语退化为普通流式裸文本（检视实测 base 版仍以裸行可见，非「被 `overflow:hidden` 挤出视口不可见」——原归因已订正） |

## 目标

1. 可读性根治：标签/浮字物理像素翻倍 + 对比度光晕，同视角对比截图肉眼可判
2. HTML UI 层按 visual-design 方法论重做（结构 → 风格 → 反泔水质检门）
3. 场景光影打磨（poster 构图常识：层次、光、动线），过质检门自查
4. 机制零改动、3 秒反馈约束不变、game/ 单文件零依赖（file:// 直开）

## 非目标

- 游戏机制/文案语义/点位数值（P2 后冻结）
- 像素美术资产重绘（16×16 tile 网格与三层着色纪律保持）
- GIF 录制、README 截图刷新（大獭统一安排）

## 方案设计

### A. 分辨率架构（根治层）

- `canvas width="960" height="540"`，`ctx.setTransform(2,0,0,2,0,0)`；静态烘焙层 `staticCv` 同步 960×540 并挂同 transform——**全部绘制代码留在 480×270 逻辑坐标系，零坐标改写**
- `render()` 合成改为 `drawImage(staticCv, 0, 0, W, H)`：源 960×540 → 设备 960×540，1:1 零插值
- CSS `image-rendering:pixelated → auto`：960 backing 对 ~754 CSS 是降采样（0.785×），nearest-neighbor 降采样会抽行（比原来更糟），平滑缩放把 2× 渲染采样折成干净边缘
- 点击映射 `hitSpot` 逻辑不变（`(clientX-left)×(W/rect.width)` 恒换算回逻辑坐标）

**像素取证坐标同步**：`getImageData` 读物理像素，p2-selftest.mjs 全部采样区 ×2（闪光点/BOSS 红瞳），并新增「种子库标签物理像素存在」用例（青色实心像素计数阈值断言）。

### B. 文字可读性（用户主诉）

- 标签/浮字：`FONT = bold 10px ui-monospace, Menlo, PingFang SC, Microsoft YaHei, monospace`——物理像素 10×2=20（原 7×1=7，近 3 倍）；CJK 字体栈显式声明，中文走系统字形而非 fallback
- 3px 暗色描边光晕（`strokeText` 后 `fillText`）：标签压草地纹理，对比度靠光晕拉平
- 完成勾 ✓ 位置改 `measureText` 实测宽度（原 `name.length×7` 是 7px 等宽估算，字号一变必叠字）
- zZz 9px、浮字带光晕；镜湖岸牌左移给 `labelBelow` 标签让出中心位

### C. HTML UI 层（redesign：保文案/IA/品牌色，换视觉结构层）

**结构层级表**（结构先于视觉，redesign 动词保留既有信息架构，层级重排如下）：

| 层级 | 单元 | 处置 |
|---|---|---|
| H1 级 | 画布（.screen-wrap） | 硬投影 3px 亮边框——最大最亮，1 秒动线锚点 |
| M 级 | 对话框（.dialog） | 主阅读面：14.5px/1.85 正文，teal 铭牌 tag（实心底+深墨字）作章节锚 |
| M 级 | 操作行（.actions/.btn） | 实心 teal CTA + 硬按压反馈（translate+硬投影位移），ghost 降级次级动作 |
| 辅级 | 状态栏（.statusbar） | 虚线分隔降噪，背包 emoji 收进 chips |
| 辅级 | HP 条（.hpbar，战斗态) | 面板化 + 分段像素纹（repeating-gradient），护盾前缘亮线 |

**风格选择**（词典+人择记录）：词典无「cozy 像素游戏 HUD」精确词条，选最接近且与既有夜色品牌色兼容的 **#2 新粗野主义的硬边纪律**（2-3px 实边、`border-radius:6-10px` 收敛版、无模糊硬投影、按压位移）× **#6 终端/CLI 的等宽纪律**（ui-monospace 骨架，P0-P3 既有识别）——两者都是既有品牌色（teal #5fd6ae / purple #957ff0 / 夜蓝底）的结构化承载，非换色。备选否决：玻璃拟态（毛玻璃与像素锐边冲突）、蒸汽波（色相超出品牌域）。

顺手修复：`.hint-chip` 选择器 bug；`.merge input` 错误态「重新输入即复位」（原 err 类/错误占位符永不复位）；删除死 CSS `.battle-acts`。

### D. 场景光影（poster 构图常识）

- 天空 4 色带 → 13 级量化渐变（整像素行，夜空纵深）
- 月晕 `fillRect` 半透明方块（放大后方形硬边可见）→ 径向渐变；月亮 60→200（hint-chip 修复后可见，占位左上会盖月）
- 暗角（vignette，烘焙层对象之上/标签之下）：边缘田块微沉，视线收束中心
- 镜湖三边暗沿：原左/上/右是生硬直线切入，补阴影沿柔化边界

## 影响范围

- `game/index.html`（唯一切面）：`<style>` 全量、canvas 属性、渲染 transform、标签/浮字绘制、天空/月晕/暗角/湖岸、封印门输入反馈
- `p2-selftest.mjs`（对话工作区，非仓库）：GAME 路径 → kelp-farm-p4、像素取证 ×2、+1 标签可读性用例
- 不触碰：src/、prompts/、README、game/ 之外一切

## 取舍（诚实声明）

用户口径「像素颗粒减半」的物理边界：**游戏美术逻辑网格仍是 480×270**——屏幕上单个美术像素的物理尺寸（~1.57 CSS px）由「美术网格 ÷ 显示宽度」决定，不随 backing 分辨率变化；物理减半需要按 2× 网格密度全套重绘资产（本次明确不做，列非目标）。本次实际交付的观感改善来自：

1. 文字物理像素 ≈3×（7px→20 device px）+ 描边光晕——主诉「字看不清」根治；
2. 每美术像素 4 个采样点 + 平滑缩放，取代 nearest-neighbor 不规则 1/2 CSS px 混排块——「pixel 太大」的块状感来源被移除，边缘干净即显细；
3. 若后续仍嫌颗粒粗，升级路径 = 2× 密度美术重绘（或按视口动态整数倍缩放），已记录于此供拍板。

## 验证

见 frontmatter `verify_by`（human_judge，T1-T5）。程序化证据以工作区 `p2-selftest.mjs` 与 `pr1435-deadlock-probe-p4.mjs` 实跑输出为准（文档不落活数字）。前后对比截图：对话工作区 `p4-before-*` / `p4-after-*`（含 DPR2 `*-zoom-seedbox` 标签特写）。

## 反泔水质检门自查

- **A1 结构同构**：骨架（顶栏→画布→对话→操作→状态栏）是 redesign 动词的保 IA 约束本身，非模板套用；层级密度重排（上表）为本次独有 → 不命中
- **A2 模板换色**：DOM/class 不变是 redesign 定义（保文案+IA）；实际改动为整套视觉语言重写（硬投影/铭牌/分段条/光晕/暗角），非变量调色 → 按动词定义豁免，理由记录在案
- **A3 风格贴皮**：硬边+硬投影贯穿画布框/铭牌/按钮/HP 面板/背包 chips/画布文字光晕，末屏（状态栏）与首屏同语言 → 不命中
- **A4 全屏均质**：眯眼 1 秒内最大=画布硬投影框、最亮=teal CTA 行 → 不命中
- 观察项：B1 无紫渐变 hero（顶部微光为钢青系径向，且无居中文案）；B2 无三卡并排；B3 emoji 均为动作语义（按钮标签/背包物品）非标题堆砌；B4 单 mono 家族系 P0-P3 既有终端/像素识别（词典 #6 同族），字重 400/700 + 字号 11.5/12.5/14/14.5 四档成体系；B5 布局左对齐+右侧工具链非全居中；B8 色相语义化（teal=交互/紫=映射守护/红=危险/金=收益），主面积为夜蓝中性底 → 不命中
- **自我批评**：teal 实心硬投影按钮带 neo-brutalist 套路感（AI 观感风险点）——处置：词条 #2 实现锚点刻意选择并与像素锐边语言互证，按压位移微交互强化「实体按键」而非贴图；另一处风险是暗角过重导致画面发闷——上限压在 0.38 边缘 alpha，中心零覆盖，实拍见截图。
