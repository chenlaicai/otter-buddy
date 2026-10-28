---
id: F20261027cbgix
title: 自定义启动目录背景图片与玻璃效果预览
doc_type: feature
summary: |
  设置页外观区新增本地图片选择与恢复默认彩色背景，图片保存到应用启动
  目录并即时替换最底层极光画布；重开浏览器、重启应用均保留。保留既有
  玻璃 token 与透明度滑杆，不做在线图库、裁切或多端云同步。
change_type: feature
capability_test: "n/a: web 外观与后端文件资产，无 agent 行为或工具轨迹变化"
intent:
  problem: "固定彩色极光画布无法让搭档用自己的风景图检验现有玻璃材质"
  expected_effect: "设置页选择合法本地图片后立即全屏生效并刷新保持，可恢复默认；坏图与存储失败回退原背景"
  verify_by:
    type: behavior_check
created_in_conversation: bc4ca9ba-9348-4283-afbf-e2d6f2dd12de
created_at: 2026-10-27
causal_links:
  from: [F20260724glas]
tags: [ui, settings, background, glass, filesystem, persistence]
modules:
  - web/src/pages/settings/index.tsx
  - web/src/styles/globals.css
  - web/src/main.tsx
  - web/src/lib/background-preference.ts
  - web/src/lib/background-preference-store.ts
  - src/usecases/settings/background-store.ts
  - src/interface-adapters/http/controllers/background-controller.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/controllers.ts
---

# F20261027cbgix 自定义本地背景图片与玻璃效果预览

## 背景

搭档原话：「我现在想给系统增加一个 替换背景图片的功能，我想换一个风景图作为背景，然后看看咱们系统的玻璃效果，而不是现在固定这个彩色背景」。

现状：最底层 `.bg-spring` 固定绘制米色底、四个径向色团、对角渐带和噪点（`web/src/styles/globals.css:180-184`）；玻璃层已经统一 token 化，设置页已有本地持久化的 `--glass-t` 滑杆（`web/src/pages/settings/index.tsx:20-27`）。本需求只更换玻璃下面的画布，不重做玻璃。

## 目标

T1：在「设置 → 外观」选择本机 JPG/PNG/WebP 图片后，立即全屏替换背景；图片保存到应用启动目录，刷新、重开浏览器和应用重启后仍生效。

T2：保留原有彩色背景作为默认项，并提供明确的「恢复默认背景」入口。

T3：背景图片与既有玻璃透明度滑杆组合可用，不改变弹窗、气泡、面板的材质语义。

T4：图片无效、损坏或本地持久化失败时给出可理解反馈，不能留下空白背景或阻塞设置页。

## 非目标

- 不做在线图库、远程 URL、跨设备云同步；本地上传到同一应用的启动目录是本需求明确目标。
- 不做裁切、缩放编辑、 focal point、背景动画、深色模式或多套主题管理。
- 不改动既有 `--glass-t` 的取值范围与各层玻璃 token。
- 不为极冷门的大图做首版图片压缩/缩略图流水线；以明确的体积上限控制本地存储风险。

## 未决问题

无。2026-10-27 19:50 搭档明确否决仅当前浏览器存储：「哎等等，不能只存当前浏览器，我期望能存到启动目录下？」；首版改为启动目录持久化，原 localStorage 方案不再交付。

## 方案设计

### 1. 启动目录资产模型

`src/usecases/settings/background-store.ts` 是唯一文件真相源，固定目录为 `path.join(process.cwd(), 'data', 'backgrounds')`；这里按搭档要求使用**应用启动 cwd**，不改为基于代码位置的 repoRoot：

- `current` 保存当前图片；文件名与路径不接受用户输入，目录加入 `.gitignore`。
- `PUT /api/settings/background` 接收浏览器读取的 data URL，原始图片上限 **8 MiB**；服务端按 canonical base64、magic bytes 与声明 MIME 三重校验，仅 JPEG/PNG/WebP，不信任扩展名。
- 写入 `.current.tmp` 后 rename 原子替换，避免进程中断留下半张图；成功才返回带版本的 `/api/settings/background?v=...` URL。
- `GET` 读取磁盘并返回白名单 MIME、nosniff、no-cache、ETag；资产不存在/损坏返回 404，前端回默认画布。
- `DELETE` 幂等删除；只有删除成功才清除页面背景，失败保留现状并报错。
- 三端点归入既有 `/api/settings` admin 鉴权族；背景直链沿用 `withIdentity`，不开放匿名静态目录。
- 前端 `background-preference.ts` 负责 FileReader、浏览器解码、API 调用和最后一次操作获胜的竞态防护；不写 localStorage。启动时从 GET 恢复，设置页用同步快照/订阅预览。

同一台机器上的其他浏览器可直接访问同一后端，因此自然共享这份启动目录资产；跨机器云同步仍不在范围。

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
- 仅自定义状态显示「恢复默认背景」。点击后等待服务端删除成功再回极光画布；删除失败保留原背景并提示，避免刷新后旧图意外回来。
- 校验/解码/读取/存储失败：保持更换前背景，显示具体错误（格式、大小、损坏图片、读取或服务端保存失败），不假装保存成功。
- 每次操作结束清空 file input 的 value，允许失败后重选同一文件。

## 影响范围

- 所有 SPA 页面共用的最底层背景。
- 设置页外观区、`web/src/main.tsx` 启动恢复、全局背景 CSS。
- 新增启动目录资产 store、背景 controller 与三个 settings 子路由；组合根负责注入。
- 不改数据库 schema、后端 SettingsDTO、模型配置、浮动獭快捷键与弹窗冻结机制。

## 风险与约束

- **磁盘写入**：磁盘满/权限不足时保存失败，服务端保留旧图，前端不切换并 toast；8 MiB 上限约束单资产大小。
- **生命周期**：图片由应用目录而非浏览器持有，重开浏览器/重启应用保留；清除启动目录资产会回默认。跨机器同步仍不提供。
- **文字可读性**：极亮/高细节风景图可能降低直接坐在画布上的辅助文字可读性；首版通过既有玻璃滑杆与 reduced-transparency 兜底，不擅自加全屏暗化层。
- **资产安全**：服务端复用附件 magic bytes 校验，排除 SVG；固定 current 路径阻断路径穿越；响应 nosniff；接口需要 admin 身份。日志不记录图片内容。
- **性能**：保持背景静止，不加动画和 `will-change`；图片只有一张。设置页缩略预览复用受控版本 URL 并限制显示尺寸，接受全尺寸解码成本；首版不引入 canvas 缩略图或压缩流水线。

## 不兼容更新

无。未设置启动目录资产时行为完全不变；旧 localStorage 方案未合入/未发布，无用户数据迁移。

## 设计取舍

机制识别检查点：命中「新增配置字段/开关」「新增持久化存储（启动目录文件）」「新增 HTTP 资产端点」，判定涉及净新增机制，四问必答；不新增数据库或后台任务。

### 机制预算四问

① **谁需要它**：当前使用 web 设置页的搭档，需要用真实风景图检验现有玻璃材质，而不是只看固定彩色渐变。

② **失败后果**：选图无效或存储失败时用户看不到预期背景；若未捕获异常可能丢提示或首屏报错。方案通过默认背景回退、toast 和原状态保留，把损害限制为「这次没有换成」，不影响对话数据与服务端设置。

③ **后续机制**：可能出错的新状态是 current 缺失、损坏、磁盘写失败或被清除；分别由默认回退、magic bytes 校验、保留旧图/toast 和重新选择修复。未来若支持跨设备云同步或多背景库，应另起资产集合与同步方案，不把 current 隐式扩成数据库。

④ **退役条件**：若背景功能长期无人使用，或产品转向统一云主题并完成资产迁移，可删除 current、背景端点与设置区；默认极光画布始终是可回退基线，不构成永久承诺。

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 图片存放 | `process.cwd()/data/backgrounds/current` + 8 MiB 上限 | localStorage、DB blob、附件表 | 搭档明确要求启动目录持久化；单文件是最小真相源，浏览器重启/清站点数据不丢，避免 DB 迁移与附件生命周期。代价是单背景、无云同步，磁盘错误由保留旧图和 toast 认领 |
| 默认背景 | 保留极光画布并可一键恢复 | 选图后覆盖默认 | 保留现有视觉基线，方便对比与退出 |
| 图片适配 | cover + center | contain、拉伸、首版裁切器 | 全屏无空白且不改变宽高比；裁切编辑超出当前验证目标 |
| 图片上蒙版 | 首版不新增 | 固定暗化/虚化 | 搭档要直接看玻璃与真实图片的组合；额外滤层会改变观察对象。可读性风险显式保留 |
| 无障碍 | reduced-transparency 仅退化玻璃；图片走独立 `body::before` 画布 | 连图片一起移除 | 用户选择的是画布内容，减少透明不等于不要背景图；独立层避开既有 `.bg-spring { background-image: none }` 一刀切 |

## 验证

1. 后端真实临时目录测试：PUT 写入 current，新 store 实例 GET 读回相同字节；验证启动目录持久化而非浏览器存储。
2. 后端测试：伪造 MIME、声明与内容不符、SVG、坏 base64、非 data URL、超过 8 MiB、坏磁盘资产均拒绝/回退；DELETE 幂等，重复保存无临时文件。
3. 前端测试：合法图片服务端保存成功后应用版本 URL；格式/大小/FileReader/解码/API 失败保持旧背景；404/服务失败/坏图回默认；连续选图、启动恢复与恢复默认的竞态最后操作获胜。
4. **静态 CSS 契约抽检**（读取样式表源码断言关键声明，不冒充 jsdom 渲染级验证）：独立 `body::before` 使用 cover/center/no-repeat；默认极光变量不变；reduced-transparency 的默认背景清空与玻璃实色兜底不回归。真实图片解码、层叠与视觉由第 5 条人工验收承担。
5. 构建与全量测试通过；真实服务选择风景图后清空浏览器站点数据并重启后端，仍读回同一图片，验证对话页、设置页的玻璃观感与恢复默认。

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

### 2026-10-27 搭档需求变更：浏览器存储 → 启动目录

搭档否决仅当前浏览器存储，原终审 matter M-09294408 已标 SUPERSEDED，PR 未合入。已移除 localStorage 真相源，新增启动目录文件 store + admin API；浏览器只负责选择/预览，应用重启与清站点数据不影响背景资产。原 S2/S6 关于 localStorage 配额和 removeItem 的处置随机制替换退役，不沿用到文件存储。

### 2026-10-27 启动目录版本代码审视处置（目录背景检视獭 / glm，PR #1665）

- 严重 1（CI web 测试 16/16 失败）：**接受并修复，更好**。`new Response(jsdom Blob)` 在 CI undici 下因 Blob 无 stream() 失败；测试响应体改为 `Uint8Array`，产品代码不变。启动目录语义、文件安全、鉴权、竞态、跨重启证据与玻璃层叠均经独立核实无发现。

### 2026-10-28 main 冲突解决

预注册：预期 main 工作账本装配与本 PR 背景装配相邻冲突；若背景语义或文件本体冲突则逐文件重审。实际命中前者：`src/bootstrap/controllers.ts` 唯一冲突，保留 `buildWorkLedgerController` 与背景 controller；路由/客户端自动合并。随后路由语句数 lint 通过拆出 `registerBackgroundRoutes` 解决，行为不变。机制清单无新增，属既有机制内 narrow-fix，无新资产/状态/端点。

证据：`git rebase origin/main` 的 UU 仅 controllers.ts；解决后 build/lint、背景 API 15 测试、web 813 测试通过，等待新 CI 与 delta。

## 实现自检（2026-10-27）

| 场景 | 操作 | 预期结果 / 证据 |
|---|---|---|
| 全量后端回归 | `npx vitest run` | 447 文件 / 7107 通过、6 skipped；含真实临时目录背景持久化测试 |
| 全量 web 回归 | `cd web && npm test` | 79 文件 / 804 测试通过（存储换轨后的新契约） |
| 构建 | `cd web && npm run build` | TypeScript 与 Vite 构建通过 |
| 文档门 | `npm run lint:intent` | 本特性 intent / verify_by 声明率 100%，无本特性 error |
| 真浏览器选图 | Chrome 1440×1000，设置页选择 1600×2400 JPEG | `body::before` 为 1440×1000，cover / 50% 50% / no-repeat，preview 96×64；截图 `data/workspaces/bc4ca9ba-9348-4283-afbf-e2d6f2dd12de/background-custom-settings.png` |
| 启动目录持久化 | 临时 cwd 启动真实服务 → 选图 → 关闭浏览器/新上下文（localStorage 空）→ 后端进程重启 | 图片写入 cwd/data/backgrounds/current（694860 字节），重启后仍从磁盘恢复；恢复默认后文件删除；page error=0。证据 `background-server-save-evidence.json`、`background-server-restart-evidence.json` |
| 对话页玻璃 | 自定义图状态进入会话列表 | 顶栏/面板显示图片取样后的玻璃效果；截图 `background-custom-conversation.png` |

- 视觉证据：默认 `background-default.png`、自定义设置 `background-custom-settings.png`、刷新 `background-custom-reloaded.png`。默认面板较浅，自定义风景图会显著透进玻璃；浅色辅助文字在深色图上变弱，是方案显式认领的可读性取舍，不新增暗化蒙版。
- reduced-transparency：静态契约已覆盖独立图片层不被 `.bg-spring` 清空；当前 Playwright/Chrome 的 `emulateMedia(reducedTransparency)` 未触发该媒体查询，故不宣称真浏览器该项已验。
- 最简检查：复用现有 Hono、身份中间件、附件 sniffType、FileReader、Image 与 CSS 伪元素，无新运行时依赖、无 DB 迁移。一个 current 文件满足单背景语义；设置页快照/订阅小模块避免主包循环依赖，不是为未来主题系统预留框架；已过最简检查。
- 负面向：未删除/绕过默认极光画布、玻璃 token、reduced-transparency 或弹窗自模糊；无旧资源需退役。首屏由同步脚本改为异步解码，明确接受解码前短暂默认画布，换取坏图不空屏。
- 影响面：不改历史 F20260724glas；本特性从它派生，只替换画布，不使原玻璃语义失效。
- 废弃资源/DB/软代码/Golden Gate/锚点重放：均 n/a；纯 A 类 web 本地外观能力。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/usecases/settings/background-store.ts` | 新增 | 启动目录文件真相源、校验、原子保存、读取与删除 |
| `src/interface-adapters/http/controllers/background-controller.ts` | 新增 | 背景 GET/PUT/DELETE HTTP 适配 |
| `src/interface-adapters/http/router.ts` | 修改 | 注册 settings 背景三端点，继承 admin 鉴权 |
| `src/bootstrap/controllers.ts` | 修改 | 注入 process.cwd()/data/backgrounds store |
| `tests/api/background.test.ts` | 新增 | 真实临时目录持久化、安全与异常测试 |
| `web/src/api/client.ts` | 修改 | 背景保存/删除 API |
| `web/src/lib/background-preference.ts` | 新增 | 浏览器校验、API 调用、应用与竞态防护 |
| `web/src/lib/background-preference-store.ts` | 新增 | 设置页同步快照与变更订阅；独立小模块避免主包循环依赖 |
| `web/src/lib/background-preference.test.ts` | 新增 | 偏好与异常路径测试 |
| `web/src/pages/settings/index.tsx` | 修改 | 外观区选图、预览、恢复与反馈 |
| `web/src/pages/settings/index.test.tsx` | 修改 | 设置页交互回归 |
| `web/src/styles/globals.css` | 修改 | 自定义画布与默认画布分层 |
| `web/src/styles/custom-background.test.ts` | 新增 | CSS 契约测试 |
| `web/src/main.tsx` | 修改 | SPA 启动恢复；解码前保留默认画布，坏值自动回退 |
| `.gitignore` | 修改 | 启动目录用户图片不入 git |
| `docs/features/2026/10/27/F20261027cbgix-custom-background-image.md` | 新增 | 方案、决策与验证档案 |
