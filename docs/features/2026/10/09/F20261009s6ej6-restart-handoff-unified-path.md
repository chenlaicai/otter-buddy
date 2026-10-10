---
id: F20261009s6ej6
title: 重启獭生路径统一 + 262K 档合成预算重新定标
doc_type: feature
change_type: fix
created: 2026-10-09
summary: |
  修复两个问题：①小獭重启没有系统消息——conversation_otters 表缺 invite_otter 写入记录
  导致 resolveFirstConversationId 找不到对话降级 bareRestart，查询层加 fallback 到
  conversation_participants；②kimi-256k 合成必然 400 失败——262K 档预算按
  密度 1.443 token/char 定标但实测 ≥ 1.511，新预算 138,788 chars（7 例真实失败最小 173,485 × 0.8），
  废弃跨窗口线性缩放假设改为分档定标；1M 档 726,752 延续 F20260924swin 保守外推
  （含 ~24% 保真代价，956,403 chars 成功样本 > 预算）。
created_in_conversation: 74abdc91-d743-4cf9-816c-aacfee433c8f
modules:
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - src/frameworks/agent/narrative-synthesis-engine.ts
  - src/interface-adapters/http/controllers/otter-controller.ts
  - tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts
  - tests/frameworks/agent/handoff-synthesis-budget.test.ts
  - tests/interface-adapters/unified-handoff.test.ts
  - tests/interface-adapters/agent-invoker.test.ts
---

## 问题一：小獭重启没有系统消息（⏳/✅ 反馈缺失）

### 根因

`restartWithUnifiedHandoff` 内部当 `resolveFirstConversationId` 找不到对话时降级为 `bareRestart()`，完全跳过 unified handoff 管线（不发系统消息）。

进一步追查 `resolveFirstConversationId` 找不到对话的原因：`conversation_otters` 表只在创建对话时写入，后来通过 `invite_otter` 加入对话的獭只写 `conversation_participants` 不写 `conversation_otters`。小獭通常不是对话创建者，所以 `conversation_otters` 里没有它们的记录，导致查不到对话。

**生产日志证据**（2026-10-09）：
```
[manual-restart] No conversation found, restarting bare
otterId=c7b73c29...（实现獭-csfw）
otterId=bac2e6bb...（检视獭-滚动二轮）
otterId=cb4b05a1...（守卫修复獭）
otterId=308cd13e...（实现獭-475）
```
以上全部是 small 类型獭，且它们都有 `conversation_participants` 记录但无 `conversation_otters` 记录。

### 修法

**查询层兼容**：修改 `sqlite-conversation-repository.ts` 的 `getIdsByOtterId`，当 `conversation_otters` 查不到时 fallback 查 `conversation_participants`（`status='active'`）。两表数据不一致是 schema 层面的历史遗留，不在本 PR 修 schema/迁移数据，只在查询层做兼容。

**入口统一**：删除 `otter-controller.ts` 的三元兜底（`agentInvoker ? : manageSession.restartSession`），生产环境 agentInvoker 始终注入；未注入时显式报错而非静默走无消息路径。

### 机制识别检查点判定

逐项打勾：
- □ 新增配置字段/枚举/开关 → **未命中**
- □ 新增状态生命周期 → **未命中**
- □ 新增定时任务/后台进程 → **未命中**
- □ 新增信号类型/消息格式 → **未命中**（复用现有 entry.system 通道）
- □ 新增持久化存储 → **未命中**
- □ 新增决策分支（结果被记住并在后续影响行为）→ **未命中**（fallback 查询不改变决策路径，只是让已有决策找到正确数据）
- □ 新增跨模块调用路径 → **未命中**（不新增调用关系，只是给已有查询加 fallback）

→ **修法决策树①：既有机制语义内修（缺啥补啥）**

**Modification-Class: narrow-fix**

---

## 问题二：kimi-256k 重启合成必然降级机械档案（预算定标错误）

### 真实失败样本（2026-10-09 日志实锤，7 例）

| 时间 | promptChars | historyBudgetChars | 结果 |
|------|-------------|-------------------|------|
| 11:01 自重启 | 180,520 | 175,944 | 400 失败 |
| 11:03 自重启 | 174,753 | 174,382 | 400 失败 |
| 11:04 自重启 | 177,942 | 178,141 | 400 失败 |
| 16:24 手动 | 181,513 | 179,331 | 400 失败 |
| 16:24 手动 | 173,485 | 178,786 | 400 失败 |
| 16:25 手动 | 175,288 | 178,849 | 400 失败 |
| 16:27 手动 | 181,133 | 177,337 | 400 失败 |

全部 262K 档，全部失败。最小失败 = **173,485 chars**。

另：F20260924swin 文档 :86 实录 09-23 **1M 档成功样本 956,403 chars**（kimi 1M），
是新定标里 1M 档的真实成功上限锚点。

### 根因分析

现行预算 `synthesisFullBudgetChars(262144) = 181,688 chars`（= 227,110 × 0.8），但真实数据显示：
- 173,485 chars 的 prompt 被 API 判超 262,144 tokens → 实际密度 ≥ **1.511 token/char**
- 旧定标假设密度 = 1/0.693 ≈ **1.443 token/char**
- 换算率定低了 ~5%，预算线虚高 ~7K chars，导致所有 trim 到 173K-181K 的 prompt 全被 API 打回

### 新定标（夹逼法）

- **262K 档**：最小失败 173,485 × 0.8 = **138,788 chars**
- **1M 档**：现行值 726,752 chars **保留**（延续 F20260924swin 保守外推决策）。
  **口径更正（检视獭 S2）**：1M 档真实最大成功是 956,403 chars（09-23，F20260924swin :86），
  > 726,752——(726,752, 956,403] 区间输入会被 trim 裁最老 ~24%（确定的保真代价，
  F20260924swin 已 L1 拍板接受）。此前实现注释误用 trim 日志观测上限 726,586 当
  「最大成功」是循环论证（trim 已裁到预算内），已更正。
- **跨窗口线性缩放假设废弃**：两档密度不对称（262K 档实测 ≥ 1.511 vs 1M 档 956,403 成功
  对应 ≤ 1.096），不再用统一比率，改为按窗口档位分别定标
- **未知档位 fallback**：保守密度 1.6 token/char 推算（介于两档实测之间）

### 密度推算验证

- 262K 档：173,485 chars 超 262,144 tokens → 密度 ≥ 1.511（失败样本下界）
- 1M 档：956,403 chars 成功（未超 1,048,576 tokens）→ 密度 ≤ 1.096（成功样本上界）
- 两档密度确实不对称，跨窗口线性缩放假设不成立
- 新预算 138,788 chars 对应 262,144 tokens 的密度 = 1.889，留有 ~25% 密度方差余量
  （注：0.8 余量隐含此密度天花板，但无直接证据——失败样本右删失，见建议 A3）

### 测试同步

- `handoff-synthesis-budget.test.ts`：262K 档断言从 181,688 改为 138,788；新增 1M 档 726,752 断言；新增未知档位 fallback 断言
- `unified-handoff.test.ts`：预检测试的 `synthesisFullBudgetChars` stub 同步更新
- `agent-invoker.test.ts`：watermark 测试的 engine stub 同步更新
- 不误裁边界测试：15 万 chars 改为 12 万 chars（< 138,788 预算）

## 影响范围

- 262K 档合成预算收紧 ~24%（181,688 → 138,788），会多裁一些历史段，但杜绝了 400 失败 + 降级机械档案的确定性损失
- 1M 档预算不变，行为不变
- 小獭重启现在能找到对话并走 unified handoff 管线，系统消息正常发出
- controller 在 agentInvoker 未注入时从静默降级改为显式报错（HttpError 500，服务端装配缺失语义；测试装配需注入 agentInvoker 或接受 500）

### 爆炸半径披露（检视 A4）

`getIdsByOtterId` 还被 `manage-session.ts:181`（archiveSession 工作记忆转历史层）消费。
fallback 改动意味着：小獭经 invite 加入的对话，重启时工作记忆现在也会被正确转历史
（此前因查不到对话而跳过转层）。**这是良性副作用**——记忆该转历史的没转才是缺陷，
但属于 fallback 改动影响不止重启路径的既成事实，如实披露。

### 已知局限（检视 A3/A5）

- **A5 多对话选对话**：`resolveFirstConversationId` 取 `ids[0]`，无 ORDER BY，
  多对话小獭的 ⏳/✅ 可能发到非搭档当前所在对话。既有语义，未改（选对话策略是独立议题）。
- **A3 密度天花板无直接证据**：0.8 余量隐含密度天花板 1.889 token/char，
  但失败样本右删失（看不到恰好成功的边界），无直接证据。建议未来在合成成功时落 usage token
  建真实密度样本库（观测锚），待实测失败/成功样本再校准 0.8 因子。
- **schema 层两表不一致**：conversation_otters vs conversation_participants 双写缺口的
  根治（统一写路径或迁移补齐）不在本 PR 范围，本 PR 仅查询层兼容。

## 验证

- [x] `sqlite-conversation-repository.test.ts`：3 个新测试（fallback、去重、left 状态过滤）全部通过
- [x] `handoff-synthesis-budget.test.ts`：24 个测试全部通过
- [x] `unified-handoff.test.ts` + `agent-invoker.test.ts`：48 个测试全部通过
- [x] `restart-flow.integration.test.ts`：5 个测试全过（含新增 agentInvoker 未注入 → 500 测试）
- [x] `tests/api/otter.test.ts`：23 个测试全过（createMockDeps 注入 otterRestartAutoHandoff stub 后裸路径 mock 语义保持）
- [x] `npx tsc --noEmit` 类型检查通过
- [x] 受影响域 86 文件 843 测试全过
- [x] **CI 三灯全绿**（check 3m44s / e2e 2m32s / golden-selftest 1m8s）——rebase 后 lint:docs / lint:intent 首次真实执行通过（检视 S1 硬门槛）
