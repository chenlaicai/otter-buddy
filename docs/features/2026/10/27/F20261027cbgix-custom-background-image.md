---
id: F20261027cbgix
title: 自定义本地背景图片与玻璃效果预览
doc_type: feature
summary: |
  设置页外观区新增本地图片选择与恢复默认彩色背景，图片仅在当前浏览器
  持久化并即时替换最底层极光画布；保留既有玻璃 token 与透明度滑杆，
  不引入上传、在线图库或跨设备同步。
change_type: feature
capability_test: "n/a: 纯 web 本地外观偏好，无 agent 行为或工具轨迹变化"
intent:
  problem: "固定彩色极光画布无法让搭档用自己的风景图检验现有玻璃材质"
  expected_effect: "设置页选择合法本地图片后立即全屏生效并刷新保持，可恢复默认；坏图与存储失败回退原背景"
  verify_by:
    type: behavior_check
created_in_conversation: bc4ca9ba-9348-4283-afbf-e2d6f2dd12de
created_at: 2026-10-27
causal_links:
  from: [F20260724glas]
tags: [ui, settings, background, glass, local-storage]
modules:
  - web/src/pages/settings/index.tsx
  - web/src/styles/globals.css
  - web/src/main.tsx
  - web/src/lib/background-preference.ts
  - web/src/lib/background-preference-store.ts
---

# F20261027cbgix 自定义本地背景图片与玻璃效果预览

## 背景

搭档原话：「我现在想给系统增加一个 替换背景图片的功能，我想换一个风景图作为背景，然后看看咱们系统的玻璃效果，而不是现在固定这个彩色背景」。

现状：最底层 `.bg-spring` 固定绘制米色底、四个径向色团、对角渐带和噪点（`web/src/styles/globals.css:180-184`）；玻璃层已经统一 token 化，设置页已有本地持久化的 `--glass-t` 滑杆（`web/src/pages/settings/index.tsx:20-27`）。本需求只更换玻璃下面的画布，不重做玻璃。

## 目标

T1：在「设置 → 外观」选择本机 JPG/PNG/WebP 图片后，立即全屏替换背景，且刷新后仍生效。

T2：保留原有彩色背景作为默认项，并提供明确的「恢复默认背景」入口。

T3：背景图片与既有玻璃透明度滑杆组合可用，不改变弹窗、气泡、面板的材质语义。

T4：图片无效、损坏或本地持久化失败时给出可理解反馈，不能留下空白背景或阻塞设置页。

## 非目标

- 不做图片上传到服务端、在线图库、远程 URL、跨浏览器/跨设备同步。
- 不做裁切、缩放编辑、 focal point、背景动画、深色模式或多套主题管理。
- 不改动既有 `--glass-t` 的取值范围与各层玻璃 token。
- 不为极冷门的大图做首版图片压缩/缩略图流水线；以明确的体积上限控制本地存储风险。

## 未决问题

无。首版按「本地选图、当前浏览器保存」最小链路执行。

## 方案设计

### 1. 本地偏好模型

新增单一前端工具模块 `web/src/lib/background-preference.ts`，集中管理：

- localStorage key：`otter-background-image-v1`；值为图片 data URL，不另建数据库字段或后端接口。
- 文件准入：MIME 仅 `image/jpeg`、`image/png`、`image/webp`；FileReader 读取后，按 **data URL 实际长度 ≤ 4,500,000 字符**验收，而不是按原始文件字节数推断配额。UI 用「图片编码后不超过 4.5 MB（通常约 3.3 MB 原图）」说明。
- 完整值还须匹配受控 data URL 字符白名单（固定 MIME 前缀 + base64 字符），再用 `Image` 异步解码；只有解码成功才允许持久化与应用。这样同时挡住坏 base64、伪造 MIME 和损坏图片。
- 应用方式：在根元素设置/移除 `--custom-bg-image` 与自定义状态属性；独立画布负责 `cover`、`center`、`no-repeat`。
- 启动恢复：`web/src/main.tsx` 在 SPA 启动时调用同一恢复入口。解码期间保留默认极光画布，成功后热替换；坏值/解码失败会清变量并尽力移除坏 key，存储访问异常静默回退到默认背景。异步解码可能让默认画布短暂出现，但不会留下永久空白。
- 设置页订阅背景偏好变化，直接打开设置页时也能在恢复完成后同步预览。

选择 data URL 而非 IndexedDB：复用现有外观偏好的 localStorage 模式，不增加异步数据库生命周期。代价是占用浏览器本地配额，因此必须有编码后 4.5M 字符上限、写入失败回滚与错误提示；不能把 data URL 注入对话、日志或后端。

### 2. 画布切换

默认 `.bg-spring` 保持当前极光画布。自定义图片使用 **`body::before` 独立固定画布**，不写入 `.bg-spring` 的 `background-image`：

- `body` 建立隔离层叠上下文；`body::before` 固定在视口、位于内容下方且不接收指针事件。只有图片解码成功后才设置根状态属性，让不透明图片覆盖默认画布；加载/解码期间下方默认画布仍完整可见。
- 独立画布使用 `background-size: cover; background-position: center; background-repeat: no-repeat`，横竖屏均铺满，不拉伸图片。
- 自定义图片模式不额外叠暗色蒙版，让搭档直接观察原始风景图与现有玻璃的真实组合效果；可读性仍由现有玻璃不透明度与 `prefers-reduced-transparency` 实色降级承担。
- reduced-transparency 模式继续禁用玻璃模糊，但**不删除用户明确选择的图片**。既有 `.bg-spring { background-image: none }` 只清默认极光层，独立 `body::before` 不受该选择器影响，玻璃实色 token 仍绘制在图片之上。

### 3. 设置页交互

「外观」区在玻璃不透明度之后增加「背景图片」：

- 当前状态缩略预览 + 「自定义图片」/「默认彩色背景」；不另存文件名，避免第二个持久化状态。
- 「选择图片」文件选择器；选中后先校验并解码，成功才应用并持久化，完成后 toast。
- 仅自定义状态显示「恢复默认背景」。点击后**先清 CSS 变量与根状态属性，立即回到极光画布，再尽力 removeItem**；若删除失败，当前页面仍保持默认，但明确提示「刷新后可能恢复自定义图」，不中断恢复动作。
- 校验/解码/读取/存储失败：保持更换前背景，显示具体错误（格式、大小编码、损坏图片、读取或本地存储失败），不假装保存成功。
- 每次操作结束清空 file input 的 value，允许失败后重选同一文件。

## 影响范围

- 所有 SPA 页面共用的最底层背景。
- 设置页外观区、`web/src/main.tsx` 启动恢复、全局背景 CSS。
- 不影响后端设置 DTO、数据库、模型配置、浮动獭快捷键与弹窗冻结机制。

## 风险与约束

- **本地配额**：localStorage 容量有限且 data URL 有编码膨胀；编码后 4.5M 字符上限仍不能保证所有浏览器都写得入，必须捕获 `setItem` 异常并回滚。
- **可移植性**：清除站点数据、换浏览器或换设备后需重新选图；在 UI 明示「仅保存在本机浏览器」。
- **文字可读性**：极亮/高细节风景图可能降低直接坐在画布上的辅助文字可读性；首版通过既有玻璃滑杆与 reduced-transparency 兜底，不擅自加全屏暗化层。
- **启动安全**：恢复入口只接受完整 data URL 字符白名单，且只写 CSS 变量，不插入 HTML；CSS 值来自受控的 `url("...")` 序列化函数。前缀合法但内容损坏的值必须经解码失败回退。
- **性能**：保持背景静止，不加动画和 `will-change`；图片只有一张。设置页缩略预览直接复用同一 data URL 并限制显示尺寸，接受浏览器解码全尺寸图片的成本；首版不引入 canvas 缩略图或压缩流水线。

## 不兼容更新

无。无既有偏好迁移；未设置新 key 时行为完全不变。

## 设计取舍

机制识别检查点：命中「新增配置字段/开关」与「新增持久化存储（浏览器 localStorage）」，判定涉及净新增机制，四问必答；不新增数据库、后台任务或跨模块后端调用。

### 机制预算四问

① **谁需要它**：当前使用 web 设置页的搭档，需要用真实风景图检验现有玻璃材质，而不是只看固定彩色渐变。

② **失败后果**：选图无效或存储失败时用户看不到预期背景；若未捕获异常可能丢提示或首屏报错。方案通过默认背景回退、toast 和原状态保留，把损害限制为「这次没有换成」，不影响对话数据与服务端设置。

③ **后续机制**：可能出错的新状态是本地 data URL 缺失、损坏、超配额或被清除；分别由默认回退、前缀校验、异常捕获和重新选择修复。未来若支持跨设备/大图，应另起服务端资产或 IndexedDB 方案，不在本 key 上隐式改变语义。

④ **退役条件**：若本地图片背景长期无人使用，或产品转向统一云端主题资产并且完成偏好迁移，可删除该 key、启动恢复脚本与设置区；默认极光画布始终是可回退基线，不构成永久承诺。

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 图片存放 | localStorage data URL + 编码后 4.5M 字符上限 | 后端上传、IndexedDB | 最小链路即可验证玻璃效果；不上传私人图片，不新增服务端资产生命周期。按编码后长度而非原图大小验收，避免 5 MiB 原图编码后必超常见配额；仍有配额风险，由失败回滚认领 |
| 默认背景 | 保留极光画布并可一键恢复 | 选图后覆盖默认 | 保留现有视觉基线，方便对比与退出 |
| 图片适配 | cover + center | contain、拉伸、首版裁切器 | 全屏无空白且不改变宽高比；裁切编辑超出当前验证目标 |
| 图片上蒙版 | 首版不新增 | 固定暗化/虚化 | 搭档要直接看玻璃与真实图片的组合；额外滤层会改变观察对象。可读性风险显式保留 |
| 无障碍 | reduced-transparency 仅退化玻璃；图片走独立 `body::before` 画布 | 连图片一起移除 | 用户选择的是画布内容，减少透明不等于不要背景图；独立层避开既有 `.bg-spring { background-image: none }` 一刀切 |

## 验证

1. 单元测试：合法 JPEG/PNG/WebP 解码成功后写入 localStorage、根变量即时更新、状态显示自定义图片；恢复默认移除 key 与变量。
2. 单元测试：错误 MIME、编码后超过 4.5M 字符、FileReader 失败、图片解码失败、setItem 抛错均不破坏原背景，并出现对应提示。
3. 启动恢复测试：合法值解码后恢复；空值/坏前缀/坏 base64/解码失败/localStorage 异常回退默认且不抛错。
4. **静态 CSS 契约抽检**（读取样式表源码断言关键声明，不冒充 jsdom 渲染级验证）：独立 `body::before` 使用 cover/center/no-repeat；默认极光变量不变；reduced-transparency 的默认背景清空与玻璃实色兜底不回归。真实图片解码、层叠与视觉由第 5 条人工验收承担。
5. 构建与既有设置页测试通过；手工在 alpha 实例选择一张真实风景图，验证对话页、设置页和弹窗下的玻璃观感及刷新持久化。

## 决策史

### 2026-10-27 方案审视处置（背景方案检视獭 / glm）

- S1（严重，reduced-transparency 冲突）：**接受并修复，更好**。采用独立 `body::before` 画布与隔离层叠上下文，不沿用会被清空的 `.bg-spring` 图片层。
- S2（严重，5 MiB 编码膨胀）：**接受并修复，更好**。改为解码后的 data URL 实际长度 ≤ 4.5M 字符，并保留 setItem 异常回滚。
- S3（建议，坏 data URL 永久空白）：**接受并修复，更好**。选图与启动恢复均先 Image 解码；失败清变量并尽力清坏 key。接受解码期间短暂显示默认画布，换取不展示坏图。
- S4（建议，CSS 测试层级）：**接受并修复，更好**。明确验证 4 只是源码静态契约抽检，真实渲染由人工验收负责。
- S5（建议，缩略图解码成本）：**接受并修复，更好**。复用原 data URL 的限尺寸预览，在性能风险中显式接受解码成本，不增加缩略图机制。
- S6（建议，恢复默认异常顺序）：**接受并修复，更好**。先清内存视觉态再尽力删存储；删存储失败不阻断当前恢复，但提示刷新后可能回到自定义图。

### 2026-10-27 代码审视初轮处置（背景代码检视獭 / glm，PR #1665）

- B1（严重，分支落后 main）：**接受并修复，更好**。rebase 到 origin/main 后重推，等 CI 实绿；非业务代码缺陷。
- 建议 1（模块连续选图竞态）：**接受并修复，更好**。虽然当前按钮 disabled 已拦住真实 UI 路径，但在模块内增加选择代数只需数行，且与启动恢复防护对称；连续选图后完成、解码中恢复默认两条回归测试确保最后操作获胜。

## 实现自检（2026-10-27）

| 场景 | 操作 | 预期结果 / 证据 |
|---|---|---|
| 全量回归 | `cd web && npm test` | 79 文件 / 807 测试通过（含连续选图与解码中恢复默认） |
| 构建 | `cd web && npm run build` | TypeScript 与 Vite 构建通过 |
| 文档门 | `npm run lint:intent` | 本特性 intent / verify_by 声明率 100%，无本特性 error |
| 真浏览器选图 | Chrome 1440×1000，设置页选择 1600×2400 JPEG | `body::before` 为 1440×1000，cover / 50% 50% / no-repeat，preview 96×64；截图 `data/workspaces/bc4ca9ba-9348-4283-afbf-e2d6f2dd12de/background-custom-settings.png` |
| 刷新与恢复 | reload → 恢复默认 → 写入坏 data URL → reload | 自定义图刷新保持；恢复后 key/变量清除；坏值自动清除，无 page error；机器证据 `background-browser-verification.json` |
| 对话页玻璃 | 自定义图状态进入会话列表 | 顶栏/面板显示图片取样后的玻璃效果；截图 `background-custom-conversation.png` |

- 视觉证据：默认 `background-default.png`、自定义设置 `background-custom-settings.png`、刷新 `background-custom-reloaded.png`。默认面板较浅，自定义风景图会显著透进玻璃；浅色辅助文字在深色图上变弱，是方案显式认领的可读性取舍，不新增暗化蒙版。
- reduced-transparency：静态契约已覆盖独立图片层不被 `.bg-spring` 清空；当前 Playwright/Chrome 的 `emulateMedia(reducedTransparency)` 未触发该媒体查询，故不宣称真浏览器该项已验。
- 最简检查：使用已有 localStorage + FileReader + Image + CSS 伪元素，无新运行时依赖。设置页快照/订阅拆成 15 行小模块，是为避免主包经懒加载设置页回环引用，不是为未来主题系统预留框架；已过最简检查。
- 负面向：未删除/绕过默认极光画布、玻璃 token、reduced-transparency 或弹窗自模糊；无旧资源需退役。首屏由同步脚本改为异步解码，明确接受解码前短暂默认画布，换取坏图不空屏。
- 影响面：不改历史 F20260724glas；本特性从它派生，只替换画布，不使原玻璃语义失效。
- 废弃资源/DB/软代码/Golden Gate/锚点重放：均 n/a；纯 A 类 web 本地外观能力。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `web/src/lib/background-preference.ts` | 新增 | 文件校验、读取、应用、持久化与恢复单入口 |
| `web/src/lib/background-preference-store.ts` | 新增 | 设置页同步快照与变更订阅；独立小模块避免主包循环依赖 |
| `web/src/lib/background-preference.test.ts` | 新增 | 偏好与异常路径测试 |
| `web/src/pages/settings/index.tsx` | 修改 | 外观区选图、预览、恢复与反馈 |
| `web/src/pages/settings/index.test.tsx` | 修改 | 设置页交互回归 |
| `web/src/styles/globals.css` | 修改 | 自定义画布与默认画布分层 |
| `web/src/styles/custom-background.test.ts` | 新增 | CSS 契约测试 |
| `web/src/main.tsx` | 修改 | SPA 启动恢复；解码前保留默认画布，坏值自动回退 |
| `docs/features/2026/10/27/F20261027cbgix-custom-background-image.md` | 新增 | 方案、决策与验证档案 |
