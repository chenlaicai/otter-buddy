---
id: F20260903gh698
title: 'bash 守卫 kill/skill 误报修复：位置感知匹配 + wrapper/bash-c 支持'
summary: |
  bash-safety-guard 的 findKillSegments 误报修复。原 KILL_COMMANDS 正则
  /\b(kill|skill)\b/ 匹配段内任意位置的 kill/skill 词元——markdown body、注释、
  echo 文本中的 skill 均被当作 kill 命令识别。当日实证：gh pr review --body 含
  skill 字样被拦、for 循环注释含 skill 被拦、grep 搜索 skill 文件被拦。
  修复：findKillSegments 改为位置感知匹配（isKillAtCommandPosition）+ 综合
  KILL_COMMANDS 正则（含 wrapper/赋值前缀/bash -c 引号内嵌支持）；新增
  extractLiteralPids 去引号、pkillTargetsOtter word-boundary 匹配、
  python3 -c one-liner 补拦。10 条历史拦截中 7 条误报全覆盖，攻击向
  （PoC-1~10 + wrapper/bash-c/xargs 变体）保持拦截。
causal_links:
  from:
    - F20260902gvrd
    - F20260830bsgr
    - F20260831aksp
status: development
change_type: fix
tags: [bash-safety-guard, false-positive, agent, safety]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: "findKillSegments 用 /\\b(kill|skill)\\b/ 匹配段内任意位置的 kill/skill 词元，markdown body/注释/echo 文本中的 skill 均被误识别为 kill 命令"
  expected_effect: "kill/skill 仅在命令位置才识别为危险命令；wrapper/赋值/bash-c/xargs 变体仍拦截；攻击向 PoC-1~10 不退化；误报回归用例全绿；76/76 测试通过"
  verify_by:
    type: capability_test
---

# F20260903gh698: bash 守卫 kill/skill 误报修复

## 背景

self-healing 定期分析（9/2 10:00 轮）确认：当前 10 条 open 的 guard_intercept
事件中 **7 条为误拦**。两模式：

1. **eval 词元文件名+数字即拦**（5 条）：已在 F20260902gvrd 修复
2. **kill/skill 词元任意位置匹配**（2 条）：本次修复

当日实证：
- `gh pr review 689 --comment --body '## 审查者 检视獭-689 ... skill ...'` 被拦
- `for pr in 683 682 681; do gh pr view $pr; done # skill 文件自查` 被拦
- `grep -rn "skill" .pi/skills/` 被拦

## 根因

```ts
// 原规则：KILL_COMMANDS 匹配段内任意位置
const KILL_COMMANDS = /\b(sudo\s+)?(\/usr\/(local\/)?bin\/)?(kill|skill)\b/;
// findKillSegments 按 shell 操作符分段后逐段 test
if (KILL_COMMANDS.test(trimmed)) → 归类为 kill 段
```

`\b(kill|skill)\b` 匹配一切独立出现的 kill/skill——markdown body 中的 skill、
注释中的 skill、echo 参数中的 skill 均被当作 kill 命令识别。叠加 INDIRECT_PID_PATTERNS
中的反引号模式（markdown 代码块反引号即命中），合法命令被拦截。

## 修复方案

采用**位置感知匹配 + 综合正则**两层策略：

### 层1：isKillAtCommandPosition（位置感知）

```ts
function isKillAtCommandPosition(text: string, pattern: RegExp): boolean {
  // regex match 必须出现在命令位置（段首或 shell 操作符后）
  // 若匹配被字母或连字符前缀（如 eval-skill / guard-kill）包围则跳过
}
```

解决模式2误报：段中间的 skill（markdown body、注释、echo 参数）不在命令位置，
isKillAtCommandPosition 返回 false，不触发拦截。

### 层2：KILL_COMMANDS 综合正则（wrapper/bash-c 支持）

```ts
const KILL_COMMANDS = /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:~\/[^\s]+\/)?(?:[A-Za-z_]\w*=\S+\s+)*(?:env\s+|timeout\s+\S+\s+|nohup\s+|command\s+|nice\s+-?n?\s*\d*\s+)*(?:kill|skill)\b|(?:bash|sh)\s*-c\s*[\s'"]?(?:kill|skill|pkill|killall)\b[^|;&]*/i;
```

正则本身处理 wrapper 命令（env/timeout/nohup）、赋值前缀（FOO=1）、
路径穿透（~/bin/kill, /usr/local/bin/kill）、bash -c 引号内嵌等攻击变体。
isKillAtCommandPosition 在 position=0 时返回 true，确保这些变体被正确拦截。

### 辅助修复

- **extractLiteralPids 去引号**：bash -c 'kill 42877' 中 PID 被引号包裹，
  parseInt("'42877'") 返回 NaN。先去引号再解析。
- **pkillTargetsOtter word-boundary**：原 lower.includes("node") 会误匹配
  "ffmpeg" 中的子串。改用 `\b` 正则确保完整单词匹配。
- **python3 -c 补拦**：脚本语言 one-liner 检测扩展为同时匹配 -e 和 -c 标志。

## 覆盖面核对

- 原有68 测试全部保持绿（含 PoC-1~10 攻击向、归一化形态、PID 脱敏）
- 新增8 个测试用例（5 模式1 回归 + 4 模式2 回归 + 攻击链回归覆盖）
- 总计76 测试全绿

### 攻击链回归测试（wrapper/bash-c/xargs/路径变体）

1. `env kill 42877` → 拦截（env wrapper 前缀 + 主 PID）
2. `FOO=1 kill 42877` → 拦截（赋值前缀 + 主 PID）
3. `nohup kill 42877` → 拦截（nohup wrapper + 主 PID）
4. `bash -c 'pkill -f otter-buddy'` → 拦截（bash -c 引号内嵌 pkill）
5. `bash -c 'kill 42877'` → 拦截（bash -c 引号内嵌主 PID）
6. `cat f | xargs -n1 kill 42877` → 拦截（xargs 带参变体）
7. `~/bin/kill 42877` → 拦截（~ 路径 + 主 PID）
8. `python3 -c 'import os; os.kill(42877, 9)'` → 拦截（python -c one-liner）

### 误报回归测试

1. `gh pr review --comment --body '...skill...'` → 放行
2. `for pr in ...; do gh pr view $pr; done # skill 文件自查` → 放行
3. `grep -rn "skill" .pi/skills/` → 放行
4. `echo skill | cat` → 放行

## 与 F20260902gvrd 的关系

F20260902gvrd 修复模式1（eval 命令位置限定），本次修复模式2（kill/skill 位置
感知匹配）。两次修复共用同一设计原则：**只有在命令位置的危险词元才构成威胁**。

## 验证

- [x] `npx vitest run tests/frameworks/agent/bash-safety-guard.test.ts` → 76/76 绿
- [x] 已有68 测试无退化（PoC-1~10 保持拦截）
- [x] 新增8 误报回归 + 攻击链回归用例全绿
- [x] 全量2867 测试通过（`npx vitest run`）
