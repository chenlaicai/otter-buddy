---
id: F20261118kills
title: "kill 守卫第 4 确认通道：ps|grep 主服务入口签名→kill 数据流（#1899 裸 bash 绕过面）"
summary: "2026-11-16 stage3a 验证会话裸写 `for PID in $(ps aux | grep \"[d]ist/src/main.js\" | awk '{print $2}'); do kill $PID; done` 按名全局匹配杀死主服务（pid 45203）——pkill/killall 防线被 ps|grep|awk|kill 管线绕过。新政 A 第 4 确认通道：ps→grep(主服务入口签名 dist/src/main.js)→…→kill 数据流等价 pkill 按名，恒拦（复用 self_kill_byname 规则族）；只认精确签名——裸 node/main.js/otter-buddy 不构成确认（无法确认是主服务），宁漏勿误继续放行。"
change_type: fix
capability_test: "n/a: 守卫判定逻辑（纯函数），以 guard 回放回归库（169 用例，其中 #1899 区块 85 条=33 模板内 block+52 负门含 18 条已接受残余钉）+ 全量 vitest 为验证载体"
intent:
  problem: "#1899 事故：主服务与 worktree alpha 跑同一命令行 `node dist/src/main.js`，大獭清理 alpha 实例时裸写 ps|grep|awk|kill 按进程名匹配，把主进程连带杀死（全系统离线）。既有 self_kill_byname 只拦 pkill/killall 按名形态；政策 A 下「非字面量 kill（变量/命令替换/管道）确认不了就放行」——ps|grep 按名扫描主进程特征再 kill 恰是「能确认」（目标来源=主进程特征名匹配），却落进放行面，形成可复发的绕过缺口。"
  solution: "psGrepMainSignatureFeedsKill 作为政策 A 第 4 确认通道：识别 ps→grep(主服务入口签名 dist/src/main.js)→…→kill 数据流，命中即拦（PS_GREP_KILL_BLOCK_MSG，ruleId 复用 self_kill_byname，与 pkill 按名同族聚合）。覆盖四种喂 kill 形态：①for 循环变量（for VAR in $(scan…); do kill $VAR）②while read 变量（scan… | while read …; do kill $v）③xargs（scan… | xargs kill）④命令替换直给（kill $(scan…)）。grep 反 self-match 括号变体 [d]ist 归一后再对 PS_GREP_MAIN_SIGNATURES（仅 dist/src/main.js）匹配；只认精确签名——裸 node/main.js/otter-buddy/vitest 无法确认是主服务，宁漏勿误放行（对偶负门保留）。"
  expected_effect: "#1899 事故凶器及同族变体全部转 block（self_kill_byname）；存量政策 A allow 面（vitest 管道批量清理、自有 pid 文件变量 kill、按裸 node/main.js 名批量清理）不受影响；主进程保护面收紧一处可复发缺口，且不违背宁漏勿误。"
  verify_by:
    type: behavior_check
    assertions:
      - "guard 回放 169/169 全绿：模板内形态全拦（事故凶器/四核心形态/字面量混合/载荷内模板），模板外 18 条残余钉全放行（M-de200a08 拍板：明确拦，不明确必须放通）"
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

- `src/frameworks/agent/psgrep-token-scan.ts`：词法级扫描层——复用 `command-lexer` 只消费可执行 token（comment/单引号字面量/转义展开不进入执行面），`||`/`&&`/`;` 作为独立语句边界不串数据流。**固定模板判定**（M-de200a08）：ps→[grep -v grep]*→grep(签名)→[grep -v grep|awk 单script]*→链尾 kill/xargs；grep argv 白名单四形态（模式/`-e 模式`/`--regexp=模式`/`-v 模式`）；白名单外任何命令/旗标形态返回放行（不确认）。四轮通用文法实现（wrapper 剥除/旗标全解析/stdin 传递性状态机）已按拍板移除。

`src/frameworks/agent/psgrep-kill-scan.ts`：数据流判定层——枚举 kill 全部目标变量（非首变量）、for 列表全部 word 的 cmdsub（非首项）、kill 前最后一次重赋值优先、最内层同名循环绑定优先；引号载荷递归必须有 bash/sh `-c` provenance（普通 echo/printf 参数不递归）且在载荷内重跑 `findKillSegments` 定位真实 kill 段（嵌套 `-c` 逐层展开）；kill 落在 cmdsub word 内时变量绑定在外层判定；直接目标枚举遇 `|` 即止（下游命令的 cmdsub 不是 kill argv）。

`src/frameworks/agent/bash-safety-guard.ts`：

- 新增 `PS_GREP_KILL_BLOCK_MSG`（ruleId `self_kill_byname`，layer `self_kill`——与 pkill 按名同族聚合，healing 归因连续）。
- 第 4 通道在字面量三查之后无条件追加（不再被「存在字面量 PID」短路——字面量与扫描来源可混合出现在同一 kill argv）。
- `checkOneKillSegment` 拆出单段四查（complexity 分解）。

`tests/guard/replay/cases-2026-10-29.ts`：#1899 区块 85 条——独立复核三轮对抗钉（15+14+23）+4 条自钉。三轮覆盖：-f 模式文件 vs 数据文件、stdin 占位 -、-q/-o 输出语义断流、常见无害长选项白名单、-m 数值参数、env -u/sudo -u 选项 arity、command -v 非执行、xargs 仅对 kill 透传 stdin、cmdsub 载荷自包含数据流递归、kill argv 变量遇管道即止、cat/echo 替换数据流。

## 判定语义（M-de200a08 拍板：固定可证明模板，2026-11-18）

四轮独立对抗复核（15+14+23+19 条双向错判）实证：通用 grep 旗标/wrapper/stdin 语义建模不可收敛——每扩一层就产生新的漏拦与误拦。按搭档拍板「bash 守卫是明确拦，不明确的必须放通」，通道收窄为**固定可证明模板**：

**模板内（明确拦）**：`ps(任意 argv) → [grep -v grep]* → grep(签名) → [grep -v grep | awk 单script]* → kill 形态`。其中：
- **ps 必须是链首命令**：ps 前有任何命令断模板；第二个 ps（无论正签名前后）断模板
- grep argv 白名单：`[grep 模式]` / `[grep -e 模式]` / `[grep --regexp=模式]` / `[grep -v 模式]`（`-v` 剥离后复用同一模式形态解析，`-v -e grep`/`-v --regexp=grep` 自引用透明）；**模式归一后精确等值** `dist/src/main.js` / `otter-buddy/dist/src/main.js`（`[d]ist` 单字符 self-match 类与匹配集等价的 `.*` 通配前后缀归一；includes 不能证明匹配——`^` 锚点/`.jsx` 后缀等变体运行时不匹配主行，一律模板外放行）；`-v 签名` → 主进程已排除（放行）
- awk 白名单：单引号字面 script，或**双引号全静态 script**（非 lit part 只允许 `\$` 类 escape；未转义 `$N` 是 var 展开语义不同构，放行）——单引号 `-c` 载荷内物理写不了单引号，双引号转义是唯一朴素形态
- **真实文件重定向断流**（`>`/`<` 目标）；fd 复制仅豁免 `2>&1`（stderr 并入 stdout）——`1>&2` 把 stdout 改到 stderr 管道断
- kill 形态四种（数据流挂钩可证明）：①for 循环变量 ②while read 变量 ③xargs ④命令替换直给；字面量与扫描来源可混合（`kill 12345 $p`）
- 载荷（`bash -c '…'`）剥引号后仍按本模板匹配

**模板外（不明确必须放通——已接受残余）**：wrapper 变体（`env -u FOO grep`、`sudo -u root grep`、`command/timeout/nohup` 包裹、赋值前缀）、非常见旗标（`-i/-m/-f/-q/-o/-n/--extended-regexp` 等）、stdin 占位与文件操作数组合（`grep 签名 -`）、`-v 非签名模式`（过滤效果确认不了）、双 ps 结构、含动态展开的双引号 awk script、非白名单中间命令（`sed/head/cat` 变体）、含动态展开的双引号 awk script。残余风险边界：模板公开后故意加 wrapper 可穿透——本通道保护对象是**事故型误杀**（失控会话顺手裸写，如 11-16 原案），非对抗型故意杀；字面量 PID 三查/pkill 按名/广播 kill 等既有防线不受影响；残余误杀经 healing 回路拿真实证据再扩模板。

**其他既有语义保持**：转义 `\$()`/反引号是字面量非执行面（宁漏勿误）；双引号 `-c` 载荷的延后替换属确认不了的面放行；`||`/`&&`/`;` 两侧独立数据流；comment/单引号字面量不进执行面；kill 前最后一次重赋值与最内层同名循环绑定优先。
