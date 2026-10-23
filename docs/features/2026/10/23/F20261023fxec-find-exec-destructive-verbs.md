---
id: F20261023fxec
title: find -exec 执行体破坏词表补齐——-exec/-execdir + rm/rmdir/mv 双层收编（M-48ac4e39 单 B）
summary: find -delete 已收（F20261016gdfv）但执行体形态（-exec rm {} \; / -exec rm -rf {} + / -execdir rm / -exec mv / 无-name / 路径形动词）双层全放行——与 -delete 同语义（对走查树批量删/移）却因词表缺口逃逸；prod/wv 双层同词表收编，执行体泛化（任意载荷）按 #1513 口径记档不追。
change_type: fix
capability_test: "n/a: 纯 A 类守卫规则行为修复，无 LLM 参与行为"
intent:
  problem: "M-48ac4e39（基座分析拆单 B 组，异构基座=guard 破坏面规则）：B1/B2/B5/B6/B7 五形态（-exec rm {} \\; / -exec rm -rf {} + / -execdir rm / -exec mv / 无-name）+ 路径形动词（/bin/rm）基线双层全 ALLOW（探针实证）——`find /repo/data -exec rm {} \\;` 与 `find /repo/data -delete` 破坏语义完全相同，只因破坏动词在执行体位置不在词表就整链逃逸"
  expected_effect: "-exec/-execdir + rm/rmdir/mv（含路径形）与 -delete 同待遇：prod segmentDestructive 出 find -exec 形态 + wv find 条件写面同判；载荷内形态经 checkDataDirDestructive 通道自动同愈；读形态/非破坏执行体/外部根/worktree 清理正道不误伤"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-23
from:
  tasks:
    - "M-48ac4e39"
---

# find -exec 执行体破坏词表补齐（M-48ac4e39 单 B）

## 背景与病灶

F20261016gdfv（10-16）把 find **-delete** 收进破坏词表（双层：prod segmentDestructive +
wv find 条件写面）。但 **-exec/-execdir 执行体形态**不在词表——`find /repo/data -exec rm {} \;`
与 `find /repo/data -delete` 的破坏语义完全相同（对走查树批量删除），却整链逃逸。

**基线复现（探针 /tmp/probe-fxec-baseline.ts，先基线后修法）**：6 形态双层全放行——

| 形态 | 基线 prod/wv | 说明 |
|---|---|---|
| `find /repo/data -name x -exec rm {} \;`（B1） | ALLOW / ALLOW | `\;` 终结 |
| `find /repo/data -name x -exec rm -rf {} +`（B2） | ALLOW / ALLOW | `+` 终结 |
| `find /repo/data -name x -execdir rm {} \;`（B5） | ALLOW / ALLOW | -execdir |
| `find /repo/data -name x -exec mv {} /tmp/ \;`（B6） | ALLOW / ALLOW | 移走主仓内容 |
| `find /repo/data -exec rm {} \;`（B7 无-name） | ALLOW / ALLOW | 无过滤器同逃 |
| `find /repo -name x -exec /bin/rm {} \;`（路径形） | ALLOW / ALLOW | 执行体绝对路径 |

守恒/不误伤对照 6/6 基线正确（-delete/-direct rm 拦、读形态/外部根/worktree 清理放）。

## 修法（双层同词表，对称入口）

- **prod（bash-safety-guard.ts segmentDestructive）**：find 分支扩第二表达式——
  `-(?:execdir|exec)\s+["']?(?:\S*\/)?(?:rm|rmdir|mv)\b`（含路径形 /bin/rm、可引号）→
  kind "find -exec"，zone = zoneOf(pathArgsOf)（落点=走查根，与 -delete 同款）
- **wv（write-target-evaluator.ts findDestructiveExpr）**：find 破坏表达式判读扩
  -exec/-execdir + 词表动词（(?:^|\/)(?:rm|rmdir|mv)$）；命中后沿用既有保守收集
  （落点=全部非旗标参数，表达式值混入=取舍 4 保守面，tee/touch 同款 fail-closed 哲学）
- **载荷同愈**：`bash -c 'find … -exec rm …'` 经 checkDataDirDestructive 完整通道
  （F20261006gfvl 复用声明）自动覆盖，钉死

**#1513 口径（本单边界）**：只收**词表缺口**（破坏动词 {rm, rmdir, mv} 在执行体位置——
与直挂形态同词表的语义别名收编），**不追历史破坏面**——执行体泛化（`-exec sh -c '…'`
任意载荷、`-exec tee` 写面等）是开放面，按口径记档不追；动词词表不扩 shred/unlink 等
（与 prod 破坏词表 {rm,rmdir,mv} 对称，不穷举）。

## Verification（证据链）

- **修复前红证**：矩阵 12 passed | 4 failed（四个拦截侧 describe 全红=双层放水面实证；
  放行侧/守恒 12 绿=不误伤基线完好）
- **修复后绿证**：bash-guard-destructive-verbs 矩阵 **16/16**（新增 5 钉：双层拦截侧×3
  + 载荷同愈 + 放行侧/守恒）；守卫域 77 文件 2128 passed | 6 skipped（touchstone 三池
  零翻转——corpus 实查零 find 破坏形态）；全仓 **422 文件 6781 passed | 6 skipped** 零回归

## 剩余风险与非目标（诚实边界）

- **执行体泛化面（记档不追，#1513）**：`-exec sh -c 'rm -rf {}'`、`-exec python -c '…'`
  等载荷形破坏、`-exec tee {}` 写面形——不在词表即不收，攻击面开放；如需收口走载荷
  分析通道独立评审
- **引号盲区误拦（既有类，非本单引入）**：破坏规则的词位判定（isKillAtCommandPosition）+
  段文本正则不识别引号内数据位——开发期只读 grep 模式串含 `find … -delete`/`-exec rm`
  字样且 find 词元前是 `|` 等白名单前导字符时被误拦（本次开发实证一次，命中详情已报）；
  与 M-2edf95d5/#1353 误拦台账同族，本单不修（修法=引号感知分词，独立面）
- `-exec` 动词形如 `rm-x`/引号内动词（`-exec 'rm'`）等边缘拼写未穷举（\b 边界 + 可选
  引号覆盖常见形态；怪形漏=保守侧残余，fail-open 方向仅限破坏动词拼写变体）
- cd 跟踪/子壳不跟踪等 F20260918mrdp 既有 Known Limitations 原样
