---
id: F20260805dmux
title: otter-detail-modal-ux
doc_type: feature

summary: |
  修复 Otter 详情弹窗灰底灰字对比度失效与信息架构缺陷（空字段噪音、缺 session id）。
  根因：L3 弹层 token 不透明度仅 53–66% 且正文误用次级文字色，7 列宽表对必然为空的字段用「-」填充。
  主机制：提高 --overlay-bg 不透明度并解除 glass-t 联动；Session Chain 宽表改卡片式块、空字段不渲染、展示可复制 session id；同步清理「反面案例」非中性残留（术语库定义 + 弹窗 badge）。

causal_links:
  from:
    - F20260805rsto   # Session Chain 链式化与文案中性化决定的上游
  to: []

status: development
change_type: fix
tags: [web, ux, otter, terminology]
modules:
  - web/src/pages/conversation/Modals.tsx
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
2. 详情弹窗仍展示「反面案例」标记——且 `isNegativeCase` 全链路恒为 false（restart/dissolve 均硬编码 false），是永不显示的死展示。

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
- 新增 seed-011「世」条目（aliases 含「第N世」「前世」「Session #N」），把 F20260805rsto 引入的术语补登记进术语库。
- 移除详情弹窗「反面案例」badge（死展示；`isNegativeCase` 字段在数据模型中保留，未来有真实设置方时再恢复展示）。

### 明确不动

- `docs/ui-sim/`（静态原型）中的旧文案——不随产品运行的设计稿，不在本次扫尾范围。
- `isNegativeCase` 字段本身及 DB 列——F20260805rsto 已决定保留。

## 验证

- `web/` 下 `npx tsc --noEmit` 通过。
- 术语库 syncSeed 机制（seed-terminology.ts）每次启动比对差异新增/更新，seed JSON 修改随下次启动同步存量库。

## 对抗审视记录

（PR 评审后回写）
