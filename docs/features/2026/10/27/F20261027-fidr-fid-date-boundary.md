---
id: F20261027-fidr
title: "特性编号日期边界可读化：显式分隔符、宽读严写与存量兼容"
summary: |
  搭档否决 F2026102759c4 一类日期与数字后缀黏连的编号：合法性不等于可读性。
  新方案以 F20261027-x59c4 为推荐形态，日期后固定短横线提供一眼可见的边界；
  接受面同时保留字母开头的无分隔存量形态，拒绝新的数字直连形态。历史识别与
  新文档/新 commit 验收分离，避免迁移近九百篇历史文档、重写 commit 或切断记忆锚点。
change_type: feature
intent:
  problem: "F2026102759c4 虽通过现行门禁，但日期 20261027 与数字后缀 59c4 黏连，搭档无法一眼识别日期边界；合法格式不等于可读格式。"
  why_now: "搭档于 2026-10-27 18:48 明确否决数字直连形态并要求立即给出新方案；若只改 PR #1664 而不改全仓契约，同类编号会继续生成。"
  expected_effect: "新编号推荐 F20261027-x59c4，日期结束位置固定可见；新数字直连被 commit/CI/文档门拒绝，旧文档与历史检索仍可识别，近九百篇存量无需迁移。"
  verify_by:
    type: behavior_check
    note: "fid-format 严格/宽读正反例、frontmatter 存量白名单、commit-msg/CI 新写拒绝数字直连、parser/disk/memory 新旧形态兼容测试与全仓 lint/CI。"
capability_test: "n/a: 文档格式契约与 lint 规则调整；由 fid-format/frontmatter/commit-parser/hook/CI/search-memory 的单元与集成回归覆盖，无产品 capability 行为变更。"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  from:
    - F20260901fidc
  supersedes: []
tags: [document, fid, readability, compatibility, lint]
modules: [src/entities/document/fid-format.ts, src/entities/document/frontmatter-validator.ts, src/usecases/health/commit-parser.ts, src/usecases/health/pr-collector.ts, src/usecases/document/disk-id-scanner.ts, src/usecases/memory/search-memory.ts, src/frameworks/db/memory/sqlite-memory-repository.ts, src/frameworks/db/migration.ts, scripts/lint-date-bombs.mjs, .githooks/commit-msg, .github/workflows/ci.yml]
---

## 背景

编号溯源：方案设计期使用 `F20261027fidr`；按搭档批准的兼容方案，实现期统一为推荐形态 `F20261027-fidr`。

搭档原话（2026-10-27 18:48）：「这个脱离我的预期了，我作为用户体验来说，我现在很难一眼看出来日期，我还需要仔细看一眼。这个改动我不认可，你需要再给出一个新方案。你现在来做」。

直接触发样本是 `F2026102759c4`：它符合 PR #670 后的 `[FR]\d{8}[a-z0-9]{4,10}`，但 `27`（日）与 `59`（后缀）视觉黏连。大獭此前只回答「合法、不用改」，把机械契约误当成用户体验结论；该判断由本方案收回。

历史约束：

- F20260901fidc / PR #670 消除的是**字母表漂移**：入库与 parser 对 `0/1/l/o` 的接受不一致；它并未证明「数字紧贴日期」具有良好可读性。
- F20260914prdb 确认 PR 标题即 squash 后 main 历史，文档 ID 与 PR 标题一致，定稿日期可顺延；本方案不能重写已合入 commit，也不能让 PR 标题、文档 frontmatter、文件名三者分叉。
- worktree-isolation 的历史文档不可变铁律禁止为了美观批量改写历史正文；存量 DB / memory_entries.source_id 也不能被无迁移改名。

## 目标

T1：人扫一眼即可定位 8 位日期结束的位置；`F2026102759c4` 一类歧义不再由新提交产生。

T2：新编号推荐形态统一为 `FYYYYMMDD-xxxx` / `RYYYYMMDD-xxxx`，例如 `F20261027-x59c4`；后缀仍允许 4–10 位小写字母数字，不恢复排除 `0/1/l/o` 的无出处字母表。

T3：严格验收与历史识别分离。新文档、commit-msg、PR 标题拒绝数字直连；历史 parser、PR 收集、磁盘扫描与记忆锚点仍能识别旧编号。

T4：不重写历史 commit，不批量改名历史文档，不迁移 DB；其他在途字母开头 PR 不被强制改号。`F2026102759c4`（尚未合入的 PR #1664）在后续该 PR 分支中改为 `F20261027-59c4`，保留后缀降低溯源成本。

T5：规则仍由 `fid-format.ts` 单一真相源承载，hook/CI 镜像有元测试防漂移，生成规范明确推荐带分隔符形态。

## 非目标

- 不恢复「后缀必须字母开头」作为唯一合法形态；它虽能分界，却继续禁掉带分隔符的纯数字后缀，且不能显式表达边界。
- 不批量给 896 篇特性文档、15 篇研究文档及其引用加短横线；这是大范围 ID 迁移，不是可读性修复的必要条件。
- 不改写 main 历史 commit，不变更已合入文档正文，不设计 DB ID 迁移。
- 不改变日期顺延规则、模块标签、change type、文档 chunk 或 FTS 架构。
- 不在本 PR 修改 #1664 的业务内容；其编号修正留在 #1664 自己的分支。

## 未决问题

无。搭档已明确问题（日期难以一眼识别）、期望（提出并执行新方案）与不认可的旧方向（数字直连合法化）。具体分隔符属于技术表现层取舍，由本方案确定为短横线。

## 现状与实证

### 当前规则与消费面

- `src/entities/document/fid-format.ts:29-42`：当前只持有一段 `[a-z0-9]{4,10}`，识别与验收混用同一形态。
- 严格/半严格验收：frontmatter validator、commit-msg、CI PR title。
- 历史识别：commit-parser、pr-collector、disk-id-scanner。
- 记忆：`sqlite-memory-repository` 的 insert/update 与 `migration` 的 FTS 重建均用 FID_ANCHOR_REGEX 决定是否把文档 ID 注入 FTS；`search-memory.ts` 另有子串 ANCHOR_PATTERN。查询走 sourceId 精确短路，不依赖连字符分词。
- 其它识别：`lint-date-bombs.mjs` 用独立 FID_DATE_RE 扫描硬编码日期炸弹；`validateFilenameSlug` 还负责无 slug 文件名 warning，dash 形态不能只改正则主契约而漏这两个入口。

### 存量规模

2026-10-27 在 `origin/main@50fe3a24` 所在工作树实测：特性文档 896 篇、研究文档 15 篇；文件名中日期后数字直连的仅 5 个：

- `F2026090326c5`
- `F202609048840`
- `F2026090211v4`
- `F202609025itn`
- `F202608119glo`

它们已经合入且可能存在于 DB source_id、memory FTS、代码注释与历史引用中。保留其读取兼容性，比批量改名并重写引用更小、更安全。当前 open PR #1660/#1661/#1662/#1663/#1638 均为字母开头，只有 #1664 是数字直连。

## 方案设计

### 1. 双形态契约：推荐显式分隔，严格验收拒绝数字直连

严格接受的新/未合入 ID：

```text
[FR]\d{8}(?:[a-z][a-z0-9]{3,9}|-[a-z0-9]{4,10})
```

两种可读形态：

| 形态 | 示例 | 用途 |
|---|---|---|
| 字母开头、无分隔 | `F20261027x59c4` | 兼容已有字母开头 ID；字母是天然边界 |
| 短横线分隔（推荐所有新 ID） | `F20261027-x59c4`、`F20261027-59c4` | 日期结束位置固定、最直观；数字开头也可读 |

明确拒绝：

- `F2026102759c4`：数字直连，本需求要消除的歧义；
- 大写后缀、非 8 位日期、3 位或 11 位后缀、下划线/空格/多个分隔符；
- 短横线写到 F/R 后（`F-20261027abcd`）或日期内部（`F2026-1027abcd`）。

`F20261027x59c4` 仍在严格接受面，是为了历史与在途 PR 连续，不是生成推荐。commit-convention、模板和错误文案统一建议 `F20261027-x59c4`。

### 2. 宽读严写：拆开读取正则与验收正则

`fid-format.ts` 明确导出两组语义，避免再拿同一个宽松段误当新文档门禁：

- **acceptance / write**：上面的双形态严格契约；frontmatter（除存量豁免）、commit-msg、CI 使用。
- **recognition / read**：`[FR]\d{8}-?[a-z0-9]{4,10}`；parser、PR collector、disk scanner、memory 文档 ID 注入与查询锚点使用，保留全部历史 4–10 位形态。`FID_ANCHOR_REGEX` 必须由该 read 契约派生为**整串锚定**正则，明确供 sqlite insert/update 与 migration FTS 重建使用；不能由严格 acceptance 契约派生，也不能漏掉带 `-` 的新形态。

导出名与注释必须让语义可机械区分（例如 `FID_ACCEPTANCE_PATTERN_SOURCE` / `FID_READ_PATTERN_SOURCE`），不能仅把 `FID_SUFFIX_SEGMENT` 悄悄改义后让各消费方误用。

`isValidFid` 面向严格验收；若现有测试/调用需要判断「可识别历史 ID」，另设名称清晰的读取判定，不用布尔函数含混两种语义。

### 3. 五个数字直连历史文档：显式白名单，不改名

既有 `LEGACY_FID_IDS` 已承载短后缀 `F20260731mmr` 的 frontmatter 例外。本方案把上述 5 个真实数字直连 ID 加入同一**入库验收白名单**，每项注释说明是历史兼容而非新形态许可：

- 新文档 validator：严格形态 OR LEGACY_FID_IDS；
- 历史识别：宽松 read pattern 无需逐 ID 白名单；
- commit-msg / CI 新标题：不消费白名单，因此不能拿旧 ID 创建新 commit/PR；
- memory：read pattern 保留旧 ID 的 FTS 注入和查询短路。

这是定向兼容，不是数字直连的普遍开口。五个文件保持文件名/frontmatter/DB 不变，历史正文零改动，不需要 `.doc-fix` 迁移批次。

### 4. 门禁与生成规范同步

- commit-msg：只接受严格双形态；报错直接给「推荐 `[F20261027-x59c4]`，数字开头必须带 `-`」。既有元测试改为锁严格段，另加历史 parser 不被同步收紧的测试。
- CI PR title：与 commit-msg 同口径收紧为严格双形态（现行 `[a-zA-Z0-9]{4,}` 允许大写且无上限，一并收紧为小写 4–10）；新增 `F2026102759c4` 反例与 `F20261027-59c4` 正例的本地验证。
- frontmatter：新数字直连 error；5+1 个白名单历史文档仍通过；其它字母开头历史文档不受影响。
- search-memory：查询锚点接受可选短横线，覆盖 4–10 位后缀，保持既有子串边界语义；测试验证新 ID 命中、旧 ID 不回归、不会把相邻普通单词错误吞入。sqlite insert/update 与 migration FTS 重建同样覆盖 read 契约的新旧形态；连字符只参与 sourceId 精确锚定/FTS 对称注入，不声称改变中文检索分词语义。
- lint-date-bombs：FID_DATE_RE 使用 read 契约（含可选 `-`），保证新形态硬编码日期炸弹继续被扫描；不能留着第二套不匹配新形态的硬编码。
- validateFilenameSlug：dash 新形态无 slug（如 `F20261027-59c4.md`）也必须产生 missing-slug warning；正常 `F20261027-59c4-slug.md` 不误报。
- commit-convention / review-dimensions / 相关模板：格式改为 `FYYYYMMDD-xxxx`，说明字母开头旧形态只用于兼容，不再作为新 ID 推荐。

### 5. 在途 PR #1664 的后续修正

本规则 PR 合入前，#1664 暂停终审。规则实现合入后，在 #1664 原 worktree：

1. 将 `F2026102759c4` 改为 `F20261027-59c4`（后缀 `59c4` 不变）；
2. 同步 frontmatter id、文件名、文档内自指、测试标题/fixture、PR title/body/linked resource groupId；
3. 保留「编号溯源：原 F2026102759c4」一句作为分支内溯源，不改写远端已存在 commit；
4. rebase 最新 main、复跑 CI 与必要 delta，再重新呈搭档终审。

本方案实现期同样执行完整改名清单：设计期 `F20261027-fidr` → 实现期 `F20261027-fidr`，同步 frontmatter、文件名、文档自指、commit/PR title/body、linked resource 的 file/worktree groupId 与路径，保留「编号溯源：原 F20261027-fidr」一句；方案讨论和记忆中的旧 ID 不重写，通过新文档自指保留可追溯性。

不把该改名混入本规则 PR，避免一个 PR 同时修改守卫回归测试与全局 FID 规则。

## 影响范围

| 消费面 | 变化 | 兼容性 |
|---|---|---|
| 新文档/新 commit/PR 标题 | 数字直连拒绝；带 `-` 或字母开头接受 | 有意的严格化 |
| 已有字母开头文档/PR | 无需改号 | 完全保留 |
| 5 个数字直连历史文档 | 白名单入库、宽读识别 | 不改文件/DB |
| 历史 commit 统计 | read pattern 继续识别旧数字直连 | 不新增 no_f_prefix |
| 记忆检索 | 新旧带/不带分隔符均可锚定 | 扩大查询形态，不删旧形态 |
| 生成规范 | 新 ID 推荐带 `-` | 文档与 hook 同步 |
| PR #1664 | 后续单独改号 | 本 PR 不含其改动 |

## 风险与约束

1. **双形态被误解为继续纵容歧义**：严格面只允许字母开头无分隔，数字开头必须 `-`；测试必须把目标反例钉死。
2. **宽读严写再次混用**：命名、注释和消费方清单三重约束；测试不只测正则本身，还测 parser 与 validator 的不同语义。
3. **白名单被当作永久扩张口袋**：仅放 6 个已实证存量；新增项需要真实历史证据，不允许把未合入 ID 加进去绕门。
4. **文件名扫描边界**：`F20261027-x59c4-slug.md` 必须完整提取 `F20261027-x59c4`，不能把后缀第一段的 `-` 当 slug 分隔；单列回归。反向的「幻影提取」也要钉住：`F20261027-notes-blurbs.md` 在 frontmatter 损坏时可能由文件名兜底识别成 `F20261027-notes`，`F20261027-notes` 在 PR body 也可能被采集为 featureId。保留 read 宽松性是历史识别必要成本，不通过「dash 后缀必须含数字」排除（会误杀 `-fidr` 且治不了无分隔同类歧义）；实现必须补负例与告警/人工边界说明，不得把疑似自然语言词直接当作已验证文档链。
5. **锚点正则部分匹配**：可选分隔符必须保证整段优先、后缀长度边界与相邻字符判断；用新旧样例与相邻文本复验。
6. **在途窗口**：本规则合并后，任何未合入数字直连 PR 会在下次 CI 被拦，这是预期；当前实证只有 #1664，已列后续。
7. **混合 commit 历史**：#1664 改号前的远端 commit 会保留旧 FID，新 commit/PR title/文档使用新 FID。pr-collector 是 commits ∪ body 一对多关联，可能把旧链与新链同时关联；需在改号后核对 open-PR 链关联与 gap 报告。若旧链产生噪音，在该 PR 的溯源备注/关联记录中说明，squash 合入后以新 FID 为唯一 main 历史，不为消除临时噪音重写远端 commit。

## 不兼容更新

无历史数据/接口不兼容迁移。新写入侧有意拒绝此前合法但不可读的数字直连 ID；历史读取和存量入库通过宽读与白名单保留，不需 `[Incompatible]` 历史重写。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 改了更好/更差的判断 |
|---|---|---|---|
| 日期边界表达 | 固定 `-`，推荐 `F20261027-x59c4` | 恢复首字母限制 | 分隔符直接解决视觉问题，且不限制数字后缀；更好 |
| 无分隔字母开头 | 严格面保留 | 全部新 ID 只能带 `-` | 保留避免在途 PR 与历史断裂，且字母天然分界；更好 |
| 数字直连历史 | 5 个白名单 + 宽读 | 批量 rename + DB 迁移 | 白名单范围小且不碰历史正文/主键；批量迁移代价和风险更大 |
| parser 与 validator | 读取/验收分离 | 一个正则同时宽读与验收 | 分离才能同时满足历史兼容与新写严格；更好 |
| 本特性设计文档编号 | 设计期暂用合法可读的 `F20261027-fidr` | 立即使用当前 validator 不认识的 `F20261027-fidr` | 设计期可 sync/lint；实现期同分支改为推荐形态并同步标题（完整清单见 §5）；更好 |
| 机制识别 | 不涉及净新增机制 | 新增配置开关或迁移状态 | 仅修改既有格式判定与正则导入关系，无新配置/状态/存储/信号/持久决策分支/新跨模块调用，跳过机制预算四问 |

### 对 #670 的明确回应

本方案不是恢复 #670 删除的旧字母表，也不是否定其「入库/parser 一致」目标。#670 修的是字符集合与解析漂移；本方案补的是当时未纳入验收的人类视觉边界。`0/1/l/o` 仍全部合法，只要求数字开头时通过 `-` 与日期分开。

## 验证

1. `fid-format` 单元：新字母/数字带 `-` 正例；字母开头无分隔兼容例；数字直连、多 `-`、错误位置、长度/大小写反例；6 个白名单只作用于 validator。
2. parser/pr-collector/disk-scanner：新分隔 ID 完整提取；旧字母/旧数字 ID 不回归；带 slug 文件名不把 ID 截短。补 `F20261027-notes-blurbs.md` / PR body `F20261027-notes` 幻影形态负例与预期处置，证明不会静默当成已验证文档链。
3. hook 元测试 + 实跑：严格段与真相源一致；`F2026102759c4` 拒绝、`F20261027-59c4` 与 `F20261027x59c4` 接受；日期校验仍取 8 位日期。
4. CI title 检查同源样例验证；不得在 workflow 留第三套无测试镜像。
5. frontmatter/lint:docs：全仓 911 篇文档在新规则下保持可入库，白名单无额外扩张；新文档反例必须红。validateFilenameSlug 对 `F20261027-59c4.md` 报缺 slug、对带 slug 新形态不误报。
6. memory：sqlite insert/update 与 migration FTS 重建覆盖新旧 ID；search_memory 对 `F20261027-59c4` 能命中，对既有 `F202609048840` 等不回归；query 子串不错误截断。lint-date-bombs 对新旧 ID 都能发现日期炸弹。
7. `npm run check`、相关测试、全量测试与 lint；实跑 commit-msg 正反例。CI 三项全绿后才呈代码终审。
8. #1664 后续改名单独核对 PR title ≡ frontmatter ≡ 文件名 ≡ 产物 groupId；改号后核对 pr-collector commits ∪ body 的旧/新 FID 链关联与 gap 报告，记录混合历史临时噪音，squash 后以新 FID 为唯一 main 历史。

## 改动范围（实现期预计）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/entities/document/fid-format.ts` | M | 严格验收/历史识别双契约与白名单 |
| `src/entities/document/frontmatter-validator.ts` | M | 新文档用严格契约，历史白名单保留 |
| `src/usecases/health/commit-parser.ts`、`pr-collector.ts`、`src/usecases/document/disk-id-scanner.ts` | M | 历史识别显式使用 read 契约 |
| `src/usecases/memory/search-memory.ts` | M | 查询锚点支持分隔符 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts`、`src/frameworks/db/migration.ts` | M | FID_ANCHOR_REGEX 明确派生 read 契约；insert/update/FTS 重建新旧 ID 均可注入 |
| `scripts/lint-date-bombs.mjs` | M | 日期炸弹 FID 识别支持 dash，补正反例 |
| `.githooks/commit-msg`、`.github/workflows/ci.yml` | M | 新写门禁严格化与文案 |
| 对应单元/集成/元测试 | M/A | 上述正反例与消费面回归 |
| `.pi/skills/code-implementation/references/commit-convention.md`、review 规范/必要模板 | M | 新 ID 推荐形态 |
| 本特性文档 | M/R | 方案定稿、实现期改为 `F20261027-fidr` 并记录决策史 |

## 实现记录（2026-10-27，搭档批准兼容方案后）

- `fid-format.ts` 拆为 acceptance/read 双契约；`isValidFid` 严格新写，memory FTS 使用 `FID_READ_ANCHOR_REGEX`，历史 5 个数字直连 ID 仅入 validator 白名单。
- commit-parser/pr-collector/disk-scanner 使用 read 契约；disk frontmatter 损坏的 dash 候选 ID 增加人工核对 warning，不静默当成已验证链。
- `check-pr-title.mjs` 从编译后真相源取严格段，CI 不再维护 YAML 内联 FID 正则；commit-msg 实跑正反例，模块词表元测试同步指向该脚本。
- search-memory 查询锚点支持可选 dash 和 4–10 位后缀；sqlite insert/update 与 migration FTS 重建保留新旧 ID。
- 文档扫描 913 篇 OK（含 5 个数字直连历史 ID + mmr）；无历史文档改名或 DB 迁移。

自检：

- 相关契约/入口/锚点测试首轮 171/171；新增端到端锚点、migration 和元测试回归 93/93。
- 全量 `npm test`：448 files / 7139 passed / 6 skipped。
- `npm run test:capability`：16 files / 16 passed / 41 skipped（未配置 LLM 端点的既有跳过，不记为真实 LLM 验证）。
- `npm run check`、ESLint、schema、启动冒烟、docs/intent/tests/evidence-anchors/skills/date-bombs lint 通过；既有 warning 未扩张为通过断言。
- `check-pr-title.mjs` 实跑：`F20261027-fidr` / `F20261027fidr` 接受，`F2026102759c4` 拒绝；commit-msg 正反例由 `tests/githooks/commit-msg-fid.test.ts` 覆盖。

## 审视处置

### r1（检视-fid方案，mimo-pro；0 严重 / 6 建议）

1. **FID_ANCHOR_REGEX 消费方遗漏 → 本方案修复**：modules/改动表补 sqlite-memory-repository insert/update 与 migration FTS 重建；§2 明确 FID_ANCHOR_REGEX 从 read 契约派生整串锚定正则，不能从 acceptance 派生。
2. **lint-date-bombs 遗漏 → 本方案修复**：现状/改动表/验证补 FID_DATE_RE 的可选 dash 与新旧样例，避免新形态逃过日期炸弹扫描。
3. **dash 无 slug 漏 warning → 本方案修复**：validateFilenameSlug 纳入消费面，明确 `F20261027-59c4.md` 报 warning、正常带 slug 不误报。
4. **幻影提取边界 → 本方案修复**：风险 #4 与验证 #2 补 `F20261027-notes-blurbs.md` / `F20261027-notes` 负例；拒绝「dash 后缀必须含数字」这一会误杀纯字母后缀且不能治本的备选。
5. **方案自身改名清单不齐 → 本方案修复**：§5 补 frontmatter/文件名/自指/PR/linked resource 全清单与旧 ID 溯源句，和 #1664 对齐。
6. **#1664 混合 FID commit 历史 → 本方案修复**：已读 pr-collector.ts:14-23，其关联语义为 commits ∪ body 一对多；风险 #7/验证 #8 补改号后的链关联/gap 核对与 squash 后唯一新 FID 口径，不重写远端历史。

r1 合规校验：报告含 3 个独立焦点、模型多样性、file:line、913 ID 全量扫描与正则/文件名/memory 探针；工作区 `r1-review-F20261027-fidr.md` 已回读。六条均由作者（大獭）本方案修复，无 r2 争议。

### r1 delta（检视-fid方案）

**通过**：六条建议 14/14 落点核查 PASS，无新增严重、无新矛盾；完整报告在工作区 `delta-review-F20261027-fidr.md`。

- 新增 low 措辞项（CI 现行允许大写/无上限而非小写）→ 按检视预批准文本本方案修复，改完即闭环，无需再开 delta。
- 设计取舍表改名摘要补「完整清单见 §5」→ 已顺手修正。

方案定稿待搭档对「显式短横线 + 宽读严写 + 存量不迁移」拍板；确认后进入实现。
