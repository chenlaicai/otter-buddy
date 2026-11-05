---
id: F20261105killa
title: "kill 守卫政策 A：非字面量目标「能确认才拦，确认不了放行」——v4 宁漏勿误原则贯彻第一站"
summary: "搭档拍板（2026-11-05 14:12 卡片回执 A_revert_default）终结 8/30 审视轮临时翻转固化的「非字面量 kill 保守拦」：INDIRECT_PID_PATTERNS 兜底拦截退役，保留三条确认通道（字面量三查/PID 文件引用/pkill 特征名）+ 广播 kill 拦截 + #844 白名单端口放行。回放库同步改向：1 条 mustBlock 改 allow（lsof 主端口间接）+ 新增 3 条 11-04 实录误拦形态 allow 用例（#1778 拟钉的 2 条实录按新政策改向后随本 PR 落地）。"
change_type: fix
capability_test: "n/a: 守卫判定逻辑（纯函数），以回放回归库 91 用例 + guard-intercept-classify 24 用例 + 全量 5682 测试为验证载体"
intent:
  problem: "v4 重写（#1711）同时立了两个矛盾条款：第二站黑名单总则「宁漏勿误、一切看不懂的形态不拦」，第一站却保留 8/30 审视轮为堵非字面量绕过临时翻转为保守拦的 INDIRECT_PID_PATTERNS——「看不懂就拦」与守卫立身之本（搭档 11-05 定调：工具拦截层不可能枚举所有 bash，无法识别就拦只会导致误拦爆发，血泪教训）直接冲突。30 天 healing 实录：17 个活跃日 37+ 次正当清理被拦（獭清自有 dev server、vitest/playwright 无头浏览器批量清理），11-03 单日 9 次。"
  solution: "checkIndirectKillTarget 删除 INDIRECT_PID_PATTERNS 兜底拦，非字面量目标默认放行；保留拦得有依据的通道：①字面量 PID 三查（PID 文件比对/args 指纹/直接父进程）②PID 文件引用（kill $(cat .otter-buddy.pid)——目标即主进程号码来源）③pkill/killall 特征名 ④广播/进程组 kill（-1 语义必含主进程，属能确认）+ #844 白名单端口溯源放行先行。"
  expected_effect: "正当清理（pid 文件变量、ps 管道批量、pgrep 命令替换）不再被拦；主进程保护面不变（三条确认通道 + 广播拦 + 服务脚本拦全保留）；v4 原则内在矛盾消除。"
  verify_by:
    type: behavior_check
    assertions:
      - "回放库 91/91 全绿：3 条 11-04 实录误拦形态（healing 47419e82/9b7eb7c7/3c413377 同族）改向 allow；确认通道 mustBlock 全保留（kill 12345/PID 文件替换/pkill 特征名/服务脚本/广播）"
      - "guard-intercept-classify 24/24：self_kill_nonliteral 探针退役改历史文案直测 classify 兜底（存量 healing 37+ 条回溯归因链不断）"
      - "全量 5682/5682 绿（vitest run 无过滤）"
      - "esbuild 直编译产物行为验证：kill $PID → allow / kill -9 $(cat .otter-buddy.pid) → BLOCK self_kill_main / cat .otter-buddy.pid | xargs kill -9 → allow（干净环境三态符合政策）"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [guard, kill, policy, fail-open, replay]
modules:
  - agent
causal_links:
  - {type: "supersedes-partial", id: "PR#1778", note: "#1778 拟把 11-04 实录钉为 mustBlock（正当拦截口径），政策 A 反转后该 2 条实录随本 PR 以 allow 形态落地回放库；#1778 分支废弃"}
  - {type: "corrects", id: "F20261030gblkv", note: "v4 重建将 8/30 保守拦作既有资产原样保留，与其总则宁漏勿误矛盾——本 PR 补完 v4"}
  - {type: "reverts-to", id: "PR#611", note: "8/30 初版立身之本即「能确认才拦」；同日审视轮为堵非字面量绕过临时翻转，战时修法固化至今"}
---

# kill 守卫政策 A（F20261105killa）

## 政策拍板

2026-11-05 14:12 搭档卡片回执 `A_revert_default`：「kill 守卫政策选 A：能确认才拦，确认不了放行」。拍板背景：搭档追问「既然是误拦，说明逻辑有问题，为啥只改测试」（#1778 呈审时），澄清「正当拦截」判定后搭档定调底线——「工具拦截层不可能把所有 bash 列出来，无法识别就拦截只会导致误拦爆发，血一般的教训，不能重蹈覆辙」。

## 演进史（为何叫「反转」）

| 时间 | 事件 | 政策状态 |
|---|---|---|
| 8/30 | PR #611 初版守卫 | 能确认才拦（立身之本） |
| 8/30 | 同 PR 审视修正轮：检视獭发现非字面量形态可绕过字面量检查 | **临时翻转为保守拦**（战时修法：9/10 PoC 拦截清单） |
| 9/16-9/25 | 事故家族迭代（#990/#1168 等） | 保守拦固化，注释写「保守拦」 |
| 10/30 | guard-v4 重建（#1711）：INDIRECT_PID_PATTERNS 作「既有资产」全保留 | 与 v4 总则「宁漏勿误、看不懂不拦」**内在矛盾**埋下 |
| 11-04 | 3 条实录误拦（healing 47419e82/9b7eb7c7/3c413377）；#1778 拟钉 mustBlock | 大獭按「正当拦截」呈审（判性存疑） |
| 11-05 | 搭档质疑 → 政策拍板 A | 宁漏勿误贯彻第一站，原则统一 |

## 变更清单

- `src/frameworks/agent/bash-safety-guard.ts`
  - `checkIndirectKillTarget`：删除 `INDIRECT_PID_PATTERNS.some(...)` 兜底拦截，非字面量目标放行；`PID_FILE_REFERENCE` 通道拦截保留（kill 段内引用主进程 pid 文件 → MAIN_KILL_BLOCK_MSG）
  - `INDIRECT_PID_PATTERNS` 常量保留（@deprecated 注记，历史归因对照用）
  - `INDIRECT_KILL_BLOCK_MSG` 保留（存量 healing 台账文案归因链：classifyGuardInterceptReason 兜底仍需可分类）
  - 文件头注释与函数注释更新政策口径与演进史
- `tests/guard/replay/cases-2026-10-29.ts`
  - mustBlock「lsof 主端口间接 kill」改向 allow（F20261105killa 注记）
  - dailyTrafficCases 新增 3 条 11-04 实录误拦形态（pid 文件变量击杀/ps 管道批量/pgrep 命令替换）allow 用例——#1778 拟钉的 2 条实录按新政策落地
- `tests/guard/replay/replay.test.ts`：mustBlockCases 分组支持 expect=allow 的改向用例（政策反转时用例留在原数组、断言切到误拦面）
- `tests/frameworks/agent/guard-intercept-classify.test.ts`：self_kill_nonliteral 探针退役（kill $PID 已放行，无现存产生该文案的命令形态），改历史原文案直测 classify 兜底归因

## 保留的确认通道（拦得有依据）

1. **字面量 PID 三查**：PID 文件主进程号相等 / args 指纹（MAIN_ARGS_SIGNATURE）/ 直接父进程是主进程
2. **PID 文件引用**：kill 段内引用 `.otter-buddy.pid`（目标即主进程号码来源）
3. **pkill/killall 特征名**：按名匹配 otter-buddy/node 特征（无法区分目标，恒拦）
4. **广播/进程组 kill**：kill -1 / kill -- -PGID（kill(2) 语义必含主进程——属「能确认」而非保守）
5. **服务脚本自杀**：otter-buddy.sh stop/restart（9/16 原案）

## 残余风险（搭档知情接受）

- 两步构造（先把主进程 PID 存进无关变量再 kill）静态确认不了 → 放行，运行时防线（主进程监控/自动重启）兜底
- 与既有「宁漏勿误」取舍同向：守卫防的是獭的误操作与提示词注入的直白形态，不防蓄意多步构造

## 验证证据

- 回放回归库 91/91（`npx vitest run tests/guard/`）：确认通道 mustBlock 全绿 + 改向 allow 用例全绿
- guard-intercept-classify 24/24（归因链兜底完整）
- 全量 5682/5682（`npx vitest run` 无过滤，2026-11-05 worktree 实跑）
- esbuild 直编译产物三态验证（绕开测试缓存的环境隔离验证）：`kill $PID → allow`、`kill -9 $(cat .otter-buddy.pid) → BLOCK self_kill_main`、`cat .otter-buddy.pid | xargs kill -9 → allow`

## 与 #1778 的关系

#1778（回放库补 11-04 实录负门用例）在本政策反转下**整体废弃**：其 2 条实录用例的 expect 必须反转，而反转后的用例已随本 PR 落地（dailyTrafficCases 3 条）。分支 guard/replay-20261104-blocks 不合入，留搭档确认后清理。

## 测试改动声明

方向：语义改向 + 新增——回放库 1 条 mustBlock 改 allow（政策反转核心断言）+ 3 条实录新增；classify 探针退役换文案直测。无测试删除。
