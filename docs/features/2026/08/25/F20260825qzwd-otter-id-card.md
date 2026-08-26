---
id: F20260825qzwd
title: 海獭身份证·游戏角色面板
summary: |
  右栏海獭卡片升级为游戏角色面板：hover 出快览卡（形象/称号/等级/武器），点击详情弹窗扩展装备区（武器=modelAlias+模型描述、技能槽=skills 清单、工具袋=注册工具分组、心法=systemPrompt 折叠展示）+ 战绩统计 + 转世履历。全字段映射真实数据源（等级=世数、EXP=发言×1+产物×10 可拆解、称号规则化派生），新增聚合端点 GET /api/otters/:id/profile + sender_id 索引。kimi 出主稿、mimo 对抗深化、大獭核验（反转发现1：modelAlias 链路 PR #445 已建）。
change_type: feature
status: draft
capability_test: "n/a: 展示层特性，方案阶段"
created_in_conversation: d1ac0eee-6e02-469e-af1b-dd4d8c30fe3e
---

# 海獭身份证·游戏角色面板

## 背景与需求

搭档原话（意图锚）：

> 「我想看到每只海獭的"身份证"，有点类似于游戏里面，每一个角色的"面板"，有个形象，然后名称/等级/身上的装备/称号等这些，那海獭们是不是也可以有，比如鼠标移到右侧海獭栏时，可以显示出每一只海獭的这个"面板"，内容则可以系统提示词/skill列表/tool列表 等等属性。既有趣，又能让我感知到和我交互的海獭们当前的能力和状态。」

背景：项目代码都是 AI 写的，搭档不完全清楚细节；搭档日常面对的是海獭，需要直观感知每只海獭的能力和状态。

设计立场（大獭声明）：**面板是"感知真实能力状态"的工具，游戏化是表达形式**。所有游戏化字段必须映射真实数据（回答得了"从哪张表/哪个 API 来"），不硬造假数值——不然面板好看但骗人。

产出的协作模式：kimi-面板设计师出主稿（信息架构/字段映射/交互/数据链路）→ mimo-面板工程师核实悬置点 + 对抗审视 + 技术深化 → 大獭核验 8 条发现（其中发现 1 反转）→ 本文档定稿。

## 目标

- T1: 右栏海獭卡片 hover 出现快览面板（形象/称号/等级/武器），点击详情弹窗升级为全量游戏面板（装备区：武器/技能/工具/心法 + 战绩统计 + 转世履历）
- T2: 全部面板字段映射真实数据源，无假数据，缺失数据如实省略（不留空占位）
- T3: 游戏化表达（等级/经验条/称号/装备隐喻）让非技术视角的搭档能直观感知海獭能力与状态差异

## 非目标

- 不做面板内交互操作（点击技能查看详情页、跳转 /skills 页）——面板只读
- 不做 per-獭 skills/tools 定制（当前所有獭 skills 相同、tools 相同，差异在 systemPrompt 与 modelAlias——如实呈现）
- 不做等级/EXP 的升级逻辑或游戏机制（进度条纯视觉，无升级触发）
- 不做对外投影脱敏（Web 前端本地可信，systemPrompt 原文展示；不进任何对外接口）
- 不做移动端全屏抽屉（PR-3 范围，视前两期效果决定是否做）

## 方案设计

### D1. 面板信息架构（kimi 主稿 §1，经审视保留）

分两层：**hover 快览卡（瞄一眼）→ 点击详情弹窗（细看）**。架构一致、密度不同，hover 卡是详情弹窗的真子集。详情弹窗复用现有 `OtterDetailModal` 扩建，不新建并行组件。

```
┌─────────────────────────────────────────┐
│ 【形象区】头像(48px+类型色环) + 名称 + 称号徽章行 │
├──────────────────┬──────────────────────┤
│ 【属性区】        │ 【状态区】            │
│ 等级/类型/模型    │ 在线状态/当前世/当前任务│
├──────────────────┴──────────────────────┤
│ 【装备区】武器(modelAlias) / 技能槽(skills)│
│  / 工具袋(tools) / 心法(systemPrompt)     │
├─────────────────────────────────────────┤
│ 【历练区】转世履历(Session Chain) + 统计行 │
└─────────────────────────────────────────┴─┘
```

#### 形象区
| 元素 | 设计 | 数据源 | 缺失表现 |
|---|---|---|---|
| 头像 | 48px `OtterAvatar`（现有组件），大獭 otter-400 色环 / 小獭 stone 色环 | otterId 渐变（恒有） | 永不缺失 |
| 名称 | 大号字 | `otters.name` | 永不缺失 |
| 称号徽章行 | chips 横排，最多 3 枚，超出 +N | 规则化派生（见 D3） | 无徽章不渲染整行 |

#### 属性区
| 字段 | 游戏化表达 | 数据源 |
|---|---|---|---|
| 类型 | 大獭「族群长老」/ 小獭「任务专员」 | `otters.type` |
| 等级 | `Lv.N`，N=世数（拉链位置口径，与现有详情弹窗一致） | session chain（现有） |
| 角色 | 小獭显示 role.name | `otters.role_name`（现有） |

#### 状态区
| 字段 | 表达 | 数据源 |
|---|---|---|---|---|
| 在线状态 | 🟢 活跃 / 💤 休眠 / 🪦 已解散 | active session 存在性 + `otters.status`（现有） |
| 本世启程 | "第 N 世 · 始于 08-25 14:30" | sessions（现有） |
| 当前任务 | streaming/processing 时"正在工作中…" | conversation `activityStatus`（现有） |

#### 装备区（核心新增）
四个装备槽，**有则渲染无则省略**：

| 槽位 | 游戏名 | 内容 | 展示策略 |
|---|---|---|---|
| ⚔️ 武器 | 驱动模型 | modelAlias + ModelPool 描述/强项 | alias + 强项 chips |
| ✨ 技能槽 | skills | `.pi/skills` 发现的清单 | chips 云，hover 出 description |
| 🎒 工具袋 | tools | 注册工具全集，按类别分组 | 默认折叠"26 件"，展开分组列表，标注"部分按獭类型门控" |
| 📜 心法 | systemPrompt | 小獭任务书原文 | 默认折叠，展开后等宽字体+限高滚动+约 N 字 |

#### 历练区
现有 Session Chain 保留，改名「转世履历」，加统计行："累计 N 世 · 发言 X 条 · 产出 Y 件"。

### D2. hover 快览卡 vs 详情弹窗（kimi §3 + mimo 发现 6/7 修订）

**hover 卡（~280px，玻璃拟态，向左弹出避免右栏溢出）**：
- 触发：悬停 ≥400ms，`useRef + clearTimeout` 手写 debounce，快速滑过不触发
- 触屏降级：`matchMedia('(hover: hover)')` 判定，触屏不注册 hover 监听，路径=点击开弹窗（与现状一致，零回归）
- 内容：头像(36px)+名称+称号(≤2枚)+Lv.N+类型+在线状态点+武器行(modelAlias)
- 不拦截点击——点击仍开详情弹窗
- **数据：全来自现有 props**（sessions/type/name），modelAlias 来自 ParticipantDTO 扩展（PR #445 已建链路，见 D5 依赖）

**详情弹窗（580px 不变，扩展现有 OtterDetailModal）**：
- 顶部形象区 + 中部装备四槽 + 属性区 + 底部转世履历
- open 时 useEffect 拉取 profile，加载期间装备区 skeleton（animate-pulse，沿用项目惯例）
- footer 操作按钮（重启/解散）不动

### D2.1 属性本质说明体系（? 图标，搭档 2026-08-25 追加需求）

搭档原话：「我期望面板上加个问号图标，然后用户点击时会显示这些属性的本质内容是什么，这问号应该也是常见的一种说明方案」。

**统一说明交互**：面板每个属性/装备槽标题右侧加 Lucide `HelpCircle` 小图标（14px，text-stone-400），**点击**（非 hover——触屏友好）弹出说明气泡（popover），再点图标或点外部关闭。说明内容 = 该属性的「本质」：它是什么、怎么算的、数据从哪来。归拢此前零散的 tooltip 设计（EXP 公式、心法语义）到同一交互模式，不再用原生 title tooltip 承载长文本。

说明文案表（实现时进前端常量，与 mockup 同源）：

| 属性 | 说明文案要点 |
|---|---|
| 等级 Lv.N | 等级 = 世数：海獭每次重启獭生（session 封存重开）+1。资历指标，非游戏升级 |
| EXP 经验条 | 经验 = 发言段数 ×1 + 产物数 ×10。纯活跃度参考，不触发任何升级；权重为展示层常量 |
| 称号徽章 | 由规则自动派生：族群长老=大獭；N 世轮回=世数≥3；高产=产出≥10；无满足则不显示 |
| ⚔️ 武器 | 驱动这只海獭的底层模型，来自创建时的 modelAlias 配置，未指定时用默认模型 |
| ✨ 技能槽 | 从 .pi/skills 目录发现的流程能力，当前全族群共享同一套；个体差异在武器与心法 |
| 🎒 工具袋 | 运行时注册的工具全集；部分工具按獭类型/大獭身份门控（注册全量≠都能用） |
| 📜 心法 | 海獭级系统提示词（任务书）。实际生效 prompt 为三层叠加：平台 base + 本心法 + 身份注入；本槽只展示中间层 |
| 战绩统计 | 发言=消息段数（一段 speak 计 1）；产出=名下链接资源数；对话=参与过的对话数。点开弹窗时实时查询 |

**设计原则**：? 说明的文案与映射表（D3）同源维护——映射表是给开发者的事实源，? 文案是给搭档的翻译层，两者不得矛盾；改映射必须同步改文案。

### D3. 游戏化字段映射表（kimi §2 + mimo 发现 2/5 修订）

| 游戏概念 | 映射真实数据 | 数据来源 | 链路状态 | 缺失/降级 |
|---|---|---|---|---|
| 等级 Lv.N | 当前世数 | session chain | 已有 | 恒有 |
| EXP 经验条 | 发言数×1 + 产物数×10（前端常量权重，? 说明明示公式，见 D2.1） | message_segments COUNT + linked_resources COUNT | **需新增** | 查询失败/为0 → 只留 Lv.N 不渲染条 |
| 称号徽章 | ①族群长老=big ②N世轮回=世数≥3 ③高产=产物≥10 ④角色名 | 派生计算 | 依赖统计 | 不满足不渲染 |
| 武器·模型 | modelAlias + 描述/强项 | `otter_configs.model_alias` → ModelPool | **PR #445 已建** | 无 alias 显示 default alias（identity-builder 同口径） |
| 技能槽 | skills 清单 | `ResourceLoader.getSkills()` | **需新增暴露** | 空表不渲染 |
| 工具袋 | 工具元数据 | `createTools()` 静态目录 | **需新增** | 恒有 |
| 心法 | `otter_configs.system_prompt`（仅 otter 级，不含身份注入，? 说明注明三层叠加，见 D2.1） | 已在库 | **需 HTTP 暴露** | 大獭常无 → 槽位不渲染（正常态非异常） |
| 在线/履历 | — | 现有链路 | 已有 | — |
| 战绩统计 | 发言数（**message_segments 口径**，mimo 发现 5）/ 产物数 / 参与对话数 | 三条 COUNT | **需新增** | 为0显示0（真实信息） |

### D4. 聚合端点（kimi §4 + mimo 发现 4/7/8 修订）

**`GET /api/otters/:id/profile`**（一次请求全量装备，详情弹窗专用；hover 卡不走此端点）

```ts
interface OtterProfileDTO {
  id: string; name: string; type: 'big' | 'small'; roleName: string | null
  modelAlias: string | null
  modelDescriptor: { alias: string; description?: string; strengths?: string[]; contextWindow?: number } | null
  systemPrompt: string | null   // 仅 otter 级；前端标注"不含平台 base 与身份注入"
  skills: Array<{ name: string; description: string; category: string }>
  tools: Array<{ name: string; description: string; group?: string }>
  stats: { messageCount: number; artifactCount: number; conversationCount: number }
}
```

要点：
- **skills/tools 子项失败隔离**（mimo 发现 4）：use case 内 try-catch，任一子源失败返回该子项 null 而非整体 500
- **已解散 otter → 404**（mimo 发现 8）：use case 开头检查 otter 状态，不让异常冒泡
- **stats 走索引**（mimo 发现 3）：新增 `idx_messages_sender_id ON messages(sender_id)`——**schema 字段消费方声明**：profile 接口 stats.messageCount（及未来任何按发言人聚合的查询）读取此索引，非"先存了再说"
- systemPrompt 安全边界：仅返回给 Web 前端（本地可信），不进任何对外投影

### D5. 依赖与排序（大獭核验后修订）

**硬依赖**：PR #445（F20260825vrqh，已建 OPEN）已把 modelAlias 加进 ParticipantDTO/OtterDTO 且全链路打通。本特性的 hover 卡"武器"字段依赖它。

mimo 发现 1（"modelAlias 不在 DTO、零新接口不成立"）在 main 快照上正确，但**未察觉并行 PR**——大獭核验后反转：#445 合入后 hover 卡"零新接口"成立。教训：对抗审视的上下文隔离是双刃剑——审阅者无立场但也不知并行工作，发现需作者/编排者核验后处置。

### D6. 分期

| 期 | 范围 | 依赖 |
|---|---|---|
| PR-1 | 后端 ParticipantDTO modelAlias（若 #445 已合入则跳过）+ 前端 hover 快览卡 + 详情弹窗形象区/称号/等级 | #445 |
| PR-2 | profile 聚合端点 + 装备四槽 + 战绩统计 + sender_id 索引 | PR-1 |
| PR-3 | 移动端全屏抽屉、EXP 动效、徽章规则调优 | PR-2 |

## 影响范围

- 右栏 OtterParticipantCard：加 hover 事件（不拦截点击）
- 详情弹窗 OtterDetailModal：扩建（复用不新建）
- 后端新增 profile 链路（usecase/controller/DTO/bootstrap 装配 4 处）
- messages 表加 sender_id 索引（新写库时生效；存量库靠 migration.ts 惯例补齐）
- 不改任何现有 API 响应结构（纯新增端点 + 可选字段）

## 风险与约束

| 风险 | 对策 |
|---|---|
| systemPrompt 很长（几千 token） | 默认折叠 + 限高滚动 + 字数估算 |
| 大獭无 systemPrompt 被误读为"没有心法" | tooltip 说明"身份由 identity-builder 注入"（kimi 发现 2 采纳） |
| skills 全局相同、装备雷同感 | 文案化解（"族群共享心法库"），视觉重心放在武器（modelAlias）与心法（systemPrompt）——真正的个体差异所在 |
| EXP 人为权重的黑盒感 | tooltip 明示公式，权重前端常量可调 |

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| hover 卡数据来源 | 现有 props + modelAlias（#445） | hover 时发请求 | hover 高频，不适合带请求；点击才拉全量 |
| 聚合端点 vs 拆分 | 聚合 + 子项隔离 | 拆三个端点 | 单机 SQLite 规模下一次请求更简；子项 try-catch 防止单点拖垮 |
| tools 元数据抽表 | **不抽**（mimo ②），静态维护 TOOL_DISPLAY_CATALOG | 抽 TOOL_CATALOG 让 factory 从表注册 | execute 闭包必须留 factory，抽表多一层间接无净收益；hover 卡只需静态元数据 |
| 装备差异呈现 | 如实呈现全局相同 | 伪造 per-獭定制 | 设计立场：不造假数据 |
| EXP 升级逻辑 | 纯视觉进度条 | 真实升级机制 | 非目标，避免过度游戏化 |

## 验证

- 接口测试：正常返回 / 大獭（systemPrompt 空、skills 非空）/ 小獭（modelAlias null）/ 已解散 404 / 不存在 404
- 前端组件测试：hover 400ms 显示+移出消失+触屏不触发 / 装备槽条件渲染 / stats 为 0 显示
- 手动验收：搭档 hover 每只獭看快览卡、点开大獭和小獭详情对比装备差异

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| api-contract/api/otter.ts | 修改 | 新增 OtterProfileDTO |
| src/usecases/otter/query-otter-profile.ts | 新增 | 聚合 use case（config/model/skills/tools/stats + 子项隔离 + 404） |
| src/interface-adapters/http/controllers/otter-controller.ts | 修改 | 新增 getProfile() |
| src/interface-adapters/http/router.ts | 修改 | 注册 GET /api/otters/:id/profile |
| src/bootstrap/usecases.ts / controllers.ts / types.ts | 修改 | 装配透传（含 ResourceLoader 注入链路） |
| src/frameworks/db/schema.ts + migration.ts | 修改 | idx_messages_sender_id 索引 |
| web/src/components/OtterProfileCard.tsx | 新增 | hover 快览卡组件 |
| web/src/pages/conversation/Modals.tsx | 修改 | OtterDetailModal 扩装备区/形象区/统计行 |
| web/src/pages/conversation/RightPanel.tsx | 修改 | OtterParticipantCard 挂 hover 逻辑 |
| web/src/api/client.ts | 修改 | fetchOtterProfile() |
| tests/api/otter.test.ts | 修改 | profile 端点测试 |

## 对抗审视决策史（本方案文档）

本方案经历一轮异模型对抗审视（kimi 出稿 → mimo 审视，异模型）。

### 审视发现处置记录

| # | 发现 | 级别 | 处置 | 判断（更好/更差） |
|---|---|---|---|---|
| 1 | modelAlias 不在 DTO，"零新接口"不成立 | 严重 | **反驳（附证据）**：PR #445 已建链路，mimo 看 main 无此信息 | 反驳成立——依赖声明从"需新增"改为"#445 已建"，PR-1 排序调整 |
| 2 | systemPrompt 三层叠加语义差异 | 严重 | 接受并修订：心法槽标注"仅 otter 级" + tooltip 说明 | 更好——消除"大獭没心法"误读 |
| 3 | stats 缺 sender_id 索引 | 严重 | 接受并修订：PR-2 加索引 | 更好——COUNT 走全表扫描是真实性能风险 |
| 4 | 聚合端点单点风险 | 建议 | 部分接受：保留聚合 + 子项 try-catch 隔离 | 更好——保留一次请求的简洁，隔离单点故障 |
| 5 | EXP 发言数口径模糊 | 建议 | 接受：明确 message_segments 口径 | 更好——多段 speak 计数更准 |
| 6 | hover 卡 400ms 需 debounce | 建议 | 接受：useRef+clearTimeout 手写 debounce | 更好——快速滑过不误触 |
| 7 | 大獭无 config 行行为未定义 | 建议 | 接受：隐藏槽位而非显示"未知" | 更好——正常态不该暗示异常 |
| 8 | 并发解散中 404 | 建议 | 接受：use case 检查状态 | 更好——明确错误码 |
| 9 | 悬置点① 装配链路 | 核实 | 采纳 mimo 方案：ResourceLoader 注入 ControllerDeps | — |
| 10 | 悬置点② TOOL_CATALOG 抽表 | 核实 | 采纳 mimo 结论：不抽表，静态目录 | — |
| 11 | （搭档追加）? 图标点击显示属性本质说明 | 需求 | 接受并纳入 D2.1：统一说明交互，归拢 EXP 公式/心法语义等零散 tooltip | 更好——触屏友好（点击优于 hover），文案与映射表同源防漂移 |

## 特性文档验证

### 2026-08-25 方案定稿（大獭）

- kimi 主稿 v1 → mimo 技术深化+对抗审视 → 大獭核验 8 条发现（1 条反转）→ 本文档
- 状态：方案定稿，待搭档终审后进入实现阶段（PR-1 → PR-2 → PR-3）

### 2026-08-26 PR-3 delta 处置（mimo-面板工程师）

**kimi 审视处置（3 严重 + 4 建议）**：

| # | 发现 | 级别 | 处置 |
|---|---|---|---|
| S1 | 假时序测试（纯函数未引用实现） | 严重 | 接受修复：重写为 @testing-library/react 组件级测试，渲染真实 RightPanel |
| S2 | 降级理由不成立（裸 createRoot 问题非 React 19 已知缺陷） | 严重 | 接受修复：移除错误降级注释，改用 fireEvent + act 方案 |
| S3 | EXP 首开动画被 React 批处理合并 | 严重 | 接受修复：rAF 方案改为 CSS @keyframes scaleX 方案 |
| A1 | 满格后数值无说明 | 建议 | 接受：exp > 100 时显示“（满格）” |
| A2 | !important 六连 | 建议 | 接受：样式移入 globals.css，移除内联 style 标签 |
| A3 | iOS 安全区 footer 危险按钮 | 建议 | 接受：添加 modal-fs-footer + env(safe-area-inset-bottom) |
| A4 | PR-2 遗留 lint warning 顺手修 | 建议 | 接受：提取 otterId 变量消除 exhaustive-deps 警告 |

**变更文件**：
- `web/src/styles/globals.css` — 新增 .exp-fill 动画 + .modal-fs-mobile 全屏抽屉 + .modal-fs-footer iOS 安全区
- `web/src/components/Modal.tsx` — 移除内联 style 标签，footer 加 modal-fs-footer class
- `web/src/pages/conversation/Modals.tsx` — EXP rAF→CSS animation，提取 otterId 修 lint warning，加“（满格）”溢出说明
- `web/src/components/OtterProfileCard.test.tsx` — 纯函数测试→@testing-library/react 组件级测试（3 debounce + 4 渲染）

**测试结果**：
- Web 测试：21 文件 / 172 测试全绿（原 174 → 纯函数 5 测试替换为组件级 3 测试）
- 后端测试：136 文件 / 1633 测试全绿
- Build：通过（tsc + vite build）
- Lint：0 errors，0 warnings（PR-2 遗留 warning 已修）
