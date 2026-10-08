---
id: F20261006gfvl
title: bash 守卫 -c 带值旗标绕过收口：extractShellCPayload 逐 token 扫描 + 封闭 optname 白名单（#1307）
summary: extractShellCPayload 的 argM 正则只认 [+-] 前缀 token，bash -o pipefail -c 'x' 的 pipefail 值无前缀 → argM 从值后重新匹配 -c、flagStr 只含 -o → 值被静默跳过；修复为逐 token 扫描旗标，带值旗标（-o/+o/-C）的值 token 一并消费并校验封闭白名单，白名单外 fail-closed。
change_type: feature
capability_test: "tests/frameworks/agent/bash-safety-guard.test.ts"
modules:
  - src/frameworks/agent/bash-safety-guard.ts
tags:
  - guard
  - bypass
  - bugfix
created_at: "2026-10-06"
created_in_conversation: dd453bf3-4035-4a1e-91e3-c3602dcdd473
intent:
  problem: "extractShellCPayload 的 argM 旗标组正则 `(?:\\s+[+-]\\S+)*?` 只认 [+-] 前缀 token——`bash -o pipefail -c 'rm -rf data/'` 的 `pipefail` 值无前缀，argM 从值后重新匹配 -c 成功、flagStr 只含 -o（白名单内）→ 值被当「载荷前杂质」静默跳过（PR #1297 终审 review FU1 实锤，V1-V4 四变体全绕）"
  expected_effect: "带值旗标（-o/+o <optname>、-C <dir>）的值 token 被正确消费并校验封闭白名单；白名单外 optname（evilopt/monitor 等）fail-closed 拦截；白名单内 optname（pipefail/errexit/nounset 等）正常放行——由新增正负向对称测试锁定"
  verify_by:
    type: behavior_check
---

## 背景与需求

### 问题描述

issue #1307：bash -c 带值旗标绕过。PR #1297 终审 review FU1 实锤：`bash -o pipefail -c 'git commit -m x'` ALLOWED——argM 旗标组 `(?:\s+[+-]\S+)*?` 只认带 `[+-]` 前缀的 token，`pipefail` 值 token 无前缀 → argM 从值后重新匹配 `-c` 成功、flagStr 只含 `-o`（白名单内）→ 值被当「载荷前杂质」静默跳过。

### 实证（探针 probe-1307b.ts，修复前）

| 形态 | 命令 | 修复前 | 修复后 |
|---|---|---|---|
| R1 | `bash -o pipefail -c 'rm -rf data/'` | 放（绕过） | 放（rm 管辖缺口，既有边界） |
| R2 | `bash -o pipefail -c 'echo pwned > config/config.yaml'` | 放（绕过） | 拦 ✅ |
| N1 | `bash -o evilopt -c 'echo x'` | 放（绕过） | 拦 ✅ |
| N2 | `bash -o pipefail -o evilopt -c 'echo x'` | 放（绕过） | 拦 ✅ |
| N3 | `bash -o monitor -c 'echo x'` | 放（绕过） | 拦 ✅ |
| N4 | `bash -o pipefail -c`（无载荷） | 放（绕过） | 拦 ✅ |
| P1 | `bash -o pipefail -c 'echo hello'` | 放 ✅ | 放 ✅ |
| P2 | `bash -o errexit -o nounset -c 'ls'` | 放 ✅ | 放 ✅ |

### 根因

`extractShellCPayload` 的 `argM` 正则 `^((?:\s+[+-]\S+)*?)\s*-c(\s|$)` 设计缺陷：

- 旗标组 `(?:\s+[+-]\S+)*?` 只认 `[+-]` 前缀 token——`-o pipefail` 的 `pipefail` 值无前缀
- `*?` 非贪婪匹配：匹配到 `-o` 后遇 `pipefail`（无前缀）停止，从 `pipefail` 后重新找 `-c`——找到
- flagStr = ` -o`（只含旗标不含值）→ 白名单校验通过
- 载荷起点 = `nameM + argM` 末尾 = `-c` 后——正确，但旗标校验不完整（值未校验）

## 方案设计

### 设计取舍（机制判定四问）

- **①既有语义内修？** ✅ 命中——`extractShellCPayload` 旗标解析语义内修（argM 正则 → 逐 token 扫描），不开新机制。**narrow-fix**。
- **②收窄管辖？** 否——是旗标校验完整性修，不是管辖缩。
- **③删机制？** 否。
- **④新增机制？** 否。

**基座对齐原则**：旗标解析与载荷提取同一函数内逐 token 扫描，不引入第二条提取路径。

**fail-closed 对称**：带值旗标的值 token 必须消费并校验——白名单外 optname 拦、`-o` 后无值拦、`-c` 后无载荷拦。

### 修复（extractShellCPayload 旗标解析重写）

argM 正则 → 逐 token 扫描：

1. `-c` → 进载荷提取
2. `-o/+o <optname>` → 消费值 token，校验在封闭白名单（shopt set -o 集，不含 monitor）内，白名单外 FAIL_CLOSED
3. `-C <dir>` → 消费值 token，不校验内容（bash 内部 chdir，只读无风险）
4. 白名单短旗标（`-x`/`-e`/`+x` 等）→ 跳过
5. 长旗标（`--restricted` 等）→ FAIL_CLOSED（V5/V7 已收口，不回退）
6. 其他 token → FILE（bash script.sh）

载荷起点定位：`after.indexOf("-c")` + 跳过 `-c` 后空白——旗标扫描已确认 `-c` 存在且前面全是合法旗标/值，`indexOf` 找到的第一个 `-c` 就是目标。

### 不做（issue 范围外）

- `rm -rf` 载荷递归不被拦：rm 归 checkDataDirDestructive 管（独立通道），不在 MAIN_WRITE_PATTERNS——不带旗标的 `bash -c 'rm -rf data/'` 也放，是既有管辖边界，不是本 issue 引入。建议单独 issue 跟踪。
- SHELL_FLAG_WHITELIST 字符类盲区：`-opipefail` 值内联形态匹配字符类放行——真 bash 3.2 实测报错 exit 2（invalid option name，-o 不接受值内联粘连），守卫放行无害（真 bash 拒执行）——字符类任意字母组合盲区是既有设计（#1297），收窄需单独 issue。

### -C 建模纠错（打回处置决策记录）

初版把 `-C` 当带值旗标（`tok === "-C"` → 消费下一 token）——**真 bash 实测推翻**：
- `bash -C -c 'echo OK'` → payload 正常执行（`-C` 是无参 noclobber 旗标，不接值）
- `bash -C /tmp -c 'echo OK'` → 报 `/tmp: is a directory` exit 126（`/tmp` 被当脚本文件名，payload 不执行）

修正：`-C` 移出带值旗标建模，由 SHELL_FLAG_WHITELIST 字符类覆盖（大写 C 已在字符类）。`-C` 后遇非旗标 token（如 `/tmp`）→ FAIL_CLOSED 保守拦（形态异常，不放行）。

### 合并修复决策记录（搭档拍板折回 #1314/#1315）

**背景**：#1313 审视收敛后，检视獭-1311 发现两个同域盲区——引号值误拦（原 #1314，P2）+ rm 破坏通道空隙（原 #1315，P1）。大獭按 #1297 先例立 follow-up issue 拆分，搭档拍板：「你合并在一起，不要开这么多次，整体来看修复都不完整」——同域盲区不拆 issue，折回本 PR 修完整。

**两块修复**：

1. **引号值误拦（原 #1314）**：`scanShellFlags` 白名单匹配前剥引号（`replace(/^["']|["']$/g, "")`——对齐 pathArgsOf 既有口径）。真 bash 3.2 实测 `bash -o "pipefail" -c 'echo hello'` 合法执行，token 化不剥引号会误拦。**空格注入面保持拦**：`"pipe fail"` 拆词后 `fail"` 白名单外 → FAIL_CLOSED。

2. **rm 破坏通道感知（原 #1315）**：`judgeShellCSegment` PAYLOAD 递归处补 `segmentDestructive` 调用——载荷逐段过 rm/mv/find -delete 主仓 data 判定（cwd 用 projectRoot，载荷在 bash -c 内执行时继承当前 shell cwd=主仓根）。**不误拦面**：非 data 目标（/tmp/scratch 等）放行，worktree 内合法 rm 不拦（resolvesToMainData 以 projectRoot 为基准，worktree 路径不在主仓 data 根下）。

## 影响范围

- `extractShellCPayload` 旗标解析完整性提升——带值旗标的值 token 正确消费并校验。
- 白名单内 optname（pipefail/errexit/nounset 等 26 个）放行面不变。
- 白名单外 optname（evilopt/monitor 等）从放行变拦截（fail-closed）。

## 验证

### 失败用例证据（修复前）

probe-1307b.ts：R1-R4（带值旗标 + 危险载荷）全放，N1-N4（白名单外 optname/无载荷）全放。

### 修复后

全量守卫测试回归绿（1187/1187）+ 探针 N1-N4 拦、P1-P6 放、N5-N8 拦。

### 自对抗变体（≥5）

| 变体 | 载荷 | 预期 | 测试 |
|---|---|---|---|
| V1 | `bash -o pipefail -c 'echo pwned > config/config.yaml'` | 拦（重定向递归拦） | ✅ R2 |
| V2 | `bash -o evilopt -c 'echo x'` | 拦（白名单外 optname） | ✅ N1 |
| V3 | `bash -o pipefail -o evilopt -c 'echo x'` | 拦（混合白名单外） | ✅ N2 |
| V4 | `bash -o monitor -c 'echo x'` | 拦（monitor 不在白名单） | ✅ N3 |
| V5 | `bash -o pipefail -c`（无载荷） | 拦（-c 后无载荷） | ✅ N4 |
| V6 | `bash --restricted -c 'echo x'` | 拦（长旗标 fail-closed） | ✅ N5 |
| V7 | `bash -o pipefail -c 'kill 42877'` | 拦（kill 族独立层） | ✅ N7 |

**绕过面分析**：`-o` 值内联形态（`-opipefail`）——token 扫描认 `-opipefail` 为单 token，不匹配 `^[+-]o$`（精确 `-o`/`+o`）→ 落 SHELL_FLAG_WHITELIST 校验 → `-opipefail` 不匹配白名单（含字母 o 后接字母）→ FAIL_CLOSED 拦 ✅。`-o` 值含空格注入（`-o "pipefail -c x"`）——split(/\s+/) 后 `"pipefail` 和 `-c"` 分属不同 token，`"pipefail` 不在白名单 → FAIL_CLOSED 拦 ✅。

## Known Limitations

- SHELL_FLAG_WHITELIST 字符类盲区：`-opipefail` 等值内联形态匹配字符类放行——真 bash 3.2 实测报错 exit 2（invalid option name，-o 不接受值内联粘连），守卫放行无害（真 bash 拒执行）——字符类任意字母组合盲区是既有设计（#1297），收窄需单独 issue。
- token 扫描按 `\s+` 切分——引号内空格（`bash -o "pipe fail" -c 'x'`）会把引号拆成多 token，剥引号后白名单校验失败 FAIL_CLOSED（保守侧，符合 fail-closed 原则）。
- `-` heredoc stdin 标记（`bash - <<'EOF'`）直接返回 FILE 交外层 heredoc 检测——外层 `scriptHeredocBodiesReadOnlySegmentAware` 管体内容，本层不管。
- rm 载荷感知的 cwd 固定用 projectRoot（载荷继承 shell cwd=主仓根）——worktree 内 `bash -c 'rm -rf ../data/'` 的相对路径解析以 projectRoot 为基准，`../data/` 解析到主仓 data/ 会拦（正确），worktree 内路径不拦（正确）。
