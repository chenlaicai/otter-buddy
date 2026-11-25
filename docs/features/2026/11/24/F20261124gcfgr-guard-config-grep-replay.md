---
id: F20261124gcfgr
title: 部署公开配置 grep 只读链误拦回放固化
summary: 将 2026-11-23/24 的公开配置只读误拦与五条现行负门命令固化为回放，保留可证伪的守卫政策现场。
change_type: bugfix
tags: [guard, replay, regression]
modules: [tests/guard/replay/cases-2026-10-29.ts]
created_at: 2026-11-24
intent:
  problem: "healing d536ca28 的部署只读命令在末段 grep SSH config 时被 cred_dir_access 拦截，与 #1892 已固化的公开配置只读放行政策不一致。"
  expected_effect: "精确真实命令进入 ALLOW 回放；当前返回 BLOCK 时测试失败，修复后该样本与既有私钥负门同时通过。"
  verify_by:
    type: static_only
    evidence:
      - "npx vitest run tests/guard/replay/replay.test.ts：healing d536ca28 必须 allow，其他负门不退化。"
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

## Rollback

Revert 本切片即删除该新增回放，不影响守卫实现。

## Golden Gate

Golden Gate: n/a（verify_by=static_only）。

## 测试改动声明

方向：收紧。本分支合计新增 8 条回放（ALLOW 3 / BLOCK 5），零存量断言删改。
