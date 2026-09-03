---
id: F20260903gh698
title: 'bash 守卫 kill/skill 误报修复：命令位置限定'
summary: |
  bash-safety-guard 的 findKillSegments 误报修复。原 KILL_COMMANDS 正则
  /\b(kill|skill)\b/ 匹配段内任意位置的 kill/skill 词元——markdown body、注释、
  echo 文本中的 skill 均被当作 kill 命令识别。当日实证：gh pr review --body 含
  skill 字样被拦、for 循环注释含 skill 被拦、grep 搜索 skill 文件被拦。
  修复：findKillSegments 改为仅在命令位置（段首或 shell 操作符后）匹配 kill 族
  词元；新增 XARGS_KILL_RE 管道模式兜底 xargs kill。10 条历史拦截中 7 条误报
  全覆盖，攻击向（PoC-1~10）保持拦截。
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
  expected_effect: "kill/skill 仅在命令位置才识别为危险命令；管道后 xargs kill 仍拦截；攻击向 PoC-1~10 不退化；误报回归用例全绿"
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

## 修复

```ts
// 命令位置限定正则——只在段首或 shell 操作符后匹配
const KILL_AT_CMD_POS = /^(?:\s*(?:sudo\s+)?(?:(?:\/[\w.-]+)+\/)?(?:kill|skill)(?!\w)\b)/;
const PKILL_AT_CMD_POS = /^(?:\s*(?:sudo\s+)?(?:(?:\/[\w.-]+)+\/)?(?:pkill|pgrep|killall|killall5)(?!\w)\b)/;
// xargs kill 管道模式兜底
const XARGS_KILL_RE = /\bxargs\s+(?:sudo\s+)?\bkill\b/;
```

shell 语义中 kill 只有在命令位置才会执行，此收紧**语义无损**：
- 段首 `kill 42877` → 命令位置 → 拦截 ✓
- `&& kill 42877` → 分段后段首 → 拦截 ✓
- `| xargs kill` → XARGS_KILL_RE 兜底 → 拦截 ✓
- `grep "skill" file` → skill 在参数中 → 放行 ✓
- `gh pr review --body '...skill...'` → skill 在 body 中 → 放行 ✓

## 路径穿透正则说明

`(?:\/[\w.-]+)+\/` 用 `+` 而非 `*` 匹配路径组件——JS 正则 `(?:\/[\w.-]+\/)*`
在多组件路径（`/usr/bin/`）上只匹配一个组件（`/usr/`），是引擎回溯特性。
`(?:\/[\w.-]+)+\/` 正确匹配 `/usr/bin/`，且 `(?!\w)` 防止 `kills`/`skills`
等变体误匹配。

## 覆盖面核对

- 原有57 测试全部保持绿（含 PoC-1~10 攻击向、归一化形态、PID 脱敏）
- 新增12 个测试用例（5 模式1 回归 + 4 模式2 回归 + 3 管道/操作符覆盖）
- 总计69 测试全绿

### 新增测试用例

**模式1 回归（eval 词元文件名+数字）**：
1. `cp plans/eval-activation-v6.md <UUID>/` → 放行
2. `ls plans/; find . -name "eval-activation*"` → 放行
3. `grep -n "v4.2|D1|D2|D3" workspaces/...` → 放行
4. `grep -n "不 boot 应用|git-common-dir" ...eval-activation-v6.md` → 放行
5. `cat > /tmp/test24.js << EOF` → 放行

**模式2 回归（进程动词词元任意位置）**：
1. `gh pr review --comment --body '...skill...'` → 放行
2. `for pr in ...; do gh pr view $pr; done # skill 文件自查` → 放行
3. `grep -rn "skill" .pi/skills/` → 放行
4. `echo skill | cat` → 放行

**管道/操作符覆盖**：
1. `cat file | xargs kill` → 拦截（管道后 xargs）
2. `echo starting && kill 42877` → 拦截（操作符后命中主 PID）
3. `echo a; sudo /usr/bin/kill 42877` → 拦截（路径穿透命中主 PID）

### 已有测试行为变化

`管道到 shell 拦截含误拦退出引导` → 改为 `管道到 shell 中 kill 在 grep 参数里 → 放行`：
`cat note.txt | grep -q kill && bash -c 'true'` 中 kill 在 grep 参数中，
非命令位置，旧代码误拦，新代码正确放行。

## 与 F20260902gvrd 的关系

F20260902gvrd 修复模式1（eval 命令位置限定），本次修复模式2（kill/skill 命令位置
限定）。两次修复共用同一设计原则：**只有在命令位置的危险词元才构成威胁**。

## 最简实现检查

已过最简检查：
- 仓库已有 KILL_COMMANDS/PKILL_COMMANDS 正则 → 改为命令位置版本
- 无新依赖、无新抽象层
- XARGS_KILL_RE 是管道场景的最小补充（1 行正则）

## 验证

- [x] `npx vitest run tests/frameworks/agent/bash-safety-guard.test.ts` → 69/69 绿
- [x] 已有57 测试无退化（PoC-1~10 保持拦截）
- [x] 新增12 误报回归用例全绿
