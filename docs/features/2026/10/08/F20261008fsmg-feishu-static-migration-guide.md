---
id: F20261008fsmg
title: 飞书静态凭证迁移引导（存量用户 IM 页可见出口）
summary: PR #1194 退役 feishu 静态凭证后存量用户静默失联——/api/channels/status 顶层透传 deprecatedFeishuConfig 标记，IM 页飞书区块渲染迁移引导条替代误导性「未配置」
change_type: feature
capability_test: "tests/interface-adapters/http/channel-controller.test.ts"
intent:
  problem: "存量 config.yaml 保留 feishu 段的用户重启后飞书静默消失，仅后端一行英文 warn（app.ts:322），IM 页无任何引导——用户不知道要迁移也不知道怎么迁"
  expected_effect: "IM 页飞书区块出现 amber 迁移引导条：是什么（旧配置退役）+ 怎么办（删段重启 + 扫码选已有应用）+ 完整文档指引"
  verify_by:
    type: automated_tests
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-08
causal_links:
  - F20260929fsqr
tags: [im, feishu, migration-guide, backward-compat]
modules: [http-api, web-im]
---

# F20261008fsmg 飞书静态凭证迁移引导

## 背景与问题

PR #1194（F20260929fsqr，2026-09-29 合入）将 feishu 静态凭证段退役，扫码双模式成为唯一接入路径。退役时留了一条后端英文 warn：

```
Feishu static config is deprecated: scan-based onboarding (create new / select existing app) is now the only path. ...
```

（src/app.ts:321-327）

**缺陷**：存量用户不看后端日志。config.yaml 保留 feishu 段的用户重启后，飞书通道静默消失，IM 页显示「未配置」——误导用户以为从没配置过，实际是旧配置已退役。

issue #1211（delta 检视獭建议 7，review 5346781396）：API 透传迁移状态 + IM 页渲染迁移引导。

## 方案设计

### 数据流

```
config.feishu（启动时快照，静态）
  → app.ts initControllers(deps.deprecatedFeishuConfig = Boolean(config.feishu))
  → ChannelController 构造注入
  → GET /api/channels/status 响应顶层（仅 true 时携带）：
      { "channels": [...], "deprecatedFeishuConfig": true }
  → web client DTO（ChannelStatusResponseDTO.deprecatedFeishuConfig?: boolean）
  → ImPage loadChannelStatus 回调写 state
  → 飞书区块顶部 amber 引导条（data-testid="feishu-migration-banner"）
```

### 设计取舍

| 决策 | 理由 |
|---|---|
| 标记仅 true 时携带（缺省不出现字段） | API 面干净：绝大多数用户（无旧段）响应里没有这个字段；显式 `false` 也按缺省处理（前端 `=== true` 判等），字段只在「需要用户看见」时存在 |
| 启动时快照而非运行时探测 | feishu 段是启动期 config 解析产物，运行中不变；避免每次 status 请求重读 config 文件 |
| 引导条内嵌迁移三步，不做外链 | web SPA 无 docs 静态服务（server.ts SPA fallback 会把 `/docs/*` 吞成首页成死链）；关键动作（删段→重启→扫码选已有应用）三步内嵌完成引导使命，完整文档以文字指引「仓库 docs/user-guide/feishu-setup.md『从旧静态凭证迁移』节」 |
| banner 放飞书区块顶部（非全页顶部） | 语义就近：问题在飞书，引导贴着飞书；微信用户无感知 |
| 引导条常驻（无「不再提示」） | 迁移完成（删段重启）后 config.feishu 为空，标记自然消失——引导条生命周期与问题同寿命，无需手动关闭 |

### 改动清单

**后端（3 文件 +61 行内）**：
- `src/interface-adapters/http/controllers/channel-controller.ts`：构造注入 `deprecatedFeishuConfig?`；getStatus 响应条件携带
- `src/bootstrap/controllers.ts`：ControllerDeps 增 `deprecatedFeishuConfig?`，透传 buildChannelController
- `src/app.ts`：initControllers 注入 `Boolean(config.feishu)`

**前端（2 文件 + 测试）**：
- `web/src/api/client.ts`：ChannelStatusResponseDTO 增 `deprecatedFeishuConfig?: boolean`
- `web/src/pages/im/index.tsx`：state + loadChannelStatus 写入 + amber 引导条（迁移三步文案）

**测试（2 文件新增 5 例）**：
- `tests/interface-adapters/http/channel-controller.test.ts`：+2 例（true 携带 / 缺省不携带）
- `web/src/pages/im/migration-banner.test.tsx`（新文件）：3 例（true 渲染含关键文案 / 缺省不渲染 / 显式 false 不渲染）

## 测试与验证

- 后端：`npx vitest run tests/interface-adapters/http/channel-controller.test.ts` → 7 passed（含新增 2）
- 后端全量：`npx vitest run` → 333 files / 5005 tests passed
- web：tsc --noEmit 0 错误；`vitest run` → 62 files / 653 tests passed（含新增 3）
- 注：web 测试在主仓 node_modules 环境跑（worktree web 无依赖安装），改动文件验证后已还原主仓

## 影响范围

- 无行为变更路径：无旧 feishu 段的部署（绝大多数）API 响应与 UI 完全不变
- 有旧段部署：IM 页飞书区块多一条 amber 引导条，其余不变
- 风险低：纯增量透传 + 条件渲染，不触碰通道状态机 / 扫码流程 / 配置解析

## 后续

- 无（issue #1211 三件套：透传 ✅ / 引导 UI ✅ / 文档链接 → 内嵌文案替代，feishu-setup.md 迁移节 #1194 已备）
