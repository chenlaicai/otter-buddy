---
id: F20260805dmux
title: otter-detail-modal-ux
doc_type: feature

summary: |
  修复 Otter 详情弹窗灰底灰字对比度失效与信息架构缺陷（空字段噪音、缺 session id）。
  根因：L3 弹层 token 不透明度仅 53–66% 且正文误用次级文字色，7 列宽表对必然为空的字段用「-」填充。
  主机制：提高 --overlay-bg 不透明度并解除 glass-t 联动；Session Chain 宽表改卡片式块、空字段不渲染、展示可复制 session id；同步清理「反面案例」非中性残留（术语库定义 + 弹窗「反面」列）。

causal_links:
  from:
    - F20260805rsto   # Session Chain 链式化与文案中性化决定的上游
    - F20260724glas   # 玻璃材质 4 层级体系的上游（本 PR 改写其 L3「最透」假设，见对抗审视 A1）
  to:
    - F20260806ovgl   # L3 弹层「近实底」实现被本特性改写为磨砂玻璃+色染（对比度目标保留）

status: development
change_type: fix
tags: [web, ux, otter, terminology]
modules:
  - web/src/pages/conversation/Modals.tsx
  - web/src/pages/conversation/RightPanel.tsx
  - web/src/lib/session-chain.ts
  - web/src/styles/globals.css
  - data/terminology/seed-terminology.json
---

# F20260805dmux: Otter 详情弹窗对比度与信息架构修复

## 背景与根因

2026-08-05 用户点击右侧栏大獭打开详情弹窗，反馈两点：字体灰、底色也灰，看不清；展示字段大量为空，且没有 session id 这类关键定位信息。

### 根因 1：对比度三层叠加失效

1. **弹层底色太透**：`--overlay-bg`（globals.css）定义为 `78%/62% × --glass-t(0.85)`，实际不透明度仅 66%/53%，40px 毛玻璃把下层聊天区灰色渗入，弹窗整体发灰。
2. **正文误用次级文字色**：Session Chain 表格数据全部 `text-stone-600`、标签 `text-stone-500`，stone-500/600 的设计语义是辅助信息，却承载了主要数据。
3. **分隔线隐形**：`border-white/30`、`border-white/20` 在半透暖白底上对比度极低，表格结构散架。

### 根因 2：信息架构缺陷

- 7 列宽表（世/状态/开始/归档/原因/反面/摘要）塞进 580px 弹窗；对 active session 而言归档时间、归档原因**必然为空**，用「-」填充制造视觉噪音；摘要列被挤压不可读。
- 缺少 session id——排查问题、关联日志时唯一可操作的定位信息。
- 「已加载能力」区块渲染 `mockSkills` 假数据，展示比没有更误导。

### 根因 3：「反面案例」非中性残留（F20260805rsto 决定未扫尾）

F20260805rsto 已决定**文案中性化**：重启不一定因为前世失败（也可能是 session 自身异常需重开），不预设反面；`isNegativeCase` 字段保留。但排查发现两处残留：

1. `data/terminology/seed-terminology.json` seed-004「重启獭生」定义仍是「搭档表达不满时触发…封存为反面案例」——术语库是 agent 可查的定义源，错误定义会持续向 LLM 输出过时框架。
2. 详情弹窗 Session Chain 表仍有「反面」列——且 `isNegativeCase` 全链路恒为 false（restart/dissolve 均硬编码 false），列值恒为「-」，是死展示。

另：「第 N 世」术语由 F20260805rsto 引入（对齐右栏「Session #N」），但未注册进术语库，违反术语改动全局排查约定。

## 修复方案

### 对比度（token 级）

- `--overlay-bg` 提到 `96%/93%` 固定不透明度，解除与 `--glass-t` 的联动降透——L3 弹层承载正文阅读，是最高层级，不该被全局透明度拉灰。低透明偏好媒体查询中的实色回退不变。
- 基本信息正文字色 `text-stone-700` → `text-stone-800`。

### Session Chain 宽表 → 卡片块（Modals.tsx OtterDetailModal）

- 每世一个卡片：标题行 = 第N世 + 状态 badge + **session id**（等宽字体短显、title 全量、点击复制带 ✓ 反馈）。
- **空字段不渲染**（归档时间/归档原因/摘要有才显示），取代「-」填充。
- active 世用 otter 色边框+底色突出；摘要独占一块完整显示。
- 移除「已加载能力」mock 区块（创建小獭弹窗的 mock 选择器未动）。
- 「角色」「职责列表」为空时整块隐藏。

### 中性化扫尾

- seed-004「重启獭生」定义改为中性表述，`context` 字段记录旧定义已废弃（新旧映射）。
- 新增 seed-011「世」条目（aliases 含「第N世」「前世」「Session #N」），把 F20260805rsto 引入的术语补登记进术语库，并写明计数口径（拉链位置）。
- 移除详情弹窗 Session Chain 的「反面」列（死展示；`isNegativeCase` 字段在数据模型中保留，未来有真实设置方时再恢复展示）。

### 「第 N 世」计数口径统一（对抗审视 C3）

- 右栏卡片原用 `sessions.length` 当世数、详情弹窗用拉链排序 index，竞态残留/多分支场景两界面会对不上。
- 提取共享函数 `sortSessionChain`（web/src/lib/session-chain.ts），右栏改为 active session 的拉链位置，两界面同口径。

### 明确不动

- `docs/ui-sim/`（静态原型）中的旧文案——不随产品运行的设计稿，不在本次扫尾范围。
- `isNegativeCase` 字段本身及 DB 列——F20260805rsto 已决定保留。

## 验证

- `web/` 下 `npx tsc --noEmit` 通过。
- 术语库 syncSeed 机制（seed-terminology.ts）每次启动比对差异新增/更新，seed JSON 修改随下次启动同步存量库。

## 对抗审视记录

2026-08-05 PR #157 一轮独立 agent 对抗检视：**无 P0，1 P1，5 P2**。用户逐题拍板，处理结果如下。

| 级别 | 条目 | 拍板与处理 |
|------|------|-----------|
| P1 C3 | 右栏 `sessions.length` vs 弹窗拉链 index，「第N世」口径不一致（rsto 遗留，本 PR 登记术语时固化） | 修：提取 `sortSessionChain` 共享，右栏统一为拉链位置；seed-011 定义写明口径 |
| P2 A1 | `--overlay-bg` 全局 L3 token 改动影响右键菜单/自动补全，缺 F20260724glas 溯源 | 修：causal_links 补 F20260724glas；功能无破坏（梯度仍单调，菜单/补全同为阅读场景，对比度提升为改善） |
| P2 A2 | globals.css glass-t 注释仍称「各层 token 用 calc 按系数缩放」，与现实不符 | 修：注释补充 L3 例外说明 |
| P2 B2 | 复制按钮在 writeText resolve 前打勾（反馈脱钩），非安全上下文同步抛错 | 修：✓ 挂 `.then()`，加 `.catch` 与 `navigator.clipboard` 存在性守卫 |
| P2 C4 | seed-011 插入位置破坏 id 升序 | 修：移到数组末尾 |
| P2 D2 | 文档「badge」措辞混淆新旧组件（旧 UI 是表格「反面」列） | 修：文档措辞订正 |

确认无问题的核查项（agent 已验证）：hooks 顺序合法；拉链逻辑逐字节不变；「已加载能力」为恒空 mock 删除无误伤；`isNegativeCase` 无任何生产路径置 true；中性化全仓扫净（剩余命中均为历史决策文档/静态原型/测试夹具）；syncSeed 按 term 匹配更新存量库属实；tsc 与 80 个 web 测试通过。

### 二轮对抗检视（2026-08-05，独立 agent）

**无 P0、无 P1**；一轮修复经独立重验（实跑 tsc + 测试 + 全仓 grep）全部修对。新增 P2 按用户拍板处理：

| 条目 | 处理 |
|------|------|
| `sortSessionChain` 对 previousSessionId undefined 化无防御（首世静默丢失） | 修：`?? null` 归一化 + 单测锁定 |
| seed-011 定义/JSDoc 未说明残留项按拉取序（时间倒序）附链尾、位置不代表代际 | 修：定义与 JSDoc 各补一句 |
| `sortSessionChain` 无单测，承载被术语库引用的世数口径契约 | 修：补 7 个用例（拉链序/残留/同 prev 分支/空数组/首世缺失/undefined 归一化/引用相等） |
| 非安全上下文复制按钮静默无反馈 | 修：降级 `execCommand('copy')`，成功才打勾；双失败仍静默（title 含全量 id 可手动复制） |
| RightPanel 每渲染 O(n²) 排序 | 不修：每獭 session 数个位，备注备查 |

二轮独立重验确认：sortSessionChain 与旧 IIFE 逻辑等价、复用原对象引用（indexOf 不可能 -1，「第0世」不可达）；previousSessionId 全链路 `string | null` 无 undefined 路径；F 文档一轮「确认无问题」声明逐条属实。
