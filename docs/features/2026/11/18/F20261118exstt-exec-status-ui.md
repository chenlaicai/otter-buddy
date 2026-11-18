---
title: 执行状态面与跨设备验收（阶段 5 PR-B）
id: F20261118exstt
date: 2026-11-18
module: session
change_type: feature
summary: |
  落实 #1868 阶段 5 PR-B（收尾片）：执行状态查询 API（GET conversation
  execution-machine 回显 + GET remote-actions 最近优先五态，listByConversation 加
  desc 序——修 ASC LIMIT 丢最新的展示面缺陷）+ Web UI（ChatView 执行机入口按钮 +
  ExecutionMachineModal：全量设备选择器含离线置灰/远程动作五态列表/SDK 边界提示）+
  双 connector 场景验收（issue 四条 alpha 实证：跨设备文件物理落 B 不在 hub/
  下线拒重连恢复/非正常死亡收尾与历史恢复可见）。
intent:
  problem: "PR-A 落了路由层与切换 API，但「执行状态展示」缺查询面与 UI；issue 阶段 5 四条（跨设备闭环/下线重连/回执丢失恢复）缺真进程实证"
  expected_effect: "对话页可查/切执行机（含离线设备可见置灰）；远程动作五态可视；双 HOME connector 等价双机场景 alpha 全过"
  verify_by:
    type: behavior_check
    evidence:
      - "web/src/pages/conversation/ExecutionMachineModal.test.tsx：全量列表/离线置灰/PUT 切换（null 回默认）/400 错误不落选中/空态/401 与 5xx 错误条（7 例）"
      - "tests/interface-adapters/http/auth-controller.test.ts：GET 回显/remote-actions 倒序+limit 收口/401/ghost 404 与不误伤（5 例）"
      - "tests/frameworks/execution/remote-execution-machine.test.ts：同毫秒 created_at rowid 定序（desc 后插入在前/asc 先插入在前/limit 边界，+1 例）"
      - "workspace verify-s5b-alpha.mts：双 connector 场景 alpha（issue 四条）"
capability_test: "web/src/pages/conversation/ExecutionMachineModal.test.tsx"
---

# F20261118exstt：执行状态面与跨设备验收（阶段 5 PR-B）

## 背景

#1868 阶段 5 第二切片（方案 stage5-routing-plan.md §2.3 剩余/§2.4/§2.5）。
PR-A（#1934，F20261118crtgr）已落路由层+切换 API；本片补查询面、Web UI 与
issue 四条的真进程实证，收尾阶段 5。

## 交付

### API 面（plumbing.executionMachines 扩展）

- `GET /api/conversations/:id/execution-machine`：当前对话机回显（`{machineId}`，
  null=默认 local——选择器初始化用）
- `GET /api/conversations/:id/remote-actions?limit=`：执行状态展示（最近优先
  DESC，limit 收口 1-200 缺省 50；列裁剪 actionId/deviceId/actionType/status/
  error/createdAt/settledAt）
- **listByConversation 加 order 参数**（缺省 asc——恢复链既有语义不变）：
  展示面传 desc——**修 ASC LIMIT 丢最新**的展示缺陷（升序截断会把最新动作截掉，
  恢复链场景用大上限缓解过的同款问题在展示面必须根治）

### Web UI

- ChatView 头部「执行机」入口（Cpu icon）→ `ExecutionMachineModal`：
  - **选择器**：全量设备（local + devices 表含离线）+ 在线状态点 + 当前回显 +
    PUT 切换（「本机」=null 回默认；**离线设备置灰不可选**——重连后可切；
    400 错误就地显示不落选中态）
  - **远程动作状态列表**：最近 30 条五态徽标（在途/成功/失败/中断/不明）+
    处置指引提示（不明=禁止盲目重试/中断=可安全重做——恢复摘要同口径）
  - **SDK 边界提示**：远程对话 SDK 文件/bash 面落中枢本地（阶段 7 对齐）——
    防「以为 SDK 也落 B」误解
- TopBar 全局投影（阶段 2）不动——对话级选择只影响本对话

### 场景验收（issue #1868 阶段 5 四条，verify-s5b-alpha.mts）

双 HOME connector（B/C）= 双「电脑」等价（独立文件系统/台账/工作区）：

| issue 条目 | 实证 |
|---|---|
| 第二台电脑接入 | 双 connector 配对上线（独立 HOME 数据目录） |
| 设备列表/选择/路由/状态 | GET 全量 + PUT 切换 + ConversationActionRouter 真实例 + remote-actions 查询 |
| A 发指令 B 写报告另入口查看 | **文件物理落 B 数据目录，hub 无同名文件**（不在 A 造假）+ API 可查五态 |
| B 下线/重连/回执丢失恢复 | 优雅下线→动作拒→重连→重试成功落 B；C 非正常死亡→会话 offline 收尾+动作拒+历史恢复可见 |

「在途回执丢失落 unknown」的确定性路径由 C2/C3 的 E2E 单测钉死（挂起 executor
+ terminate 精确控制在途）；alpha 真进程不赌毫秒级竞态（write 秒完成）。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| listByConversation 序 | 加 order 参数（asc 缺省兼容） | 改默认 desc | 恢复链既有语义零扰动（C2 测试顺序敏感）；展示面显式 desc |
| 离线设备可选性 | 置灰不可选 | 允许切离线（用时才报错） | 「切换成功一用就炸」体验差；PR-A 已定（PUT 400）——UI 与 API 同口径 |
| ④b 验收形态 | 杀后收尾+历史可见（不赌在途竞态） | 真进程在途 unknown | 毫秒级竞态不可稳定复现；确定性路径单测已钉死——alpha 验收收尾语义 |
| Modal 承载 | 选择器+状态列表合一 | 分散到侧栏 | 单入口低侵入（ChatView 头部一个按钮）；状态列表仅此消费 |

## 机制识别检查点

- 新增持久化存储：否
- 新增状态生命周期：否
- 新增信号/消息格式：否（REST 端点）
- 新增决策分支：是（limit 收口/离线置灰/错误不落选中）
- 新增跨模块路径：是（plumbing 两个只读回调 → conversationRepo/remoteActionRegistry；ChatView → Modal → 三 API）

结论：修法决策树②既有机制内扩展（PR-A 列与 Registry 之上的只读面 + UI）。

## 验收标准

| 场景 | 预期 |
|---|---|
| GET execution-machine | {machineId}（null=默认） |
| GET remote-actions | 最近优先 + limit 收口（越界归 50）+ 五态 |
| 离线设备 | UI 置灰不可选（重连后可切） |
| 「本机」选项 | PUT null（回默认） |
| 切换 400 | 就地显示错误，选中态不漂移 |
| 未登录 | 两 GET 401 |
| 不存在对话 | 两 GET 404「conversation not found」（对齐 PUT 口径，不混作默认 local） |
| 双 connector 闭环 | 文件物理落 B 不在 hub；下线拒；重连恢复；历史可见 |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit`（主仓+web） | PASS |
| ExecutionMachineModal（7 例） | PASS |
| auth-controller（+5 例） | PASS |
| remote-execution-machine registry（+1 例） | PASS |
| `npm test` 全量 | 见 PR checks |
| alpha 双 connector（issue 四条） | ALL PASS |

## Rollback

Revert 本 PR：两 GET 端点与 UI 移除即可；order 参数留列无害（asc 缺省语义不变）。
依赖 PR-A（#1934）的列与切换 API。
