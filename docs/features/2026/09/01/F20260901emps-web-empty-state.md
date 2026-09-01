---
id: F20260901emps
title: "Web 页面空态治理：能力库真数据源 + 记忆搜索初始态内容（#576）"
summary: 用户 8/28 点名「能力库和记忆搜索页面内容都是空的，这不好」。诊断确认：能力库页数据源是 8/21 的静态快照（9/11 个 skill，随仓库演化过时）；记忆搜索页初始态只有引导文案。修复：新增 GET /api/skills（ResourceLoader 真相源）与 GET /api/memory/recent（最近记忆），两页打开即有真实内容，空态有显式文案，并补页面非空冒烟断言防回归。
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯 web/HTTP 数据链路修复，无 LLM 行为变更"
tags: [web, frontend, skills, memory, empty-state, api]
modules:
  - api-contract/api/skill.ts
  - api-contract/api/memory.ts
  - src/interface-adapters/http/controllers/skill-controller.ts
  - src/interface-adapters/http/controllers/memory-controller.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/controllers.ts
  - src/app.ts
  - src/usecases/memory/memory-repository.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - web/src/api/client.ts
  - web/src/pages/skills/
  - web/src/pages/memory/
  - tests/api/skills.test.ts
  - tests/api/memory.test.ts
---

# Web 页面空态治理：能力库真数据源 + 记忆搜索初始态内容（#576）

## 背景

2026-08-28 09:43 用户原话（memory 05099989，挑选 README 截图素材的上下文）：「能力库 和 记忆搜索 页面上内容其实都是空的，这不好；对话截图凑合吧」。README 改用对话截图（PR #550）只是素材层面的绕过，页面本身空态这个产品缺陷未进入任何工作流（daily-review 2026-08-29 立此 issue）。

## 诊断（先诊断后动手）

排查端到端数据链路（dist 产物 → API → 前端渲染条件）后确认**不是渲染条件 bug**，是**数据源问题**：

| 页面 | 诊断结论 | 证据 |
|---|---|---|
| 能力库 /skills | 数据源是组件内硬编码静态清单（9 个 skill + 分组），8/21 #372 引入后从未更新。仓库实际 11 个 skill（manifest 11 项、ResourceLoader 发现 11 个）。dist 产物 grep 证实：`skills-C2Hbdvaj.js` 只含 9 个 skill 名，缺 `post-merge-cleanup`、`stock-analysis`。**页面非空但内容过时失真**——「空」的体感来自内容与实际系统状态脱节 | `git log -- web/src/pages/skills/`；`grep -o` dist 产物 |
| 记忆搜索 /memory | 页面代码正常（初始态有引导文案、搜索链路完整），但**初始态没有任何数据**——必须先输入关键词才有内容。正常环境（有历史对话入库）下打开也是一片引导文案，用户感知即「空」 | `web/src/pages/memory/index.tsx` 初始态分支 |

**环境区分**：两个页面在运行环境正常的机器上也不是「渲染 bug 导致空白」，而是「无初始数据源」的产品设计缺口。据此修复方向定为**补数据链路**而非修渲染条件。

## 方案设计

### 1. 能力库：静态快照 → API 真数据源

- **后端**：新增 `GET /api/skills`（`SkillController` + `SkillDirectory` 端口）。数据源 = pi-agent `ResourceLoader.getSkills()`（app.ts 适配），与 otter 实际加载的 skill 集合一致——**页面所见即系统所载**。description 取自各 SKILL.md frontmatter（三段式契约摘要），比原静态清单的手写 desc 更完整。
- **前端**：挂载时 fetch；降级链 API 成功 → 真实清单（按内置分组归类，未识别的进「其他」）；API 失败 → 内置兜底清单 + 「离线兜底」标注；API 空数组 → 显式空态「未发现任何 skill」。
- **分组归类**：API 返回平铺列表，前端按内置分组顺序归类（`groupSkills`）。ResourceLoader 不提供分组信息（manifest.yaml 的注释分组是 lint 用的，不在运行时数据中），「其他」桶兜住新增 skill。

### 2. 记忆搜索：初始态补「最近记忆」

- **后端**：`MemoryRepository` 新增 `listRecent(limit)`（created_at DESC，`NOT LIKE '%\_chunk'` 过滤文档分段碎片——它们是检索素材不是可读内容）。新增 `GET /api/memory/recent?limit=10`（上限 50）。MemoryController 注入 repo（原构造只收 usecase）。
- **前端**：初始态（`results === null` 时）请求 recent 并渲染列表；点「展开上下文/查找相似」走既有 Modal 链路。recent 空 → 显式空态「暂无记忆数据」（区分于加载失败）；接口失败 → 静默降级回引导文案（搜索仍是主路径，不打扰）。
- **切正常搜索后不回退**：`results !== null` 后 recent 分支不再渲染。

## 变更清单

| 文件 | 变更 |
|---|---|
| `api-contract/api/skill.ts` | 新增：SkillItemDTO / SkillListDTO |
| `api-contract/api/memory.ts` | 新增 RecentMemoryDTO |
| `src/interface-adapters/http/controllers/skill-controller.ts` | 新增 SkillController + SkillDirectory 端口 |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 新增 recent 方法；构造注入 MemoryRepository |
| `src/interface-adapters/http/router.ts` | 注册 GET /api/skills、GET /api/memory/recent |
| `src/bootstrap/controllers.ts` | 装配 SkillController（可选注入）；MemoryController 传 repos.memory |
| `src/app.ts` | ResourceLoader → SkillDirectory 适配器（null 安全：warmup 前不注入） |
| `src/usecases/memory/memory-repository.ts` | 接口新增 listRecent |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | listRecent 实现（排除 chunk） |
| `web/src/api/client.ts` | 新增 getRecentMemory |
| `web/src/pages/skills/index.tsx` | 重写数据获取：fetch /api/skills + 降级链 + 空态；组件 export 化 |
| `web/src/pages/memory/index.tsx` | 初始态渲染最近记忆 + 空态；组件 export 化 |
| `tests/api/skills.test.ts` | 新增：/api/skills 契约测试（2 用例） |
| `tests/api/memory.test.ts` | 新增：/api/memory/recent 3 用例（DTO 形状/默认空/limit 上限） |
| `web/src/pages/skills/index.test.tsx` | 新增：页面非空冒烟断言（3 用例：真数据/降级/空态） |
| `web/src/pages/memory/index.test.tsx` | 新增：页面非空冒烟断言（3 用例：最近记忆/空态/降级） |
| `tests/api/helpers.ts` | memoryRepo / skillDirectory 可注入 |

## 验证

- server：`npx vitest run` 209 files / **2602 tests 全绿**（含新增 5）；`npx tsc --noEmit` 零错误
- web：`npx vitest run` 41 files / **341 tests 全绿**（含新增 6）；`npx tsc --noEmit` 零错误
- **已过最简实现检查**：skills 页曾考虑「后端读 manifest.yaml + SKILL.md 解析」自建读取器——放弃，因 ResourceLoader 已在运行时持有同一数据（避免第二真相源）；memory 页曾考虑「预置一个热门关键词自动搜索」——放弃，因 recent 列表无 query 依赖、语义更直（最新 ≠ 最相关），且不占检索配额。Modal 未引入 focus-trap 库（#510 另文，用 20 行模块级栈解决）。
- 冒烟断言即 issue 要求的防回归：skills 三态（真数据/离线降级/空态）、memory 三态（recent 数据/空态/降级）各有用例锁定，页面静默空白将直接测红。

## 本次变更对旧特性的记录

- **skills-page-under-construction（F20260821wckn，#372）**：其引入的「静态清单 + 建设中横幅」被本特性取代——横幅保留（管理功能仍未接入），静态清单降级为 API 失败时的兜底数据。历史文档不改（铁律），本文件即变更记录。
- **memory-web-capability-parity（F20260716szw8）**：无冲突。本特性不动搜索链路，只补初始态数据源；recent 端点复用其 DTO 体系（MemoryEntryDTO / toMemoryEntryDTO）。

## 取舍

- **ResourceLoader 而非 manifest.yaml**：manifest 只有结构化字段（next/not_for/category），description 真相源在 SKILL.md frontmatter——ResourceLoader 一次拿全，且保证与 otter 实际加载一致。代价：测试环境（无 ResourceLoader）路由不注册，前端走降级链——helpers 已按此设计。
- **recent 排除 chunk**：feature_chunk/research_chunk 是文档分段碎片，直接罗列对用户无意义还挤占 10 条限额。ESCAPE 转义 `\_` 防 `_chunk` 误匹配 `xchunk` 类 contentType。
- **memory 页降级静默**：skills 页降级有标注而 memory 页没有——skills 的兜底数据可能过时失真（必须标注），memory 的降级只是回到原引导文案（无失真风险）。
