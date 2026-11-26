---
id: F20261126mvpcf
title: 旧污染清理脚本 vec 删除 fail-closed
summary: cleanup-memory-pollution 启动即加载 sqlite-vec，vec 删除探测失败时抛出并回滚整个删除事务，不再跳过 vec 后删除主记忆；同时补齐 memory_vec_generations 联动与真实 vec0、故障触发器回归。
change_type: fix
doc_type: feature
created_at: 2026-11-26
created_in_conversation: f4402db8-9dee-4979-82b9-f0d46ed4f195
capability_test: "n/a: 纯 A 类 SQLite 运维脚本修复，由真实子进程、临时 vec0 文件库和故障触发器验证，不新增 LLM 自由行为"
tags: [memory, vector, sqlite, maintenance, safety, regression]
modules:
  - scripts/cleanup-memory-pollution.mjs
  - tests/scripts/cleanup-memory-pollution.test.ts
from: [F20260827mpcg, F20261126mvhyg, F20261124mvcas]
intent:
  problem: "旧污染清理脚本未加载 sqlite-vec，vec0 删除探测失败后把 delVec 置空并继续删除 memory_entries；vec 删除故障也会被吞掉，确定性地产生主 entry 已删而向量残留的孤儿。"
  expected_effect: "脚本加载 sqlite-vec 后，正常 apply 删除目标 entry 的 FTS/Vec/weights/task/edge/generation 全卫星且无孤儿；vec 删除不可用时进程失败、事务回滚，主 entry 与 weights 不变。"
  verify_by:
    type: behavior_check
    rollback: "revert 本 PR 可回滚代码，但会恢复旧脚本的孤儿风险；回滚后不得再运行旧 apply。无 schema 迁移，本 PR 未对真实主库写入，不涉及生产数据恢复。"
    risk_note: "只修旧污染清理这一历史产生路径；晚到 embedding 由既有代际 CAS 防护，本 PR 不重写。真实活库 apply 仍须单独批准。"
---

# 旧污染清理脚本 vec 删除 fail-closed

## 预注册与实际对照

- **预注册 X**：主要缺陷是旧清理路径只删主 entry 与其它卫星、跳过 vec；当前正常 `deleteBySource` 不是本次修复对象。
- **验证 Y**：最终测试夹具在 `origin/main` 旧脚本上应出现两类失败——目标 vec 残留；vec 删除失败被吞且主 entry 继续删除。修复后同一套测试应全绿。
- **反例 Z**：若正常加载 vec 后仍留孤儿，或故障时事务不能回滚，则说明不是单纯扩展装载问题，需要停止并重新定位。
- **实际**：预期完整命中。旧脚本最终夹具 4 用例中 2 红：目标 vec 残留 3 条；故障场景进程成功并删除 3 条主 entry。修复后同一套 4/4 通过。

## 两条历史产生路径与本次边界

### 路径 A：旧污染清理跳过 vec——本 PR 修复

`cleanup-memory-pollution.mjs` 原先没有加载 sqlite-vec；vec0 删除探测失败后把 `delVec=null`，但事务仍继续删除 weights、tasks、edges、FTS 和 memory_entries。只要目标 entry 有向量，就必然留下孤儿。缺少历次 apply 的完整日志，不能据此把现存 83,236 条逐条归因或分摊给此路径。

### 路径 B：晚到 embedding 在删除后写回——已由既有 CAS 防护

11/24 前的 `storeEmbedding` 可在主 entry 删除后写入晚到向量；`F20261124mvcas` 已加入 current entry + generation/content_hash 检查。文档归档—复活振荡是该竞态的放大条件，不是本 PR 要再修的第三个机制。本 PR 不改 writer、CAS、检索或文档同步。

## 实现与取舍

1. 打开 DB 后立即 `loadSqliteVec(db)`，dry-run 与 apply 使用相同连接能力；装载失败在删除前直接终止。
2. 保留既有 vec probe，但 catch 不再降级为 `delVec=null`，而是抛出带 cause 的明确错误。probe 或后续实际 vec 删除失败都会退出 `db.transaction`，整个删除回滚。
3. 增加既有 `memory_vec_generations` 表的联动删除；旧临时库无此表时保持兼容，不新增 schema。
4. 不改动既有备份方式、A/B/C 类清理口径、dry-run 默认值、主应用或真实活库。

机制判定：`Modification-Class: narrow-fix`。没有新增自动决策、调度、持久化结构或运行时检索语义，只让既有删除事务不再绕过其声明的 vec 卫星清理。

已过最简实现检查：复用项目已有 sqlite-vec 依赖和脚本事务，没有引入新模块、依赖或通用清理框架。正常路径与故障路径各一条行为测试即可判别本修复；故障用普通表 + BEFORE DELETE 触发器制造确定性错误，正常路径仍使用真实 vec0，两者不互相冒充。

## 负面向验收

- dry-run 仍不写库、不创建备份；A 空内容、B 重复 chunk、C archived chunk 的原有判定不变。
- 正常 apply 仍保留最新重复项和全部正常 entry；存活 entry 的 FTS/Vec/weights/generation 保留。
- vec 不可用时不再绕过保护：主 entry 与 weights 保持原值，事务无部分提交。
- 不修改历史文档、不改 `SqliteMemoryRepository`、不改检索排序/Vec 池深/模型/并发/scheduled prompt。
- 未对真实主库运行 apply 或 VACUUM；未清理任何为本次工作保留的 worktree/分支。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 既有 dry-run | 对临时污染库执行默认模式 | 报告污染，主库行数不变，无备份 |
| 既有正常 apply | 对含空内容/重复 chunk 的临时库执行 apply | 仅目标删除，最新重复项与正常 entry 保留，仍有备份 |
| 真实 vec0 全卫星 | 每个 entry 预置 FTS/Vec/weights，目标再置 task/edge，全部预置 generation | 目标六类表与 edge 均清零，孤儿=0；三个存活 entry 的主行与 FTS/Vec/weights/generation 均保留 |
| vec 删除故障 | 用普通表替代 vec 并注册 BEFORE DELETE 触发器，插入 probe 命中行后 apply | 进程非零、stderr 明确 fail-closed；六个主 entry 与六个 weights 不变 |
| 新旧对照 | 对最终测试夹具分别运行 `origin/main` 旧脚本与修复脚本 | 旧版 2 个目标测试失败；新版同一套 4/4 通过 |

## Verification

### 失败用例证据（bugfix）

- **修复前现象**：最终夹具对 `origin/main` 旧脚本运行，4 用例中 2 失败：①`memory_vec 目标残留: expected 3 to be 0`；②故障场景 promise resolved，stderr 原样为「跳过 vec 清理」，stdout 报告「已删除 3 条污染条目」。完整输出：`evidence/mvpcf-red-final.log`。
- **复现步骤**：在临时文件库建立真实 vec0 与全部卫星；故障用例改用普通表 + 拒绝 DELETE 触发器并插入 `__probe__` 行；执行 `npx vitest run tests/scripts/cleanup-memory-pollution.test.ts`。旧脚本通过 `git show origin/main:scripts/cleanup-memory-pollution.mjs` 临时恢复，运行后立即还原本 PR 实现。
- **修复后对照**：同一命令、同一最终夹具 **4/4 通过**，输出见 `evidence/mvpcf-green.log`。
- 中间两次夹具修正（重开库后加载 vec、参数化 SQL、让 probe 命中触发器）只修测试设施，未放宽任何业务断言；最终红灯已用最终夹具重跑确认。

### 当前检查

- `npx vitest run tests/scripts/cleanup-memory-pollution.test.ts tests/scripts/memory-vec-hygiene.test.ts`：2 文件、**9/9 用例通过**（本修复 4 + 相邻孤儿清理 5）。
- `npm run build`、`npx tsc --noEmit`、脚本与测试 ESLint、`npm run lint:tests`、`npm run lint:docs`、`npm run lint:intent`、`git diff --check`：通过。
- Golden Gate：n/a（纯 A 类确定性脚本，无 prompt/skill/tool description 行为变更）。
- CI 状态以 PR Checks 为准；本 PR 不以局部绿灯代替机械门。

## 风险与回滚

- 本修复让 vec 故障从「删主数据但留垃圾」变为「整体失败」，运维可见性和数据安全性更好；代价是本次清理需要修复 vec 环境后重跑，这是有意的 fail-closed。
- probe 失败发生在既有备份之后、事务删除之前，可能留下一个备份文件，但不会留下部分删除。
- 代码可 revert；但 revert 会恢复旧缺陷，回滚后必须停用旧 apply。无 schema 变更，本 PR 未写真实主库，不涉及生产数据回滚。

## 未执行事项

- 未执行真实活库污染清理或孤儿清理；实际删除仍走单独审批。
- 未重新修改晚到 embedding/CAS、正常 repository 删除、检索或健康观测；它们是已有独立边界。
