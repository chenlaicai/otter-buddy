---
id: F20260713u9v4
title: ui-frontend-design
from_ids: [F20260709x7k3, F20260709m2n8, F20260709p4q7, F20260713i5k2, F20260713o4t8]
tags: [design, ui, frontend, react]
modules: [web]
doc_kind: spec
status: locked
created_at: 2026-07-13
---

# F20260713u9v4 [web] UI 前端设计

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。
>
> 本文档设计 Otter Buddy 的前端 UI。基于 S1 产品形态定义（8 个核心用例）、S2 架构设计（React 19 + Tailwind 4 + Hono）、S3 数据模型设计（对话树、三层记忆、Otter 生命周期），产出完整的 UI 页面清单和仿真页面规格。
>
> **核心原则**：仿真页面是视觉设计蓝图，定义布局、色彩、组件结构和交互行为。React 实现遵循仿真页面的视觉设计，技术栈使用 React + Tailwind + Hono（← UA-14 修订）。
>
> **锁定状态**：本文档 [design-time] 章节已锁定，所有 [required] 章节已填写完成。

## 背景 [required]

Otter Buddy 后端已完成 infra 层（db, config, logger, llm-gateway, agent-core, embedding）和 domain/otter 模块。前端尚未开始。用户要求先产出 UI 清单，确认后再做仿真页面（HTML + 可点击），且仿真页面必须可完整代码实现。

### 约束输入

- S1 产品形态：大獭+临时小獭、三层记忆、对话树、重启獭生、统一能力库、8 个核心用例
- S2 架构：React 19 + Tailwind 4 + Hono + SSE 流式推送 + react-flow 对话树可视化
- S3 数据模型：conversations（含 tree_path）、messages（append-only）、otters、otter_sessions、memory_entries、skills、linked_resources、key_facts
- S2 接口定义：ConversationService（14 方法）、MemoryService（11 方法）、OtterService（5 方法）、CapabilityService（4 方法）、ExternalSystemService（3 方法）
- S2 通信：HTTP POST 发送消息 + SSE 流式接收响应
- S2 MVP 优先级：P0=UC1+UC2, P1=UC7+UC8, P2=UC3+UC4+UC5+UC6

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 前端技术栈 | React 19 + Tailwind 4 + Hono | S2 D15 + UA-14 |
| 对话树可视化 | react-flow（S2 决策保留，UI 当前迭代暂不使用） | S2 D15 |
| 实时通信 | WebSocket（对话界面），覆盖 S2 D21 的 SSE 决策 | UA-14（用户明确指令） |
| 页面架构 | MPA（多页面应用），对话界面 SPA + WebSocket，其他页面独立 URL 跳转 | UA-14 |
| 布局架构 | 三栏布局（左导航 + 中内容 + 右上下文） | 本文档决策 D-UI-1 |
| 仿真页面形式 | HTML + CSS + JS（可点击交互）- 作为视觉设计参考 | 用户明确要求（ui1） |
| 仿真与实现关系 | 仿真页面为视觉设计蓝图，React 实现遵循仿真页面的视觉设计和组件结构，但技术栈使用 React + Tailwind + Hono | UA-14 修订 |
| 开发范围 | 仅前端实现，API 契约延后，代码中 TODO 标记 | UA-14 |

### 玻璃质感调研结论（UA-6）

**调研时间**：2026-07-14

**调研范围**：Tailwind CSS v4 生态中的玻璃拟态(Glassmorphism)库及 Apple Liquid Glass 实现方案。

**关键发现**：

| 库/方案 | 版本 | 类型 | TW v4 | 真实折射 | 成熟度 |
|---------|------|------|-------|---------|--------|
| 手写 CSS (backdrop-blur) | N/A | 内置 | Yes | No | 生产就绪 |
| `@casoon/tailwindcss-glass` | 0.9.7 | CSS 插件 | Yes | No | v0.x |
| `tw-glass` | 0.0.5 | CSS 插件 | Yes | Yes (SVG) | v0.0.x |
| `simple-liquid-glass` | 4.1.0 | React 组件 | N/A | Yes (SVG) | 稳定 |
| `shadcn-glass-ui` | 2.11.2 | React 组件库 | Yes (4.1+) | No | 稳定 |

**决策**：手写 CSS 玻璃工具类（当前 index.html 已实现的 `.glass` / `.glass-strong` / `.glass-card` / `.glass-input`）。

**决策理由**：
1. Tailwind v4 内置 `backdrop-blur-*` / `backdrop-saturate-*` / `bg-*/{opacity}` 已足够实现标准玻璃拟态
2. Apple Liquid Glass 的核心折射效果需要 SVG displacement maps，仅 Chromium 支持，库均为 v0.x
3. 当前手写方案已达成 Apple 玻璃视觉效果（blur(30px) + saturate(180%) + 透明度层级）
4. 零依赖、零维护成本、仿真即实现原则下 CSS 直接翻译为 React + Tailwind

**正反论点记录**：
- 正方（手写）：零依赖、已验证效果、仿真即实现、标准玻璃拟态足够
- 反方（用库）：`simple-liquid-glass` 可提供真实折射和色散效果，更接近 Apple 原生
- 裁决：折射效果仅 Chromium 支持且库版本过低，视觉增益不抵维护成本。手写方案在 blur+saturate 组合下已达成"Apple 玻璃风格"的用户预期

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 msg#1 | 咱们来做本系统的ui设计，你先分析下本系统的设计计划，然后先出一份ui清单 | 时序：先分析设计计划，再出 UI 清单 | 需先分析现有设计文档，再产出 UI 清单 |
| UA-2 | 当前讨论 msg#1 | 这个确认好之后，你再做仿真页面（html加可点击） | 时序：UI 清单确认后，再做仿真页面；形式：HTML + 可点击 | 两步走：先清单后仿真 |
| UA-3 | 当前讨论 msg#1 | 必须是所有的页面、所有的操作、最终真实的页面！ | 程度：必须；范围：所有页面、所有操作；属性：最终真实的 | UI 清单必须覆盖全部页面和操作，不能遗漏 |
| UA-4 | 当前讨论 msg#1 | 最终的这个仿真页面必须是可完整代码实现的 | 程度：必须可完整代码实现 | 仿真页面的设计必须可直接翻译为 React 代码 |
| UA-5 | 当前讨论 msg#1 | 不允许 仿真是一套，然后我确认好了之后代码实现又是另外一套 | 否定：仿真与实现不一致 | 仿真即设计蓝图，React 实现严格按仿真页面构建 |
| UA-6 | ui2 msg#1 | 玻璃质感在tailwind中是否已有成熟的样式库，我觉得用苹果的玻璃风格作为主题是一个不错的idea | 属性：苹果的玻璃风格；条件：tailwind中已有成熟样式库（疑问） | 用户希望采用 Apple 玻璃风格作为主题，需调研 Tailwind 生态中的玻璃质感库可行性 |
| UA-7 | ui2 msg#1 | 中间区域肯定是核心的对话区域，一定要够大 | 程度：肯定、一定要；属性：核心的对话区域、够大 | 中央对话区是核心，必须最大化占据空间，左右栏不能挤压中央 |
| UA-8 | ui2 msg#1 | 左侧栏的对话不要搞两套展示模式（列表和树状），先保留列表即可 | 否定：不要搞两套展示模式；时序：先保留列表；程度：即可 | 左栏仅保留列表模式，移除树状视图模式。树状视图不做为当前迭代目标 |
| UA-9 | ui2 msg#1 | 页面上方目录栏的《大獭状态》有点莫名其妙，这个具体是表示啥 | 程度：有点莫名其妙（困惑信号） | 用户对顶栏"大獭状态"的用途不理解，说明该设计缺乏合理性，应移除或重新定义 |
| UA-10 | ui2 msg#1 | 目录栏的海獭还是emoji图标，这个目录栏难道不是全局唯一的吗 | 否定：还是emoji（不满信号）；程度：难道不是全局唯一的（反问） | 顶栏必须全局统一，所有页面使用相同的图标系统（Lucide），不得出现 emoji |
| UA-11 | ui2 msg#3 | 看着只有弹出窗口（比如新增小獭窗口）有玻璃效果，主界面没有玻璃效果呀，左侧栏、中间消息、右侧信息 全都无玻璃效果 | 否定：主界面没有玻璃效果；范围：左侧栏、中间消息、右侧信息 全都无 | 玻璃效果必须在主面板（左栏/中央/右栏）上视觉可辨，不能仅弹窗可见。需增强背景色彩对比度并降低面板透明度 |
| UA-12 | ui2 msg#3 | 顶栏tab咋不在中间了；而且点击其他界面 顶栏又回到中间，并且海獭是🦦，感觉多个页面中 顶栏不是相同的 | 疑问：咋不在中间了；否定：又回到中间、不是相同的；属性：🦦 emoji | 顶栏 tabs 必须居中显示，所有页面顶栏完全一致（同一组件），不得出现 emoji |
| UA-13 | ui2 msg#5 | 系统图标能换一个吗，不要这种爪子 | 否定：不要这种爪子；属性：系统图标 | 顶栏 Logo 图标替换为自定义 SVG 水獭头部图标，不使用 Lucide paw-print |
| UA-14 | ui2 msg#7 | 本次你可以将页面低保真图都做了，咱们也讨论了很多轮，不要浪费，你本次聚焦在前端吧，数据和api可以后定（这一点记得写到特性文档中和代码中todo），本次特性范围还是把前端这些能定的都先实现好，特别是样式、显式效果这些。当然，我明确体现你，技术栈要贯彻，不要手搓html+js。react、tailwind、hono，并且有url跳转，只有对话界面要用websocket来对接实时消息加载（spa），而不要把整个系统所有页面都放到一个spa中了 | 范围：聚焦前端、数据和api后定；程度：技术栈要贯彻、不要手搓；否定：不要把整个系统所有页面都放到一个spa中；属性：react、tailwind、hono、url跳转、websocket、对话界面spa | 本次开发范围仅前端，API 延后（代码中 TODO 标记）。技术栈必须使用 React + Tailwind + Hono，不手搓 HTML+JS。MPA 架构：对话界面 SPA + WebSocket，其他页面独立 URL 跳转。覆盖 S2 SSE 决策为 WebSocket |

## 目标 [required]

### P1 - UI 清单（当前阶段）

产出完整的 UI 页面清单，覆盖：
- 全部页面/视图（含布局、组件、操作）
- 全部弹窗/对话框
- 全部状态（空状态、加载中、错误、流式响应）
- 页面间导航关系

### P2 - 仿真页面（确认后下一阶段）

基于确认的 UI 清单，产出可点击的 HTML 仿真页面：
- 纯 HTML + CSS + JS（无构建步骤）
- 可点击交互（页面跳转、弹窗、表单）
- 视觉效果与最终 React 实现一致
- 组件结构可直接翻译为 React 组件

## 非目标 [required]

- 不设计 REST API 端点 / API 契约（属于 adapter/http 模块设计，← UA-14 延后）
- 不实现后端 domain 逻辑（属于后端 development）
- 不修改 S1/S2/S3 已锁定的设计（S2 D21 SSE 被 UA-14 覆盖为 WebSocket，仅此例外）
- 不做视觉设计稿（Figma 等），仿真 HTML 即视觉设计
- 不使用手搓 HTML+JS 实现最终产品（← UA-14：必须使用 React + Tailwind + Hono）

## 设计 [required]

### 布局架构（D-UI-1: 三栏布局）

```
┌─────────────────────────────────────────────────────────────┐
│  顶栏: Logo | 视图切换(对话/搜索/能力/设置)                    │
├──────────┬──────────────────────────────┬────────────────────┤
│          │                              │                    │
│  左栏     │       中央内容区              │    右栏(上下文)     │
│          │                              │                    │
│  对话列表  │   根据当前视图切换:            │   根据当前对话切换:  │
│          │   - 对话视图(默认)            │   - Otter 参与者    │
│          │   - 记忆搜索                  │   - 关键信息        │
│          │   - 能力库                    │   - 链接资源        │
│          │   - 设置                     │                    │
│          │                              │                    │
├──────────┴──────────────────────────────┴────────────────────┤
│                       (无底栏)                                │
└─────────────────────────────────────────────────────────────┘
```

**设计要点**：

| 要点 | 决策 | 理由 |
|------|------|------|
| 三栏布局 | 左导航 + 中内容 + 右上下文 | Chat as Substrate，对话为主，上下文辅助 |
| 左栏模式 | 仅对话列表（列表模式） | ← UA-8：不搞两套展示模式，先保留列表即可 |
| 中央区域最大化 | 左栏固定宽度(flex-shrink-0)，中央 flex-1 占据剩余空间 | ← UA-7：中间区域是核心对话区，一定要够大 |
| 右栏可折叠 | 默认展开，可收起 | 小屏幕或不需要上下文时释放空间给中央 |
| 视图切换 | 顶栏 Tab 切换 | 对话/搜索/能力/设置四个主视图 |
| 右栏仅对话视图有 | 其他视图时右栏隐藏 | 搜索/能力/设置不需要对话上下文 |
| 顶栏内容 | Logo + 视图切换 Tab（无大獭状态） | ← UA-9：大獭是持久 Otter，"在线状态"无意义；实时状态由对话区流式指示器展示 |
| 顶栏 tabs 居中 | logo 左对齐 + tabs 居中 + 右侧等宽占位 | ← UA-12：顶栏 tabs 必须居中显示 |
| 顶栏全局统一 | 所有页面使用同一顶栏组件（Lucide 图标 + Tailwind + 玻璃风格） | ← UA-10：顶栏必须全局唯一，不得出现 emoji 图标 |
| 玻璃效果可见性 | 背景色块透明度 0.22-0.32 + 面板透明度 0.32-0.42 | ← UA-11：玻璃效果必须在主面板视觉可辨，不能仅弹窗可见 |

### 前端架构（D-UI-2: MPA + 对话 SPA）← UA-14

**架构决策**：多页面应用（MPA），非单 SPA。每个视图是 Hono 提供的独立页面，页面间通过 URL 跳转。仅对话界面为 SPA（WebSocket 实时消息）。

```
Hono Server
├── GET /                    -> 对话视图 (SPA, WebSocket)
├── GET /conversation/:id    -> 对话视图 (SPA, WebSocket)
├── GET /memory              -> 记忆搜索视图 (独立页面)
├── GET /skills              -> 能力库视图 (独立页面)
└── GET /settings            -> 设置视图 (独立页面)
```

**技术栈**：React 19 + Tailwind 4 + Hono

| 要点 | 决策 | 理由 |
|------|------|------|
| 页面架构 | MPA，每页独立入口 | ← UA-14：不要把所有页面放到一个 SPA |
| 对话界面 | SPA + WebSocket | ← UA-14：对话需要实时消息加载 |
| 其他页面 | 独立页面，URL 跳转 | ← UA-14：页面间通过 URL 跳转 |
| 实时通信 | WebSocket（覆盖 S2 SSE 决策） | ← UA-14：用户明确指令 |
| API 对接 | 延后，代码中 TODO 标记 | ← UA-14：数据和 API 后定 |
| 数据源 | Mock 数据 + TODO 占位 | ← UA-14：聚焦前端样式和显示效果 |

**仿真页面与 React 实现的关系**：
- 仿真页面（HTML+CSS+JS）是视觉设计蓝图，定义了布局、色彩、组件结构、交互行为
- React 实现遵循仿真页面的视觉设计和组件映射，但使用 React + Tailwind + Hono 技术栈
- 仿真页面中验证的玻璃效果 CSS、SVG 图标、色彩方案直接迁移到 React 实现

### 页面清单

#### 1. 对话视图（Chat View）- P0

**路由**：`/` 或 `/conversation/:id`

**布局**：三栏完整布局

**左栏 - 对话列表**：

| 组件 | 说明 | 操作 |
|------|------|------|
| 新建对话按钮 | 顶部，创建根对话 | 点击 -> 创建新对话弹窗 |
| 对话列表 | 按更新时间倒序 | 点击 -> 切换对话 |
| 对话项 | 标题 + 状态标记(active/completed/archived) + Otter 参与者头像 | 右键 -> 上下文菜单 |
| 上下文菜单 | 完成对话 / 归档对话 / 创建子对话 | 菜单项禁用条件：已归档 -> 禁用"归档"和"完成"；已completed -> 禁用"完成" |
| 搜索历史对话入口 | 顶部搜索图标 | 点击 -> 跳转记忆搜索视图 |

**中央 - 消息流**：

| 组件 | 说明 | 操作 |
|------|------|------|
| 对话标题栏 | 标题 + 状态 + 父对话链接(如有) + 操作按钮 | 操作: 创建子对话 / 完成对话 / 归档对话 |
| 消息列表 | 按时序排列，用户消息 + Otter 消息 | 滚动加载历史消息 |
| 用户消息 | 右对齐，用户头像 | 无操作(append-only) |
| Otter 消息 | 左对齐，Otter 头像 + 名称 | 点击 Otter 名称 -> 查看 Otter 信息 |
| 多 Otter 消息区分 | 不同 Otter 使用不同颜色标签(头像边框色 + 名称色)，大獭固定为蓝色系，小獭按创建顺序分配颜色(绿/橙/紫等) | 点击 Otter 头像 -> Otter 信息弹窗 |
| 多 Otter 交互入口 | 输入框支持 @小獭名称 指定回复对象；不 @ 时默认大獭路由 | 输入 @ 触发 Otter 名称自动补全 |
| 流式响应 | 打字机效果，WebSocket 实时推送 | 流式中可点击"停止生成" |
| Otter 思考状态 | "大獭正在思考..." / "小獭XX正在回复..." | 等待动画 |
| 消息内容渲染 | 基础 Markdown 渲染(代码块、换行、加粗、列表)，使用 react-markdown | 代码块支持语法高亮(扩展点) |
| 消息时间戳 | 悬浮显示 | 无操作 |
| 错误消息 | LLM 失败/外部操作失败时显示 | 重试按钮(仅 LLM 失败) |
| 输入框 | 底部固定，多行文本 | Enter 发送 / Shift+Enter 换行 |
| 输入框附件 | 表情/附件按钮(MVP 可省略) | MVP 最小实现: 纯文本 |

**右栏 - 上下文面板**：

| 组件 | 说明 | 操作 |
|------|------|------|
| Otter 参与者列表 | 大獭 + 活跃小獭 | 点击 -> Otter 详情弹窗 |
| 创建小獭按钮 | 仅大獭可操作 | 点击 -> 创建小獭弹窗 |
| 关键事实列表 | 当前对话的 key_facts | 添加(行内表单) / 标记(星标切换) / 删除 |
| 关键事实添加表单 | 行内展开：content(文本) + category(可选文本) | 点击"添加"按钮展开行内表单，填写后确认添加 |
| 链接资源列表 | 当前对话的 linked_resources | 添加(弹窗) / 点击跳转 / 删除 |
| 链接资源添加弹窗 | resource_type(文本，开放机制) + url(文本) + title(可选文本) | 点击"添加"按钮弹出弹窗，填写后确认 |
| 自动链接标识 | auto_linked=1 的资源显示"自动"标签 | 无操作(只读) |
| Session 信息 | 当前 Otter 的 Session 状态 + 历史 | 点击 -> Session 历史弹窗 |
| 重启獭生按钮 | 用户表达不满时触发 | 点击 -> 重启獭生确认弹窗 |

**状态**：

| 状态 | 说明 |
|------|------|
| 未配置 LLM（首次使用） | 中央显示引导卡片"请先配置 LLM"，带"前往设置"按钮跳转设置视图。输入框禁用。 |
| 空对话(新创建) | 中央显示"开始对话"引导 |
| 加载历史消息 | 骨架屏 / 加载动画 |
| 大獭正在回复 | 输入框上方显示"大獭正在输入..." + 动画 |
| LLM 错误 | 消息流中显示错误卡片 + 重试按钮 |
| WebSocket 连接断开 | 顶部黄色提示条"连接已断开，正在重连..." |
| 对话已归档 | 标题栏显示"已归档"标记，输入框禁用 |

#### 2. Otter 管理面板（Otter Panel）- P0

**形式**：右栏面板 + 弹窗

**右栏 - Otter 参与者区**：

| 组件 | 说明 | 操作 |
|------|------|------|
| 大獭卡片 | 名称 + "大獭" 标签 + 状态(active) + 创建时间 | 点击 -> Otter 详情弹窗 |
| 活跃小獭列表 | 名称 + 角色名 + 头像(颜色标签) | 点击 -> 小獭详情弹窗 |
| 创建小獭按钮 | 大獭的操作 | 点击 -> 创建小獭弹窗 |
| 解散小獭 | 小獭卡片上的菜单 | 点击 -> 解散确认弹窗 |

**弹窗 - Otter 详情**：

| 组件 | 说明 |
|------|------|
| Otter 基本信息 | 名称、类型(大獭/小獭)、状态、角色(小獭)、职责列表 |
| 创建信息 | 创建时间、创建者(大獭) |
| Session 历史 | Session 列表(状态、开始时间、归档时间、archive_reason、是否反面案例、摘要) |
| 已加载能力 | Skill 列表(名称、类型) |
| 操作按钮 | 重启獭生(仅当前活跃 Otter) / 解散(仅小獭) |

**弹窗 - 创建小獭**：

| 组件 | 说明 | 操作 |
|------|------|------|
| 名称输入 | 小獭名称 | 文本输入 |
| 角色名称 | 小獭角色(如"方案A视角") | 文本输入 |
| 角色职责 | 职责列表 | 多行输入 / 标签输入 |
| 能力选择 | 从能力库选择 Skill | 多选下拉 |
| 上下文注入 | 大獭提取的相关上下文(自动生成，可编辑) | 文本域 |
| 确认/取消 | | |

**弹窗 - 解散小獭确认**：

| 组件 | 说明 |
|------|------|
| 提示信息 | "解散小獭XX？Session 将归档到大獭历史记忆，已加载能力将回收。" |
| 归档摘要 | 可编辑的归档摘要(默认自动生成) |
| 确认/取消 | |

**弹窗 - 重启獭生确认**：

| 组件 | 说明 |
|------|------|
| 提示信息 | "重启獭生将封存当前 Session 为反面案例，并开新 Session 换角度重来。" |
| 前情摘要 | 可编辑的摘要(默认自动生成) |
| 确认/取消 | |

#### 3. 记忆搜索视图（Memory Search）- P0

**路由**：`/memory`

**布局**：顶栏 + 左栏(搜索区) + 中央(结果区)，右栏隐藏

| 组件 | 说明 | 操作 |
|------|------|------|
| 搜索框 | 输入搜索关键词 | 输入 -> 点击搜索/Enter |
| 层过滤器 | working / historical / key_info / 全部 | 单选 |
| 粒度过滤器 | coarse / fine / 全部 | 单选 |
| 对话过滤 | 限定对话范围(可选) | 下拉选择 |
| 搜索按钮 | 执行搜索 | 点击 -> 搜索 |
| 结果列表 | 按相关性排序 | 点击 -> 展开详情 |
| 结果项 | 内容摘要 + 来源(消息/摘要/关键事实/链接资源) + 对话标题 + 时间 + 相关性分数 | |
| 展开上下文 | 显示前后消息 | 点击 -> 调用 expand |
| 细化搜索 | 基于上次结果调整查询 | 点击 -> 输入新查询 |
| 查找相似 | 查找相似条目 | 点击 -> 调用 searchSimilar |
| 标记/取消标记 | user_flagged 切换 | 点击 -> 切换标记状态 |
| 标记指示 | 已标记条目显示星标 | |

**状态**：

| 状态 | 说明 |
|------|------|
| 初始(未搜索) | 显示搜索引导 + 最近检索的记忆 |
| 搜索中 | 加载动画 |
| 无结果 | "未找到相关记忆，尝试调整搜索词" |
| 降级提示 | embedding 不可用时提示"语义检索不可用，仅显示关键词匹配结果" |

#### 4. 能力库视图（Skill Library）- P2

**路由**：`/skills`

**布局**：顶栏 + 左栏(Skill 列表) + 中央(详情)，右栏隐藏

| 组件 | 说明 | 操作 |
|------|------|------|
| Skill 列表 | 按类型分组(tool/prompt_template/workflow) | 点击 -> 查看详情 |
| 注册新 Skill 按钮 | 顶部 | 点击 -> 注册弹窗 |
| Skill 详情 | 名称、描述、类型、定义(schema + handlerRef) | |
| 分配状态 | 哪些 Otter 已加载此 Skill | |
| 加载到 Otter | 选择 Otter -> 加载 | 下拉选择活跃 Otter |
| 卸载 | 从 Otter 卸载 Skill | 点击卸载按钮 |

**弹窗 - 注册 Skill**：

| 组件 | 说明 |
|------|------|
| 名称 | Skill 名称(唯一) |
| 描述 | Skill 描述 |
| 类型 | tool / prompt_template / workflow |
| Schema | JSON 格式的参数 schema |
| Handler 引用 | handlerRef |
| 确认/取消 | |

**状态**：

| 状态 | 说明 |
|------|------|
| 空列表(无 Skill) | "尚未注册任何 Skill，点击上方按钮注册" |

#### 5. 设置视图（Settings）- P0

**路由**：`/settings`

**布局**：顶栏 + 中央(表单)，左右栏隐藏

| 组件 | 说明 | 操作 |
|------|------|------|
| LLM 配置区 | Provider 选择(OpenAI/Anthropic/Google) | 下拉选择 |
| Model 选择 | 根据 Provider 列出可用模型 | 下拉选择 |
| API Key | 密码输入框 | 输入 |
| 测试连接 | 验证 API Key 是否有效 | 点击 -> 测试中状态 -> 成功/失败反馈 |
| 系统参数 | 端口号(只读) / DB 路径(只读) | |
| 记忆参数 | 半衰期天数 / 权重系数(只读，高级) | |
| Embedding 状态 | 模型加载状态 / 维度 | |
| 保存按钮 | 保存配置 | 点击 -> 保存中 -> Toast 反馈(成功/失败) |
| 未保存变更提示 | 有未保存修改时，保存按钮高亮；离开页面前提示"有未保存的变更" | |

#### 6. 对话操作弹窗

**弹窗 - 创建新对话**：

| 组件 | 说明 |
|------|------|
| 标题输入 | 对话标题 |
| 父对话(可选) | 如果从树视图创建子对话 |
| 参与 Otter | 默认大獭 |
| 确认/取消 | |

**弹窗 - 完成对话确认**：

| 组件 | 说明 |
|------|------|
| 提示 | "完成此对话？子对话未完成时父对话也可完成。" |
| 确认/取消 | |

**弹窗 - 归档对话确认**：

| 组件 | 说明 |
|------|------|
| 提示 | "归档后对话可检索但不活跃。" |
| 确认/取消 | |

#### 8. 全局组件

| 组件 | 说明 | 触发条件 |
|------|------|---------|
| 通知 Toast | 操作成功/失败提示 | 创建小獭成功、解散完成、保存设置成功/失败等 |
| 确认弹窗 | 通用确认对话框 | 删除操作等 |
| 错误边界 | React Error Boundary，fallback UI 显示"页面出错了" + "重新加载"按钮 | 组件渲染错误 |
| 加载骨架屏 | 骨架屏动画 | 数据加载中 |
| 空状态插画 | 友好的空状态提示 | 无对话、无搜索结果等 |
| WebSocket 连接状态条 | 顶部连接状态指示 | 连接断开/重连中/已连接 |
| Otter 头像组件 | 大獭/小獭统一头像，支持颜色标签 | 各处复用 |
| 消息渲染器 | 基础 Markdown 渲染(代码块、换行、加粗、列表)，使用 react-markdown | 消息显示 |

### 页面导航关系

```
顶栏 Tab 切换:
┌──────────────────────────────────────────┐
│  [对话]  [记忆搜索]  [能力库]  [设置]     │
└──────────────────────────────────────────┘

对话视图 (默认)
├── 左栏: 对话列表
├── 中央: 消息流
│   ├── 创建新对话弹窗
│   ├── 创建子对话弹窗
│   ├── 完成对话弹窗
│   ├── 归档对话弹窗
│   ├── Otter 详情弹窗 (点击 Otter)
│   ├── 创建小獭弹窗 (右栏)
│   ├── 解散小獭弹窗 (右栏)
│   ├── 重启獭生弹窗 (右栏)
│   ├── Session 历史弹窗 (右栏)
│   ├── 添加关键事实 (行内表单)
│   ├── 链接资源弹窗
│   └── 未配置 LLM 引导卡片
└── 右栏: 上下文面板
    ├── Otter 参与者
    ├── 关键事实 (行内添加/标记/删除)
    └── 链接资源 (弹窗添加/跳转/删除)

记忆搜索视图
├── 搜索区: 搜索框 + 过滤器
└── 结果区: 结果列表
    ├── 展开上下文
    ├── 细化搜索
    ├── 查找相似
    └── 标记/取消标记

能力库视图
├── Skill 列表
├── Skill 详情
├── 注册新 Skill 弹窗
└── 加载/卸载 Skill

设置视图
├── LLM 配置
├── 系统参数
├── 记忆参数
└── 保存反馈 (Toast + 未保存变更提示)
```

### 操作清单（按用例覆盖）

| 用例 | 涉及页面 | 涉及操作 | MVP 优先级 |
|------|---------|---------|-----------|
| UC1 与大獭对话 | 对话视图 | 发送消息、接收流式响应、查看历史消息 | P0 |
| UC2 历史对话检索 | 记忆搜索视图 | 输入查询、过滤、查看结果、展开上下文、细化搜索、查找相似、标记 | P0 |
| UC3 多 Otter 协作 | 对话视图 + 右栏 | 创建小獭、加载能力、与小獭对话(@指定)、解散小獭 | P2 |
| UC4 重启獭生 | 对话视图 + 右栏 | 触发重启、封存确认、新 Session 开始 | P2 |
| UC5 外部系统操作 | 对话视图 | 在对话中指令大獭操作外部系统（通过 AgentTool） | P2 |
| UC6 能力加载 | 能力库视图 + 创建小獭弹窗 | 注册 Skill、加载到 Otter、卸载 | P2 |
| UC7 对话树导航 | 对话视图 | 创建子对话、通过左栏列表切换对话 | P1 |
| UC8 对话外部关联 | 对话视图 + 右栏 | 手动添加链接资源、查看自动链接 | P1 |

### 仿真页面规格

仿真页面以纯 HTML + CSS + JS 实现。**每个页面文件包含该页面的全部弹窗和状态**，模拟真实用户体验--弹窗在具体页面上下文中触发，状态是页面内状态：

| # | 文件 | 页面 | 包含的弹窗 | 包含的状态 |
|---|------|------|-----------|-----------|
| 1 | `index.html` | 对话视图（主页面） | 创建新对话、创建子对话、完成对话确认、归档对话确认、创建小獭、解散小獭确认、重启獭生确认、Otter 详情、Session 历史、链接资源 | 空对话、加载历史、大獭正在回复、流式响应、LLM 错误、WebSocket 断开、对话已归档、未配置 LLM 引导 |
| 2 | `memory-search.html` | 记忆搜索视图 | - | 初始未搜索、搜索中、无结果、降级提示 |
| 3 | `skills.html` | 能力库视图 | 注册 Skill、加载到 Otter | 空列表(无 Skill) |
| 4 | `settings.html` | 设置视图 | - | 保存中、保存成功 Toast、保存失败 Toast、未保存变更警告、测试连接中 |

> **注**：对话树视图已移除（← UA-8），左栏仅保留对话列表模式。
>
> **废弃文件**（← UA-10）：`styles.css` 和 `app.js` 不再使用。所有页面统一使用 Tailwind CDN + Lucide CDN + 内联 JS。

**仿真原则**：

| 原则 | 说明 |
|------|------|
| 组件一一对应 | HTML 中的每个区块对应一个未来的 React 组件（见下方组件层级映射） |
| class 语义化 | CSS class 使用 React 组件名风格（如 `.chat-message`, `.otter-card`） |
| 交互可演示 | 点击按钮 -> 弹窗打开、Tab 切换可演示 |
| 模拟数据 | 使用静态 JSON 模拟数据（用户消息、Otter 列表、搜索结果等） |
| 流式模拟 | 用 setInterval 模拟 SSE 流式响应效果 |
| 响应式 | 最小宽度 1024px（桌面应用，单用户本地） |
| 弹窗内嵌 | 弹窗作为页面内的 overlay 实现，不跳转到独立页面 |
| 顶栏全局统一 | ← UA-10：所有页面使用同一顶栏（Tailwind CDN + Lucide 图标 + 玻璃风格），严禁 emoji 图标 |
| 设计系统统一 | ← UA-10：所有页面使用 Tailwind CDN + Lucide + 玻璃风格，废弃 styles.css |

### React 组件层级映射

> 以下为核心页面（对话视图）的组件拆分映射，开发者可直接据此实现 React 组件。

| HTML block (CSS class) | React Component | 关键 Props | 说明 |
|------------------------|----------------|-----------|------|
| `.app-layout` | AppLayout | activeView | 顶栏 + 三栏容器 |
| `.top-bar` | TopBar | activeView, onChangeView | Logo（自定义 SVG 水獭）+ Tab 切换 |
| `.left-panel` | LeftPanel | conversations[] | 左栏容器（仅列表模式） |
| `.conversation-list` | ConversationList | conversations[], activeId, onSelect | 对话列表 |
| `.conversation-item` | ConversationItem | conversation, isActive, onContextMenu | 单个对话项 |
| `.chat-view` | ChatView | conversationId, messages[] | 中央对话区 |
| `.chat-header` | ChatHeader | conversation, onComplete, onArchive, onCreateChild | 对话标题栏 + 操作按钮 |
| `.message-list` | MessageList | messages[], streamingMessage, onLoadMore | 消息流 |
| `.message-item` | MessageItem | message, sender | 单条消息 |
| `.message-content` | MessageContent | content, format: 'markdown' | 消息内容渲染(react-markdown) |
| `.streaming-indicator` | StreamingIndicator | otterName | "正在输入..." 动画 |
| `.message-input` | MessageInput | onSend, disabled, placeholder, mentionList | 输入框(支持 @ 提及) |
| `.right-panel` | ContextPanel | conversation, otters[], onCollapse | 右栏上下文 |
| `.otter-participants` | OtterParticipants | otters[], onCreateSmall, onDissolve | Otter 参与者区 |
| `.otter-card` | OtterCard | otter, onClick | 单个 Otter 卡片(颜色标签) |
| `.key-facts-section` | KeyFactsSection | facts[], onAdd, onFlag, onDelete | 关键事实区(行内添加表单) |
| `.linked-resources-section` | LinkedResourcesSection | resources[], onAdd, onDelete | 链接资源区(弹窗添加) |
| `.session-info` | SessionInfo | session, history[], onRestart | Session 信息 + 重启獭生 |
| `.modal-overlay` | Modal | isOpen, onClose, title | 通用弹窗容器 |
| `.toast` | Toast | message, type, duration | 通知提示 |
| `.error-boundary-fallback` | ErrorFallback | onReload | 错误边界 fallback UI |
| `.llm-setup-guide` | LLMSetupGuide | onGoToSettings | 未配置 LLM 引导卡片 |

## 硬约束 [required]

- 仿真页面的组件结构必须与后续 React 实现一一对应
- 所有 8 个用例的 UI 流程必须完整覆盖
- 所有页面状态（空、加载、错误、流式、降级、未配置 LLM）必须有对应 UI
- 对话消息为 append-only，UI 中不提供编辑/删除消息功能
- 重启獭生按钮仅在用户触发时显示，Otter 不能自主触发
- 大獭是唯一持久 Otter，UI 中不提供"创建大獭"功能
- 消息发送使用 HTTP POST，响应接收使用 WebSocket（仿真中用 JS 模拟）
- 每个仿真 HTML 文件包含该页面的全部弹窗和状态，不拆分到独立文件
- 左栏仅对话列表模式，不提供树状视图（← UA-8）
- 顶栏全局统一：所有页面使用 Lucide 图标 + Tailwind + 玻璃风格，严禁 emoji（← UA-10）
- 顶栏 Logo 使用自定义 SVG 水獭头部图标，不使用 Lucide paw-print（← UA-13）
- 顶栏不含"大獭状态"指示器（← UA-9）
- 顶栏 tabs 必须居中显示（← UA-12）
- 所有仿真页面统一使用 Tailwind CDN + Lucide CDN，废弃 styles.css（← UA-10）
- 视觉风格采用 Apple 玻璃风格，使用手写 CSS 玻璃工具类，不引入第三方玻璃质感库（← UA-6）
- 玻璃效果必须在主面板（左栏/中央/右栏）视觉可辨：背景色块透明度 ≥ 0.22，面板透明度 ≤ 0.42（← UA-11）
- 不使用手搓 HTML+JS 实现最终产品，必须使用 React + Tailwind + Hono（← UA-14）
- MPA 架构：对话界面 SPA + WebSocket，其他页面独立 URL 跳转，不做单 SPA（← UA-14）
- 实时通信使用 WebSocket（覆盖 S2 D21 SSE 决策）（← UA-14）
- API 契约延后，所有 API 调用位置用 TODO 标记，使用 mock 数据（← UA-14）
- 开发聚焦前端样式和显示效果，不实现后端逻辑（← UA-14）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 布局架构 | 三栏布局 | 双栏(左导航+中央) | 对话上下文(关键信息/参与者)需要常驻可见 |
| 左栏模式 | 仅对话列表 | 列表 + 对话树 panel 切换 | ← UA-8：用户明确不要两套展示模式，先保留列表 |
| 中央区域最大化 | 左右栏 flex-shrink-0 固定宽度，中央 flex-1 | 固定中央宽度 | ← UA-7：中央对话区是核心，必须够大 |
| 右栏可折叠 | 默认展开可收起 | 始终展开 | 小屏幕或专注对话时可释放空间 |
| Otter 管理形式 | 右栏面板 + 弹窗 | 独立页面 | Otter 管理是对话的上下文，不应离开对话 |
| 记忆搜索独立页面 | 顶栏 Tab 切换 | 对话内嵌搜索 | 搜索是跨对话的全局功能，不限定于当前对话 |
| 仿真用纯 HTML | HTML+CSS+JS | React storybook | 无需构建步骤，用户可直接在浏览器打开 |
| 仿真弹窗内嵌 | 弹窗嵌入页面文件 | 独立 modals.html 文件 | 弹窗在具体页面上下文中触发，独立文件无法体现触发场景 |
| 消息格式 | 基础 Markdown 渲染(MVP) | 纯文本 | LLM 回复天然含 markdown（代码块、列表、加粗），纯文本导致格式丢失，影响基础体验。MVP 使用 react-markdown 渲染 |
| 多 Otter 消息区分 | 头像边框色 + 名称色标签 | 仅名称文字 | 视觉快速区分不同 Otter，改善多 Otter 对话可读性 |
| 关键事实添加 | 行内表单 | 弹窗 | 操作轻量，行内展开比弹窗更快 |
| 链接资源添加 | 弹窗 | 行内表单 | 字段较多(type+url+title)，弹窗更合适 |
| 输入框 | 纯文本多行 + @提及 | 富文本 | MVP 最小实现，@提及支持多 Otter 交互 |
| 视觉风格 | Apple 玻璃风格 + otter 暖色系 | 纯白/冷灰 | ← UA-6：用户确认采用苹果玻璃风格。手写 CSS 玻璃工具类(backdrop-blur + saturate + 透明度)，不引入第三方库。调研结论：成熟库均为 v0.x 阶段，手写方案已达成 Apple 玻璃视觉效果且零依赖 |
| 玻璃质感实现 | 手写 CSS 工具类(.glass/.glass-strong/.glass-card/.glass-input) | @casoon/tailwindcss-glass / tw-glass / simple-liquid-glass | 调研结论：(1)标准玻璃拟态 Tailwind v4 内置 backdrop-blur 即可实现 (2)Apple Liquid Glass 需 SVG displacement maps 仅 Chromium 支持且库均为 v0.x (3)手写方案零依赖、零维护成本、已验证视觉效果 |
| 图标系统 | Lucide 线条图标 + 自定义 SVG 水獭 Logo | Emoji / Lucide paw-print | ← UA-10/UA-13：Lucide 用于功能图标，Logo 使用自定义 SVG 水獭头部（两耳+圆脸+眼鼻），不使用 emoji 或 paw-print |
| 顶栏内容 | Logo + 视图切换 Tab（无大獭状态） | Logo + Tab + 大獭状态 | ← UA-9：大獭是持久 Otter，"在线状态"始终为 true 无意义；实时状态由对话区流式指示器展示 |
| 仿真技术 | Tailwind CSS CDN + Lucide CDN | 手写 CSS / styles.css | ← UA-10：所有页面统一使用 Tailwind CDN + Lucide，确保顶栏全局一致。styles.css 废弃 |
| 消息数据结构 | 流式过程 + 最终答复(独立两部分) | 单一流式文本 | 参考 snail shell 模式，流式过程(可折叠 monospace 区块)与最终答复(Markdown 正文)视觉分离 |
| Session 模型 | 每个 Otter 独立 session chain | 每个对话一个 session | Session 是 Otter 个体属性，对话只是 Otter 交互的载体 |
| 页面架构 | MPA（多页面，URL 跳转） | 单 SPA（客户端路由） | ← UA-14：用户明确不要单 SPA。MPA 降低复杂度，对话界面单独 SPA + WebSocket，其他页面轻量独立 |
| 实时通信 | WebSocket | SSE (EventSource) | ← UA-14：用户明确指令覆盖 S2 D21。WebSocket 支持双向通信，适合未来 Otter 主动推送场景。SSE 仅单向 |
| 开发范围 | 仅前端，API 延后 + TODO | 全栈实现 | ← UA-14：用户明确聚焦前端样式和显示效果。API 契约后续单独设计 |
| 仿真 vs 实现 | 仿真为视觉蓝图，实现用 React+Tailwind+Hono | 仿真=实现（严格一一对应） | ← UA-14 修订：仿真页面定义视觉设计和组件结构，React 实现遵循但技术栈不同 |

## 改动范围 [required]

### 仿真页面（视觉设计参考）

| 文件 | 操作 | 说明 |
|------|------|------|
| `docs/ui-sim/index.html` | 已创建 | 对话视图仿真页面（Tailwind CDN + Lucide + 玻璃风格，自包含） |
| `docs/ui-sim/memory-search.html` | 需更新 | 记忆搜索仿真页面 - 需迁移到 Tailwind CDN + Lucide + 玻璃风格 |
| `docs/ui-sim/skills.html` | 需更新 | 能力库仿真页面 - 同上 |
| `docs/ui-sim/settings.html` | 需更新 | 设置仿真页面 - 同上 |
| `docs/ui-sim/styles.css` | 废弃 | ← UA-10：所有页面统一使用 Tailwind CDN |
| `docs/ui-sim/app.js` | 废弃 | 所有页面内联 JS |

### React 前端实现（← UA-14 开发范围）

| 文件/目录 | 操作 | 说明 |
|-----------|------|------|
| `web/` | 新增 | 前端项目根目录（Hono + React + Tailwind） |
| `web/server.ts` | 新增 | Hono 服务器入口，MPA 路由 |
| `web/pages/conversation/` | 新增 | 对话视图 SPA（WebSocket 实时消息） |
| `web/pages/memory/` | 新增 | 记忆搜索视图（独立页面） |
| `web/pages/skills/` | 新增 | 能力库视图（独立页面） |
| `web/pages/settings/` | 新增 | 设置视图（独立页面） |
| `web/components/` | 新增 | 共享 React 组件（TopBar、Modal、Toast 等） |
| `web/styles/` | 新增 | 共享样式（玻璃工具类、色彩变量） |

> **API TODO 标记**：所有 API 调用位置使用 `// TODO: API contract not yet defined` 标记，使用 mock 数据替代。API 契约后续单独设计。

## 验证 [required]

### UI 清单完整性

- [x] 覆盖全部 8 个核心用例的 UI 流程
- [x] 覆盖全部页面/视图（对话、搜索、能力、设置）
- [x] 覆盖全部弹窗（创建小獭、解散、重启獭生、Otter 详情、Session 历史、创建对话、创建子对话、链接资源）
- [x] 覆盖全部状态（空、加载、错误、流式、降级、未配置 LLM）
- [x] 覆盖全部操作（发送消息、@提及小獭、创建子对话、完成/归档对话、创建/解散小獭、重启獭生、搜索记忆、标记记忆、行内添加关键事实、弹窗添加链接资源、注册/加载/卸载 Skill、配置 LLM）

### 仿真页面验收

- [x] 所有页面可在浏览器直接打开（无构建步骤）
- [x] 所有按钮可点击，触发对应交互
- [x] 页面间可跳转（顶栏 Tab）
- [x] 弹窗可打开/关闭（在页面上下文中触发）
- [ ] 顶栏全局统一（所有页面 Lucide 图标 + Tailwind + 玻璃风格，无 emoji）— memory-search/skills/settings 需更新
- [x] 流式响应效果可演示
- [x] 多 Otter 消息视觉区分可演示
- [x] @提及功能可演示
- [x] 视觉效果与预期 React 实现一致（Tailwind class 可直接翻译）
- [x] 组件结构与 React 组件一一对应（对照组件层级映射表）

### 用户反馈迭代（ui2）

- [x] UA-6：玻璃质感调研完成，决策手写 CSS 玻璃工具类
- [x] UA-7：中央对话区最大化确认
- [x] UA-8：左栏移除树状视图，仅保留列表
- [x] UA-9：顶栏移除"大獭状态"
- [x] UA-10：顶栏全局统一要求写入硬约束
- [x] UA-11：玻璃效果可见性修复（背景色块 0.22-0.32 + 面板 0.32-0.42）
- [x] UA-12：顶栏 tabs 居中（flex-1 左右占位）
- [x] UA-13：Logo 替换为自定义 SVG 水獭头部图标
- [x] UA-14：开发范围、技术栈、MPA 架构、WebSocket 决策写入 Feature 文档
- [ ] memory-search/skills/settings 仿真页面更新（development 阶段执行）
- [ ] React 前端实现（development 阶段执行）

### 两位架构师共识

- [x] 架构师-1 独立分析并产出草稿
- [x] 架构师-2 对抗审视（11 项发现：3 阻断 + 5 应修复 + 3 次要）
- [x] 架构师-1 全部修复（F1-F11）
- [x] 架构师-2 验证通过
- [x] 双方确认设计方案可接受

### 用户确认

- [x] UI 清单确认（"可以"）
- [x] 仿真页面确认（"先这样吧"）
- [x] 布局决策确认（三栏布局、Otter 右栏管理、记忆搜索独立 Tab）
- [x] 布局迭代确认（← UA-8：移除对话树左栏切换，仅保留列表；← UA-9：移除顶栏"大獭状态"）
- [x] 消息数据结构确认（流式过程 + 最终答复分离、上下文窗口、时间戳、耗时）
- [x] Session 模型确认（每个 Otter 独立 session chain）
- [x] 视觉风格确认（otter 暖色系 + 浅色玻璃拟态 + Lucide 图标 + Tailwind）

## 关联 [required]

- **S1 产品形态定义**：[F20260709x7k3](../09/F20260709x7k3-product-form-definition.md)
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)
- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **infra LLM+Agent+Embedding**：[F20260713i5k2](./F20260713i5k2-infra-llm-agent-embedding.md)
- **domain/otter 设计**：[F20260713o4t8](./F20260713o4t8-domain-otter.md)
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)

## 核心业务行为 [required]

| # | 场景 | 预期 UI 行为 | 意图锚 |
|---|------|-------------|--------|
| B-UI-1 | 当用户在对话视图发送消息时 | 消息立即显示在消息流中，输入框清空，显示"大獭正在输入..."，随后流式显示回复 | ← S2 B1 |
| B-UI-2 | 当用户搜索历史记忆时 | 跳转记忆搜索视图，输入查询后显示结果列表，支持展开/细化/查找相似 | ← S2 B2 |
| B-UI-3 | 当大獭创建小獭时 | 右栏 Otter 参与者列表新增小獭卡片(带颜色标签)，对话中显示"小獭XX已加入"通知 | ← S2 B3a |
| B-UI-4 | 当用户触发重启獭生时 | 弹出确认弹窗，确认后显示"Session 已封存"，新 Session 开始 | ← S2 B4a, B4b |
| B-UI-5 | 当用户创建子对话时 | 弹出创建对话框，确认后左栏对话列表新增子对话项 | ← S2 B5a, UA-8 |
| B-UI-6 | 当 LLM 调用失败时 | 消息流中显示错误卡片，提供重试按钮，已生成部分保留 | ← S2 B14 |
| B-UI-7 | 当 WebSocket 连接断开时 | 顶部显示黄色提示条，自动重连，重连后恢复 | ← S2 B14, UA-14 |
| B-UI-8 | ~~已移除~~ 当用户查看对话树时 | ~~左栏切换为树视图~~（← UA-8：树状视图已移除，UC7 通过左栏列表切换对话实现） | ~~← S2 B12~~ |
| B-UI-9 | 当用户添加关键事实时 | 右栏行内表单展开，填写确认后关键事实列表实时新增条目 | ← S2 B8 |
| B-UI-10 | 当用户解散小獭时 | 弹出确认弹窗(含归档摘要)，确认后右栏小獭卡片移除，对话中显示"小獭XX已解散" | ← S2 B7a |
| B-UI-11 | 当 embedding 不可用时 | 记忆搜索视图显示降级提示"语义检索不可用" | ← S2 B-S3-2 |
| B-UI-12 | 当用户配置 LLM 时 | 设置视图提供 Provider/Model/API Key 输入，支持测试连接，保存反馈 Toast | ← S2 D20 |
| B-UI-13 | 当用户首次打开未配置 LLM 的应用时 | 对话视图中央显示引导卡片"请先配置 LLM"，带跳转设置按钮 | ← S2 D20 |
| B-UI-14 | 当多 Otter 对话中用户 @小獭名称时 | 输入 @ 触发 Otter 名称自动补全，选择后消息发送给指定小獭 | ← S2 B3a |
| B-UI-15 | 当外部系统操作自动关联资源时 | 右栏链接资源列表自动新增条目，显示"自动"标签 | ← S2 B6 |
