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
6. 序号修复：`第N门` = skills 数组全局序（= 书页顺序，因 buildPages 按同序组页）；目录页与章目录页同口径。
7. 长文分页：`paginateText` 按行装箱（30 行/页），超页高切页，不断词。正文区字号 12px 容纳全文。
8. 目录页：`CodexTOCPage` 列三编结构，点击跳页沿用 ear/jump 机制。

### 设计取舍（留痕）

- **仓根定位**：`readSkillBody`/`readSystemSections` 不用 `process.cwd()`（alpha 实例 cwd 是数据根非仓根），用 `import.meta.dirname` 从编译产物位置（`dist/src/frameworks/agent/`）向上四级推仓根 + `.pi/SYSTEM.md` 存在性校验，失败兜底 `process.cwd()`。
- **工具清单来源**：派工单要求运行时真实注册集。聚合点 `createTools` 在 `interface-adapters/agent-runtime/tool-factory.ts`，http 层引用它有先例（controllers 引 AgentInvoker 类型）。取全集（不注入可选 repo/白名单）——「系统会什么」的答案不受 invoke 级白名单过滤影响，更贴近兵器谱语义。这是 app bootstrap 期唯一可稳定获得的真实全集；invoke 级动态集不在端点层可达。
- **机制识别检查点**：大獭判定无命中（不新增机制，属展示层修复 + 数据源扩展，Modification-Class=narrow-fix）。本特性不经 RA 流程。
- **序号口径**：「第N门」编号 = skills 数组全局序（书页顺序同口径），非章内序。字母序下 chapter 唯一成员的编号可能非「第一门」（如 companion=第三门），但目录页与秘籍页严格一致——符合派工单「序号与页序一致」的字面要求。

## 测试

- `web/src/pages/skills/index.test.tsx`（25 断言）：三编结构、skill 正文渲染、心法节存在、兵器谱渲染、序号与页序一致、prompts 降级、翻页引擎回归（检视獭-uxrc2 off-by-one 防护）、paginateText/buildPages 单测
- `tests/api/skills.test.ts`（6 断言）：skills body 透传、prompts system/tools 契约、默认空实现、500 路径

## 自检

- 真机截图（alpha 实例 3102 + vite dev 5199，无头 Chrome）：封面/编目+心法节同框/长 skill 续页（adversarial-review 6 页连续切片）/兵器谱 27 件/目录页，存 `data/workspaces/9eeb7b69-26d5-4957-b7f2-9f7fd5a00d77/shots/`
- 后端 API 实测：skills 14 项全带 body（adversarial-review 10871 字符）；prompts 7 sections + 27 tools
- lint 0 错、tsc 干净、interface-adapters 398 测试全过、前后端特性测试 25+6 全过
