---
id: F20260929scfx
title: 能力库全书——skill 正文全文 + 系统提示词分节 + 工具清单三编展示
summary: 能力库页面从 14 条 frontmatter 摘要升级为三编全书：卷首 SYSTEM.md 心法总纲分节续页、卷中 skill 正文全文装箱分页、卷末工具清单紧凑排版，并修复第N门序号与页序不一致。
status: implemented
created: 2026-09-29
created_in_conversation: 9eeb7b69-26d5-4957-b7f2-9f7fd5a00d77
modification_class: narrow-fix
related: [F20260901emps, F20260924uxrc]
---

# 能力库全书（F20260929scfx）

## 背景

能力库页面（`web/src/pages/skills/index.tsx`，F20260924uxrc 双页摊开秘籍书）原先只展示 14 个 skill 的 frontmatter description 摘要（数据源 `GET /api/skills`，仅取 `ResourceLoader.getSkills()` 的 name+description）。后果：页数少（10 摊开）、每页下半空白、目录「第N门」序号按 API 数组序与翻页顺序不一致、右页几乎只有 skill 名一个大字。搭档明确要求：展示系统提示词全文 + skill 正文全文 + tool 清单，填满页面（对话 9eeb7b69 拍板方案）。

## 目标

- 卷首·心法总纲：`/api/prompts` 的 system sections（SYSTEM.md 按 `## ` 切分），每 section 一页起、过长自动续页
- 卷中·招式秘籍：skill 正文全文进正文区，过长自动续页；五章流派分组保留
- 卷末·兵器谱：tools 清单紧凑列表排版，自动分页
- 序号修复：「第N门」按书页实际顺序编号，目录页与各章秘籍页同口径

## 方案（已拍板，未变更范围）

### 后端

1. **SkillDirectory 扩展 body**：`SkillController` 端口加 `body?: string`；`app.ts` 适配器按约定路径 `<repoRoot>/.pi/skills/<name>/SKILL.md` 读 frontmatter 后正文（`readSkillBody`）。ResourceLoader 返回的 skill 对象无 filePath，走约定路径；读失败降级 `body=''` 不报错。
2. **新增 `GET /api/prompts`**（`PromptController`，挂 `router.ts` + `bootstrap/controllers.ts`）：
   - `system`: 读 `.pi/SYSTEM.md`，`stripFrontmatter` 后按 `## ` 二级标题切分 `[{title, content}]`（`readSystemSections`）
   - `tools`: `[{name, description}]`，取 `tool-factory.createTools` 的真实全集（27 项）
3. DTO：`api-contract/api/prompt.ts` 新增 `PromptBundleDTO`；`skill.ts` 的 `SkillItemDTO` 加 `body?: string`。

### 前端（`web/src/pages/skills/index.tsx`，保留书式视觉与翻页机制）

4. 双源并行拉取 `/api/skills` + `/api/prompts`；prompts 失败降级 null（卷首/卷末跳过，封面标「离线兜底」），skills 失败才整书降级内置清单。
5. 书重排三编：`buildPages` 组页——编目页 → 心法各节（含续页）→ 各章（章目录 + skill 页含续页）→ 兵器谱（含续页）。PageModel 扩展 kind: 'toc' | 'chapterToc' | 'section' | 'skill' | 'tools'。
6. 序号修复：「第N门」= **书序编号（ord）**——`buildPages` 组页时按 skill 实际出现顺序递增（续页共享首页 ord），目录页/章目录页/秘籍页/页脚四处置同源读取。（检视修复：初版直接用 skills 数组下标编号，数组序=字母序与 CHAPTERS 分组书序错位，翻书编号乱序——已改 ord 计数器口径，测试补乱序数据断言。）
7. 长文分页：`paginateText` 按行装箱（30 行/页，超长行按 ~64 字符估算折行），超页高切页，不断词；代码围栏（```）不跨页切。正文区字号 12px 容纳全文。
8. 目录页：`CodexTOCPage` 列三编结构，点击跳页沿用 ear/jump 机制。

### 设计取舍（留痕）

- **仓根定位**：`readSkillBody`/`readSystemSections` 不用 `process.cwd()`（alpha 实例 cwd 是数据根非仓根），用 `import.meta.dirname` 上溯推仓根。两种布局层级不同（dist 4 级 / src 3 级），逐一候选 + `.pi/SYSTEM.md` 存在性校验，全不命中兜底 `process.cwd()`。
- **工具清单来源**：聚合点 `createTools`（`interface-adapters/agent-runtime/tool-factory.ts`）。空 ctx 调用只得**无条件基础集 27 件**——条件注册工具（healing/workspace_*/create_scheduled_task/query_signals/halt/resolve_signal 等）依运行时环境挂载，不在清单内；UI 兵器谱文案如实标注「无条件基础工具 N 件」并附条件注册说明段。反向地，编排工具（wait/create_otter/dissolve_otter/merge_pr 等）多数 otter 经白名单拿不到，但它们是系统能力的一部分，谱上保留。
- **SYSTEM.md 首段引言**：首个 `##` 前的标题/术语段（约 400 字）并入第一编作引言，不丢弃（检视修复：初版 splitByH2 静默丢弃且注释失实）。代码围栏内的 `##` 不视为分节边界。
- **机制识别检查点**：大獭判定无命中（不新增机制，属展示层修复 + 数据源扩展，Modification-Class=narrow-fix）。本特性不经 RA 流程。

## 测试

- `web/src/pages/skills/index.test.tsx`（27 断言）：三编结构、skill 正文渲染、心法节存在、兵器谱渲染、书序编号乱序断言、目录编号同口径、目录直达 + 奇数末页显式视野断言（uxrc2 防护恢复）、翻页引擎回归、paginateText/buildPages 单测
- `tests/api/skills.test.ts`（6 断言）：skills body 透传、prompts system/tools 契约、默认空实现、500 路径

## 检视与修复（F20260929scfx 检视獭-scfx REQUEST_CHANGES → 修复）

4 严重全部修复：
1. 序号口径改 ord 组页计数器（目录/章目录/秘籍页/页脚四处置同源），乱序数据测试断言
2. CI e2e tsc：test mock 键对齐 SkillEntry.desc；rebase main
3. 回归防护恢复：奇数末页改显式最终视野断言（=maxView 5）；新增「总目录条目可点直达」用例
4. 兵器谱文案改「无条件基础工具」+ 补条件注册说明段；PR body 断言同步改实

顺手修 5 建议：paginateText 围栏不跨页 + 长行估算折行、resolveRepoRoot 双布局候选、/api/prompts 加无鉴权注释、SYSTEM.md 首段引言并入第一编（改 splitByH2）、序号测试命名去过度声明。

## 自检

- 真机截图（alpha 实例 3102 + vite dev 5199，无头 Chrome）：封面/编目+心法节同框/长 skill 续页（adversarial-review 6 页连续切片）/兵器谱 27 件/目录页，存 `data/workspaces/9eeb7b69-26d5-4957-b7f2-9f7fd5a00d77/shots/`
- 后端 API 实测：skills 14 项全带 body（adversarial-review 10871 字符）；prompts 7 sections + 27 tools
- lint 0 错、tsc 干净、interface-adapters 398 测试全过、前后端特性测试 25+6 全过
