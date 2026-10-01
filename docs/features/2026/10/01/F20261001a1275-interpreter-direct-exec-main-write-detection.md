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

1. **MAIN_WRITE_PATTERNS 新增 2 条通道正则**（src/frameworks/agent/bash-safety-guard.ts:592-604）：
   - python -c：`python[\d.]*\s+(?:-[A-Za-z](?:\s+(?!-)\S+)?\s+)*-c(?:\s*["'`]|\s+(?!["'`])\S)`
   - node -e|--eval：`node(?:\d+)?\s+(?:--[A-Za-z-]+(?:\s+[^\s;&|]+)?\s+)*(?:-e|--eval)(?:\s*["'`]|\s+(?!["'`])\S)`
   - 旗标位容许 python 带参旗标（-W ignore / -X dev），node 长旗标（--max-old-space-size 4096）
   - 无引号载荷（`python3 -c print(...)`）同样识别（提取失败 → 保守拦）

2. **oneLinerPayloadReadOnly 判定链**（:855-895）：
   - `extractOneLinerPayload`：escape 感知引号扫描提取载荷（未闭合/无引号 → null → fail-closed）
   - 同一条命令含多个 one-liner（python + node 混合）→ 全部提取成功且全部只读才豁免
   - python → `pythonBodyReadOnly`，node → `nodeBodyReadOnly`（复用现有白名单基础设施）

3. **checkMainCheckoutWrite 集成**（:997-1004）：
   - 新增 `oneLinerReadOnly` 预计算（只在命令实际含 one-liner 形态时提取一次，非 one-liner 命令无提取开销）
   - MAIN_WRITE_PATTERNS 循环内 index 1/2（slice 后）命中时查 `oneLinerReadOnly` 豁免
   - index 0（heredoc）保持原有 `heredocReadOnly` 豁免逻辑不变

4. **pythonBodyReadOnly 补充**（:822-824）：新增 `import os` 否定检测——os 模块只读子面（getcwd/listdir）与写面（remove/system）无法静态区分，import os 即不豁免（保守拦）。

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

kill 检测侧已有 `python -c`/`node -e` 形态检测（:316-319，F20260923glay），本次是**同一盲区在主仓写检测侧的对齐补齐**——两个检测链路独立运行，互不依赖。

## 验证

### 回归测试

**事故原文**（session entry 417 原样提取）作为测试用例，断言判定为 BLOCKED：
```typescript
const incident = "pwd; python3 -c \"\nsrc = open('config/config.yaml').read()\nassert 'port: 3000' in src\nopen('config/config.yaml','w').write(src.replace('port: 3000','port: 3102',1))\nprint('patched')\"; grep -n \"port:\" config/config.yaml | head -2";
expect(checkBashCommandSafety(incident, mainPid, undefined, { projectRoot })).toContain("当前 bash 工作目录在主仓");
```

### 全量测试

- 守卫相关测试：tests/frameworks/agent/ 48 文件 1037 用例全绿
- pre-commit 全量：build + lint + test + smoke 全过
- 新增用例：12 个（事故原文回归 + 写签名拦截 + 只读放行 + cd 豁免 + kill 链交叉 + 旗标位识别 + 无引号载荷 fail-closed）

### 最简实现检查

已过最简检查：
- 复用现有 `pythonBodyReadOnly`/`nodeBodyReadOnly` 白名单基础设施（不新写只读判定链）
- 复用现有 `MAIN_WRITE_PATTERNS` 通道正则架构（不新建判定链路）
- `oneLinerPayloadReadOnly` 只新增 60 行（提取 + 多载荷协调），无框架化

## 影响范围

| 文件 | 变更 | 行为变化 |
|------|------|----------|
| src/frameworks/agent/bash-safety-guard.ts | +2 通道正则 +oneLinerPayloadReadOnly +import os 否定检测 | python3 -c / node -e 载荷含写签名时被判定主仓写（BLOCKED），纯只读载荷不误拦 |
| tests/frameworks/agent/bash-safety-guard.test.ts | +12 用例（#1275 describe 块） | 事故原文回归 + 对称测试 |
| tests/frameworks/agent/bash-guard-layered-detect.test.ts | 1 用例更新（node -e readFileSync 不在白名单 → 拦） | 与 one-liner 通道白名单口径对齐 |
| tests/frameworks/agent/guard-intercept-classify.test.ts | 1 用例更新（python3 -c os.kill 分类从 self_kill_script → main_write） | 判定顺序变化（主仓写检测在 kill 链之前） |

## Discovered Issues

无。

## Known Limitations

1. **ruby -e / perl -e 未覆盖**：方案要求提到 ruby/perl，但 #1252 事故实证与 kill 检测侧对齐口径（:316-319）均只覆盖 python/node。ruby/perl 在守卫检测链路中无先例，如需覆盖另行立项。
2. **NODE_READONLY_METHODS 白名单偏窄**：readFileSync 等常用只读 API 不在白名单（fail-closed 原则），node -e 只读形态放行面小于 python -c。如需扩白名单另行评估。
3. **载荷内字符串含 > | 等 shell 操作符**：已由 REDIRECT_PATTERN 的引号剥离基准（stripQuotedTextSpans）处理，载荷内 > | 是 JS/python 语法文本不是 shell 操作符，不触发重定向/管道拦截。
