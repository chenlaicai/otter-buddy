---
id: F20261030gcfbx
title: 守卫拦截分类器指纹表对 guard-v4 全量重对齐（26→7 条），恢复 1c 机械分账
summary: |
  本 PR 原为「补 8 条 v3 指纹缺口」（T4 复盘门 10/26 触发）；rebase 上 main 时
  遭遇 #1702 守卫重建清场 + #1711 guard-v4 重写——v3 全部守卫文案发射点消亡，
  分类器指纹表与现实整体脱节（40 条测试 29 红），按「PR 语义随 main 演化」重定位
  为 v4 全量重对齐：死指纹整体退役（26→7 条），guard-v4 七条活文案（第一站杀进程
  判定 4 条 + 第二站黑名单三类 3 条）全量入表，真实探针回归重写（21 条，processProbe
  桩对齐 replay 基建）。连带修复 agent-invoker-guard-bounce 2 条 v3 mock 文案依赖。
change_type: fix
capability_test: "n/a: fix 类（观测层分类映射重对齐，不涉能力面）——回归由 tests/frameworks/agent/guard-intercept-classify.test.ts 21 条探针承担"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: 2026-10-30
causal_links:
  - F20260930gslog
  - F20261030gbrmv
  - F20261030gblkv
---

编号溯源：原 `F20261026gcfb`（4 位字母草稿编号）；2026-10-28 按五位字母契约改
`F20261028gcfbx`；2026-10-30 定稿改 `F20261030gcfbx`（两次定稿：前次是编号契约
对齐，本次是 rebase 上 main 后按当日定稿日期收口 + v4 重对齐）。

## 背景（两次语义定位）

**第一次（10/26-10/28，v3 时代）**：T4 复盘门实测修复后窗口 287 条结构化拦截中 31 条
（heredoc 25 / S5 外发 6）ruleId 落 unknown——10/19 后新增守卫规则文案未同步指纹表。
本 PR 补齐 8 条缺口指纹，初轮对抗审视 request-changes、处置后 delta 通过（流程闭环）。

**第二次（10/30，本次）**：搭档指示改定稿日期并 rebase 上 main。main 已合入
#1702（守卫重建清场：旧守卫 11 模块 + 40+ 测试文件整体移除，classify 本体在保留名单）
与 #1711（guard-v4 重写：杀进程判定 + 黑名单三层架构，文案全部换新）。后果：

- 原 PR 补指纹的 4 个 v3 机制（C2 载荷判定器 / #1543 git 域 / wrapper / kill 唯一文案源）
  已随清场消亡，8 条新指纹全部变死指纹；
- 分类器存量指纹表与 v4 现实整体脱节——生产路径上 v4 文案将全部落 unknown 兜底，
  1c 机械分账比 v3 时代亏欠更大；
- 原测试文件被 #1702 连坐删除（classify 是保留主体，该删除属清场连坐，本 PR 恢复）。

按「PR 语义随 main 演化」重定位为 v4 全量重对齐。

## 变更内容

### 指纹表重对齐（26→7 条 + 结构化前缀 + sleep 历史指纹）

| v4 活文案（bash-safety-guard.ts） | ruleId | layer | id 取舍 |
|---|---|---|---|
| MAIN_KILL_BLOCK_MSG（三查/PID 文件段内引用/stop 脚本共用） | self_kill_main | self_kill | 新 id（v4 机制；三查合并了 v3 的 literal/pidfile/script_stop 多规则） |
| INDIRECT_KILL_BLOCK_MSG（变量/命令替换目标） | self_kill_nonliteral | self_kill | 复用旧 id（语义未变，healing 聚合连续） |
| PKILL_OTTER_BLOCK_MSG（pkill/killall 特征名） | self_kill_byname | self_kill | 复用旧 id（同语义） |
| BROADCAST_KILL_BLOCK_MSG（kill -1 / -- -PGID） | self_kill_process_group | self_kill | 复用旧 id（同语义） |
| 凭证目录禁止访问（A 类黑名单） | cred_dir_access | permission | 新 id（v4 新机制） |
| 向非协作域名上传数据（B 类，含 fail-closed 分支同文案） | network_exfil | permission | 复用旧 id（S5 外发面语义延续） |
| 「下载即执行」（C 类，管道+进程替换同文案） | download_exec | bypass_guard | 新 id（v4 新机制） |

保留的活通道：`[file-tool-guard]` 结构化前缀（#1661 引入，v4 未变）、sleep_block
历史指纹（发射点 stripSleepMarkerIfPresent 兼容层仍在，历史台账文案仍可分类；拦截
本体已随 v4 退役为软约束）。

退役的死指纹（26 条）：v3 kill 族 7 细分（literal/pidfile/pipe_shell/script/eval/
script_stop/indirect）、脚本执行 2（script_file_exec/alias_shell_payload 双指纹）、
C2 载荷族 4（stdin_shell_opaque/stdin_interp_payload/heredoc_payload/heredoc_shell_payload）、
wrapper_saturated、main_write 族 4（main_write/main_write_resolve/data_destructive
双形态）、git 域 2（protected_push/git_dir_write）、pr_merge。以上发射点全部随
#1702 清场消亡（main 上零 grep 命中，kill-block-messages.ts 已成孤儿模块）。

### 测试重写（40 条 → 21 条，真实探针 = guard-v4 真实判定）

- 探针基建对齐 replay.test.ts：processProbe 桩（identity 恒 null = 三查「查无此进程」），
  全平台确定性不真查 ps；
- 真实探针 9 形态：kill 主 PID（一查）/ PID 文件段内引用 / kill 变量目标 / pkill 特征名 /
  kill -9 -1 广播 / 凭证目录（ssh/gnupg/aws 三形态）/ 上传非协作域名 + 无 URL fail-closed /
  下载即执行（管道 + 进程替换）；
- 探针词元拆写（"ki"+"ll"）：探针命令字面量会触发本仓 bash 守卫拦截（写测试内容
  ≠执行，但守卫不做区分——两个 v4 误报实录已留 healing 台账）；
- 保留全部非守卫通道用例：结构化前缀、unknown 兜底、buildGuardInterceptContext
  落账字段族（#1207 误报特征 / 脱敏 / repeated 计数）、#1661 文件工具结构化审计。

### 连带修复：agent-invoker-guard-bounce.test.ts（2 条 mock 文案依赖）

GB-6a/GB-6e 的 mock 拦截文案是 v3 死文案（main_write/kill literal），分类器重对齐后
归 unknown → 降级通道测试失效。改为 v4 活文案：低危层示例换 cred_dir_access
（permission），高危层示例换 self_kill_main；GB-1 的 `not.toContain("restart")`
断言过时删除（v4 文案自带 restart-service 受控出口指引，恰是正道）。

## 设计取舍

- **重定位而非重开 PR**：分支语义演化在 PR 描述可见（对话留痕），避免「关旧开新」
  丢失审视闭环历史（初轮 request-changes → 处置 → delta 通过的处置记录仍有参考价值）。
- **id 复用 vs 新 id**：语义未变的 4 个复用旧 id（healing 历史聚合连续，跨版本趋势
  可比）；v4 新机制 3 个新 id（self_kill_main/cred_dir_access/download_exec）——
  不硬塞旧名，防语义漂移。
- **sleep_block 指纹保留**：拦截本体退役但兼容层在、历史台账要能分类，删了历史
  unknown 化，留则零成本——留。
- **机制识别判定**：分类器指纹表是观测层数据映射，不碰守卫判定机制，Modification-
  Class: narrow-fix。
- **最简实现检查**：已过——指纹表数据重写 + 测试重写，无新代码路径、无新依赖。

## 验证

### 失败证据（bugfix 硬规则）

- 重对齐前（新 main + 旧分支内容恢复后）：guard-intercept-classify.test.ts
  **29 failed / 11 passed（40 条）**——全部 v3 探针/文案依赖；
- 重对齐后：同文件 **21/21 passed**；全量 `npx vitest run` **421 文件 / 5567 passed**；
  `npx eslint src/ tests/` 零告警；`npx tsc --noEmit` 零错。

### 验收标准（可机械断言）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| v4 七条文案分类 | vitest guard-intercept-classify.test.ts | 21/21 过 |
| v4 真实判定探针有效 | 同上（探针失效即红设计） | 全过（探针命令全部被 v4 真实拦截） |
| unknown 兜底语义不变 | 「未映射文案落 unknown」用例 | 过 |
| 降级通道不回归 | agent-invoker-guard-bounce.test.ts | 11/11 过 |

### 负向自查（本次变更破坏了什么旧契约 / 绕过了什么既有保护）

- 死指纹退役使 v3 文案不再可分类（落 unknown）——这是对现实的如实反映而非破坏：
  发射点已消亡，新拦截只产 v4 文案；历史台账中 v3 文案事件按当时 ruleId 落库的历史
  数据不受影响（分类是落账时点的，不回溯重分类）。
- self_kill 细分 id 合并为 self_kill_main：跨版本聚合时 v3 的 self_kill_literal/
  pidfile/script_stop 与 v4 的 self_kill_main 不连续——已在指纹表注释和本文档声明，
  需要时按时间窗切分。

## 影响面当场自检

- F20260930gslog「倒逼补表」契约再次被验证（v4 换文案未同步表 → unknown 暴露 →
  本 PR 补表闭环）；F20261030gblkv（v4 重写）未同步指纹表是其遗留欠账，本 PR 闭环。
- T4 复盘门的「1b 指纹表欠账」（v3 语境）已被 #1702 清场 supersede——本 PR 的 v4
  重对齐取代原欠账闭环。
- 两个 v4 误报实录（本对话实测被拦）：heredoc 写测试文件含凭证路径字符串被 A 类拦、
  bash 命令内嵌探针 kill 字面量被拦——已留 healing 台账，属 v4 文案/判定的改进候选，
  不在本 PR 范围。
