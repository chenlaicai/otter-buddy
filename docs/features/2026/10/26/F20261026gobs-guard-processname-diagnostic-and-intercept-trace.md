---
id: F20261026gobs
title: 进程名诊断回显 kill 语境门 + bash 守卫拦截显式落痕（M-2edf95d5 / M-2bf6e98c）
summary: "M-2edf95d5：命令行含 otter-buddy 字样（--author=\"… <otter-buddy>\"、node 解释器、含仓库路径脚本）在非 kill 语境被「进程名模式」误标，回显误导根因归因——收窄到 kill 语境（有 kill 族动词）才回显；M-2bf6e98c：守卫拦截在 tool_execution_start 走 abort，信号异步与工具执行竞态致被拦命令静默 exit 0 零输出（#1616 主仓落点 node 探针实证），abort 自动重试又冲淡痕迹——拦截前置到 tool_call 门显式落痕（isError 显式回显被拦理由）"
change_type: fix
capability_test: "n/a: 纯守卫判定/诊断回显行为修复，无 LLM 参与行为"
intent:
  problem: "①M-2edf95d5 进程名模式误拦族（#1585 台账）：`git commit --author=\"修复獭-守卫可观测 <otter-buddy>\"` 的 author email 字样、`node script.js` 的解释器名、含 otter-buddy 路径的脚本命令，在被守卫拦（main-write 等）时命中详情挂「进程名模式」标签——该模式仅做诊断回显但回显误标连续误导两次根因归因（作者/归因者误以为是进程名模式拦的，实为 main-write）。根因：locateTriggerContext 的进程名模式正则对数据位（引号内 email、命令名、路径）无差别匹配。②M-2bf6e98c 守卫拦截静默中和：#1616 主仓落点 node 探针「静默 exit 0、零输出」（--base nosuchref 必报错路径也静默），对照实验证明命令未执行到脚本——守卫拦截在 tool_execution_start 走 abortOnUnsafeBash→doAbort→session.abort()，abort 信号异步生效与工具执行竞态，被拦命令可能已 spawn 并返回静默成功；abort 后自动重试又把痕迹冲淡。探针据此误判为闸洞（假绿污染排查结论）"
  expected_effect: "①「进程名模式」只在 kill 语境（有 kill 族动词 pkill/killall/kill/pgrep/skill）回显——非 kill 语境的 otter-buddy/node 字面量是数据/命令名不标；真实 kill 目标语义（pkill -f otter-buddy）回显不变。②被拦 bash 命令不执行，tool_call 门返回显式 isError「此命令被安全守卫拦截（命令未执行）：<理由>」——模型/探针看到显式落痕而非静默 exit 0，排查结论不再被假绿污染"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-26
from:
  tasks:
    - "M-2edf95d5"
    - "M-2bf6e98c"
---

# 进程名诊断回显 kill 语境门 + bash 守卫拦截显式落痕（M-2edf95d5 / M-2bf6e98c）

## 背景与病灶

### M-2edf95d5 进程名模式误拦族（诊断回显误标）

`locateTriggerContext`（bash-safety-guard.ts）的「进程名模式」正则 `(?<!\/)\b(?:otter-buddy|otter_buddy|dist\/src\/main|main\.js|node)\b(?!\/)` 只做了 token-slash 检查（F20261019f714 收窄路径型 token），但对**数据位**无差别匹配：

- `git commit --author="修复獭-守卫可观测 <otter-buddy>"` —— author email 字样 `<otter-buddy>` 被标「进程名模式」
- `node /path/script.js` —— 解释器名 `node` 被标「进程名模式」
- 含 otter-buddy 路径/字面量的命令 —— 被标「进程名模式」

该模式**仅做诊断回显、不参与拦截判定**（locateTriggerContext 注释在案），但回显误标连续误导两次根因归因（#1585 台账：署名规范 author 格式被误判进程名，归因者误以为是进程名模式拦的，实为 main-write 拦的）。

### M-2bf6e98c 守卫拦截静默中和（假绿污染排查）

#1616 排查插曲：主仓落点 node 探针「静默 exit 0、零输出」（`--base nosuchref` 必报错路径也静默），对照实验（同脚本 /tmp 仓正常报错）证明命令未执行到脚本——是守卫拦截的静默中和。

机制：守卫拦截在 `tool_execution_start`（circuit-breaker subscribe）走 `abortOnUnsafeBash → doAbort → session.abort()`，abort 信号**异步**生效与工具执行**竞态**——被拦命令可能已 spawn 并返回「exit 0、零输出」的静默成功；abort 后自动重试又把被拦命令的痕迹冲淡（静默替换）。探针据此误判为闸洞（假绿），污染排查结论。

## 修法决策与机制识别检查点

**修法决策树判定**：
- M-2edf95d5 → **② 收窄问题机制的管辖边界**（「进程名模式」诊断只管 kill 语境，不再对数据位泛匹配）→ `scope-reduction`
- M-2bf6e98c → **① 在既有机制语义内修（缺啥补啥）**（守卫已拦截，缺显式落痕——补上）→ `narrow-fix`

**机制识别检查点**（逐项打勾）：
- □ 新增配置字段/枚举/开关 —— 否
- □ 新增状态生命周期 —— 否
- □ 新增定时任务/后台进程 —— 否
- □ 新增信号类型/消息格式 —— 否（复用 halt/loop-block 既有 `{block, reason}` → isError SDK 通道）
- □ 新增持久化存储 —— 否
- □ 新增决策分支（结果被记住并影响后续行为）—— 否（纯运行时临时分支，不持久化）
- ☑ 新增跨模块调用路径 —— **是**（model-runtime-registry 的 tool_call 门 → bash-safety-guard 的 checkBashCommandSafety）

**为何命中检查点（跨模块调用路径）但不涉净新增机制**：bashGuardGate 复用三样既有机制——① tool_call 门机制（haltToolCallGuard/loopBlockGuard 同一条链、同一 `{block, reason}` 返回格式）② 守卫判定（checkBashCommandSafety，与 abortOnUnsafeBash 同源同参）③ SDK 的 `{block}` → isError tool result 通道——只是把既有守卫判定接进既有门，是「新调用路径接旧机制」不是净新增机制（无新配置/新状态/新定时任务/新信号/新存储）。故走①②③而非④（新增机制），不涉机制预算四问与重对抗门。

**Modification-Class**：`narrow-fix`（M-2bf6e98c 主修，①既有机制语义内修；M-2edf95d5 为②scope-reduction，同分支内一并交付）。

## 修复内容

### 1. 进程名诊断回显 kill 语境门（M-2edf95d5，bash-safety-guard.ts）

`locateTriggerContext` 的「进程名模式」增加 kill 语境门：`hasKillVerb = /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:p?kill|skill|killall5?|pgrep)\b/i.test(command)`——无 kill 族动词时跳过「进程名模式」回显（数据位字面量是数据/命令名不是 kill 目标）。保留既有 token-slash 检查（路径型 token 不标）。

### 2. bash 守卫门显式落痕（M-2bf6e98c，model-runtime-registry.ts + pi-session-factory.ts）

新增 `bashGuardGate(store, toolName, input)`——tool_call 层对 bash 命令跑 `checkBashCommandSafety`，被拦时返回 `{block: true, reason: "此命令被安全守卫拦截（命令未执行）：<理由>"}`，SDK 生成 isError tool result 返回 LLM（显式落痕）。接进 tool_call 门链：`haltToolCallGuard ?? loopBlockGuard ?? bashGuardGate`。

- **fail-open**：store / guardProjectRoot 缺省时放行（镜像 halt/loop-block），退化到 abortOnUnsafeBash 兜底链（降级不降安全）
- **同源判定**：守卫参数（projectRoot/sessionCwd）由 `_executeWithSession` 提为单一真相源，store（tool_call 门）与 attachGuards（abort 兜底链）同点求值，防门与 abort 判定分歧（R-2b）

## 红绿证据

**M-2edf95d5 红证（修复前，探针实测）**：
```
### A1-git-author
CMD: git commit --author="修复獭-守卫可观测 <otter-buddy>" -m "feat: x"
GUARD: BLOCK -> 写命令落点解析到主仓…（main-write 拦）
【命中详情】进程名模式：…复獭-守卫可观测 <otter-buddy>" -m "fea… @32   ← 误标
```

**绿证（修复后，探针实测）**：
```
### A1-git-author
GUARD: BLOCK -> 写命令落点解析到主仓…（main-write 拦，理由清晰）
（无【命中详情】进程名模式误标）
### C1-real-kill
GUARD: BLOCK -> …（kill 族拦）
【命中详情】kill 族命令：…pkill -f otter-… @0；进程名模式：…pkill -f otter-buddy… @9   ← kill 语境真命中保持
```

**M-2bf6e98c 红绿**：`bashGuardGate` 修复前不存在（bash 命令走 abort 竞态静默中和）；修复后返回显式 isError「此命令被安全守卫拦截（命令未执行）」。测试 `tests/frameworks/agent/bash-guard-gate.test.ts` 锁定 6 形态（被拦显式落痕/放行/非 bash/fail-open/空命令/主仓写同源）。

## 测试

- `tests/frameworks/agent/bash-guard-processname-diagnostic.test.ts`：+5 用例（kill 语境门），全 25 用例过
- `tests/frameworks/agent/bash-guard-gate.test.ts`：+6 用例（显式落痕），全过
- 全量回归：431 files / 6867 passed / 6 skipped 零失败
- tsc --noEmit 零错误；eslint 零错误

## 影响范围与边界

- **M-2edf95d5**：只影响「进程名模式」诊断回显（不参与拦截判定），收窄后非 kill 语境不标——拦截判定零变化（保护零削弱，真实 pkill/killall 拦截与回显不变）
- **M-2bf6e98c**：被拦 bash 命令从「abort + 静默中和」改为「tool_call 门显式 isError」——拦截判定同源（checkBashCommandSafety），只是落痕方式变显式；abortOnUnsafeBash 保留为兜底链（门 fail-open 时降级）
- **与在途 PR 边界**：#1641（isKillAtCommandPosition 词法误判）在 kill-segment-finder.ts，#1640（gh pr checks 透传）在 tool-factory.ts——本单在 bash-safety-guard.ts（诊断回显）+ model-runtime-registry.ts（tool_call 门）+ pi-session-factory.ts（守卫参数传递），三者不重叠，无撞车

## 建议与遗留

- 门与 abort 的双层判定（gate 先拦、abort 兜底）对放行命令有两次 checkBashCommandSafety 的性能开销——若实测可感知，后续可优化为 gate 置已检标志、abort 跳过重复判定（本单不展开，避免行为面扩大）
- M-2bf6e98c 的「静默 exit 0」精确合成点（abort 竞态 vs 沙箱中和 vs 自动重试替换）静态分析未完全钉死——本修复在 tool_call 门层显式落痕，**无论下游哪条路径静默中和，被拦命令都不会执行、必然带显式痕迹**（鲁棒覆盖），精确机制待下次现场复现时补钉
