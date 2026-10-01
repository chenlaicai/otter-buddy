---
id: F20260930lrbk
title: "lint:docs 警告 ratchet 清存量：271→3，历史文档 rename 开口修复"
summary: |
  lint:docs 警告 ratchet 顶满（271/271），下一份新增警告的文档即撞墙。本特性按五类盘点后清存量：
  221 条 slug title 按正文 H1/summary 派生人类可读 title（205 机械 + 16 手工消歧），38 条旧
  change_type、2 条旧 status 迁移到现行枚举，audit 补进 KNOWN_EXPLORATION_TYPES（R20260810piab
  在用且语义真实），6 个缺 slug 文件名 git mv 补后缀（另 3 个被历史文档相对链接引用，rename 会
  断链，跳过豁免）。顺带修复 lint-historical-docs 对 R 形态 rename 的双重误拦（.doc-fix 声明
  + 纯 rename 放行 / rename+编辑按两侧 frontmatter 边界校验）。MAX_WARNINGS 271→3 锁死成果。
change_type: feature
status: active
capability_test: "n/a: 文档元数据批量订正 + lint 脚本行为变更（A/B 类），行为变化由 tests/lint-historical-docs.test.ts 与 lint:docs 自身验收"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
---

# F20260930lrbk lint:docs 警告 ratchet 清存量

## 背景

issue #1257：`scripts/lint-docs.mjs` 的 ratchet `MAX_WARNINGS = 271` 已顶满（2026-09-30 实测 271 warnings / 696 docs OK）。ratchet 设计意图是「警告数只减不增」，但顶满状态下任何新增 1 个警告的文档都会直接越限失败——下一份特性文档提交者必撞墙。

## 盘点（2026-09-30 基线，main 4b5e418f）

| 类别 | 数量 | 处置 |
|---|---|---|
| Title looks like a slug | 221 | 205 条正文 H1 剥 ID 前缀后全库唯一→机械派生；16 条按 summary 首句手工撰写（4 条重复 H1 消歧、12 条无中文 H1/无 H1） |
| 旧 change_type | 38 | bugfix×23→fix、feature_update×10→feature-update、new_feature×3→feature、Refactor×1→refactor、docs×1（hk47）→feature-update |
| 旧 status | 2 | review→implemented（hybr，RRF 已上线 src/usecases/memory/search-engine.ts）、reviewed→active（rbrg，代码已落地 bootstrap 全层） |
| 旧 exploration_type | 1 | audit 收编进 KNOWN_EXPLORATION_TYPES（R20260810piab 在用，语义真实：对既有实现/依赖的审计型研究；DB 无 CHECK 约束、web 无硬编码，零破坏面） |
| 文件名缺 slug | 9 | 6 个 git mv 补后缀（内容零变化）；3 个跳过（见下） |

## 取舍

### 3 个文件名不改（ratchet 地板）

F20260716i5n2 / F20260826mwrd / F20260826sgpa 被其他历史文档正文以相对链接引用（t2ab:340、x7k3:201、c2sg:15、c3hr:15、c4sg:15）。rename 会断链；修链接=改历史文档正文，被 lint:historical-docs 禁止。三者长期豁免，MAX_WARNINGS 下调到 3（不是 0）。

### R 形态 rename 双重误拦修复（lint-historical-docs）

本 PR 要 git mv 6 个历史文档，实测发现纯 rename（similarity 100%）被双重误拦：

1. `isAddedOnBranch` 按 oldPath 判历史 → 报「本分支新建才可改」
2. `checkFrontmatterScope` 用 `-- <newPath>` 单路径 diff，rename 检测被抑制，文件呈现为「全文新增」，行号必然越界 → 拦

修复（F20260930lrbk，机制不是约定，.doc-fix 声明对 rename 通道同样强制）：

- R 配对改从全量 staged diff（`-M` 显式开启 rename 检测）提取本文件段：
  - similarity 100% 且无 hunk → 纯 rename（内容零变化，文件名级元数据订正）→ 放行
  - 有 hunk → rename+编辑，按 old/new 两侧 frontmatter 边界校验（正文编辑仍拦）
  - 未匹配到 R 配对（相似度 <50% 退化 A+D）→ 宁拦（大改不是文件名订正）
- 修掉原 hunk 扫描两处边角：`indexOf("@@")` 会被 hunk 体内含 @@ 的行干扰（改行首锚定 `\n@@`）；diff 末段无尾随换行时 `(?=\n(?:diff --git |$))` 永不匹配（look-ahead 重组）

测试锁定：tests/lint-historical-docs.test.ts 新增 4 用例（R100+声明放行 / 无声明拦截 / rename+frontmatter 编辑放行 / rename+正文编辑拒绝），22/22 通过。

### new_feature→feature 的连带（lint:capability ratchet 持平）

lint:capability 的 ratchet（68）对 `change_type: feature|prompt` 强制 capability_test。3 个 new_feature→feature 迁移文档中 2 个缺声明（ax376-pr-evaluation、rhib），已按同类格式补 `n/a` 理由，68/68 持平不推高。

## 影响范围

- **本 PR 触碰约 252 个历史文档的 frontmatter**（title/枚举/capability_test）+ 6 个 rename + 3 个代码/脚本文件（known-values.ts、lint-docs.mjs、lint-historical-docs.mjs）+ 1 个测试文件 + docs/README.md 陈旧行订正
- **历史文档 frontmatter 订正，不改正文语义**——所有 M 变更行均在 frontmatter 块内（lint-historical-docs 机械校验放行为证）
- doc-sync：文件名变化会触发 file_path 变化与 memory 库重插，合入后需跑 sync_docs 收敛（主仓侧动作）
- memory 库 id 残留：ax376 双文件共用 id 的存量问题（见 Discovered Issues），本 PR 不动 id

## 验证

- `node scripts/lint-docs.mjs`：**3 warnings（上限 3）/ 696 docs OK / 0 errors**（271→3）
- `npm run lint:capability`：68 warnings / OK（与 main 持平）
- `npm run lint:intent`：237 warnings / 682 docs OK / exit 0（与 main 同为不阻断量级）
- `npx vitest run`：312 files / 4470 tests 全绿
- lint-historical-docs 门禁：.doc-fix 放行 246 个 M + 6 个 R

## Discovered Issues（职责外发现，不在本 PR 处置）

1. **F20260824ax376 id 重复**：fix-lock-manager-concurrency 与 pr-evaluation-system-phase1 两个文件 frontmatter id 相同。id 是 DB 主键性质（fid 唯一约束），重复会致 sync 归档/检索错乱。修 id 牵动 DB/file_path/引用链，超出本 PR 范围，建议单独立 issue。
2. **docs/README.md:14 title 约束陈旧**：写「建议 kebab-case，与文件名后半段对齐」，与同文件 :31-33（title 应人类可读、slug 放文件名）矛盾——已顺手订正进本 PR。
3. **#1256 与 #1258 是同一 bug 的两个立案**（实现獭-1256 在对话中的排查结论），建议大獭在 #1258 合入后二合一关停。
