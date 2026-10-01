---
id: F20261001a1275
title: "bash 守卫主仓写检测补解释器直执行形态盲区：python3 -c / node -e 载荷白名单判定"
summary: "9/29 #1252 事故实证：小獭用 `python3 -c \"open('config/config.yaml','w').write(…)\"` 绕过主仓写检测（MAIN_WRITE_PATTERNS 只覆盖重定向/python heredoc/git 写族），污染主仓 config。本次在 MAIN_WRITE_PATTERNS 链路补 one-liner 通道正则（python -c / node -e|--eval），载荷只读白名单豁免复用现有 pythonBodyReadOnly/nodeBodyReadOnly 基础设施（与 #1207 heredoc 体感知判定同架构：通道正则 + 载荷白名单），fail-closed 原则：白名单外/提取失败一律拦。"
change_type: fix
capability_test: "tests/frameworks/agent/bash-safety-guard.test.ts #1275 describe 块（12 用例：事故原文回归 + 写签名拦截 + 只读放行 + cd 豁免 + kill 链交叉）"
created_in_conversation: dd453bf3-4035-4a1e-91e3-c3602dcdd473
intent:
  problem: "bash 守卫主仓写检测不覆盖解释器直执行形态（python3 -c / node -e），9/29 #1252 事故实证小獭用该形态绕过守卫污染主仓 config"
  expected_effect: "python3 -c / node -e 载荷含写签名时被判定主仓写（BLOCKED），纯只读载荷（print/read/grep 类）不误拦，cd worktree 后豁免"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
  - tests/frameworks/agent/bash-guard-layered-detect.test.ts
  - tests/frameworks/agent/guard-intercept-classify.test.ts
tags:
  - bash-guard
  - main-checkout-write
  - interpreter-direct-exec
  - one-liner
  - python-c
  - node-e
  - #1252
  - #1275
causal_links:
  from:
    - F20260922scwd
    - F20260930l573
    - F20260923glay
    - F20260930p125
  supersedes: []
---

## 问题

主仓写检测 `checkMainCheckoutWrite`（src/frameworks/agent/bash-safety-guard.ts:926）的 `MAIN_WRITE_PATTERNS`（:592 起）只覆盖：
1. `REDIRECT_PATTERN`（重定向）
2. python heredoc（`python3 - <<EOF`）
3. git 写族

**盲区**：`python3 -c "…"` / `node -e "…"` 解释器直执行形态。

**事故实证**（9/29 #1252，session entry 417）：小獭-能力库全书在 F20260929scfx 验证期间执行：
```bash
pwd; python3 -c "
src = open('config/config.yaml').read()
assert 'port: 3000' in src
open('config/config.yaml','w').write(src.replace('port: 3000','port: 3102',1))
print('patched')"; grep -n "port:" config/config.yaml | head -2
```
cwd 主仓、无 cd 前缀 → 守卫判定 ALLOW，主仓 `config/config.yaml` 被污染（port 3000 → 3102）。

## 方案

### 架构对齐

与 #1207 heredoc 体感知判定（F20260930l573）同构：
- **通道正则**：`MAIN_WRITE_PATTERNS` 新增两条 one-liner 通道（python -c / node -e|--eval）
- **载荷白名单**：`oneLinerPayloadReadOnly` 复用现有 `pythonBodyReadOnly` / `nodeBodyReadOnly` 只读判定链
- **fail-closed**：白名单外/载荷提取失败/未闭合引号 → 保守拦

### 改动点

1. **MAIN_WRITE_PATTERNS 新增 4 条通道正则**（src/frameworks/agent/bash-safety-guard.ts:592-604）：
   - python -c：`python[\d.]*\s+(?:-[A-Za-z](?:\s+(?!-)\S+)?\s+)*-c(?:\s*["'`]|\s+(?!["'`])\S)`
   - node -e|--eval：`node(?:\d+)?\s+(?:--[A-Za-z-]+(?:\s+[^\s;&|]+)?\s+)*(?:-e|--eval)(?:\s*["'`]|\s+(?!["'`])\S)`
   - ruby -e：`ruby[\d.]*\s+(?:-[A-Za-z]+\s+)*-e(?:\s*["'`]|\s+(?!["'`])\S)`
   - perl -e：`perl[\d.]*\s+(?:-[A-Za-z]+\s+)*-e(?:\s*["'`]|\s+(?!["'`])\S)`
   - 旗标位容许带参旗标（-W ignore / -X dev / --max-old-space-size 4096）
   - 无引号载荷（`python3 -c print(...)`）同样识别（提取失败 → 保守拦）
   - 锚集对齐 git 写族（单 | / & 同样切段——管道右段绕过实证，S-1）
   - 通道/预闸/提取三处正则抽公共常量统一（ONELINER_CHANNEL_PATTERNS / ONELINER_PRE_GATE / ONELINER_EXTRACT_PATTERNS，S-4）

2. **oneLinerPayloadReadOnly 判定链**（:855-895）：
   - `extractOneLinerPayloads`：escape 感知引号扫描循环提取全部同型载荷（非单次——S-2 修复，任一载荷提取失败/未闭合/任一非只读 → null → fail-closed）
   - 同一条命令含多个 one-liner（python + node 混合/同解释器多实例）→ 全部提取成功且全部只读才豁免
   - python → `pythonBodyReadOnly`，node → `nodeBodyReadOnly`，ruby/perl → `rubyPerlBodyReadOnly`（恒 false，fail-closed 起步）
   - 豁免判定基准为原始命令文本（checkBashCommandSafety 首次扫描路径）——V1 归一化二次扫描剥引号误拦不发生在首次扫描（S-3）

3. **checkMainCheckoutWrite 集成**（:997-1004）：
   - 新增 `oneLinerReadOnly` 预计算（只在命令实际含 one-liner 形态时提取一次，非 one-liner 命令无提取开销）
   - MAIN_WRITE_PATTERNS 循环内 index 1/2（slice 后）命中时查 `oneLinerReadOnly` 豁免
   - index 0（heredoc）保持原有 `heredocReadOnly` 豁免逻辑不变

4. **pythonBodyReadOnly 补充**（:822-824）：新增 `import os` 否定检测——import os 的完整面无法静态确认无写面调用（os.remove/system 与 os.getcwd 同以 os. 开头），import os 即不豁免（保守拦）。from os import getcwd 可精确匹配只读子面放行（两语义并存：import 面保守拦，from-import 面按白名单放行）。

## 设计取舍

### 机制判定四问（动手前作答）

① **此问题能否用既有机制的规则扩充解决？** → 能。主仓写检测机制本体（MAIN_WRITE_PATTERNS 链路）已存在，one-liner 是该机制内新增的一条判定规则，不是新机制。

② **新机制相比规则扩充带来的增量价值是否覆盖其维护成本？** → n/a（非新机制，见①）。

③ **新机制会催生后续机制吗？** → 不会。one-liner 通道是主仓写检测的规则扩充，与 heredoc 体感知判定同架构，不引入新的机制依赖链。

④ **退役条件是什么？** → 当主仓写检测机制整体重构（如 F20260928grv2 统一结构模型判定层完全接管主仓写检测）时，one-liner 通道随机制迁移。

**结论**：Modification-Class = `narrow-fix`（既有机制内规则扩充，非新机制）。

### 不误拦对称测试

新 pattern 本身过「不误拦」对称测试（12 用例全绿）：
- 只读载荷（print/open read/json.dumps/console.log）→ 放行
- 写签名载荷（open 'w'/writeFileSync/appendFileSync/getattr 动态形态）→ 拦截
- cd worktree 后豁免 → 放行
- kill 链交叉（python3 -c os.kill）→ 拦截（kill 链独立命中，不因主仓写豁免放行）

### 与 kill 检测侧的对齐

kill 检测侧已有 `python -c`/`node -e`/`perl -e`/`ruby -e` 形态检测（:316-319，F20260923glay），本次是**同一盲区在主仓写检测侧的对齐补齐**——四个解释器通道全部覆盖，两个检测链路独立运行，互不依赖。

### 检视獭-1278 处置（delta r1）

6 项严重发现全部采纳（S-1 至 S-6），4 项建议全部采纳：
- **S-1**：锚集对齐 git 写族（单 | / & 同样切段）——管道右段写载荷绕过实证
- **S-2**：提取器循环提取全部同型载荷——`python3 -c "print(1)" && python3 -c "open('w')…"` 只读掩护写实测放行
- **S-3**：豁免判定基准为原始命令文本——V1 归一化二次扫描剥引号误拦不发生在首次扫描
- **S-4**：通道/预闸/提取三处正则抽公共常量统一——`-W ignore` 带参旗标位漂移实证
- **S-5**：ruby/perl 只读全拦（fail-closed 起步）——与 kill 检测侧 :316 对齐，先堵写面
- **S-6**：特性文档三处订正（readFileSync 归因错误、无先例矛盾、import os 回归未披露）

## 验证

### 回归测试

**事故原文**（session entry 417 原样提取）作为测试用例，断言判定为 BLOCKED：
```typescript
const incident = "pwd; python3 -c \"\nsrc = open('config/config.yaml').read()\nassert 'port: 3000' in src\nopen('config/config.yaml','w').write(src.replace('port: 3000','port: 3102',1))\nprint('patched')\"; grep -n \"port:\" config/config.yaml | head -2";
expect(checkBashCommandSafety(incident, mainPid, undefined, { projectRoot })).toContain("当前 bash 工作目录在主仓");
```

### 全量测试

- 守卫相关测试：tests/frameworks/agent/ 48 文件 **1049/1049 全绿**
- pre-commit 全量：build + lint + test + smoke 全过
- 新增用例：22 个（事故原文回归 + 写签名拦截 + 只读放行 + cd 豁免 + kill 链交叉 + 旗标位识别 + 无引号载荷 fail-closed + S-1 至 S-5 绕过形态固化 + 建议 4 三维度测试矩阵）

### 最简实现检查

已过最简检查：
- 复用现有 `pythonBodyReadOnly`/`nodeBodyReadOnly` 白名单基础设施（不新写只读判定链）
- 复用现有 `MAIN_WRITE_PATTERNS` 通道正则架构（不新建判定链路）
- `oneLinerPayloadReadOnly` 只新增 60 行（提取 + 多载荷协调），无框架化

## 影响范围

| 文件 | 变更 | 行为变化 |
|------|------|----------|
| src/frameworks/agent/bash-safety-guard.ts | +4 通道正则（python/node/ruby/perl）+oneLinerPayloadReadOnly 循环提取 +import os 否定检测 +公共常量统一 | python3 -c / node -e / ruby -e / perl -e 载荷含写签名时被判定主仓写（BLOCKED），纯只读载荷不误拦，管道右段同样覆盖 |
| tests/frameworks/agent/bash-safety-guard.test.ts | +22 用例（#1275 describe 块含 S-1 至 S-5 固化 + 建议 4 三维度） | 事故原文回归 + 对称测试 + 绕过形态反向断言 |
| tests/frameworks/agent/bash-guard-layered-detect.test.ts | 1 用例更新（node -e readFileSync 不在白名单 → 拦） | 与 one-liner 通道白名单口径对齐 |
| tests/frameworks/agent/guard-intercept-classify.test.ts | 1 用例更新（python3 -c os.kill 分类从 self_kill_script → main_write） | 判定顺序变化（主仓写检测在 kill 链之前） |

## Discovered Issues

无。

## Known Limitations

1. **NODE_READONLY_METHODS 白名单偏窄**：readFileSync 等常用只读 API 在源码 :952 白名单中，但「node -e require('fs') readFileSync」仍被拦截——真实原因是 nodeBodyReadOnly 的 bare 调用名白名单不含 `require`（:972），`require` 被当作未知 callee 拦。与 heredoc 通道同口径 fail-closed，如需放宽需扩白名单另行评估。
2. **ruby/perl 只读全拦（fail-closed 起步）**：S-5 处置——ruby -e / perl -e 通道已纳入（与 kill 检测侧 :316 对齐），但只读白名单未构建（rubyPerlBodyReadOnly 恒 false），先堵写面，放行面后续放宽。
3. **载荷内字符串含 > | 等 shell 操作符**：已由 REDIRECT_PATTERN 的引号剥离基准（stripQuotedTextSpans）处理，载荷内 > | 是 JS/python 语法文本不是 shell 操作符，不触发重定向/管道拦截。
4. **import os 否定检测对 heredoc 路径的回归**：pythonBodyReadOnly 新增 import os 门（:822-824）后，`python3 - <<EOF + import os + os.getcwd()` 从放行变拦——保守设计：import os 的完整面无法静态确认无写面调用（os.remove/system 与 os.getcwd 同以 os. 开头），from os import getcwd 则可精确匹配只读子面放行。跨通道行为回归已披露，取舍为安全侧倾斜。
