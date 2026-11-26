---
id: F20261124gcfgr
title: 部署公开配置 grep 只读链误拦回放固化
summary: 将 2026-11-23/24 的公开配置只读误拦与现行负门命令固化为回放（守卫修复根因归属 F20261126cwred）。
change_type: bugfix
tags: [guard, replay, regression]
modules: [tests/guard/replay/cases-2026-10-29.ts]
created_at: 2026-11-24
intent:
  problem: "healing d536ca28 的部署只读命令在末段 grep SSH config 时被 cred_dir_access 拦截，与 #1892 已固化的公开配置只读放行政策不一致。"
  expected_effect: "精确真实命令进入 ALLOW 回放；d536ca28/55e01e59/4935d204 三条 SSH 公开只读样本作为守卫修复（F20261126cwred）的可证伪复现转绿，0dea2289 按政策 A 改向 allow，既有私钥负门（cat/cp 私钥）不退化。"
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

## 守卫修复归属

本误拦的守卫修复（CRED_WRITE_RE 重定向分支收窄 + fd 前缀判据）另立特性文档 F20261126cwred，含根因、修复、样本政策对齐与范围外披露（pgrep 红 → #2059、词尾数字粘连 → #2063）。本文件只保留回放固化档案。

## Rollback

Revert 本切片即删除该新增回放，不影响其它实现。

## Golden Gate

Golden Gate: n/a（verify_by=static_only）。

## 测试改动声明

方向：收紧。本分支合计新增 8 条回放（ALLOW 3 / BLOCK 5）+ `0dea2289` expect block→allow（政策 A 改向，非删改断言，属政策演进同步）。
