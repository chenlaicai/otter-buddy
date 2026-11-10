---
id: F20261110rstor
title: 链接资源恢复字段补全与归档对账
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 生产数据恢复脚本与 SQLite 对账，无 LLM 参与行为"
intent:
  problem: "#1793 的 120 行已恢复记录仍有字段缺口且 109 行保持 active，需要只凭可靠来源补全并归档"
  expected_effect: "120 行均归档且 memory 镜像 120/120、悬挂 0；可证明字段回填，缺失来源的字段逐项保留，active 计数按归档数精确对账"
  verify_by:
    type: behavior_check
causal_links:
  - F20261110archy
  - F20260720k3m7
summary: 为 #1793 的 120 行恢复记录提供可 dry-run 的备份/事务脚本；仅从 10-26 备份与合并文档回填字段，归档全部记录并保留不可恢复项证据。
---

# 链接资源恢复字段补全与归档对账

## 范围

#1807 已修复 DELETE 的代码语义，但没有改写生产恢复行。本特性承接 #1805：对 `linked_by='restored-1793'` 的 120 行做可复核字段补全、终态归档和 active/memory 对账。无来源字段不伪造“无损恢复”。

## 只读来源盘点

- 当前 120 行：109 active / 11 archived；memory_entries 镜像 120/120，悬挂镜像 0。
- `data/backups/otter-buddy-pre-ghost-cleanup-online-2026-10-26T06-36-53-256Z.db` 覆盖 20/120。
- 可从该备份恢复：原 `linked_by` 20 条、category 10 条、group_id 若干；其他非空值冲突必须先人工复核，不直接覆盖。
- 合并 commit / PR 标题 / 特性文档可证明 11 条 pr/worktree/branch 的 groupId；另有一条 groupId 由备份补齐，共 12 条。

### 无可靠来源的必填组

以下 3 条保留 `group_id=NULL`，不得从 URL 或标题猜 F 编号：

| id | 类型 | 标题 |
|---|---|---|
| `5179c4cd-f78f-4354-9a28-3b858d6b0894` | pr | CoLink #2504 撤回公共骨架 PR |
| `ff60269d-fcd9-4286-a484-c0bcdadfd9c8` | worktree | dm-topic-summary |
| `78d5270f-c0d2-4d30-82ec-4ee4e2d39139` | pr | 私聊话题总结链复用频道生成链 |

其余缺口也如实保留：category 110 条、metadata 120 条、otter_id 120 条、superseded_by 120 条；auto_linked 的 0 是恢复时默认值，不能当成已核实原值；原 `linked_by` 无备份来源的 100 条保留 `restored-1793` 占位。

## 恢复机制

`scripts/recover-linked-resources-1793.mjs` 默认 dry-run，只有 `--apply` 才写：

1. 预检 120 行与 20 条备份匹配；冲突即拒绝。
2. 用 better-sqlite3 backup API 生成一致性安全备份，而非直接 cp 活库。
3. 单事务只更新有来源的 category/linked_by/group_id，再按 120 个 ID 归档；不按恢复占位符归档，避免原 linked_by 恢复后漏掉 20 行。
4. 复核 integrity_check、active 前后差值、120/120 archived、memory 镜像 120/120、悬挂 0；证据 JSON 落盘。
5. `--db=<path>` 支持最小彩排库，正式生产写与 rehearsal 分离。

## Acceptance Test

| 判据 | 证据 | 状态 |
|---|---|---|
| dry-run 不写且来源可复核 | `/tmp/otter-1805-dryrun.json`：120 行、20 备份、28 行更新计划、3 个未决 groupId | ✅ |
| 备份/事务/归档/对账可执行 | 最小彩排库 120 行 + memory 120 行，apply 后 120 archived、109 行状态变化、integrity ok、active 109→0、镜像 120、悬挂 0 | ✅ |
| 生产备份与事务恢复 | 生产安全备份路径、执行前后计数、证据 JSON | ✅ 已执行 |
| 生产最终对账 | 生产 active 1615→1506、120/120 archived、镜像 120、悬挂 0 | ✅ 只读复核一致 |

彩排首次还证明直接对 3.3GB 活库做完整副本可能超过 5 分钟工具窗口，因此生产备份需独立长时执行，不能把超时中断当作完成。

## 生产执行记录

独立审查通过后，于 2026-11-10 10:14 从**主仓根目录**执行正式 `--apply`：

- 安全备份：`data/backups/otter-buddy-pre-restore-fields-1805-2026-11-10T02-14-57.672Z.db`（3,956,371,456 bytes；backup API 一致性备份，另行只读 integrity_check=ok）。
- 证据：`data/backups/restore-1793/restore-fields-1805-evidence.json`。
- 28 行发生有来源更新：linked_by 20、category 10、groupId 12；其余无来源字段保持缺口。
- 109 行由 active 改为 archived；全量 active 1615→1506，120/120 archived。
- 生产只读复核：integrity_check=ok、memory 镜像 120/120、悬挂 0。
- 两处旧 slug 重命名已写入 `supersededBackupValues`：F20261026gcfb→F20261030gcfbx、F20261020chatunify→F20261022chatunify，均服从现行 merge 证据。
- 二次执行会因原占位行数守卫拒绝，防重复恢复。

## 独立审查

检视獭-1805（模型别名 `apig-glm-5.3-flash`）r1：**通过，可执行生产 apply，无严重问题**。独立复现 dry-run 一致，逐条核对 merge/文档来源、120 ID 归档、事务与 active 公式、幂等守卫和 memory 对账。B1 已把备份旧 slug 与现行值冲突落证据；B2 正式执行从主仓根目录；B3/B4 生产记录与彩排分开回填。
