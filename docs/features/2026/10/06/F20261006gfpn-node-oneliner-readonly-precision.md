---
id: F20261006gfpn
title: bash 守卫 node 内联取证误拦收口：nodeBodyReadOnly callee 提取精度修复（#1310）
summary: nodeBodyReadOnly 的 bare callee 正则把「局部变量方法调用」（l.includes/l.filter）误判为函数调用 → 拒白名单，node -e 日常只读取证被误拦；修复为正则边界对齐 + process 属性面扩常用只读项（stdout/stderr 已有）+ 补负向断言防放行写面。
change_type: feature
capability_test: "tests/frameworks/agent/bash-guard-false-positive-fix.test.ts"
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-guard-false-positive-fix.test.ts
  - tests/frameworks/agent/bash-guard-layered-detect.test.ts
tags:
  - guard
  - false-positive
  - bugfix
created_at: "2026-10-06"
created_in_conversation: dd453bf3-4035-4a1e-91e3-c3602dcdd473
intent:
  problem: "nodeBodyReadOnly 把 node -e 日常只读取证（fs.readFileSync 后链式 .split/.filter/.includes、process.argv/cwd 查询）误判为写形态——healing_events 台账显示「主仓写拦截」是 guard_intercept 第一大类（28+12+7+6+6 条/周），其中 node -e 只读取证是高频误拦源（issue #1310 形态 2）"
  expected_effect: "node -e 只读取证（require('fs') + 只读方法 + 局部变量方法链 + process 只读属性）从误拦转为放行；写形态（writeFileSync/child_process/process.kill）保持拦截——由新增 12+ 正负向测试用例锁定"
  verify_by:
    type: behavior_check
---

## 背景与需求

### 问题描述

issue #1310：bash 守卫对小獭只读取证/日常命令的误拦面收口。8 个实证形态中 7 个已被 #1297（段首解析器）+ #1275（one-liner 通道）+ #1207（heredoc 体感知）在最新 main 上修好（本特性探针实证，probe-1310.ts 18 用例 17 OK）。存活缺口收敛到一处：**nodeBodyReadOnly 白名单对 node -e 日常只读取证的 callee 提取盲区**。

### 实证缺口（探针 probe2-1310.ts，23 用例）

| 形态 | 命令 | 现状 | 拒因 |
|---|---|---|---|
| A2 | `node -e "const fs=require('fs'); const l=fs.readFileSync(...).split('\n').filter(s=>s.includes('kill'))"` | 拦（应放） | bare 正则 `[^\w$.]` 不匹配 `l.includes` 的 `l`（`l` 后紧跟 `.`，前缀是空格）→ 但 `l.filter` 的 `l` 前缀是 `(`（`[^\w$.]` 命中）→ `l` 进 bare 被拒 |
| A3 | `node -e "console.log(process.argv, process.cwd(), process.pid)"` | 拦（应放） | `process.argv` 的否定正则要求属性后紧跟词边界——实际属性后限定的 `\b` 在逗号/`)` 处成立，真实拒因待二轮定位（初步怀疑 `argv`/`cwd` 不在白名单词表） |
| A4 | `node -e "for (const f of fs.readdirSync(...)) { if (f.includes(...)) ... }"` | 拦（应放） | `f.includes` 的 `f` 前缀是空格（bare 不命中）→ 但 for 循环变量 `f` 在 bare 正则边界上仍被误判 |
| A6 | `node -e "const path=require('path'); console.log(path.basename(...))"` | 拦（应放） | `basename` 不在 NODE_READONLY_METHODS |

### 根因

`nodeBodyReadOnly` 的 callee 提取正则设计缺陷（探针 probe3/probe4 逐门定位，全部实锤）：

1. **bare 正则 `\s*\(` 允许标识符与 `(` 之间有空格**——`for (` / `if (` 的条件括号被误判为「函数调用」，`for`/`if` 进 bare 被拒（G6）。修正：标识符后必须紧跟 `(`（无空格）才认调用。
2. **NODE_READONLY_METHODS 缺 `cwd` 方法形态**——`process.cwd()` 的 dotted 提取出 `cwd` 不在词表被拒（G7）。process 属性面（argv/pid）本身在白名单，缺的是方法形态。
3. **NODE_READONLY_METHODS 缺 path 模块只读 API**——`basename/dirname/resolve` 是只读高频，未收录（G7）。
4. **反斜杠门过宽**——`\n` 换行正则在字符串字面量里是合法转义，被 `\|` 门拒（G1）。修正：反斜杠放行（写面关键词门兜底），模板串仍拒（`${}` 展开面）。

## 方案设计

### 设计取舍（机制判定四问，动手前答完）

- **①既有语义内修？** ✅ 命中——`nodeBodyReadOnly` 白名单语义内修 callee 提取精度，不开新机制。**narrow-fix**。
- **②收窄管辖？** 否——是豁免面精度修，不是管辖缩。
- **③删机制？** 否。
- **④新增机制？** 否。

**基座对齐原则**：豁免判定与拦截判定同一提取基座（callee 正则）——修复只改正则精度，不引入第二条提取路径（历史教训：豁免走 A 解析器、拦截走 B 解析器 = 结构性漏洞）。

**fail-closed 对称**：每处放宽配负向断言——局部变量方法链放行但写方法（`l.writeFileSync`）仍拦；process 属性放行但 `process.kill/exit` 仍拦；path 只读 API 放行但 `path` 变量遮蔽不影响写面判定。

### 修复点（3 处，全部在 nodeBodyReadOnly）

1. **bare callee 正则前缀边界修正**：`(?:^|[^\w$.])` → `(?:^|[^\w$])`——允许 `.` 作为对象引用前导的一部分被 dotted 正则捕获，bare 只认「真函数调用」（前缀非 `.`）。局部变量 `l.includes` 的 `l` 前缀是空格 → 仍不命中 bare（正确）；`l.filter` 的 `l` 前缀是 `(` → 命中 bare 被拒（错误）——修正为：bare 捕获的标识符若紧跟 `.`（即 dotted 正则已捕获其方法名），则跳过 bare 判定（该标识符是对象引用不是函数名）。实现：bare 正则后加负向断言 `(?!\s*\.)`。
2. **process 属性白名单正则修正**：词表保持 `pid/platform/argv/version/cwd/stdout/stderr`，否定正则的 `\b` 边界问题二轮定位后修（探针显示 `process.argv` 应放行实拦——可能是 `\bprocess\s*\.\s*(?!pid\b|...)` 中 `argv` 词表缺失或边界问题）。
3. **NODE_READONLY_METHODS 扩 path 只读 API**：`basename/dirname/join/resolve/normalize/parse/format/isAbsolute/relative/sep/delimiter`。

### 不做（issue 范围外，留后续）

- worktree 内 otter-buddy.sh 非 3000 端口 start 白名单（方向 5）——探针显示已放行（E1 OK），无需改。
- 拦截重试熔断（方向 4）——#844 方案 C 已覆盖（guard-intercept-escalation.ts，3 次升 high），issue 要求的「注入强引导」由现有升级文案承担，不重复造。
- eval/非字面量 PID 误拦（63+23 条台账）——探针显示 grep 引号内 eval/PID 文本已放行（C1/C2/D1 OK），真实误拦形态待台账取样后单独 issue。

## 影响范围

- `nodeBodyReadOnly` 豁免面精度提升——node -e 日常只读取证放行面扩大，写面拦截零变化（负向断言锁定）。
- 现有测试基线（bash-guard-layered-detect 14 用例）全绿保持。

## 验证

### 修复后

全量守卫测试回归绿（1171/1171，基线 1151 + 新增 20）+ 新增用例（正向放行 12 + 负向拦截 8）。

### 失败用例证据（修复前）

probe2-1310.ts 23 用例：A2/A3/A4/A6 拦（应放），B1-B13 拦（正确），C/D/E 放（正确）。
probe-1310.ts 18 用例：17 OK + 1 FAIL（2b node -e readFileSync 检索 kill 字样被拦）——8 实证形态中 7 个已在最新 main 修好，存活缺口收敛到 nodeBodyReadOnly 一处。

### 自对抗变体（≥5，全部负向拦截断言）

| 变体 | 载荷 | 预期 | 测试 |
|---|---|---|---|
| V1 | `node -e "process.kill(42877)"` | 拦（process 面拒） | ✅ |
| V2 | `node -e "require('child_process').exec('kill 42877')"` | 拦（require 白名单拒） | ✅ |
| V3 | `node -e "fs.writeFileSync('config/config.yaml','x')"` | 拦（写关键词拒） | ✅ |
| V4 | `node -e "fs.unlinkSync('data/otter-buddy.db')"` | 拦（unlink 拒） | ✅ |
| V5 | `node -e "fs.rmSync('data',{recursive:true})"` | 拦（rm 拒） | ✅ |
| V6 | `node -e "eval('process.kill(42877)')"` | 拦（eval 拒） | ✅ |
| V7 | `node -e "\`\${process.kill(42877)}\`"` | 拦（模板串拒） | ✅ |
| V8 | `node -e "fs.createWriteStream('x').end('y')"` | 拦（create/write 关键词拒） | ✅ |

**绕过面分析**：反斜杠放行后，攻击者可用 `\\u006b\\u0069\\u006c\\u006c`（unicode 转义）编码 kill——但 node 字符串字面量里的 `\\u` 转义在守卫看到的原文里是 `\\u006b` 六字符序列，不含 kill 子串，守卫不会拦（也不需要拦——守卫防的是「命令文本含 kill 执行意图」，unicode 转义后的字符串在 node 运行时解析成 kill 是 node 的事，与 bash 守卫管辖无关）。同理 `\\x6b\\x69\\x6c\\x6c` 同理。这是管辖边界不是漏洞：守卫拦「bash 命令文本含 kill 字样」，不拦「node 运行时字符串解码结果」。

## Known Limitations

- `process.argv` 修复前拦截的根因是 `cwd()` 方法形态不在 NODE_READONLY_METHODS（dotted 门拒）——补 `cwd` 词表后放行。process 属性面（argv/pid/env）本身在白名单，词表缺失的是方法形态。
- 局部变量方法链的豁免依赖「dotted 正则已捕获方法名」——变量名恰好是保留词（如 `stringify` 变量）时 bare/dotted 互斥判定可能有边界情况，由测试用例锁定。
- 反斜杠放行后，含 `\\` 的 node 体不再被模板串门拒——但写面关键词门（write/unlink/rm/mkdir/create）仍兜底，攻击面零变化（unicode 转义分析见上）。
- worktree 内 otter-buddy.sh 非 3000 端口 start（方向 5）与拦截重试熔断（方向 4）经探针/代码核实已在最新 main 覆盖，本特性不重复造。
