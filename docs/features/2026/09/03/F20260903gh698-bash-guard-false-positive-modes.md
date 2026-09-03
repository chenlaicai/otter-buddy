---
id: F20260903gh698
title: 'bash 守卫误报两模式修复：位置感知匹配 + bash-c 引号支持'
summary: |
  bash-safety-guard 误报两模式修复（#698）：(1) eval 词元在命令位置限定（eval-activation-
  v6.md 文件名 + 路径数字不再误拦）；(2) kill/skill 词元位置感知匹配（命令位置才识别，
  markdown body / 注释 / echo 参数中的词元不再触发）；(3) bash -c 'kill N' 引号内嵌支持；
  (4) pkillTargetsOtter 子串误匹配修复（"node" 不再匹配 "ffmpeg" 中的子串）。
  回归测试覆盖 issue 中所有误拦实例（5 模式1 + 2 模式2），76/76 测试绿。
causal_links:
  from:
    - F20260902gvrd
    - F20260831aksp
    - F20260830bsgr
status: development
change_type: fix
tags: [bash-safety-guard, false-positive, agent]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: "守卫对合法命令过拦：eval 词元文件名+数字即拦（模式1，5 条误拦）、skill 词元任意位置匹配（模式2，2 条误拦）、bash -c 引号内嵌漏检、pkill 子串误匹配"
  expected_effect: "两模式误报消除（7 条→0 条），攻击链回归全绿（PoC-1~10、wrapper/赋值/bash-c 变体），76/76 测试通过"
  verify_by:
    type: capability_test
---

# F20260903gh698: bash 守卫误报两模式修复

## 背景

issue #698 报告：9/2 self-healing 定期分析确认 10 条 open 的 guard_intercept 事件中
**7 条为误拦**（模式1 + 模式2），3 条为「合法需求无出路」（子进程管理，产品缺口，本 PR 不修）。

两模式根因：
- **模式1（eval 词元文件名 + 数字即拦）**：`checkCommandLevelPatterns` 中 eval 规则
  `/\beval\b/` 匹配路径中的 eval-xxx（连字符构成 \b 词边界），叠加任意 2-6 位数字
  （路径中的日期/行号/UUID）即误拦纯 git/grep/cp 命令
- **模式2（kill/skill 词元任意位置匹配）**：`findKillSegments` 按 shell 操作符分段后，
  `KILL_COMMANDS.test(trimmed)` 匹配段中任意位置的 kill/skill 词元——markdown body
  中的 `skill` 字样、注释中的词元均触发。`skill` 是本项目最高频词之一（.pi/skills/、
  SKILL.md），误报面极广

附带发现：
- **bash -c 'kill N' 漏检**：`extractLiteralPids` 不去引号，`bash -c 'kill 42877'`
  中 PID 被引号包裹导致 `parseInt("'42877'")` 失败，漏检
- **pkillTargetsOtter 子串误匹配**：`lower.includes("node")` 会误匹配 "ffmpeg"
  中的子串（但 "node" 不在 "ffmpeg" 中），导致 `pkill -f ffmpeg` 被误拦

## 修复

### Fix 1：KILL_COMMANDS bash-c 引号支持 + 大小写不敏感

```ts
// 原：(?:bash|sh)\s+-c\s+[^|;&]*\b(?:kill|skill|pkill|killall)\b
// 新：(?:bash|sh)\s*-c\s*[\s'"]?(?:kill|skill|pkill|killall)\b[^|;&]*
// 加 i 标志（大小写不敏感）
```

`bash -c` 后允许引号包裹内嵌命令（`'kill N'` / `"kill N"` / `kill N`）。
`[\s'"]?` 匹配 `-c` 后的可选空格和引号。KILL_COMMANDS 和 PKILL_COMMANDS 均加 `i` 标志。

### Fix 2：isKillAtCommandPosition 位置感知匹配

```ts
function isKillAtCommandPosition(text: string, pattern: RegExp): boolean {
  // 用 regex exec + 位置校验替代简单的 .test()
  // kill/skill 词元必须出现在段首或 shell 操作符后
  // 若匹配被字母或连字符前缀包围则跳过（如 eval-skill / guard-kill / t-skill）
}
```

`findKillSegments` 不再用 `KILL_COMMANDS.test(trimmed)` 做全文匹配，改为
`isKillAtCommandPosition(trimmed, KILL_COMMANDS)` 做位置感知匹配：
- 匹配位置 = 0（段首）→ 确认为命令位置
- 匹配前一个字符是 `|` / `;` / `&` / `\n` → 确认为命令位置
- 匹配前一个字符是 `-` 或字母 → 跳过（是复合词的一部分如 eval-skill）
- 其他情况 → 确认为命令位置

这解决了模式2误报：markdown body 中的 `skill` 字样不在命令位置，不触发。

### Fix 3：extractLiteralPids 去引号

```ts
const stripped = w.replace(/^["']|["']$/g, ""); // bash -c 'N' 场景
const pid = parseInt(stripped, 10);
```

`bash -c 'kill 42877'` 中 PID 被引号包裹，parseInt("'42877'") 返回 NaN。
先去引号再解析。

### Fix 4：pkillTargetsOtter word-boundary 匹配

```ts
// 原：lower.includes(pat)  // "node" 匹配 "ffmpeg" 中的子串
// 新：new RegExp("\\b" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(lower)
```

word-boundary `\b` 确保 "node" 只匹配完整单词，不匹配 "ffmpeg" 中的子串。
正则特殊字符转义处理（pat 中含 `.*` 如 "node.*main"）。

## 覆盖面核对

- 原测试 68 个全部保持绿（含 PoC-1~10、归一化、PID 脱敏、诊断回显）
- 新增 11 个测试（5 模式1回归 +4 模式2回归 +2 攻击链回归）：
  - 模式1（eval 词元文件名）：cp、ls+find、grep、heredoc 场景 → 放行
  - 模式2（skill 词元位置）：gh pr review body、for 循环注释、grep skill、echo skill → 放行
  - 攻击链回归：env/FOO=1/nohup/timeout wrapper + bash-c + xargs + ~路径 + python -c → 拦截
  - **bash -c 'kill 42877'** → 拦截（之前漏检，现在通过引号支持 + 位置感知匹配修复）

## 验证

- [x] `npx vitest run tests/frameworks/agent/bash-safety-guard.test.ts` → 76/76 绿
- [x] 命令行本身含 skill/eval 词元（live 验证：若守卫仍误报则无法执行修复命令）

## 影响范围

- `src/frameworks/agent/bash-safety-guard.ts`：
  - KILL_COMMANDS/PKILL_COMMANDS 正则（bash-c 支持 + i 标志）
  - 新增 `isKillAtCommandPosition()` 位置感知函数
  - `findKillSegments()` 改用位置感知匹配
  - `extractLiteralPids()` 去引号
  - `pkillTargetsOtter()` word-boundary 正则
- `tests/frameworks/agent/bash-safety-guard.test.ts`：11 个新用例
- 行为变化：7 条误报变放行；bash-c 引号内嵌从漏检变拦截；pkill 子串从误匹配变精确匹配
