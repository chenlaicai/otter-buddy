---
id: F20261124gcfgr
title: 部署公开配置 grep 只读链误拦回放固化
summary: 将 2026-11-23/24 的公开配置只读误拦与现行负门命令固化为回放，并修复 CRED_WRITE_RE 重定向分支把 stderr 重定向误判为写凭证的根因（#2000）。
change_type: bugfix
tags: [guard, replay, regression]
modules: [tests/guard/replay/cases-2026-10-29.ts]
created_at: 2026-11-24
intent:
  problem: "healing d536ca28 的部署只读命令在末段 grep SSH config 时被 cred_dir_access 拦截，与 #1892 已固化的公开配置只读放行政策不一致。"
  expected_effect: "精确真实命令进入 ALLOW 回放；修复 CRED_WRITE_RE 重定向分支后，d536ca28/55e01e59/4935d204 三条 SSH 公开只读样本转绿，0dea2289 按政策 A 改向 allow，既有私钥负门（cat/cp 私钥）不退化。"
  verify_by:
    type: static_only
    evidence:
      - "npx vitest run tests/guard/replay/replay.test.ts：healing d536ca28/55e01e59/4935d204 必须 allow，私钥负门必须 block。"
capability_test: "n/a: 纯命令判定器静态回放，无 LLM 场景"
---

# 部署公开配置 grep 只读链误拦回放固化

## 问题与范围

healing `d536ca28-692a-41eb-83bd-d68181a90e60` 的完整 toolcall 在读取部署文件后，使用 grep 读取 SSH 公开配置并经 head 限长。既有 #1892 回放已明确此类公开只读操作应放行；本切片只追加精确样本，不把 commandHead 的截断形态当作完整命令，也不扩大私钥访问权限。

## 验证

`npx vitest run tests/guard/replay/replay.test.ts`：

- 首轮固化 d536ca28 时实测 206 例中此例失败（received `block`），其余 205 例通过。
- 2026-11-25 追加 11-24 的 7 条去重样本（ALLOW 2 / BLOCK 5）后，实测 **213 例中 3 失败、210 通过**。失败全部为 SSH 公开只读 ALLOW 样本（d536ca28、55e01e59、4935d204），作为 #2000 的可证伪复现；5 条 `curl→python` / 按名杀进程负门全部按预期 BLOCK。

各候选 verdict 与本文件 `expect` 逐条对应；candidates JSON 仅是 gitignored 过程产物，不作为 PR 验收依据。55e01e59、5c5e88d8、79cd0623、2a658702 四条在独立检视后已还原为原始 invoke toolcall，只有 7f8305e6 按安全纪律对密码与实体 ID 做等价占位。

四条原始命令可按下列锚点在 `invoke_events` 中回读（`event_type=assistant_toolcall`，时间均为 UTC）：

| healing | invoke_id | sequence_num | created_at |
|---|---|---:|---|
| 55e01e59-ebb6-4513-aa6a-c1c0a9eba629 | 359a8ad7-3093-4694-8ad4-f896b63addff | 100 | 2026-11-24T01:00:52.200Z |
| 5c5e88d8-c3ae-4df9-aa66-24132e7876f6 | 066683f7-d4dd-46e1-ab80-c824cf0f5f1c | 354 | 2026-11-24T04:20:02.003Z |
| 79cd0623-d401-40ef-b961-1fd8faa305ea | 53b315ba-e53c-4e1b-a840-6ced0e6e0820 | 135 | 2026-11-24T08:59:46.726Z |
| 2a658702-cc88-40d0-aae4-8d1d4c69b59c | bec0da17-134e-4300-b86f-c71183427c80 | 76 | 2026-11-24T10:33:30.762Z |

## 守卫修复（#2000）

### 根因

`src/frameworks/agent/bash-safety-guard.ts` 的 `CRED_WRITE_RE` 末尾为 `|>>|>/`——末尾 `/` 是正则字面量定界符，被提前截断，最后一个分支实为裸 `>`。因此任何含 `>` 的凭证上下文命令（`2>/dev/null`、`2>&1`、非凭证重定向目标）旧版全误拦为「写凭证」。SSH config 公开只读链普遍携带 `2>/dev/null`，即被此裸 `>` 误拦。

### 修复

收窄重定向分支为 `(?:^|[\s;&|])\d*>>?\s*[^\s;&|]*\.(?:ssh|gnupg|aws)\b`——重定向操作符须在命令边界（行首/空白/; & | 后，紧邻的 fd 前缀数字 `\d*` 算进命令 token），且目标确为凭证路径（.ssh/.gnupg/.aws）才拦。非凭证目标的 fd 重定向（`2>/dev/null`、`2>&1`）、尖括号占位（`<pattern> ~/.ssh`）放行；fd 前缀写凭证（`2> ~/.ssh/x`）仍拦（审视发现的退化点，已补相邻形态负门回放）。

### 样本政策对齐

`0dea2289`（2026-11-12 固化的负门：`grep -R ~/.ssh/config 2>/dev/null`）本是「含 .ssh 即拦」旧政策（#1892 前）遗留，其 block 判定依赖裸 `>` 误拦 stderr 重定向。修复后按「政策 A 改向」惯例 expect block→allow（样本留在 mustBlockCases，测试自动按 allow 断言）。

### 范围外披露（不修，交大獭裁决）

`49a9b0c7`（pgrep 红）是 `0f9874302` 追加的第 4 个缺陷，根因 `kill-segment-finder.ts:15` 的 `PKILL_COMMANDS` 误含 `pgrep`（查询误当杀）。与 #2000（SSH config cred_dir_access）无关；简单移除 pgrep 会导致 `kill $(pgrep -f "dist/src/main.js")` 漏拦（安全退化，违反「不改变安全语义」），需独立方案分离「pgrep 查询」与「pgrep→kill 数据流」，不并入本 PR。

## Rollback

Revert 本切片即删除该新增回放与守卫修复，不影响其它实现。

## Golden Gate

Golden Gate: n/a（verify_by=static_only）。

## 测试改动声明

方向：收紧。本分支合计新增 8 条回放（ALLOW 3 / BLOCK 5）+ `0dea2289` expect block→allow（政策 A 改向，非删改断言，属政策演进同步）。
