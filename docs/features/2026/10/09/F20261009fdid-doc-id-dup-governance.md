---
id: F20261009fdid
title: '特性文档 id 重复治理（#1274）：两组存量换新 id + lint:docs 唯一性检查防复发'
summary: |
  两组特性文档共用同一 frontmatter id（F20260824ax376 两篇 / F20260903gh698 两篇）
  治理：ax376 组保留 pr-evaluation、fix-lock 换新 id F20261009slmc 并 rename 到
  2026/10/09；gh698 组保留 kill-position-fp、false-positive-modes 换新 id
  F20261009bgfm 同样 rename。两个历史文档的 rename + frontmatter id 编辑走
  .doc-fix 声明通道（lint-historical-docs rename 通道，#1273 已验证）。
  防复发：lint:docs 新增 id 唯一性检查（findDuplicateIds 纯函数，重复 id 一律
  error），5 个锁定用例（含两组原始形态）。intent-exempt-list.txt 注释中
  「重复 ID 歧义」现状描述同步更新。两组建档时清零存量，检查上线即绿。
change_type: fix
capability_test: tests/lint/lint-docs.test.ts
related_issues: ["#1274"]
causal_links:
  from:
    - F20261001lrbk
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-09
intent:
  problem: "两组特性文档共用同一 frontmatter id（F20260824ax376/F20260903gh698 各 2 篇）——id 是 sync_docs 入库主键，重复致后同步覆盖前同步（fix-lock 篇内容已在记忆库丢失）"
  expected_effect: "docs/features 全库 id 唯一；lint:docs 对重复 id 报 error 阻断 commit；新 id（F20261009slmc/F20261009bgfm）经 sync_docs 入库可检索；既有测试零回归"
  verify_by:
    type: behavior_check
---

# 特性文档 id 重复治理（#1274）：两组存量换新 id + lint:docs 唯一性检查防复发

## 背景

issue #1274（2026-10-01，#1257 清 lint:docs 存量时发现）+ #1283 检视发现的第二组（大獭勘察纳入同案治理）：

两组特性文档共用同一 frontmatter id。文档 id 是记忆库（sync_docs 入库）的主键性质标识——同 id 双文件时后同步的覆盖前同步的，且无任何机制拦截新重复产生。

**危害实证**：ax376 组 fix-lock 篇（SimpleLockManager 并发修复，PR #383）的内容已
在记忆库被 pr-evaluation 篇（PR #386，同日合入、后同步）覆盖丢失——issue 描述的
病已实际发生，不是理论风险。

## 处置（两组）

### 组 1：F20260824ax376（本 issue 原案）

| 文件 | 处置 | 依据 |
|---|---|---|
| `docs/features/2026/08/24/F20260824ax376-pr-evaluation-system-phase1.md` | **保留 id** | 外部引用 6 处（F20260917sdpl:47/74、F20260825evgl:28/193/247、F20260824rhib:93）+ 代码引用（src/frameworks/db/schema.ts:614 注释、tests/frameworks/db/migration.test.ts:233、tests/lint/lint-intent.test.ts:2/493）全指 PR 评估体系语义；记忆库在场的也是它 |
| `docs/features/2026/08/24/F20260824ax376-fix-lock-manager-concurrency.md` | **换新 id F20261009slmc** + rename 到 `docs/features/2026/10/09/F20261009slmc-simple-lock-manager-concurrency-fix.md` | 全仓零外部引用；记忆库该 id 的记录已被 pr-evaluation 后同步覆盖（本篇内容丢失在库中——重复 id 危害的实证本体） |

### 组 2：F20260903gh698（#1283 检视发现，一并治理）

| 文件 | 处置 | 依据 |
|---|---|---|
| `docs/features/2026/09/03/F20260903gh698-bash-guard-kill-position-fp.md` | **保留 id** | 记忆库在场的是本篇内容；外部代码引用（src/frameworks/agent/kill-segment-finder.ts:10/14/18/80/112、src/frameworks/agent/bash-safety-guard.ts:193/213）语义核对全指「kill/skill 位置感知匹配」——即本篇主题（false-positive-modes 的 Fix 2 是其子集重述） |
| `docs/features/2026/09/03/F20260903gh698-bash-guard-false-positive-modes.md` | **换新 id F20261009bgfm** + rename 到 `docs/features/2026/10/09/F20261009bgfm-bash-guard-false-positive-modes.md` | 外部引用零语义命中（详见下方引用核对表）；记忆库该 id 只有 kill-position-fp 内容（本篇从未入库） |

### gh698 组引用核对表（逐点语义核对）

| 引用点 | 上下文语义 | 指向 |
|---|---|---|
| `src/frameworks/agent/kill-segment-finder.ts:10` | 「bash -c 支持引号包裹的内嵌命令」——kill 检测正则扩展 | kill-position 主题 ✅ 保留方 |
| `src/frameworks/agent/kill-segment-finder.ts:14` | 「pkill/killall 族含路径穿透，加 i 标志」——kill 命令正则 | kill-position ✅ |
| `src/frameworks/agent/kill-segment-finder.ts:18` | 「位置感知匹配——regex match 必须出现在命令位置」——本篇核心方法 | kill-position ✅ |
| `src/frameworks/agent/kill-segment-finder.ts:80` | 「位置感知匹配 + 间接防线兜底」 | kill-position ✅ |
| `src/frameworks/agent/kill-segment-finder.ts:112` | 「按 shell 操作符分段。#777 起含 \| 管道：F20260903gh698 不含 \| 的理由」——kill 段划分口径 | kill-position ✅ |
| `src/frameworks/agent/bash-safety-guard.ts:193` | 「去引号——bash -c 'kill N' 中 PID 被引号包裹」——extractLiteralPids | 两篇同述（kill-position「辅助修复」/bgfm「Fix 3」）；kill-position 在场，指保留方 ✅ |
| `src/frameworks/agent/bash-safety-guard.ts:213` | 「改用 word-boundary 正则——includes("node") 会误匹配 "ffmpeg" 子串」——pkillTargetsOtter | 同上，两篇同述，指保留方 ✅ |
| `scripts/lint-intent.mjs:186`（注释，本 PR 已改） | 「重复 ID 实测存在」的治理前现状描述 | 两篇整体（id 重复本身），非语义指向 ✅ |
| `scripts/intent-exempt-list.txt:6`（注释，本 PR 已改） | 同上 | 两篇整体 ✅ |
| `docs/features/2026/09/22/F20260922gpqa` frontmatter from | 「findKillSegments 引号感知」的前置演进——kill 检测修复链 | kill 检测主题，指保留方 ✅ |
| `docs/features/2026/09/28/F20260928grv2:21` | related 列表「F20260903gh698 # 对抗变形」 | 守卫修复链演进，指保留方 ✅ |
| `docs/features/2026/09/28/F20260928grv2:50` | 「6 轮补丁演进（F20260830bsgr → F20260903gh698 → …）」 | 守卫修复链演进，指保留方 ✅ |

**结论**：gh698 组保留 kill-position-fp（记忆库在场 + 全部语义引用命中它），false-positive-modes 换新 id。核对发现的显著问题（false-positive-modes 声称模式1 本次修，但模式1 实际由 F20260902gvrd 修复——kill-position-fp 记述正确）**不改历史文档正文**（lint-historical-docs 禁止），如实记入本表。

### 新 id 规范执行记录

- F20261009slmc / F20261009bgfm：F + 当日日期（2026-10-09，`date` 实跑取）+ 4 位随机后缀，全仓 grep 查重零命中
- 文件名同步 rename（git mv，R100 rename 配对）
- 挪入 `docs/features/2026/10/09/`（id 日期段必须匹配目录路径——frontmatter-validator validateFilePath 强制）
- 历史文档 rename + frontmatter id 编辑走 .doc-fix 声明（两文件同一 commit；.doc-fix 内容见 commit，提交后删除）

## 防复发（lint:docs id 唯一性检查）

### 实现

`scripts/lint-docs.mjs`（既有 commit-time gate 内新增检查项，非新机制）：

- 新增纯函数 `findDuplicateIds(entries)`：收集全 docs/features + docs/research 的 `{rel, id}`，重复 id → `Map<id, files[]>`
- 主循环改为 `main()` + isMain 守卫（对齐 lint-intent.mjs 模式，import 时只暴露纯函数不跑文件遍历）
- 重复 id 一律 **error**（阻断 commit）：打印共用文件清单 + 换新 id 指引
- 缺 id 条目跳过（缺 id 由 validateXxxFrontmatter 管辖，不属重复语义）

### 锁定用例（tests/lint/lint-docs.test.ts，5 个）

1. 两文件共用同 id（ax376 组原始形态锁定）
2. 三文件共用同 id（泛化覆盖）
3. 无重复 → 空 Map（治理后期望态）
4. 缺 id 跳过（不误报）
5. 多组重复同时报（不只报第一组）

### 存量清零 + 上线即绿

两组重复在本 PR 建档时已换新 id 清零 → 检查上线时全库 id 唯一，`npm run lint:docs` 直接绿（PR Verification 节实跑输出为证）。

## 设计取舍

- **为何 rename 到 2026/10/09 而非留在原目录**：validateFilePath 强制 id 日期段 = 目录路径（src/entities/document/frontmatter-validator.ts:185），新 id 含 20261009 → 留在 08/24 或 09/03 目录会被 lint:docs 报 error（File path does not match expected）。挪目录是唯一合法路径。**新 id 日期段口径（检视 S1）**：用治理日 2026-10-09 而非创作日——代价是 frontmatter created_at 仍为原创作日而 id 日期段是换 id 日，两者语义不同（id 日期段=「该 id 的诞生日」而非「文档内容的创作日」）。备选「新 id 沿用创作日日期段」被否：validateFilePath 强制目录路径与日期段一致，沿用旧日期段就得留在旧目录，与新 id 查重隔离性（新旧同目录易混淆）冲突，且 lint date-bombs 门对 2026-10-09 前后日期无影响。本口径与 #1168/#1126 的 FID 顺延先例一致（顺延即改日期段）。
- **为何 fix-lock/false-positive-modes 换 id 而非保留方换**：保留方判定标准 = 外部引用语义全指向它 + 记忆库在场记录是它。换错方向会把 6+ 处外部引用和记忆库在场记录全部切断。
- **历史文档正文一字不动**：lint-historical-docs 铁律。false-positive-modes 的「模式1 修复归属失实」问题如实记录在本特性文档核对表，不回改历史正文。
- **lint 检查放 lint:docs 而非新脚本**：lint:docs 已遍历全文档解析 frontmatter，加检查项是既有机制语义内补缺（修法决策树①）；新建脚本反而重复遍历。
- **机制识别检查点判定（动手前完成）**：新增配置字段/枚举/开关：无；新增状态生命周期：无；新增定时任务：无；新增信号类型：无；新增持久化存储：无；新增决策分支被持久化消费：无（lint 检查是纯运行时判定，exit code 不落盘）；新增跨模块调用路径：无。**全部未命中 → 修法决策树①（既有机制语义内修），Modification-Class: narrow-fix**。

## 影响范围

- `docs/features/2026/08/24/F20260824ax376-fix-lock-manager-concurrency.md` → `docs/features/2026/10/09/F20261009slmc-simple-lock-manager-concurrency-fix.md`（rename + frontmatter id 行，正文零改动）
- `docs/features/2026/09/03/F20260903gh698-bash-guard-false-positive-modes.md` → `docs/features/2026/10/09/F20261009bgfm-bash-guard-false-positive-modes.md`（rename + frontmatter id 行，正文零改动）
- `scripts/lint-docs.mjs`（id 唯一性检查 + main() 重构）
- `scripts/intent-exempt-list.txt`（注释行更新：重复 ID 现状描述 → 治理后留档）
- `scripts/lint-intent.mjs`（186 行注释同步）
- `tests/lint/lint-docs.test.ts`（新建，5 锁定用例）
- `docs/features/2026/10/09/F20261009fdid-doc-id-dup-governance.md`（本文档）

## 验证（全部实跑）

- [x] 单测：`npx vitest run tests/lint/lint-docs.test.ts` → 5/5 绿（08:57 实跑：Test Files 1 passed / Tests 5 passed）
- [x] lint:docs 全库绿：`npm run lint:docs` → 741 docs OK，3 warnings（基线不变，id 唯一性检查上线即绿）
- [x] lint:docs 红-绿验证：构造 F20261009slmc 重复 fixture → 命中 `[duplicate id] F20261009slmc 被 2 个文件共用` error；删除后复跑绿（exit=0）
- [x] lint:historical-docs：rename + .doc-fix 声明过闸（commit 时实跑输出：`放行 2 个历史文档修改`；R99% + id 行编辑走两侧 frontmatter 边界校验路径）
- [x] lint:intent 727 docs OK / lint:capability 68 warnings（上限不变）/ lint-prompt-anchors / lint:date-bombs / lint:skills / lint:tool-manifest 全绿
- [x] 全量测试回归：`npx vitest run` → 339 files / 5076 tests 全绿
- [x] 最简实现检查：已过——lint:docs 既有遍历内加纯函数检查，无新脚本/新依赖/新遍历；处置记录集中在一份特性文档，不散落
- [x] sync_docs 后 search_memory 按 F20261009slmc / F20261009bgfm 可检索（worktree 内 sync_docs 实跑：synced 3 / archived 1；search_memory 按 F20261009slmc 命中 SimpleLockManager 并发修复内容（fix-lock 重插成功）、按 F20261009bgfm 命中误报两模式内容（首插）；F20260903gh698 记录只剩 kill-position 内容）
- [ ] **收尾环（合并后主仓执行，检视 S1 修正后的 durable 验收判据）**：主仓根跑 sync_docs（默认 rootDir）→ 验收判据是生产库 features 表 F20261009slmc / F20261009bgfm / F20261009fdid 的 **status = active**（仅「search_memory 可检索」不合格——archived 记录同样可被检索到，拦不住归档态）

## 已知边界（检视 r1 处置：共享记忆库 sync 归档脆弱性）

**现象（10/09 实测）**：生产库 features 表中 F20261009slmc / F20261009bgfm / F20261009fdid 及保留方 F20260824ax376 一度全部 status=archived。

**机制（sync-documents.ts:321 archiveDeletedDocuments）**：sync 按 rootDir 扫描磁盘，库内任何 active 记录的 filePath 在该 rootDir 下不存在 → 归档。本项目多 worktree + 主仓共存，每个 rootDir 树的文件集合不同：
- worktree sync 时：主仓重命名后的新路径不在 worktree 树（若记录 filePath 是主仓形态）→ 归档；更隐蔽的是保留方 ax376——它库内记录的 filePath 曾是 fix-lock 旧路径（重复 id 时代的错乱写入），rename 后该路径在任何树都不存在 → 被 worktree sync 归档（本 PR worktree sync 的 archived:1 即它）。
- 主仓 sync（合并前）同理：PR 分支的新路径不在主仓树 → 再归档。

**影响**：合并前的任何中间 sync 都是搅动源；最终以合并后主仓根的 sync 为准收敛（见收尾环）。

**根治方向（不在本 PR 范围）**：sync 归档按 rootDir 限定本树来源的记录（如按入库 root 打标，只归档自己树的记录），或 archiveDeletedDocuments 对「 filePath 在其它已知 root 存在」做交叉检查。建议另立 issue 跟踪。

### 模式1 修复归属失实的可发现性（检视 S2）

false-positive-modes 篇（新 id F20261009bgfm）正文声称「模式1 本次修」，但模式1（eval 词元命令位置限定）实际由 F20260902gvrd（PR #757，前一天）修复——kill-position-fp 篇记述正确。历史正文不可改（lint-historical-docs 禁止），本核对表如实留档。检视 S2 建议的 .doc-fix 通道订正不采用：该通道仅限元数据订正（id 对齐/格式订正），修正事实性叙述属内容修改、按通道语义应走 supersede 新文档——但本失实是同 commit 双篇撞 id 时代的记述出入，杀伤面小（两篇各自自洽），单独立 supersede 文档不成比例，本节即为可发现性留档（新 id 的 relates-to 链 + 本节均可检索到该出入）。若后续有人按 bgfm 篇追溯模式1 修复，以本节为准。

## 对抗审视 r1 处置记录（检视獭-1375，1 严重 + 3 建议）

| 发现 | 处置 |
|---|---|
| **严重 1** fix-lock 重插未达 durable 终态（生产库 status=archived，「search_memory 可检索」验收口径拦不住归档态） | 采纳：验收判据改「features.status = active」+ 新增「收尾环」条目（合并后主仓根 sync 复核）+ 新增「已知边界（共享记忆库 sync 归档脆弱性）」节（含机制、双向影响面、根治方向另立 issue） |
| 建议 S1 新 id 日期段口径未声明 | 采纳：设计取舍段补口径（id 日期段=诞生日语义，与 FID 顺延先例一致，备选创作日方案被否及理由） |
| 建议 S2 模式1 归属失实可发现性增强 | 部分采纳：不用 .doc-fix（通道语义限元数据订正，事实叙述修改应走 supersede，不成比例）——以本文档专节留档 + relates-to 链承载可发现性，并修正简报转述误差（原文是「声称模式1 本次修」非「声称 PR #760」） |
| 建议 S3 findDuplicateIds 与 format 门隐式耦合 | 采纳：lint-docs.mjs 函数 JSDoc 补耦合声明（未来 format 门放宽需同步引入规范化比对） |
