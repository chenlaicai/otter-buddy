---
id: F20261124gcfgr
title: 部署公开配置 grep 只读链误拦回放固化
summary: 将 healing d536ca28 的完整公开配置只读命令固化为 ALLOW 回放，复现其与既有政策不一致的误拦。
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

`npx vitest run tests/guard/replay/replay.test.ts`：样本期望 `allow`。固化时实测 206 例中此例失败（received `block`），其余 205 例通过，作为 #2000 的可证伪复现。

## Rollback

Revert 本切片即删除该新增回放，不影响守卫实现。

## Golden Gate

Golden Gate: n/a（verify_by=static_only）。

## 测试改动声明

方向：收紧。新增一条 ALLOW 回归样本，零存量断言删改。
