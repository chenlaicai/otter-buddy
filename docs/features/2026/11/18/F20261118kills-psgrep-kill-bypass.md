---
id: F20261118kills
title: "kill 守卫第 4 确认通道：ps|grep 主服务入口签名→kill 数据流（#1899 裸 bash 绕过面）"
summary: "2026-11-16 stage3a 验证会话裸写 `for PID in $(ps aux | grep \"[d]ist/src/main.js\" | awk '{print $2}'); do kill $PID; done` 按名全局匹配杀死主服务（pid 45203）——pkill/killall 防线被 ps|grep|awk|kill 管线绕过。新政 A 第 4 确认通道：ps→grep(主服务入口签名 dist/src/main.js)→…→kill 数据流等价 pkill 按名，恒拦（复用 self_kill_byname 规则族）；只认精确签名——裸 node/main.js/otter-buddy 不构成确认（无法确认是主服务），宁漏勿误继续放行。"
change_type: fix
capability_test: "n/a: 守卫判定逻辑（纯函数），以 guard 回放回归库（146 用例，七轮检视+两轮独立复核对抗探针持续追钉）+ 全量 vitest 为验证载体"
intent:
  problem: "#1899 事故：主服务与 worktree alpha 跑同一命令行 `node dist/src/main.js`，大獭清理 alpha 实例时裸写 ps|grep|awk|kill 按进程名匹配，把主进程连带杀死（全系统离线）。既有 self_kill_byname 只拦 pkill/killall 按名形态；政策 A 下「非字面量 kill（变量/命令替换/管道）确认不了就放行」——ps|grep 按名扫描主进程特征再 kill 恰是「能确认」（目标来源=主进程特征名匹配），却落进放行面，形成可复发的绕过缺口。"
  solution: "psGrepMainSignatureFeedsKill 作为政策 A 第 4 确认通道：识别 ps→grep(主服务入口签名 dist/src/main.js)→…→kill 数据流，命中即拦（PS_GREP_KILL_BLOCK_MSG，ruleId 复用 self_kill_byname，与 pkill 按名同族聚合）。覆盖四种喂 kill 形态：①for 循环变量（for VAR in $(scan…); do kill $VAR）②while read 变量（scan… | while read …; do kill $v）③xargs（scan… | xargs kill）④命令替换直给（kill $(scan…)）。grep 反 self-match 括号变体 [d]ist 归一后再对 PS_GREP_MAIN_SIGNATURES（仅 dist/src/main.js）匹配；只认精确签名——裸 node/main.js/otter-buddy/vitest 无法确认是主服务，宁漏勿误放行（对偶负门保留）。"
  expected_effect: "#1899 事故凶器及同族变体全部转 block（self_kill_byname）；存量政策 A allow 面（vitest 管道批量清理、自有 pid 文件变量 kill、按裸 node/main.js 名批量清理）不受影响；主进程保护面收紧一处可复发缺口，且不违背宁漏勿误。"
  verify_by:
    type: behavior_check
    assertions:
      - "guard 回放 146/146 全绿：事故凶器及同族变体 mustBlock + 对抗探针负门 allow 全保留（七轮检视共追钉 5+4+3+4+2+2 组探针；独立复核两轮：15 条+14 条对抗钉全部修复并钉入回归）"
      - "存量 allow 用例不受影响：ps|grep vitest while-read 批量清理、p=$(cat pids/backend.pid); kill $p 等政策 A 改向用例全放行"
      - "guard-intercept-classify 28/28：新文案含「按名匹配会命中主进程」锚词，classify 归因 self_kill_byname 连续"
      - "全量 vitest run 无回归；tsc --noEmit 与 eslint 对改动文件零告警"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [guard, kill, self_kill, fail-open, replay, ps-grep-bypass]
modules:
  - agent
causal_links:
  - {type: "extends", id: "F20261105killa", note: "政策 A 第 4 确认通道——补齐「ps|grep 按名扫描主进程特征」这一政策 A 遗留的可确认形态缺口"}
  - {type: "corrects", id: "issue#1899", note: "2026-11-16 stage3a 误杀主服务事故根因与防线补强"}
---

# kill 守卫第 4 确认通道：ps|grep 主服务入口签名→kill（F20261118kills）

## 事故还原

2026-11-16 16:44，主服务（pid 45203，端口 3000）被 SIGTERM 杀死。排查确认非崩溃：stage3a 验证会话在清理 alpha 实例时裸写：

```bash
for PID in $(ps aux | grep "[d]ist/src/main.js" | awk '{print $2}'); do kill $PID 2>/dev/null; done
```

主服务与 worktree alpha 同一命令行 `node dist/src/main.js`，按名匹配等于无差别扫射；grep 的 `[d]ist` 括号变体还专门规避了「grep 自身命令行含关键词」的自匹配——这是熟悉 grep 惯用法的人才写得出的绕过形态。

## 为何防线漏了

| 既有防线 | 覆盖形态 | 本案为何漏 |
|---|---|---|
| `self_kill_byname` | `pkill`/`killall` 按名 | 凶器用 `kill $PID`（变量），非 pkill |
| `self_kill_main` 三查 | 字面量 PID 指向主进程 | 目标是非字面量变量 |
| `PID_FILE_REFERENCE` | `kill $(cat .otter-buddy.pid)` | 未引用 pid 文件 |
| 广播/进程组 | `kill -1`/`kill -- -PGID` | 非广播形态 |
| 政策 A 非字面量 | 确认不了→放行 | 本案**能确认**却落进放行面 |

关键：政策 A「能确认才拦」确认不了才放行——而「ps 输出经 grep 过滤主进程特征名再取 PID 喂 kill」的目标来源就是主进程特征名匹配，与 pkill 按名**同构**，属「能确认」，却被既有通道漏掉。

## 变更

- `src/frameworks/agent/psgrep-token-scan.ts`：词法级扫描层——复用 `command-lexer` 只消费可执行 token（comment/单引号字面量/转义展开不进入执行面），`||`/`&&`/`;` 作为独立语句边界不再串数据流；grep 旗标按真实语义解析（`-v`/`--invert-match` 反向、`-vE` 组合、显式 `-i` 才大小写折叠，默认敏感；GNU 文法区分 pattern 与 file operands——`grep foo 签名`/`grep -f 签名` 中签名是文件非模式；`-e` 显式模式后位置参数全是文件）；ps/grep 前剥 command/env/timeout/赋值等受限 wrapper；数据源状态机——新 `ps` 重置数据流，旧 inverse 不否决新数据源的正向扫描。

`src/frameworks/agent/psgrep-kill-scan.ts`：数据流判定层——枚举 kill 全部目标变量（非首变量）、for 列表全部 word 的 cmdsub（非首项）、kill 前最后一次重赋值优先、最内层同名循环绑定优先；引号载荷递归必须有 bash/sh `-c` provenance（普通 echo/printf 参数不递归）且在载荷内重跑 `findKillSegments` 定位真实 kill 段（嵌套 `-c` 逐层展开）；kill 落在 cmdsub word 内时变量绑定在外层判定；直接目标枚举遇 `|` 即止（下游命令的 cmdsub 不是 kill argv）。

`src/frameworks/agent/bash-safety-guard.ts`：

- 新增 `PS_GREP_KILL_BLOCK_MSG`（ruleId `self_kill_byname`，layer `self_kill`——与 pkill 按名同族聚合，healing 归因连续）。
- 第 4 通道在字面量三查之后无条件追加（不再被「存在字面量 PID」短路——字面量与扫描来源可混合出现在同一 kill argv）。
- `checkOneKillSegment` 拆出单段四查（complexity 分解）。

`tests/guard/replay/cases-2026-10-29.ts`：#1899 区块 62 条（36 block + 26 allow）——含独立复核两轮 29 条对抗钉（一轮：6 漏拦+9 误拦；二轮：9 漏拦+5 误拦）+ 4 条自钉（-e 文件操作数/while-cmdsub kill/echo 引号数据/timeout wrapper 载荷）。

## 判定语义（为何不误伤）

- **只认精确签名**：grep 模式须含 `dist/src/main.js`（主服务与 worktree alpha 同命令行，按此签名扫描后 kill 时二者不可区分，属「能确认」）才拦截；`grep node`、`grep main.js`、`grep otter-buddy`、`grep vitest` 等无法确认是主服务，宁漏勿误放行。
- **`grep -v` 是排除非扫描**：`grep -v 签名` / `--invert-match` 明确从结果里搬除主进程，不构成正面扫描；`ps | grep -v 'main' | grep vite | xargs kill`（只清 vite）放行。
- **反 self-match 归一**：`[d]ist` 单字符括号变体先归一为 `dist` 再匹配——只剥离单字符类（self-match 惯用法），不动 `[0-9]`/`[a-z]` 等真实字符类。
- **数据流挂钩**：扫描链与 kill 必须有变量绑定/管道/命令替换的真实喂送关系，非「同命令内恰好共现」；变量目标取 kill 所在最内层同名循环绑定、kill 前最后一次重赋值优先（内层遮蔽/重赋值不再误关联外层扫描），同名 kill 段按出现次序对齐（重复 `xargs kill` 不漏后一段）。
- **词法边界（新世复核后）**：只消费 command-lexer 可执行 token——`#` 注释与单引号字面量永不进入执行面（注释里的 `grep -v` 否决不了真实链，注释/单引号里的 `ps|grep` 也不构成扫描）；`||`/`&&`/`;` 两侧是独立数据流不串链；grep 默认大小写敏感，仅显式 `-i` 才折叠；`-vE`/`-ve` 等组合短旗标中的 `v` 就是反向匹配。
- **转义字面量不当替换**：`\$()`/反引号是字面量非执行面（宁漏勿误），双引号 `-c` 载荷的延后替换属确认不了的面，放行——单引号等价载荷仍在拦截面。
