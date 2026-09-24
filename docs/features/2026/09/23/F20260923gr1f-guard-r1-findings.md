---
id: F20260923gr1f
title: bash 守卫 r1 审视发现处置（#1154）：载荷级判定 + 遮蔽修复 + 管道右段标记
change_type: fix
status: implemented
created: 2026-09-23
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/kill-segment-finder.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: 'PR #1125（#852 引号感知修复）在 r1 结论「需要修改（3 严重 + 2 建议）」后未经处置即合并，main 遗留三处实证洞：S2 多载荷段 hits[0]+break 遮蔽真实攻击（良性 decoy 漏拦）；S3 语义判定扫外层段文本引入 2 例误拦（载荷内注释命中进程名表 / bash -c 传参变量命中间接 PID）；S1 六个新用例全用分号分隔形态对新分支零回归保护'
  expected_effect: '逐载荷入结果（遮蔽面灭）；语义判定输入收敛到载荷级命中段 + 外层剥载荷上下文（误拦面灭）；真金拦截面（引号内无分隔符+前缀词包裹）与误拦面各有回归用例锁定，回退红绿验证成立；lsof | xargs kill 管道组合杀拦截面不回退'
  verify_by:
    type: capability_test
    note: tests/frameworks/agent/bash-safety-guard.test.ts 新增 6 用例（#1154 节），回退 src 后 3 红 2 绿（红绿区分度实证），vitest 自动断言
summary: '#1154（PR #1125 r1 未处置即合并的欠账）：KillSegment 增 payload/source 字段跨层携带载荷与管道右段标记；checkKillSegment 语义判定改为「载荷级命中段 + 剥载荷外层上下文」双输入；hasIndirectPidTarget 的 xargs 剥除按「无 stdin 来源」收窄（管道/命令替换存在时不剥）；pkillTargetsOtter 剥 shell 注释再判定。'
tags: [bash-guard, security, defense-in-depth]
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
from: [F20260922gpqa]
---

# F20260923gr1f bash 守卫 r1 审视发现处置（#1154）

## 背景

PR #1125（#852 引号感知修复）在检视獭1125 r1 结论「需要修改（3 严重 + 2 建议）」后未经处置与 delta 复核即合并（merge commit 7a7889a4）。检视獭核查 main 现状后建 issue #1154 收拢待修复发现。本 PR 为全部发现的处置。

## 处置明细

### S2（遮蔽漏拦）：逐载荷入结果

`findKillSegments` 第三分支从 `hits[0].isPkill + break`（首个良性命中遮蔽后续载荷的真实攻击）改为**逐载荷逐 hit 入结果**——多载荷段每个命中独立入判定管线，良性 decoy 不再遮蔽攻击载荷。

### S3（误拦 ×2）：判定输入收敛到载荷级

`KillSegment` 新增 `payload` 字段（仅载荷级命中携带）。`checkKillSegment` 对载荷级命中的段构造 `outerContext`（外层段剥离载荷后的文本），`pkillTargetsOtter` / `hasIndirectPidTarget` / `extractLiteralPids` 均双输入判定——外层包装/传参/注释不再混入 kill 目标语义判定。

配套两处模式层修复：

- `pkillTargetsOtter`：剥 shell 注释（`#.*$`）再判定——`pkill -f myapp # node` 的 `# node` 是注释不是目标，不剥会命中进程名表的 `node`
- `hasIndirectPidTarget`：xargs 剥除收窄到「无 stdin 来源」形态——管道（`|`）或命令替换（`` $()/`` ``）存在时 kill 目标来自外部输入（间接，不剥，`lsof | xargs kill` 拦截面保留）；裸 `xargs kill 99999` 无输入来源，剥除后走字面量判定与裸 kill 语义一致

### 管道右段标记（处置中新发现）

`split(/[;&|\n]/)` 把 `|` 吞了——管道右段（`lsof | xargs kill` 的 `xargs kill`）单看段文本无管道符，xargs 剥除会把「目标来自上游 stdin」这层间接来源漏掉（处置中实证：存量 2 用例红）。`KillSegment` 新增 `source: "pipe"` 标记：段起点前一个非空字符是单 `|`（排除 `||` 第二字符）即管道右段，`hasIndirectPidTarget` 对该类段禁用 xargs 剥除并直接判间接。

### S1（测试同义反复）：真金形态锁定

新增 6 用例（测试文件 `#1154` 节）：真金拦截面（引号内无分隔符 + 前缀词包裹 ×2）、遮蔽回归（M1）、误拦放行面（F1/F2/F3）。**回退红绿验证**：stash src 后跑新用例 3 红（S2/S3 真金）+ 2 绿（G1/G2 在回退态因载荷递归仍拦——属 S2/S3 修复的附带覆盖，非同义反复）。

### A1/A2（行级）

- A1：搬迁孤儿注释已在重构中归位（matchKillAtPosition 拆出时 JSDoc 随宿主迁移）
- A2：文件头 FID 笔误 `F20260922gpq` → `F20260922gpqa`（本 PR 一并修正）

## 设计取舍

- **双输入判定而非替换**：`outerContext` 与 `segment` 都进判定（`pkillTargetsOtter(segment) || pkillTargetsOtter(outerContext)`）——外层段文本仍可能含真实目标（如 `bash -c 'kill 5' 42877` 的位置参数形态），只判载荷会漏；混入的误拦由剥载荷解决而非切除外层。
- **source 标记走字段而非正则**：段文本内查 `|` 在 split 后不可能（分隔符被吞），必须在分段时跨段携带——接口字段比重新扫原文更便宜且语义显式。

## 已知边界

- `source:"pipe"` 只看紧邻前一个分隔符——`a | b | xargs kill` 链式管道中右段仍正确标记（左段 `b` 以 `|` 结尾），但「管道上游是白名单 lsof」的精确判定归 whitelistedPortAllow 规则 2c（本 PR 不动）。
- 畸形引号（不配对/嵌套同种引号）的载荷提取边界同 #852 声明，未扩大。

## 验证

- 探针 12 形态矩阵全过（G1/G2/M1/M0/F1/F2/F3/R1/R2/R3/P1/P2）
- 存量 221 + 新增 6 = 227/227 绿；tsc 0 错；eslint 0 警（checkKillSegment 改对象参数压 max-params，matchKillAtPosition 拆出压复杂度）
