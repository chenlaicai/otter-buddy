---
id: F20261009dpve
title: "bash 守卫 cd 豁免负门第二触发条件：动态路径源签名阻断（#1309）"
summary: "cd 豁免形态下 heredoc 体动态拼接路径写主仓（os.environ['REPO']+'/data/x'）端到端放行——负门只锚绝对路径字面量，路径来自外部可控源时字面量不存在。修复：负门扩第二触发条件（python：os.environ/environ/getenv(/input(/sys.argv；node：process.env），动态源遇 open 写面即拦，只读体仍放行。"
change_type: fix
capability_test: "tests/capability/ n/a: bash 守卫判定的纯代码逻辑单测（14 用例覆盖），非 prompt 行为面"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - "#1309（issue）"
  - "#1240 / F20261006c1240（负门引入——本单扩其第二触发条件）"
  - "#1308 / F20261009cphr（管道右段识别基座——本单动态源负门经 heredocHeaderIsInterpreter 自动覆盖管道形态）"
  - "docs/designs/bash-guard-constitution.md（守卫宪法——本单挂 L3 主仓写层）"
tags: [bash-guard, heredoc, cd-exemption, security, dynamic-path]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: "cd 豁免形态下 heredoc 体动态拼接路径写主仓端到端放行——负门只锚绝对路径字面量，denylist 在负门之后的写判定链内无消费点"
  expected_effect: "动态路径源签名（environ/getenv/input/argv/process.env）+ 写面 → cd 链拦（与无 cd 链 fail-closed 同判）；动态源纯读/程序内拼接/相对路径写正道放行；#1240 绝对路径负门不回归"
  verify_by:
    type: behavior_check
---

# F20261009dpve cd 豁免负门第二触发条件：动态路径源签名阻断（#1309）

## 背景

issue #1309（P2，PR #1301 检视 r1 发现 3 建账）：`cd /tmp && python3 - <<'PY'` + 体内 `p = os.environ['REPO'] + '/data/x'; open(p,'w')` 形态端到端放行。无 cd 对照：同体被拦（pythonBodyReadOnly 的 `import os` fail-closed → 通道不豁免）。cd 链缺等价防线——denylist（os.environ 签名）在负门之后的主仓写判定链内，cd 豁免 return null 旁路全部写判定，无消费点。

探针实证（修复前，主仓 dist，projectRoot=主仓根）：

| 场景 | 修复前 |
|---|---|
| A：cd + os.environ 拼接 + open 写 | ALLOW（洞） |
| A 对照：无 cd 同体 | BLOCK（fail-closed 生效） |
| B：cd + 纯程序内字符串拼接打印 | ALLOW（须保持） |
| C：cd + 相对路径写 | ALLOW（正道，须保持） |
| E：cd + node process.env + writeFileSync | ALLOW（洞，同族） |

## 根因

负门（#1240）`scriptHeredocAbsPathsInsideMain` 只识别**绝对路径字面量**（正则锚 `/…` 形态）。路径来自环境变量/外部输入时字面量不存在 → 负门失明 → cd 豁免直接放行。双链防线不对称：无 cd 链靠 heredocReadOnly fail-closed 兜住，cd 链的 cd 豁免 return null 短路了写判定链。

## 修复设计

**Modification-Class：narrow-fix**（负门既有消费结构不变，扩第二触发条件）。

cd 豁免负门加第二触发条件：`scriptHeredocBodiesTouchDynamicPathSource`——heredoc 体含动态路径源签名即阻断（与绝对路径无关）：

- **python 签名**：`os.environ` / 裸 `environ`（from os import environ 形态）/ `getenv(` / `input(` / `sys.argv`
- **node 签名**：`process.env`

两触发条件同构消费既有判定链：触发后仍走 `scriptHeredocBodiesReadOnlySegmentAware`——体非只读 → 拦；体只读 → 放行（纯读探查正道）。

**设计取舍**（issue 修复方向评估）：

- issue 候选 A（体含非只读签名即阻断 cd 豁免）**不采**——会拦所有非只读 python heredoc 的 cd 形态（含相对路径写正道），可用性损失大，issue 自评「需配相对路径落点判定」引入的复杂度远超收益
- issue 候选 B（denylist 签名 + 拼接/环境变量读取 → 保守拦）**部分采**——签名收紧为「动态路径源」而非「任一 denylist 签名」：攻击链核心是「路径来自外部可控源」，`os.environ`/`input()`/`argv` 是路径不可静态判定的充分条件；纯程序内拼接（`p='/data/'; q=p+'x'`）不拦——落点要么是可见绝对路径（#1240 负门管）要么与主仓无关
- 不加宽泛 `+` 拼接签名：误伤正道（字符串拼接是日常数据处理高频形态），且拼接源不外部可控时不构成绕过向量

**误伤面声明**：`import os` + `os.environ` 纯读打印形态被拦——这不是本负门拦的，是 `pythonBodyReadOnly` 的 `import os` fail-closed 既有语义（无 cd 链同拦，双链一致）；只读豁免走 `from os import environ` / `os.environ.get` 配白名单子面形态（测试锚定）。该误拦面在 #1309 之前就存在，非本单引入。

### 机制判定四问

- 命中机制识别清单？**否**——不新增独立机制，是既有负门（#1240）的第二触发条件扩展，消费结构（触发→体只读判定→拦/放）完全复用。
- ①谁需要：cd 豁免链需要与无 cd 链 fail-closed 对称的动态路径防线。
- ②失败后果：动态拼接路径写主仓端到端放行（A/E 探针实证）。
- ③后续机制：无依赖。与 #1308 管道右段识别正交（heredocHeaderIsInterpreter 基座共享，管道形态自动覆盖，F 探针实证）。
- ④退役条件：若守卫改走运行时落点判定（如 LD_PRELOAD 跟踪 open），静态签名负门整体退役。

## 验证

- **失败证据链**：修复前探针 A/E ALLOW（本文档「背景」节，探针 /tmp/probe-1309.mjs）。
- **修复后**：同探针 A/E → BLOCK；B/C/D 放行保持；F（cat 管道形态）BLOCK——#1308 基座自动覆盖。
- **测试**：#1309 16 用例（拦截 7：os.environ/from import environ/getenv/input/sys.argv/node/cat 管道 + 语义校正 1；放行 4：from import 纯读/node 纯读/相对路径写/程序内拼接；回归 2：#1240 绝对路径负门拦/只读放行 + import os 纯读声明面 1；检视 r1 P1 修复 2：python 只读+cat 数据放行 / python 动态源写+cat 数据拦）。全量 5123 绿（342 文件），lint 0，tsc 0。
- **双链一致性**：A 场景 cd 形态与无 cd 形态均 BLOCK（修复前 cd ALLOW / 无 cd BLOCK 不对称）。

## 检视处置记录

**r1（检视獭-1382）**：1 严重 + 2 建议。

- **P1 多 heredoc 混合正道误拦（采纳，已修）**：`scriptHeredocBodiesReadOnlySegmentAware` 对非解释器 heredoc（cat/tee 数据体）在 every() 中直接 false——python 只读 + cat 数据的正道组合（先跑只读探查脚本再写数据文件）被误拦，且 parent commit 放行（本单引入的回归）。修法：非解释器 heredoc 不参与体判定（跳过），与 blankDataHeredocBodies 同语义——数据体无 shell 执行语义，负门仅锚解释器体。补 2 用例：python 只读 + cat 数据 → 放行；python 动态源写 + cat 数据 → 仍拦（动态源负门触发时不被 cat 体放行）。
- **建议 1 签名命中注释/字符串（采纳方向，留档不扩面）**：`\b(?:os\.)?environ\b` 会命中注释/字符串字面量（`# os.environ is a dict`）。剥除注释/字符串需引入 python 语法解析，复杂度远超收益；实际误伤需「体含注释/字符串中的签名字样 + 负门触发 + 体只读判定失败」三重叠加，概率极低。Known Limitations 声明此面。
- **建议 2 node/python 语言间不对称（接受现状）**：node `process.env` 纯读放行 vs python `import os` + `os.environ` 纯读拦——#1207 fail-closed 既有语义（无 cd 链同判），非本单引入；已在「误伤面声明」段说明。

## Known Limitations

- 动态源签名是保守子集：`os.getenv` 之外的间接动态形态（如 `open(__file__ + '/../x')`、`chr()` 构造路径）不触发本负门——前者落点可见可判（file 锚），后者已有 `pythonBodyReadOnly` 门 ① 否定检测（`__` 前缀/eval 族）覆盖。
- 签名会命中注释/字符串字面量（`# os.environ` / `print("os.environ")`）→ 负门触发 + 体判定 fail-closed → 拦。属保守侧误拦（需三重叠加），剥除注释/字符串需语法解析，复杂度远超收益（检视 r1 建议 1 处置）。
- shell 层环境变量（`$REPO` 裸定界体展开）不在本单范围——裸定界体的 `$` 已被 `scriptHeredocBodiesReadOnlySegmentAware` 的 `sp.quoted || !/[$`]/` 条件拒绝豁免（fail-closed）。
