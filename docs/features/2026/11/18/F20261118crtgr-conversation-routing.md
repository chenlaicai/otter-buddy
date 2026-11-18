---
title: 工具路由开放（阶段 5 PR-A：对话级执行机）
id: F20261118crtgr
date: 2026-11-18
module: session
change_type: feature
summary: |
  落实 #1868 阶段 5 PR-A：对话级当前执行机（conversations.current_machine_id
  列，NULL=默认 local 存量零迁移）+ ConversationActionRouter（workspace 六动作
  工具按对话当前机路由——显式 target 优先；悬空目标 fail-closed 不静默回切）+
  API 面（GET /api/execution-machines 全量设备列表含离线 + PUT
  /api/conversations/:id/execution-machine 对话切换，目标未注册 400）+ connector
  repo listDeviceOnlineStatus。SDK 文件/bash 面保持 Registry 恒 local（协议 v1 只放六动作
  边界，阶段 7 对齐）。
intent:
  problem: "阶段 4 后 workspace 六动作工具已全接 ActionRunner 路由链（协议位 targetMachineId 在），但缺选择层——对话永远落 local，无法『设备列表、当前设备选择、明确目标路由』"
  expected_effect: "对话切换到 connector 后獭的 workspace 六动作物理落远程机（不在 hub 本地）；显式 target 压过对话配置；指向已撤销设备报错不静默回切；存量对话零行为变化"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/usecases/execution/conversation-action-router.test.ts：默认 local/对话切换远程/显式 target 优先/悬空 fail-closed/查询失败回落/六动作提取 conversationId"
      - "tests/frameworks/db/conversation/conversation-machine-column.test.ts：新库含列/存量库 ALTER 幂等/repo 读写"
      - "tests/interface-adapters/http/auth-controller.test.ts：GET join 在线状态/PUT 切换（401/400/404/200/null 回默认）"
capability_test: "tests/usecases/execution/conversation-action-router.test.ts"
---

# F20261118crtgr：工具路由开放（阶段 5 PR-A：对话级执行机）

## 背景

#1868 阶段 5 第一切片（方案 stage5-routing-plan.md §2.1/§2.2/§2.3 部分）。
阶段 4 后路由链已通（工具→ActionRunner→Registry.resolve，target 协议位在），
本切片补选择层：对话级当前执行机存储 + 工具路由 + 切换 API。PR-B 补执行状态
查询与 Web UI + 双 connector 场景验收。

## 交付

### 数据层：conversations.current_machine_id

- 新表含列 + 存量库幂等 ALTER（同 introduced_by_pr 模式）
- 语义：NULL=默认 local（存量对话零迁移零行为变化）；**显式切换不自动漂移**
  （设备下线不回切——下次动作总闸拒，人决定切回或等重连，fail-closed 与
  「重连≠恢复」一致）
- repo 窄接口（不进实体）：getExecutionMachineId / setExecutionMachineId
  （对话不存在 false fail-closed）

### ConversationActionRouter（usecases/execution）

- 实现 ActionRunner：targetOverride（显式）→ 对话 current_machine_id（六动作
  input 提取 conversationId，无需 ToolContext）→ Registry 默认 local
- **查询失败 fail-closed 抛错**（M1 检视处置：无法读配置=不知道指向哪，落 local
  是危险方向的猜测——与悬空目标同处置；仅真实「无配置 null」回落默认）
- 悬空目标（设备撤销/未上线）：resolve 抛错不静默回切——防「以为在 B 干活
  其实在 A」
- 装配：platforms options 加 toolActionRunner（缺省退化 executionMachines——
  旧装配/测试兼容）；**SDK env 构造面仍走 Registry 恒 local**（pi-session-factory
  多处注入不动——协议 v1 只放六动作，SDK 面阶段 7 对齐，方案 §2.2 边界）

### API 面

- `GET /api/execution-machines` 增强（M2 检视处置：**全量设备列表**——local +
  devices 表全部已配对设备含离线；Registry 投影下线即注销，离线设备只有 devices
  表可见——「人要看得见离线设备才能决定切回」；lastSeenAt 优先在线会话实时值，
  否则 devices.last_seen_at；收口 connectorRepo.listDeviceOnlineStatus）
- `PUT /api/conversations/:id/execution-machine`：body `{machineId: string|null}`（**空 body ≠ null**——回默认须显式 `{machineId:null}`，m4 契约）；`"local"` 归一化为 null 写列（m1b：列语义唯一）；
  目标不在 Registry（未上线/未配对）→ 400；对话不存在 → 404；null 回默认；
  鉴权 owner session（非 public）
- connector repo：listDevices()（设备列表查询面）

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 路由粒度 | 对话级列（窄接口直查） | 进 Conversation 实体 | 实体/repo 全链免改；读频率=每次六动作，直查列成本可忽略 |
| 设备下线后 | 不自动回切 local | 自动回切 | fail-closed：静默回切=「以为在 B 其实在 A」——动作报错让人决定 |
| SDK 面路由 | 不路由（恒 local） | SDK 也路由 | createExecutionEnvironment 无远程落点（阶段 1 定死）；协议 v1 只放六动作 |
| 切换校验 | 目标必须在册（Registry list） | 允许指向离线设备 | 「切换成功但一用就炸」体验差；离线设备重连后自然在册（投影注册） |
| conversationId 来源 | action.input 提取 | ToolContext 注入 | 六动作 input 均携带（C2 已验证）；router 无需侵入工具工厂签名 |

## 机制识别检查点

- 新增持久化存储：是（列级扩展，幂等 ALTER）
- 新增状态生命周期：是（对话级机器指向——切换/回默认/悬空三态）
- 新增信号/消息格式：否
- 新增决策分支：是（路由序/悬空 fail/查询失败回落）
- 新增跨模块路径：是（platforms 工具面 → router → Registry/对话 repo；HTTP → plumbing 回调 → repo）

结论：修法决策树②既有机制内扩展（ActionRunner 协议位/Registry/幂等 ALTER 均为既有机制）。

## 验收标准

| 场景 | 预期 |
|---|---|
| 存量对话（无配置） | 六动作落 local——零行为变化（全量回归背书） |
| 对话切换 connector 后 | 獭 workspace_write 物理落远程机数据目录 |
| 显式 target | 压过对话配置（协议位语义不变） |
| 对话指向已撤销设备 | 动作报「machine not registered」不落 local |
| 对话查询失败（DB 异常） | 动作抛错不落 local（M1：fail-closed 与悬空一致） |
| 离线已配对设备 | GET 列表可见（online:false + lastSeenAt）——人能看见才能决定切回（M2） |
| GET 列表 | machines join 在线状态（无会话设备不带 online） |
| PUT 切换 | 目标未注册 400 / 对话不存在 404 / 成功 200 / null 回默认 |
| 未登录 | 两端点 401（fail-closed） |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| conversation-action-router（6 例） | PASS |
| conversation-machine-column（2 例：新库/存量 ALTER） | PASS |
| auth-controller 端点（+5 例：GET 全量含离线/缺省退化/PUT 四态/local 归一化随装配） | PASS |
| `npm test` 全量 | 488 files / 6162 全绿（修复轮 +1：M1 抛错用例改造） |

## 检视处置记录（dspro 首轮：0 blocker / 2 major / 5 minor / 2 suggestion）

- **M1 查询失败静默回落 local（fail-closed 后门）**：已修——catch 改 throw
  （仅真实「无配置 null」回落默认）；单测改造为「抛错 + local 零调用」。
- **M2 设备列表半接线（离线设备不可见/online 恒 true/listDevices 零调用）**：
  已修（选 (a) 全量方案）——GET 改 local + `connectorRepo.listDeviceOnlineStatus()`
  全量（含离线 + lastSeenAt 取 COALESCE(在线会话, devices.last_seen_at)）；
  裸 SQL 收口 repo；listDevices 删除（被含 name 的状态视图取代）；测试补
  「离线已配对设备可见」断言。
- **m1(a) PUT TOCTOU**：记录不改（窗口毫秒级且语义与「切换后下线→动作报错」
  设计一致）；**m1(b) "local" 归一化 null**：已修。
- **m2 切换写动 updated_at**：已修——去掉（updated_at 语义=最后活动）。
- **m3(a) ALTER 归位**：已修——挪 conversations 建表函数；**m3(b) 裸 SQL**：
  并入 M2 收口 repo。
- **m4 空 body ≠ null 契约**：已修（F 文档 API 段写明）。
- **m5 计数**：已修（Verification 表）。
- **s1 router 转发原始 override**：已修——对齐 Registry 转发 undefined（一行）。
- **s2 离线 lastSeenAt 数据源**：并入 M2（COALESCE 方案）。

## Rollback

Revert 本 PR：列留存无害（NULL 语义不变）；platforms options 缺省退化
（toolActionRunner 未传=旧行为）；router/API 端点移除即可。PR-B（状态面/UI）
依赖本切片的列与 API——revert 需一并回退。
