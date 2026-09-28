---
fid: F20260928grv2
id: F20260928grv2
title: bash 守卫整体重设计——统一结构模型（词法层单遍解析 + 全判定层消费模型）
summary: >
  守卫从「多份正则各扫原始文本」重构为「一次词法解析产出结构化命令模型，
  全部判定层消费模型」——词法层（单遍 O(n) 状态机）→ 结构模型层（segments/
  argv/重定向/赋值/子 shell/递归载荷）→ 判定层 v2（kill 族/cd 豁免/pipe-to-shell/
  eval 载荷/one-liner/PR merge/#844 白名单全量模型版）→ 入口路由（parseOk=false
  走 V1 文本链兑底）。V2 行为变化白名单（双向锁）：新拦 kill 0（#1169）与
  bash<file（U5）；放行 #1170（管道/分号杀 cd 豁免）与 #1171（引号/heredoc 词样
  误伤）；白名单外 V1 的 234 用例语义 100% 保持。今天 9/28 真实拦截台账 10 条
  固化为回归（6 误拦全放行 + 1 规则内拦保持 + 3 对照拦）。全仓 4100/4100 绿。
created: 2026-09-28
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
change_type: feature
status: implemented
related_issues: ["#1170", "#1171", "#1169"]
related:
  - F20260830bsgr          # 守卫初版
  - F20260903gh698         # 对抗变形
  - F20260922gpqa          # #852 引号感知（kill-segment-finder 拆出）
  - F20260924gfpn          # 主仓写 cd 豁免
  - F20260925gr1f          # #1154 三轮审视处置（本轮的 V1 基线之一）
capability_test: tests/frameworks/agent/command-lexer.test.ts
intent:
  problem: >
    守卫 V1 的 shell 结构理解散落在 9 处独立实现（分段 4 份口径不一/引号处理
    3 处/cd 跟踪 2 套/入口最多 3 遍全量判定），全部判定层在原始文本上跑正则——
    误拦与漏拦是同一缺陷的两面。一个月 6 轮补丁（bsgr→gh698→#777→gpq→gfpn→
    #1168）每次都在文本判定上再叠一层形态处理，RHI 显示守卫文件 30 天 bugfix
    3 次——补丁模式的失败证据。
  expected_effect: >
    一次词法解析产出结构化命令模型，全部判定消费模型而非文本（parse once,
    judge everywhere）。#1170（管道/分号杀 cd 豁免）与 #1171（引号/heredoc 词样
    误伤）的误拦面归零；kill 0（#1169）与 bash<file（U5）纳入拦截；V1 的
    234 用例语义 100% 保持（双向锁）。
  verify_by:
    type: capability_test
    note: >
      四层测试：词法 golden 35 + 模型结构 24 + V1 基线 234（零红保持）+ V2 白名单
      39 + 真实拦截回放 9。红绿双向：禁用模型判定入口 → V2 白名单 8 用例红；
      cd 豁免回 V1 → #1170 用例红。
---

# bash 守卫整体重设计：统一结构模型

## 背景

bash-safety-guard 经历 6 轮补丁演进（F20260830bsgr → F20260903gh698 → #777 →
F20260922gpqa → F20260924gfpn → F20260925gr1f），每轮都在「多份正则各扫原始文本」
的架构上叠加形态处理。搭档拍板整体重设计（2026-09-26/28）：

> 「不要打补丁式修改，而要抓住核心设计。一个 pr 完整实现到 bash 拦截的完整版本」

方案（guard-redesign-proposal.md，设计师 mimo-pro + 检视 glm 两轮收敛）：
统一结构模型——词法层一次解析产出结构化命令模型，全部判定层消费模型。

## 根因（设计师二号修正版，代码级实证）

1. **shell 结构理解 9 处各自为政**：分段逻辑 4 份（有的含单 `|`、段边界定义都不同）、
   引号处理 3 处（5 处不识别转义的弱去引号）、cd 跟踪 2 套（data 破坏检测有段级
   cwd 跟踪、主仓写检测只认「首段 cd 且无管道分号」——#1170 直接根因）
2. **判定层全在原始文本上跑正则**：引号/heredoc/管道/bash -c 载荷每层独自处理
3. **入口最多 3 遍全量判定**（heredoc 剥离预处理 + 原文 + 归一化）

## 方案设计

### 架构：parse once, judge everywhere

```
bash 命令
  │
  ▼
command-lexer.ts        词法层（单遍 O(n) 状态机，零依赖）
  │  字符流 → Token 流（Word 含 WordPart 展开结构 / 操作符 / heredoc span）
  ▼
command-model.ts        结构模型层
  │  Token 流 → CommandModel（segments + argv + redirects + assignments
  │  + subshell + joiner + 递归 payloads）
  ▼
guard-model-judge.ts    判定层 v2（全部消费模型）
  │  kill 族/pkill 特征名/PID 文件/间接目标/管道 stdin/U1 kill 0/U5 bash<file/
  │  eval 载荷递归/one-liner/pipe-to-shell/PR merge partner-gate/#844 白名单三规则
  ▼
bash-safety-guard.ts    入口路由
     模型判定优先；parseOk=false → V1 文本链全量兜底（D3 kill 族解析失败必拦）
```

### 关键决策（方案 D1-D7 + 检视 r1 修订）

| 决策 | 内容 |
|---|---|
| D1 | 自写词法层（非 tree-sitter）：热路径依赖纯净；需求是词法级安全语义非完整 AST |
| D2 | 语法覆盖限定安全相关子集：引号/展开/操作符/heredoc/bash -c 递归/子 shell 括号（r1-S1）；cmdsub 深度 ≤2 层超限保守拦（r1-S2）；case 语句进排除区（Ad2） |
| D3 | 分层 fail-closed：kill 族解析失败必拦（V1 兜底链）；纯读放行 |
| D4 | 一个 PR 原子切换（双轨=根因复制） |
| D5 | 14 类对抗面矩阵机械转测试 |
| D6 | 性能预算：病态输入实测（见下）；1MB 输入上限防失控 |
| D7 | 三层测试分离：词法 golden / 模型结构 / 判定决策表 |

### V2 行为变化白名单（搭档拍板，双向锁）

**白名单内新拦**（五项——r1-delta C1 补全，sleep 与词元修补集终审追认中）：
1. `kill 0`（进程组语义——U1/#1169，载荷内 kill 0 信号覆盖含主进程的整组）
2. `bash <file>` / `bash file`（U5——任意文件含不可求值位置参数，r1-S3 扩展；脚本内容未经逐条判定，保守拦+提示改写）
3. 词元修补集（批准方案 S3-⑤）：`kill $$` / `setsid kill` 等 kill 族词元形态
4. cd 含展开且不可溯源 → 保守拦+改写指引文案（批准方案 S3-④）
5. `sleep ≥5s` / `infinity` 硬拦（#1126 协同，大獭 S5 仲裁——#1126 先合，否则 sleep 文案走 kill 域误导链）

**白名单内放行（以前误拦）**：
- #1170：管道/分号不再杀死 cd 豁免（`cd worktree && git commit | tail` 等）
- #1171：引号/heredoc 内 kill 词样字面量（sed 替换串/测试代码/文档字符串）
- `$VAR` 传参、worktree 路径字样、echo/grep 上下文进程名词样

**白名单外零变化（V1 234 用例锁定）**：基线用例红绿双向验证逐条对账；白名单外新拦以 V1 断言为准绳。

### V1 判定全量继承（P4 补齐的形态清单）

eval+数字参数 / one-liner 词样+数字（node -e/--eval/python -c/perl -e）/
嵌套载荷递归到底（#852 bash -c 套 bash -c）/ 并列多载荷全提取（#1154 S2
逐载荷语义）/ pipe-to-shell 三源检测（上游词样+注释词样+下游 shell 段载荷）/
pkill 特征名表全量（V1 十模式含 node.*main/dist/src 中缀）/ 词文本去引号归一化
（"ma''in.js" 塔死形态）/ PR merge argv 位判定（#858 语义模型化）/ 诊断块归一化
二次定位（#730）/ PID 文件跨段检测 / cd 豁免的 & 和 | 语义（cd 后台化不豁免）/
赋值溯源（W=/path; cd $W 拼接形态）/ #844 白名单三规则（含 #918 多次赋值只认最后
一次）。

## 机制预算四问

1. **语义影响**：判定语义从「文本模式匹配」迁到「结构理解」——误拦面（引号/
   heredoc/管道豁免）归零，拦截面全量继承且新增 kill 0 / bash<file 两项（拍板
   白名单内）。词法层解析失败一律走 V1 兜底链（保守侧不变）。
2. **测试覆盖**：四层 341 用例（词法 35 / 模型 24 / V1 基线 234 / V2 白名单 39 /
   真实回放 9）。红绿双向验证亲跑：禁用模型入口 → V2 白名单 8 红恢复全绿；
   cd 豁免回 V1 → #1170 用例红。
3. **可回滚性**：入口路由单点（bash-safety-guard.ts 的 modelOk 分支）——回滚 =
   删路由恢复 V1 直跑，词法/模型层无副作用可保留。V1 判定链全量保留未删。
4. **监控建议**：观察 healing 台账 guard_intercept 事件的误拦形态是否归零（重点：
   cd worktree + 管道、引号词样）；月度回放本特性 real-replay 测试集并从台账
   增补新现场。

## 旧机制退役说明

- **quoted-text-sanitizer.ts（#858 脱敏）**：**保留不删**——V1 兜底链（parseOk=false
  路径）仍依赖它；模型路径下其语义由词法层引号结构天然承担（词样在引号内=lit
  part，不是命令位）。待观察期后（台账确认误拦归零）可在独立 PR 评估退役。
- **kill-segment-finder.ts**：同上保留为 V1 兜底链组件。
- **normalizeForDetection 三遍扫描**：模型路径短路（模型放行即返回，不再跑 V1
  kill 族文本判定）；诊断块保留归一化二次定位能力。

## 已知边界

1. **解码器中转不拦**（`echo base64串 | base64 -d | sh`）：方案 D5 #9 建议保守拦，
   但 V1 PoC-8 用例断言放行且不在拍板白名单内——按双向锁从 V1（放行）。方案级
   分歧（A2 vs 白名单外零变化）留独立 issue 呈搭档追认。
2. **注释词样口径**：`curl | bash # kill N` 注释词样计入拦截（V1 文本扫不辨注释
   的口径保持）；纯注释无 pipe-to-shell 上下文则不拦。
3. **性能口径（r1-S4 处置：按最坏病态形态重定预算线）**：病态分两档——常规病态
   （单层深引号/管道段串/嵌套 cmdsub）<60ms 实测达标；**最坏病态**（交替引号塔、
   混合 640KB）65-135ms——词法层 O(n) 保持（标度实验线性），剩余为碎片 part 对象
   分配（MAX_PARTS_PER_WORD=256 截断防护）+ V1 兜底组件扫描。正常命令
   0.023-0.066ms（真实负载无感知）。V1 退役后自然改善。
4. **trap 载荷 / 更多 shell 内建**（A1/A2 记录项）：V1 同盲区，白名单外不动。
5. **#1126 协同（r1-S5，含合并顺序警示）**：sleep 检测已补模型版（argv 位 +
   时长静态求和，语义对齐 #1126 文本版）。**合并顺序锁定：#1126 必须先合**——
   sleep 拦截文案带 `__bash_sleep_block__:` 标记，分流代码（retry-policy 的
   bash_sleep 前缀）在 #1126 里；若本 PR 先合，sleep 拦截走现有 kill 域链，
   搭档将看到误导文案。去重时保留 #1126 文本版对载荷内 sleep 形态的覆盖
   （模型版只扫顶层段，`bash -c 'sleep 30'` 属其 R1 逃逸面口径）。
6. **U5 覆盖（r1-S3 处置）**：拦任意扩展名文件（bash < x.txt / bash data.bin /
   bash $SCRIPT 均拦——换扩展名绕过面闭合）；-s 旗标与 source/. 内建不在拦截面
   （source 是 shell 内建不走解释器 argv——V1 同盲区）。

## 验证记录

| 项 | 结果 |
|---|---|
| V1 基线 | 234/234 零红（语义 100% 保持） |
| agent 域 | 881/881（r1 处置后，+11 锁定用例） |
| 全仓 | 4130/4130（289 文件，r1 处置后） |
| tsc / eslint | 0 错 / 0 error |
| 红绿双向 | 入口禁用→V2 白名单 8 红；cd 豁免回 V1→#1170 红 |
| 性能（D6，r1-S4 口径） | 常规病态 <60ms（528KB 单层引号 24ms/8000 段 45ms）；最坏病态（交替引号塔 65-83ms，MAX_PARTS 截断防护）；正常 0.023-0.066ms |
| 真实回放（V9+） | 9/28 台账 10 条：6 误拦全放行 + 1 规则内拦保持 + 3 对照拦 |

## 交付物

| 文件 | 说明 |
|---|---|
| `src/frameworks/agent/command-lexer.ts` | 词法层（~560 行） |
| `src/frameworks/agent/command-model.ts` | 结构模型层（~280 行） |
| `src/frameworks/agent/guard-model-judge.ts` | 判定层 v2（~570 行） |
| `src/frameworks/agent/bash-safety-guard.ts` | 入口路由改造（V1 链保留为兜底） |
| `tests/frameworks/agent/command-lexer.test.ts` | 词法 golden 35 用例 |
| `tests/frameworks/agent/command-model.test.ts` | 模型结构 24 用例 |
| `tests/frameworks/agent/guard-v2-behavior.test.ts` | V2 白名单 39 用例 |
| `tests/frameworks/agent/guard-v2-real-replay.test.ts` | 真实拦截回放 9 用例 |

## r1 审视处置记录（代码检视獭 5 严重 + 4 建议，2026-09-28）

| 发现 | 处置 |
|---|---|
| S1 `kill${IFS}42877` 漏拦（V1 拦→V2 放，击穿 U1） | argv0 含 var part 时首词 lit 前缀 kill 族 → 间接拦（词内展开计入，含 `kill${IFS}0`）+3 锁定用例 |
| S2 裸定界 heredoc body 数据行误拦（V1 放→V2 拦） | 体含展开特征（$/反引号）才递归，纯数据体不判（V1 stripHeredocPayloads 对齐）+2 用例 |
| S3 U5 扩展名过滤绕过（bash < x.txt 放） | 任意文件全拦（含不可求值位置参数 bash $SCRIPT）；-c 载荷跳过不误伤 +3 用例 |
| S4 引号塔 70-92ms 超预算 + PR body 口径不实 | evalWord 数组 join（O(n²)→O(n)）+ MAX_PARTS_PER_WORD=256 截断防护（65-83ms）；预算口径按最坏形态重定（已知边界 3） |
| S5 #1126 sleep-guard 会被模型短路绕过 | 模型版 judgeSleepCommand 补位（argv 位+时长求和，语义对齐 #1126）；#1126 合入 rebase 时去重 +4 用例 |
| A1 base64\|sh 方案级分歧 | 维持白名单外从 V1（放行），独立 issue 呈搭档追认（大獭已仲裁） |

closes #1170 #1171 #1169

## 后续行动（非本 PR）

1. 解码器中转（base64|sh 载荷不可知）独立 issue——白名单外，需搭档拍板取舍
2. quoted-text-sanitizer / kill-segment-finder 退役评估——观察期（台账误拦归零）
   后独立 PR
