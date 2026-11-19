---
id: F20261119mgrrb
title: 迁移校验与回退（#1868 阶段 6 切片 6b）：export/restore/verify 三工具 + 回退 runbook
change_type: feature
tags: [deployment, migration, sqlite, verify, rollback]
modules: [ci, docs]
summary: 阶段 6 切片 6b：中枢数据域上云的搬运与校验工具链——export（停源 fail-closed 探活 + sqlite backup API 一致性导出 + manifest 记录全量 sha256 与逐表行数）、restore（解包即三级校验：文件 sha 全量/表行数逐库逐表/多余文件检测，不过即停留现场）、verify（幂等独立重跑，切流后巡检与回退前比对复用）。数据域白名单单源（主库+durable-sessions+workspaces+sessions+attachments+feishu+metrics+owner-password；不含 models/backups/logs/rehearsal，对齐关 bge 资源定稿）。配套 migrate-runbook.md 覆盖真切七步序列与回退剧本（云端验证期增量丢弃语义如实披露）。
intent:
  problem: "阶段 6a 给了部署底座但数据还全在本机；把 ~12G 数据域搬上 ECS 需要一致性保证（活库快照会损坏）、完整性证明（搬完怎么信）、以及回退路径（搬坏了怎么回）——三件事缺一不可切流"
  expected_effect: "export→restore→verify 工具链可用且被端到端测试钉住：停源才可导出（fail-closed 探活）、sqlite 走 backup API（WAL 合并语义）、manifest 含全量 sha256+逐表行数、restore 内置三级校验不过即停、verify 幂等可重跑；回退剧本明确「本机数据冻结点可随时重启」"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/scripts/migrate-tools.test.ts：白名单收集/排除（4 断言组）+ manifest 自校验 + 篡改三态检测（sha 或 size/表行数/多余文件）+ CLI 端到端（export→restore→verify 真实 tar.gz 全链路，4 例）"
      - "deploy/ecs/migrate-runbook.md：真切七步 + 回退剧本 + 演练三命令"
capability_test: "tests/scripts/migrate-tools.test.ts"
---

# F20261119mgrrb：迁移校验与回退（阶段 6 切片 6b）

## 背景

阶段 6a（#1945）交付部署底座后，数据迁移是真切前的最后一道工程墙。资源定稿不变：
关 bge（FTS-only），迁移集 ~12G vs ECS 剩 19G。

## 工具链

| 脚本 | 职责 | 关键语义 |
|---|---|---|
| `scripts/migrate-export.mjs` | 停源一致性导出 → tar.gz + manifest | 探活 fail-closed（/api/ping 可达即拒，--skip-liveness 调试逃生口且产物打标）；sqlite 走 better-sqlite3 backup API；普通文件 clonefile/reflink；manifest 对 staging 计算（与产物严格同源） |
| `scripts/migrate-restore.mjs` | 解包 + 内置校验 | 三级不过 exit 1 留现场；--require-empty 防误覆盖 |
| `scripts/migrate-verify.mjs` | 独立幂等重跑 | 切流后巡检 / 回退前快照比对复用 |
| `scripts/migrate-lib.mjs`（+ .d.mts） | 共享库 | 白名单单源 / sha256 流式 / 表行数快照 / 三级校验纯函数 |
| `deploy/ecs/migrate-runbook.md` | 操作剧本 | 真切七步 + 回退剧本 + 演练三命令 |

三级校验：①文件清单+大小+sha256 全量 ②sqlite 逐库逐表行数 ③目录内多余文件检测。

## 设计决策

- **白名单而非黑名单**：迁移域显式枚举（MIGRATE_INCLUDES 单源）——新增数据目录必须
  显式入单，防止「忘了排除新垃圾」或「忘了带上新数据」两头错。
- **manifest 对 staging 而非活数据计算**：校验基准与 tar 内容严格同源（活数据在
  计算期间再变也不影响基准正确性）。
- **表行数而非业务级校验**：行数是 schema 无关的通用不变量（100 表零适配）；
  业务级抽查留给演练轮人检。
- **restore 不自动回滚**：校验失败留现场供诊断（自动删一半的状态更难排查）。

## 已知边界

- 演示级端到端用小 fixture；12G 真数据的耗时/内存曲线在 6c 演练轮实测。
- durable-sessions 逐库 backup 是串行的（184 个小库实测很快；如慢可并行化，暂不做）。
- manifest 不含文件权限位（tar 保留权限；校验只管内容——权限漂移由 restore 后
  systemd 起不来这类硬失败暴露）。

## Verification

| 验证 | 结果 |
|---|---|
| tsc --noEmit | EXIT=0 |
| vitest（migrate-tools 4 例，含真实 tar.gz 端到端） | PASS |
| 全量回归 | 见 PR checks |

## Rollback

revert 单 commit：纯增量工具（scripts/ 四文件 + runbook + 测试），无 schema 无运行时改动。
