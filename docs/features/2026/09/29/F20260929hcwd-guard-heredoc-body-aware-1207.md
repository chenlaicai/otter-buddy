---
fid: F20260929hcwd
id: F20260929hcwd
title: bash 守卫 #1207 误拦集群修复——heredoc 体感知判定 + V2 wrapper 剥除对齐 + 引导文案命令感知
summary: >
  #1207 一周 17+ 条误拦的三处根因修复：①只读 python heredoc 被主仓写通道正则
  整体拦——体感知判定反转为只读白名单（可调用名门：动态形态/open 写 mode/危险
  模块接触面一律不豁免，初版 denylist fail-open 被对抗审视端到端击穿后反转）；
  ②「cd wt 后写命令被误判主仓写」在 main 已由 F20260928grv2 的 modelCdExemption
  修复，本 PR 以 6 个误拦形态回归固化；③修复过程探针实证 V2 三个安全缺口并封堵
  （wrapper 连剥不全致 #760 A4 攻击形态放行、bash/node heredoc 体直接执行 kill
  主 PID 零判定、wrapper 叠加超界 fail-open）。closer 语义对齐 bash（定界符独占
  行），堵死「假闭合行 + 尾段写入」利用链。dev-server 引导文案改命令感知。
  全仓 4373/4373 绿，delta r1 攻防 17 形态全对。
created: 2026-09-29
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
change_type: fix
status: implemented
related_issues: ["#1207", "#760"]
related:
  - F20260928grv2          # V2 结构模型（cd 豁免/管道右段判定的宿主）
  - F20260922scwd          # 主仓写检测（误拦规则的宿主）
  - F20260924gfpn          # git 只读白名单 + 写族正则
  - F20260914dsrv          # dev-server 引导附加层
  - F20260914ectx          # #858 内嵌文本脱敏
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: >
    #1207 记录了守卫「主仓写判定」的持续误拦集群（9/25×14 + 9/29×3）：命令已
    cd 到 worktree 仍被拦、只读 python heredoc 探查被拦且引导文案答非所问。
    误拦无逃生通道（issue 1069 白名单未落地），獭被迫反复绕路，告警噪音持续累积。
  goal: >
    只放行误拦形态、不放松任何真实攻击面（#760 血训）：误拦复现用例转 PASS，
    全部既有 BLOCK 用例保持 BLOCK；封堵修复过程中实证的 V2 漏拦缺口。
solution: |
  根因一：python heredoc 误拦（E5，9/29 09:06 实时案例）。
  MAIN_WRITE_PATTERNS[1]（python3 - << 通道）按通道形态整体拦，不解析体内容。
  探针实证：引号定界 heredoc parseOk=true 走 V2 模型路径，模型层判体为数据放行
  后，文本层补跑的 checkMainCheckoutWrite(原始命令) 在未剥体的原文上命中通道
  正则——误拦发生在 V2 路径而非 V1 兑底链。
  修复（delta r1 反转后的终态）：体感知判定=只读白名单，三道门全过才豁免——
  ①否定检测：反斜杠续行/转义、__import__/getattr/globals 等动态形态、
  import as 别名、计算键调用 obj['x'](...)、lambda——出现即不豁免；
  ②open mode 门：只接受字面 'r'/'rb' 或无 mode（默认 'r'）；裸位置变量实参、
  mode= 关键字、写 mode 均拒；
  ③可调用名白名单收口：体内所有 callee 根名（print/open/re/json/Path…）与
  尾方法名（read/read_text/loads/dumps…）都在白名单集——白名单外一律不豁免
  （pathlib unlink/write_text、fileinput inplace、mmap 等天然在拦截面）；
  ④模块接触面门：os/sys 只放白名单子面（getcwd/listdir/walk/stat/path），
  shutil/subprocess/socket/ctypes 等全禁。
  bare（裸定界符）体仅在不含 $ 与反引号时豁免（无展开面则 bare ≡ quoted）；
  未闭合永不豁免。closer 对齐 bash 语义：定界符必须独占一行（行首无空白、
  行尾无任何字符）——堵死「体首定义 EOF = 0 合法经过假闭合行 + 尾段真实写入」
  的端到端利用链（检视獭实证：真实 bash 写出文件、初版守卫判 ALLOW）。
  重定向判定基准：仅「已验证只读」的 python/node 体等长隐去（体里 > 是语言内
  语法非 shell 重定向）；bash/sh 体与 bare 展开面体永不隐去。

  根因二：cd worktree 后写命令误判（issue 主根因，E1-E4/F1/F2）。
  main 的 F20260928grv2 modelCdExemption（段级 cd 链 + 静态求值）已修复主形态——
  本 PR 以 6 个 issue 原文形态固化为回归测试，防未来回退。

  修复过程中实证的 V2 安全缺口（同 PR 封堵，拦截面收紧）：
  ③ wrapper 参数连剥不全：V1 stripCommandPrefixes 是 while 循环连剥全部旗标/
     数字/赋值参数，V2 effectiveCommand 只剥一个——xargs -n1 -I{} kill {} 的
     argv0 落在 -I{} 上，kill 段失认；且管道右段「字面参数」判定把 {} 占位符
     当字面参数。两处都对齐 V1：连剥改循环；字面参数收窄为纯数字 PID（#777
     剥括号口径）。#760 A4 攻击 PoC 恢复拦截。
  ④ bash/node heredoc 体直接执行无判定：bash - <<EOF 内 kill <mainPid>、
     node - <<EOF 内 process.kill(<mainPid>) 修复前全放行（V2 判体为数据 +
     文本层无规则）。checkHeredocScriptBodies：shell 体（bash/sh/zsh/dash/ksh）
     递归体级判定 + V1 全量链（语义精确，echo kill N 数据位不误拦，限深 1 层
     超深保守拦）；node 体只读白名单反向豁免（readFileSync/console 等枚举面，
     白名单外一律拦——计算键/别名等动态形态对白名单不可见故天然被拦）；python
     体跳过（由体感知豁免路径承担）。挂点四处：统一入口（原始命令）、
     checkWhenMainPidMissing（node 白名单不依赖 PID）、V1 OnText 链（剥体输入
     extractHeredocSpans 只命中空白体自然 no-op；未闭合保留原文时体判定生效——
     修正初版「挂点三处」声明失实）、shell 体递归（按输入长度严格递减收敛）。
  ⑤ wrapper 叠加超 guard≤8 界 fail-open：剥到上限首词仍是 wrapper 词 →
     段不可判定。delta r1 修为饱和保守拦（effectiveCommand 返回
     wrapperSaturated 标记，judgeKillSegment 见标记即拦）——初版返回 null
     会让段被当非 kill 跳过（fail-open 方向错误）。
  ⑥ python 通道正则扩展：python[\d.]* + 绝对路径形态（python3.11、
     /usr/bin/python3 修复前进不了通道）。
  ⑦ <<- dash 定界整链盲区（delta r2，检视 delta 2 严重）：HEREDOC_OPEN 不匹配
     <<-，整套体判定对其不可见——bash/node 体级真杀三形态放行实证（base 同
     放行 = 存量缺口，但与已修声明同构）。修复：定界符正则加 -?；<<- 的
     closer 允许行首 TAB（bash 只剥 tab 不剥空格，`^\t*D$` 严格于宽版——
     空格前缀仍不闭合，不重开宽版利用链）；span 增 dash 标记。
  ⑧ 变量 mode open 与反序列化执行面（delta r3，检视 delta 2 终轮 (a)(b) 类修）：
     (a) 门② 检查正则误写（\/ 应为 ,）致变量 mode 全部漏过，且 pathlib
     .open 签名首参即 mode 槽位（无路径位）此前不在检查范围——类修：mode
     槽位见裸标识符即不豁免（内建 open 首参后任意位置实参 / .open 全部位置
     实参），mode= 关键字值必须字面 'r'/'rb'；路径位裸标识符（open(path)）
     不构成写向量，E5 可用性保留。(b) 反序列化执行面全禁：dill/joblib/
     shelve/marshal/yaml 入危险模块（与 pickle 同执行面——pickle 禁了其他
     全开等于没堵）；allow_pickle 非字面 False 一律拒（变量旗标穿不过）。

  附带：appendDevServerGuidance 改命令感知——只在命令真实命中进程操作形态
  （kill 族/lsof/pkill/killall/restart-service 词元）时附加 dev-server 引导，
  只读 heredoc 被拦时不再出现答非所问的重启建议（PROCESS_OPS_SHAPE）。

  delta r2 白名单迭代（检视 delta 2 建议顺手项）：三高频只读点补入白名单
  （glob.glob/iglob、pandas 读族 read_csv/read_json/read_excel/read_table/
  read_parquet + DataFrame 探查 describe/head/tail/info、Path.open——mode
  仍由 open 门独立把关）；社区标准固定别名放行（import pandas as pd /
  numpy as np，其余别名仍不豁免）；csv 移出危险模块列表（无代码执行面，
  写盘由 open mode 门兜底，且文件名字面量 'x.csv' 会被 \bcsv\b 误伤）；
  S1 通道正则尾巴（多级/绝对路径目录段）订正。
trade_offs:
  - 豁免面只收不扩（白名单方向）：体白名单识别不了的形态（新 API、复杂控制流）
    保守拦——豁免是例外，拦截是默认。denylist 方向（初版）被端到端利用链证伪，
    已永久放弃。
  - bash/sh 体递归 V1 全量链而非词元扫描：体里嵌套 heredoc 限深 1 层、超深保守
    拦——换取语义精确（不按词元误拦数据位）且无零判定盲区。
  - node 体白名单比 python 收得更紧（几乎只放 readFileSync/console 面）：node
    无 shell 递归通道可用，白名单是唯一静态防线，宁紧勿松。
  - dev-server 引导命令感知而非删除：issue 844 的受控路径引导对真实进程操作场景
    仍有价值，只裁掉「无差别附加」的噪音面。
  - issue 1069 受控脚本白名单不在本 PR 范围（issue 明示，勿顺手做）。
verification:
  - npx tsc --noEmit → 0 error
  - npx eslint .（全仓）→ 0 error
  - npm test 全仓 → 306 files / 4373 tests 全绿（delta r1 新增 16 攻防用例）
  - issue 误拦形态复现：E1 cd wt && git add / E2 git add -A && commit --author / E3
    git rebase / E4 echo && node /tmp / E5 只读 python heredoc / F1 cd wt && git commit /
    F2 cd wt && git merge → 全 PASS（放行）
  - delta r1 攻防 17 形态：假闭合利用链（closer 对齐后拦）/ import as 别名 /
    __import__ / getattr / Path.unlink / fileinput inplace / node 计算键写 /
    node 别名 kill / 未闭合 node 体 kill / wrapper 饱和 10 层 / python3.11 体写 /
    绝对路径 python 只读放行 / 混合体读掩护写 / bare 体 $(...) / 未闭合 quoted /
    E5 主形态 / python3.11 只读放行 → 全部符合预期
  - 初版攻击 PoC 17 形态：裸 kill / env kill / bash -c 内嵌 / xargs -n1 -I{}（恢复）/
    ~/bin/kill / FOO=1 kill / cd wt 伪装真杀 / kill $VAR / rm -rf data/metrics /
    体级 os.kill / from os import kill 裸调 / open r+b / os.open O_WRONLY /
    subprocess 调 kill / json.dump 落盘 / shutil.rmtree data / bash 体真 kill → 全 BLOCK
  - 放行面不回归：json.dumps+print、pathlib read_text、'r'/'rb'/无 mode 只读、
    node readFileSync 分析、bash 体 echo kill 字样（数据位）→ 全放行
capability_test_plan:
  - tests/frameworks/agent/bash-safety-guard.test.ts（#1207 主形态 + delta r1 攻防两面 + 跨解释器安全）
  - tests/frameworks/agent/guard-v2-behavior.test.ts（A4 wrapper 连剥 + 饱和保守拦 + node 体对称面）
production_assertion:
  assertion: cd <worktree> && git commit/add/rebase 形态命令的 guard_intercept「主仓写」类拦截，未来 30 天 ≤2 条
  baseline: 一周 17+ 条（issue #1207，9/25×14 + 9/29×3）
  check: sqlite healing_events 按 error_type=guard_intercept + description LIKE '%主仓%' 计数
  due: 2026-10-29
known_limitations:
  - python 体白名单只放内置只读面与 re/json/pathlib 读族/pandas 读族/glob——
    其余第三方库读 API 不在白名单，会被保守拦（逃生：落盘 /tmp 或告知搭档）
  - bare（裸定界符）体含 $ 或反引号即不豁免（展开面不可静态判）
  - <<- 变体允许行首 TAB 的 closer——空格前缀的 <<- 定界行不闭合（保守侧，
    bash 实际只剥 tab，行为一致）
  - 复合命令 cd <非主仓> && python heredoc 体绝对路径写主仓：modelCdExemption
    按 cd 落点豁免主仓写检查（grv2 存量行为，#1189），体绝对路径逃逸——
    已建独立 issue #1240 排期（不在本 PR 范围）
  - issue 1069 受控脚本白名单未落地，误拦无正道逃生通道（独立 issue 排期）
---

# F20260929hcwd：bash 守卫 #1207 误拦集群修复

## 问题

#1207 记录守卫「主仓写判定」持续误拦（一周 17+ 条），两类形态：

1. `cd <worktree> && git commit/add/rebase` 仍被判「未 cd 到 worktree」拦截
2. 只读 python heredoc 探查被拦，且引导文案是「重启 dev server 请用受控脚本」——答非所问

## 根因（探针实证，非推断）

### 根因一：python heredoc 误拦

`MAIN_WRITE_PATTERNS[1]`（`python3 - <<` 通道正则）按通道形态整体拦，不解析体。
探针实证关键事实：**引号定界 heredoc parseOk=true，走 V2 模型路径**——模型层判体
为数据放行后，文本层补跑的 `checkMainCheckoutWrite(原始命令)` 在未剥体的原文上命中
通道正则。误拦发生在 V2 路径，不是 V1 兑底链。

### 根因二：cd worktree 后写命令

main 的 grv2 架构（modelCdExemption 段级 cd 链）已修复——issue 主根因在开工时已是
绿灯形态。本 PR 固化 6 个 issue 原文形态为回归测试。

### 修复中实证的 V2 安全缺口（同 PR 封堵）

3. **wrapper 参数连剥不全**：V2 `effectiveCommand` 对 wrapper 词只剥 1 个参数
   （V1 是 while 连剥全部）——`xargs -n1 -I{} kill {}` 的 argv0 落在 `-I{}`，
   kill 段失认 → #760 A4 攻击 PoC 形态放行。管道右段「字面参数」判定还把 `{}`
   占位符当字面参数（第二漏拦半）。
4. **bash/node heredoc 体直接执行无判定**：`bash - <<EOF` 内 `kill <mainPid>`、
   `node - <<EOF` 内 `process.kill(<mainPid>)` 修复前全放行——体级真杀主 PID。
5. **wrapper 叠加超界 fail-open**：≥9 层 wrapper 词叠加后剥除饱和，初版对齐
   只对齐了「连剥」没对齐「超界方向」（delta r1 修为饱和保守拦）。

## 演进史（初版 → 对抗审视 → delta r1）

初版体豁免用「写签名 denylist 不命中即放行」——对抗审视（检视獭-1207，mimo-pro）
端到端击穿：别名 import / `__import__` / getattr / `Path.unlink()` / fileinput
inplace 等 8 日常形态全放行，且 sanitizer 宽版 closer（容忍定界行空白）与 bash
闭合语义错位被凑出完整利用链（体首 `EOF = 0` 让 python 合法经过假闭合行，尾段
真实写盘，守卫判 ALLOW、真实 bash 写出 marker 文件实证）。

delta r1 修复方向（按检视建议）：

| 检视发现 | 修复 |
|---|---|
| 严重 1：豁免 fail-open + closer 错位利用链 | 豁免反转为只读白名单（四道门）；closer 对齐 bash 语义（定界符独占一行） |
| 严重 2：node denylist 同构绕过 + 挂点声明失实 + fail-open 表述失实 | node 判定反转为只读白名单；挂点补进 V1 OnText 链（四处全实证）；文档表述与实现对齐 |
| 建议 1：wrapper 超界 fail-open | 饱和保守拦（wrapperSaturated 标记 → judgeKillSegment 拦） |
| 建议 2：python3.11/绝对路径不进通道 | 通道正则扩展 `python[\d.]*` + 可选路径前缀 |
| 建议 3：Modification-Class 只描述一半 | 双向声明（见 commit） |

## 方案

| 改动 | 文件 | 内容 |
|---|---|---|
| 体感知白名单豁免 | bash-safety-guard.ts | `PY_READONLY_CALLS/METHODS` + `pythonBodyReadOnly`（四道门：否定动态形态 / open mode / 可调用名收口 / 模块接触面）+ 通道豁免分支 |
| node 体白名单 | bash-safety-guard.ts | `nodeBodyReadOnly`（fs 只读 API + console 面，计算键/别名天然被拦） |
| shell 体递归判定 | bash-safety-guard.ts | `checkHeredocScriptBodies` + `judgeShellHeredocBody`（限深 1 层，超深保守拦）+ 挂点统一入口/PID 缺失/V1 OnText 三路径 |
| closer 语义对齐 | quoted-text-sanitizer.ts | `extractHeredocSpans`（`^delim$` 独占行，quoted/closed 标记）；`blankHeredocBody` 同步 strict（V1 侧同构利用链封堵） |
| 重定向判定基准 | bash-safety-guard.ts | `blankVerifiedScriptBodies`（仅已验证只读体隐去；bash/sh/bare 展开面体永不隐去） |
| wrapper 连剥对齐 | guard-model-judge.ts | `effectiveCommand` 循环连剥 + 管道右段字面参数收窄为纯数字 PID + 饱和保守拦 |
| 通道扩展 | bash-safety-guard.ts | python[\d.]* + 绝对路径形态 |
| 引导命令感知 | circuit-breaker-helpers.ts | `PROCESS_OPS_SHAPE` 命中才附加 dev-server 引导 |

## 验证

- 全仓 4373/4373 绿 + tsc 0 error + eslint 0 error
- 误拦复现 7 形态全放行；delta r1 攻防 17 形态全对；初版攻击 PoC 17 形态全 BLOCK
- 放行面：dumps/read_text/'rb'/无 mode/readFileSync/echo kill 数据位 → 全放行

## 生产断言

`cd <worktree> && git commit/add/rebase` 的「主仓写」类 guard_intercept 未来 30 天
≤2 条（基线一周 17+）。检查：healing_events sqlite，到期 2026-10-29。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 开发獭-1207
