---
id: F20261110archy
title: 链接资源 DELETE 改为归档语义
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 纯后端状态机与 HTTP/SQLite 行为，无 LLM 参与行为"
intent:
  problem: "HTTP DELETE 物理删除 linked_resources，绕过归属和状态校验，与只归档契约冲突"
  expected_effect: "DELETE 对正确归属的 active/superseded 资源返回 204 且行转为 archived；未知 ID、跨对话和重复归档分别拒绝，生产代码无 linked_resources 物理删除路径"
  verify_by:
    type: behavior_check
causal_links:
  - F20260716ttf7
  - F20260720k3m7
summary: 将链接资源 HTTP DELETE 从物理删除改为归属校验后的归档；保留 204 兼容，删除 repository 物理删除面，并对既有 120 行恢复现场做显式对账。
---

# 链接资源 DELETE 改为归档语义

## 问题与搭档拍板

#1793 实证：自动体检调用 HTTP DELETE 后，120 行 `linked_resources` 被 SQL 物理删除，而非进入 `archived`。该路径绕过 `canTransitionArtifactStatus`，也不校验 URL 中的 conversationId 是否属于资源。

2026-11-10 搭档先询问「哪里有删除按钮？」，确认这不是已证实的可见 UI 按钮，而是后端 HTTP API 缺陷；随后原话「可以」，确认方向 A：DELETE 改归档语义，保留 HTTP 204。不得再把该事故描述成用户点击了界面按钮。

## 修复契约

1. `DELETE /api/conversations/:id/resources/:resourceId` 调用 `ManageKeyInfo.archiveResource(resourceId, conversationId)`，成功仍返回 204。
2. 资源不存在或 conversation 不匹配均抛 `not_found`（404），避免跨对话写及泄露他域资源存在性。
3. 已 archived 或其他不允许迁移的状态抛 `conflict`（409），不返回 204 假成功；active/superseded 可按既有状态机归档。
4. 删除 `ManageKeyInfo.deleteLinkedResource`、repository 接口/SQLite 实现与 mixin 的 `DELETE FROM linked_resources`，让生产代码不再暴露物理删除入口。
5. 归档只改 `status`，资源行、标题等字段与 memory_entries 镜像保留。HTTP GET key-resources 不过滤 archived 的既有行为不变；UI 时间轴与 `list_artifacts` 工具仍只显示 active/superseded。
6. 重复 DELETE 返回 409，因此本接口不是幂等删除。批量调用方遇 409 应把它视为已达 archived 终态并停止重试，不得放大为重试风暴；并发下 SQL 0-row 兜底同样映射为 409，不泄漏 500。

## 设计取舍

- 复用现有 archive usecase，不另建删除服务或垃圾回收机制。
- 不把 DELETE 改成 PATCH，也不改变 204，降低调用方迁移成本；领域行为按搭档拍板改为归档。
- conversation 不匹配按 404 而非 409，和未知 ID 使用同一外部语义，避免跨对话信息泄露。
- 物理删除方法直接删除而非保留为“备用”，防止未来调用方误回旧路径；历史数据恢复只走显式备份/恢复脚本，不走生产 API。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 正确归属 active 资源 DELETE | API 204；真实 SQLite 行仍存在且 status=archived | ✅ |
| 未知 ID / 跨对话 | usecase not_found，无状态写入；API 404 | ✅ |
| 已 archived 重复 DELETE | usecase conflict；API 409；行不变 | ✅ |
| 生产写路径 | 全仓无 `DELETE FROM linked_resources` 生产调用 | ✅ |
| 类型与既有行为 | 相关 API/usecase/SQLite 测试、tsc、ESLint | ✅ |

## 120 行恢复现场与边界

恢复报告（issue 2026-11-06 11:35）确认 120/120 行已回库，恢复前备份与 SQL 均在 `data/backups/restore-1793/`。2026-11-10 开工回查：`linked_by='restored-1793'` 共 120 行，对应 memory_entries 镜像 120/120 仍在；当时 109 active、11 archived。

既有缺口不因本代码修复自动消失：category/metadata/otter_id/auto_linked/group_id(14/19)/superseded_by 中无可靠来源的列不得伪造；`linked_by='restored-1793'` 是可追溯占位。数据归档与可恢复字段补全需单独事务备份和对账，不能用本 PR 的单元测试冒充生产恢复完成。

独立审查只读回查补充：120 行 memory 镜像 120/120；`source_table='linked_resources'` 但本体不存在的悬挂镜像为 **0**；全表状态仅 active/superseded/archived，conversation 外键孤儿为 0。

**范围切分**：本 PR 只交付 DELETE 代码语义与归属/状态校验，不用 `closes #1793` 自动关闭总 issue。120 行字段补全与 active/日报对账移 #1805；PATCH flag 与 `update_artifact_status` 的同族归属校验移 #1804。

## 验证记录

- 首轮聚焦：3 文件 39/39；r1 处置后扩展聚焦（含 scheduler mock 类型回归）：4 文件 **152/152** 通过。
- 端到端：真实 `createTestApp` + controller + usecase + SQLite 覆盖跨对话 404、正确归属 204、行保留 archived、重复 DELETE 409；另有源码机械护栏防物理删除回归。
- `npx tsc --noEmit`、相关 ESLint、`git diff --check` 通过。
- `npm run build`、`lint:docs -- --base origin/main`、`lint:intent -- --base origin/main` 通过。
- 源码检索：`DELETE FROM linked_resources` 零命中；`deleteLinkedResource` 仅剩 HTTP controller 方法名（对外 DELETE 入口，内部已改 archive）。
- 真 LLM 能力测试不适用。

## 独立审查

检视獭-1793（运行时模型别名 `apig-deepseek-v4.1-flash`）r1：**通过，0 严重 / 7 建议**。已在本 PR 处置：S1 并发 0-row→409；S2 删除无效 mock/断言并补源码护栏；S3 补真实 HTTP→SQLite 端到端；S4 补悬挂镜像 0 与状态值域证据；S5 另立 #1804；S6 修正 causal links；S7 补 HTTP 读取口径与非幂等重试语义。S7 的死 archive 接口不在本 PR 扩大清理，留作既有死代码边界。

r2 delta：通过，另留 3 条非阻断建议。R1 已改 repository 直接抛 `DomainError(conflict)`，usecase 不再匹配错误文案；R2 护栏递归扫 `src/`；R3 以运行时模型别名替代不可自证厂牌描述。

r3 最终 delta：**通过，无新问题**。三轮发现（7→3→0）全部闭环；聚焦 4 文件 152/152，扩面 tests/api + tests/usecases/conversation + tests/usecases/scheduler 共 58 文件由检视方复跑通过。
