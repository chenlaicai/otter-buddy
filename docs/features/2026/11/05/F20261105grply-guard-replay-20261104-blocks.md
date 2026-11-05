---
id: F20261105grply
title: 守卫回放库补 2 条 11-04 实录负门用例：非字面量 PID 清理双形态
created: 2026-11-05
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
change_type: feature-update
status: implemented
modules:
  - tests/guard/replay/cases-2026-10-29.ts
summary: "2026-11-05 晨检守卫固化段：11-04 拦截 7 条 → 4 SKIP（download_exec 数据消费误拦族，续 F20261102grply 铁律待搭档拍板）+ 2 条 BLOCK 固化（self_kill_nonliteral 非字面量 PID 清理双形态：pid 文件变量引用击杀、ps 管道批量击杀——库内原有 lsof 主端口间接形态，这两个变体缺位；第 3 条实录 node execSync 动态 PID 与既有用例同构不单独钉）。回放 88→90 全绿。"
intent:
  problem: "11-04 healing 实录 self_kill_nonliteral 3 条正当拦截中，2 条命令形态（p=$(cat pids/backend.pid); kill $p / ps|grep|awk|while kill）在回放库缺位——不固化则未来守卫改动可能静默放宽非字面量击杀拦截而回放库不报警"
  expected_effect: "mustBlock 新增 2 用例逐条 BLOCK（reason 含「无法静态确认」）；全量回放绿（88→90）"
  verify_by:
    type: capability_test
    description: "npx vitest run tests/guard/replay/replay.test.ts 90/90 全绿"
source_issue: null
related_prs: ["1778"]
causal_links: []
tags: [guard, replay, negative-gate, self-kill, regression]
---

# F20261105grply 守卫回放库补 2 条 11-04 实录负门用例

## 背景与来源

2026-11-05 晨检（每日对话健康检查守卫回放段）跑 `scripts/generate-guard-replay.mjs --db data/otter-buddy.db`：11-04 拦截 7 条 → 去重 7 候选 → 逐条裁决：

- **4× download_exec → SKIP**：同族误拦（curl 管道进 python3/node 的 API JSON 数据消费，含 GitHub API / HN API / Chrome CDP 调试端口），续 F20261102grply（99f96502）定性「政策性拦截·已知摩擦·精细化候选」。按回放库铁律「搭档确认误拦后固化」未入库——该族放行语义（URL 白名单/管道消费豁免）已在 RHI #641 候选池等搭档拍板（RHI 侧 11-05 已 dismissed 终态化）。
- **3× self_kill_nonliteral → 正当拦截，其中 2 条形态固化**：正当拦截（colink 仓库 dev 进程清理，kill 目标均为变量/命令替换，静态不可证安全）。两个命令形态库内缺位：
  1. **pid 文件变量引用**（healing 47419e82）：`p=$(cat data/dm-thread-debug/app/pids/backend.pid); kill $p`
  2. **ps 管道批量击杀**（healing 9b7eb7c7）：`ps aux | grep "vitest" | grep -v grep | awk '{print $2}' | while read p; do kill $p; done`
  
  第 3 条实录（healing 3c413377，node execSync 动态 PID）与既有「kill -9 $(lsof -tiTCP:3000)」命令替换形同构，不单独钉。

## 变更内容

mustBlockCases 组 +2（`tests/guard/replay/cases-2026-10-29.ts`），全部 reasonContains「无法静态确认」。

## 验证

- `npx vitest run tests/guard/replay/replay.test.ts` → 90/90 全绿（基线 88，worktree guard-replay-1105 本机实跑，含新增 2 条）
- PR #1778 CI 复跑同一命令

## 判性依据（healing 台账锚点）

| healing 事件 | 规则 | 判定 | 依据 |
|---|---|---|---|
| 47419e82 / 9b7eb7c7 | self_kill_nonliteral | 正当拦截 → 固化 2 条 | kill 目标为 pid 文件变量 / ps 管道批量，形态库内缺位；引导出口（字面量 PID / restart-service kill-by-pid）已给出，LLM 换路径推进 |
| 3c413377 | self_kill_nonliteral | 正当拦截 → 不单独钉 | node execSync 动态 PID 与既有 lsof 命令替换形同构，已覆盖 |
| fa63e6e3 / a78a325d / f9877327 / 5815bff7 | download_exec | 误拦族 → SKIP | API JSON 数据消费非下载执行；同 #641 族等搭档拍板 |

## 修正记录

对抗审视（检视獭-1105，2026-11-05）发现初版全链声称「补 3 条」与实际 diff（+2 用例，88→90）不符——「3 条实录判 BLOCK」与「2 条形态缺位固化」混写。已全链修正（PR title/commit message/PR body/本文档）：新增 2 条，基线 88→90。审视原文见 PR #1778 review（--comment）。

## 后续动作

- PR #1778 delta 复审（检视獭-1105）→ 搭档终审
- download_exec 数据消费族的放行语义仍在候选池（RHI #641 dismissed 终态 + healing 样本 defer 归口），拍板后按铁律固化 ALLOW 用例
