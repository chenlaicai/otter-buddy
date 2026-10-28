---
id: F20261027fidrx
title: "特性编号日期边界可读化：固定五位字母、宽读严写与存量兼容"
summary: |
  搭档最终决策（2026-10-28）：新 ID 在 8 位日期后固定 5 个小写字母，不用中划线。
  新写验收严格 [FR]\d{8}[a-z]{5}；历史识别继续兼容旧 4–10 位字母数字与分隔形态，
  历史文档、DB、commit 不迁移，记忆 FTS 与查询锚点保持可用。
change_type: feature
intent:
  problem: "F2026102759c4 虽通过现行门禁，但日期 20261027 与数字后缀 59c4 黏连，搭档无法一眼识别日期边界；合法格式不等于可读格式。"
  why_now: "搭档于 2026-10-28 08:06 否决中划线方案，明确要求固定后五位只能字母并保持历史兼容；最新指令取代前一日短横线拍板。"
  expected_effect: "新编号日期后固定 5 个小写字母；新写不接受数字/中划线/其它长度，旧文档、历史检索与记忆锚点保持正常。"
  verify_by:
    type: behavior_check
    note: "fid-format 固定 5 字母与历史宽读正反例、frontmatter 历史默认读与新增严格、commit-msg/CI 行为测试、parser/disk/memory 新旧兼容与全仓 lint/CI。"
capability_test: "n/a: 文档格式契约与 lint 规则调整；由 fid-format/frontmatter/commit-parser/hook/CI/search-memory 的单元与集成回归覆盖，无产品 capability 行为变更。"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  from:
    - F20260901fidc
  supersedes: []
tags: [document, fid, readability, compatibility, lint]
modules: [src/entities/document/fid-format.ts, src/entities/document/frontmatter-validator.ts, src/usecases/health/commit-parser.ts, src/usecases/health/pr-collector.ts, src/usecases/document/disk-id-scanner.ts, src/usecases/memory/search-memory.ts, src/frameworks/db/memory/sqlite-memory-repository.ts, src/frameworks/db/migration.ts, scripts/lint-date-bombs.mjs, .githooks/commit-msg, .github/workflows/ci.yml]
---

## 背景与最终决策

2026-10-27 搭档指出 `F2026102759c4` 难以一眼识别日期。大獭先提出并实现了「日期后短横线」方案，完成方案与代码审视，但在未合入前，搭档于 2026-10-28 08:06 明确翻案：「等等，是我的问题，我没细看，但我不想要中划线。为什么不直接就固定后五位只能是字母呢，然后保持兼容方案，保证旧文档和记忆正常可用」。

最终决策以该最新指令为准：

- **新写 ID 固定 `[FR]\d{8}[a-z]{5}`**：日期后恰好 5 个小写字母，不用中划线，不含数字，不接受其它长度。
- 字母表是完整 `a-z`，不排除 `0/1/l/o`（0/1 本就不是字母，l/o 允许）。固定长度与纯字母共同保证日期边界。
- **历史兼容保留**：旧 4–10 位字母数字、数字直连及历史分隔形态仍用于读取/入库/记忆锚点，不改旧文档、不迁 DB、不重写 commit。
- 本特性设计/初版使用 `F20261027fidr`（4 字母，历史形态）；按最终规则提交前统一改为 `F20261027fidrx`（5 字母）。新规则合入后新生成的 ID 必须是 5 字母。

此前短横线方案、审批、实现与 delta 仅作决策史保留，不再作为合入目标。本特性文档、提交与 PR #1668 均使用 `F20261027fidrx`；按本最终方案重写后重新独立审视，不沿用旧方案的终审通过结论。

## 目标

T1：新编号一眼可读，例如 `F20261027abcde`；日期总是 8 位，后续总是 5 个小写字母。

T2：commit-msg、PR 标题与新增文档 lint 对非 5 字母新写一致拒绝；历史 parser 不被同步收紧。

T3：历史文档和记忆正常可用。validator 默认 read，lint 只对当前分支新增文档启用 strictNewId；无需把近九百个历史 ID 硬编码成白名单。

T4：memory FTS 注入/重建与查询锚点继续覆盖旧 4 位、长后缀、数字直连和既有分隔形态；新 5 字母自然也包含在 read 契约中。

T5：单一真相源与可执行镜像有行为/元测试，生成规范明确固定 5 字母，避免后续再次自行发挥格式。

## 非目标

- 不使用中划线或任何分隔符作为新写 ID 的组成。
- 不迁移历史文档/DB，不重写历史 commit，不批量改名旧 ID。
- 不恢复旧 `[a-kmnp-z]` 字母表，不增加生成器或新配置/状态/存储。
- 不在本 PR 混入 #1664 的守卫回归改动；其改号后续单独处理。

## 方案设计

### 1. 新写严格、历史宽读

`fid-format.ts` 导出：

```text
acceptance: [FR]\d{8}[a-z]{5}
read:       [FR]\d{8}-?[a-z0-9]{4,10}
```

- `isValidFid` / FID_ANCHOR_REGEX 是固定 5 字母新写契约。
- FID_READ_ANCHOR_REGEX 是历史识别契约，供 memory FTS insert/update/migration；query anchor 同步宽读。
- parser/pr-collector/disk-scanner 用 read，避免历史 commit/PR/文件名漏判。
- commit-msg 和 PR title 只用 acceptance；中划线、数字、4/6 位后缀都拒绝。

### 2. 历史文档与新增文档分流

`validateFeatureFrontmatter` / `validateResearchFrontmatter` 默认 read，保证启动 sync 和历史文档不被新规则卡死。新增可选 `strictNewId` 参数，只有 `lint:docs` 对 `origin/main...HEAD` 的新增文档传 true：

- 历史：原 4 位、长后缀、数字直连均继续入库；`F20260731mmr` 保留原白名单。
- 新增：固定 5 字母；非 5 字母报 Invalid ID。
- 基线不可达时增量严格门降级为既有 read，commit/CI 标题门仍硬拦，避免 lint 基线问题让全流程不可运行；实现需独立审视此降级是否可接受。

### 3. 入口与生成规范

- PR title 使用零构建依赖 `check-pr-title.cjs`，FID 严格段与真相源元测试锁镜像；行为测试覆盖 5 字母接受与各类反例。
- commit-msg 同步固定 5 字母，旧 commit 仍由 parser read 合规识别。
- lint-date-bombs、filename slug 用 read，不遗漏历史形态。
- commit-convention 与 review 规范明确 `FYYYYMMDDxxxxx`，不提供中划线或数字后缀示例。
- 新增 frontmatter 损坏的 dash 候选告警仅为历史识别可观测性，不代表允许新写 dash。

## 影响与风险

| 面 | 决策 | 理由 |
|---|---|---|
| 历史 898 个非 5 字母文档 | 默认 read，不迁移 | 直接满足搭档兼容要求 |
| 新文档 | lint 对分支新增 strictNewId | 防止新歧义继续产生 |
| 旧 commit/PR | parser read | 不新增 no_f_prefix/失联 |
| 记忆 | FTS/查询 read | 旧 4 位、长后缀、数字直连不回归 |
| 在途 PR | 规则合入后需改非 5 字母标题 | 当前 #1664 及 4 位后缀 PR 需按各分支同步，避免门禁突红 |
| 字母表 | 全小写 a-z | 只限字母，不无依据缩小字母表 |
| 机制 | narrow-fix | 格式判定与既有调用修改，无净新增机制 |

已知风险：增量 lint 依赖 origin/main，基线不可达时新增文档严格门降级；这是可用性与严格性取舍，必须由 CI 新写标题门与新增文档测试补足，不得宣称所有环境均 fail-closed。另一个风险是在途 PR 改号窗口，本规则合入后需立即处理，不允许以兼容为名让新标题继续绕过。

## 验证

1. fid-format：5 字母接受；4/6 位、数字、中划线、大写拒绝；历史形态 read 可识别。
2. frontmatter：历史 4 位/长后缀/数字直连默认通过；strictNewId 对非 5 字母拒绝，新 5 字母接受。
3. hook/PR title 行为级 spawnSync 正反例；严格段与真相源元测试锁镜像。
4. parser/pr-collector/disk-scanner：历史 ID 不回归；新 5 字母正常提取。
5. memory insert/update/migration/search：旧 4 位、长后缀、数字直连与新 5 字母端到端命中。
6. lint:docs 全量历史 OK，新增非 5 字母反例必须红；`npm run check`、全量测试与 CI 三项绿。
7. 代码独立 r1/delta：重点审增量严格门、历史兼容与在途 PR 窗口，不沿用中划线实现的通过结论。

## 方案修订记录

- 2026-10-27 短横线方案已完成实现与 delta，但搭档 2026-10-28 明确不要中划线；该终审未合入、授权请求作废。
- 2026-10-28 按最新指令改为固定 5 字母，保留 read/FTS/历史识别兼容。以下为工程实现史，短横线部分已由本次修订替换，不是现行契约。

## 2026-10-28 固定 5 字母版自检

- FID/frontmatter/hook/PR title/parser/disk/memory 相关回归：12 files / 207 passed。
- `npm run check` 通过；`lint:docs`：915 篇文档 OK；intent lint 通过。
- 全量 `npm test`：7180 passed / 3 failed / 6 skipped。3 个失败均在 `tests/usecases/health/rhi-scan-worker.test.ts`；独立干净 worktree `review-fidr-baseline` 基于最新 `origin/main@387a30a7` 单跑同文件复现同样 3 失败（8 passed），确认非本 PR 引入，不记为全量绿。

以下为 2026-10-27 中划线旧版工程与审视史，仅作追溯，不是本版验收结果。

## 实现记录（2026-10-27，搭档批准兼容方案后）

- `fid-format.ts` 拆为 acceptance/read 双契约；最终 acceptance 为固定 5 字母，memory FTS 使用 `FID_READ_ANCHOR_REGEX`，历史文档由 read 契约整体兼容，无需 898 个白名单。
- commit-parser/pr-collector/disk-scanner 使用 read 契约；disk frontmatter 损坏的 dash 候选 ID 增加人工核对 warning，不静默当成已验证链。
- `check-pr-title.cjs` 在 CI build 前以零依赖 CommonJS 运行；元测试将其严格段与真相源字符级锁镜像，CI 不再维护 YAML 内联 FID 正则；commit-msg 实跑正反例，模块词表元测试同步指向该脚本。
- search-memory 查询锚点支持可选 dash 和 4–10 位后缀；sqlite insert/update 与 migration FTS 重建保留新旧 ID。
- 文档扫描 913 篇 OK（含 5 个数字直连历史 ID + mmr）；无历史文档改名或 DB 迁移。

自检：

- 相关契约/入口/锚点测试首轮 171/171；新增端到端锚点、migration 和元测试回归 93/93。
- 全量 `npm test`：新 head delta 复核 449 files / 7151 passed / 6 skipped（大獭初验 448 / 7139，r1 新增行为测试后由检视-1668 独立复跑）。
- `npm run test:capability`：16 files / 16 passed / 41 skipped（未配置 LLM 端点的既有跳过，不记为真实 LLM 验证）。
- `npm run check`、ESLint、schema、启动冒烟、docs/intent/tests/evidence-anchors/skills/date-bombs lint 通过；既有 warning 未扩张为通过断言。
- `check-pr-title.cjs` 实跑：`F20261027abcde` 接受，数字直连/中划线/4 位/6 位后缀拒绝；commit-msg 正反例由 `tests/githooks/commit-msg-fid.test.ts` 覆盖。首轮远端 CI 暴露标题步骤先于 build、不能依赖 dist 后改为零依赖 CJS 并重验。

## 审视处置

### 代码 delta（检视-1668）

代码面 PASS：r1 三建议逐条充分，cjs 捕获组 6 例边界探查无新问题；新 head 全量 449 files / 7151 passed / 6 skipped 独立复跑。check 因 Playwright 安装等待后于 16m00s  SUCCESS，e2e 2m54s SUCCESS，golden-selftest 1m52s SUCCESS；run 40506518004 新 head CI 三项全绿。PR 留痕待检视补发。

### 代码 r1（检视-1668，mimo-pro；0 严重 / 3 建议）

1. **标题校验器缺行为级自动测试 → 本 PR 修复**：新增 `tests/scripts/check-pr-title.test.ts`，spawnSync 覆盖 dash/字母接受、数字直连拒绝、7 个模块黑名单拒绝与开放集非黑名单接受。
2. **PR body 写 mjs/复用编译产物与实际 cjs/零依赖不符 → 本 PR 修复**：PR body 改为零构建依赖 CJS + 元测试锁真相源；实现记录原已正确。
3. **模块黑名单文案「禁用」但 PR title 放行 → 本 PR 修复**：cjs 捕获模块段，按与 module-tags.ts 对账的黑名单真实拒绝；推荐词提示同步恢复，行为测试覆盖 7 个黑名单与开放集。

r1 合规：4 个独立焦点、全库 frontmatter/commit/文件名白名单实证、182 个关键测试独立复跑、PR review `pullrequestreview-5667199371` COMMENTED；head `2fa2a0a4` CI 三项全绿。

待代码 delta 复核。

### r1（检视-fid方案，mimo-pro；0 严重 / 6 建议）

1. **FID_ANCHOR_REGEX 消费方遗漏 → 本方案修复**：modules/改动表补 sqlite-memory-repository insert/update 与 migration FTS 重建；§2 明确 FID_ANCHOR_REGEX 从 read 契约派生整串锚定正则，不能从 acceptance 派生。
2. **lint-date-bombs 遗漏 → 本方案修复**：现状/改动表/验证补 FID_DATE_RE 的可选 dash 与新旧样例，避免新形态逃过日期炸弹扫描。
3. **dash 无 slug 漏 warning → 本方案修复**：validateFilenameSlug 纳入消费面，明确 `F20261027-59c4.md` 报 warning、正常带 slug 不误报。
4. **幻影提取边界 → 本方案修复**：风险 #4 与验证 #2 补 `F20261027-notes-blurbs.md` / `F20261027-notes` 负例；拒绝「dash 后缀必须含数字」这一会误杀纯字母后缀且不能治本的备选。
5. **方案自身改名清单不齐 → 本方案修复**：§5 补 frontmatter/文件名/自指/PR/linked resource 全清单与旧 ID 溯源句，和 #1664 对齐。
6. **#1664 混合 FID commit 历史 → 本方案修复**：已读 pr-collector.ts:14-23，其关联语义为 commits ∪ body 一对多；风险 #7/验证 #8 补改号后的链关联/gap 核对与 squash 后唯一新 FID 口径，不重写远端历史。

r1 合规校验：报告含 3 个独立焦点、模型多样性、file:line、913 ID 全量扫描与正则/文件名/memory 探针；工作区 `r1-review-F20261027fidr.md` 已回读。六条均由作者（大獭）本方案修复，无 r2 争议。

### r1 delta（检视-fid方案）

**通过**：六条建议 14/14 落点核查 PASS，无新增严重、无新矛盾；完整报告在工作区 `delta-review-F20261027fidr.md`。

- 新增 low 措辞项（CI 现行允许大写/无上限而非小写）→ 按检视预批准文本本方案修复，改完即闭环，无需再开 delta。
- 设计取舍表改名摘要补「完整清单见 §5」→ 已顺手修正。

方案定稿待搭档对「显式短横线 + 宽读严写 + 存量不迁移」拍板；确认后进入实现。
