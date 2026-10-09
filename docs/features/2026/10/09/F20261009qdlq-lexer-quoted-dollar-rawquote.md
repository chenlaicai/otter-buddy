---
id: F20261009qdlq
title: "命令词法层 $\" raw-quote 回退：双引号内 $ 紧邻闭引号不再误吞外层引号（#1374）"
summary: "词法 scanExpansion 对 $\" 一律按 locale 引用 $\"...\" 找配对闭引号——grep \"^npm|^$\" 形态（$ 是正则锚定、\" 是外层闭合）被误判 locale 未闭合，连带外层引号 fail → parseOk=false → modelCdExemption 退化 false → cd worktree + git commit + grep 管道被误拦（4 连拦实证）。修复：$\" 仅在外层双引号上下文（quoted=\"double\"）按字面 $ 回退，闭引号留给外层引号扫描消费；词首 $\" 维持 locale 处理不变。"
change_type: fix
capability_test: "tests/capability/ n/a: bash 守卫词法层纯代码逻辑单测（词法 8 用例 + 守卫端到端 2 用例），非 prompt 行为面"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
modules: [src/frameworks/agent/command-lexer.ts, tests/frameworks/agent/command-lexer.test.ts, tests/frameworks/agent/bash-safety-guard.test.ts]
tags: [guard, lexer, false-positive, cd-exemption]
issues: [1374]
status: done
---

## 背景

#1374（P1）：`cd <worktree> && git commit -F msg.txt | grep -vE "^npm|^$" | head -5` 形态被 MAIN_WRITE_BLOCK_MSG 拦截——cd 已指到 worktree，git commit 落点不在主仓，属误拦。2026-10-08 晚大獭因此 4 连拦（含一次系统熔断中断发言），最终去管道绕路提交。

## 根因

`command-lexer.ts` `scanExpansion` 对 `$"` 分发一律按 locale 引用 `$"..."` 处理：`indexOf('"', i+2)` 找配对闭引号。bash 里 `$` 后跟 `"` 有两种解释：

1. **locale 引用**：`$"..."`（词首，有配对闭引号）
2. **raw-quote**：`$` 是正则锚定等字面量，`"` 是外层双引号的闭合（如 `grep "^npm|^$"`）

greedy `indexOf` 把②误判为①的未闭合 → `fail("unclosed locale quote")` → 连带外层引号扫描也 fail（`unclosed double quote`）→ `parseOk=false` → `modelCdExemption` 首行 `parseOnce` 失败直接退化 false → cd 豁免失效 → git 写族正则命中 → 拦。

探针实证（修复前 dist）：`grep -vE "^npm|^$"` → parseOk=false（issues: unclosed locale quote @16 / unclosed double quote @9）；同形态单引号 / 无 `$` 版本 parseOk=true。

## 修复设计

**raw-quote 回退**（narrow-fix，command-lexer.ts `scanExpansion` `$"` 分支，+8/-3 行）：

- `$"` 在**外层双引号上下文**（`quoted === "double"`）→ `"` 定是外层闭合（真 locale 引用不会出现在双引号内——`$"` 在双引号内无 locale 语义），`$` 按字面量 lit part 入栈，`"` 留给外层引号扫描消费，不 fail
- 词首 `$"`（`quoted === null`）维持 locale 处理不变——真 locale `$"hello world"`（unknown 且 parseOk=true）、未闭合 `$"abc`（fail）、残缺配对 `$"a"b"c`（fail）行为与修复前完全一致

**取舍**：
- 初版设计用「闭引号后词尾内无更多 `"`」做②形态判据——发现会把词首真 locale `$"hello world"` 也误判为②（闭引号恰在词尾），导致外层扫描从 `hello world"` 起找错引号连锁 fail。收紧为 quoted 上下文判据后歧义消解：双引号内的 `$"` 不可能是 locale 引用，判据零误伤。
- 不做「$ 后单字符是否正则锚定字符」语义判定——词法层不做语义，只修「不该 fail 的 fail」。

### 机制判定四问

- 命中机制识别清单？**否**——不新增机制，是既有 `$"` 分发分支的上下文感知修正（quoted 参数早已传入，本单开始消费）。
- ①谁需要：引号内 `$` 紧邻闭引号的所有正则/锚定形态（grep/sed/awk 高频）。
- ②失败后果：cd 豁免退化误拦（issue 4 连拦实证，含系统熔断中断发言）。
- ③后续机制：无依赖。modelCdExemption/负门/通道链全部下游消费 parseOnce 结果，修复点在词法源头。
- ④退役条件：若词法层引入真 bash 语法解析器（shfmt 级），本启发式退役。

## 验证

- **失败证据链**：修复前探针（对 main dist）`grep "^x$"` / `grep -vE "^npm|^$"` 等 4 形态 FAIL（unclosed locale quote + unclosed double quote 双 fail）。
- **修复后**：同探针全 OK；locale 未闭合/残缺配对维持 FAIL（保守面不破）；`$VAR` 展开不受影响。
- **测试**：词法层 8 用例（修复面 3：issue 复现/锚定行尾/无管道同形态；保守面 3：真 locale 语义保持/locale 未闭合 fail/词首残缺配对 fail；复合形态 1：引号内 `$"` 残余未闭合维持 fail；回归 1：$VAR）+ 守卫端到端 2 用例（cd worktree + git commit + grep `"^npm|^$"` 管道 → 放行；单引号对照组）。全量 5123 绿（342 文件），lint 0，tsc 0。

## Known Limitations

- 引号内 `$"` 后残余未闭合词（`echo "a$"b"`）维持 fail——bash 实际语义是引号拼接，词法层不追嵌套语义；与本修复目标形态（$ 紧邻词尾闭引号）无交集，测试已锁定现状。
- 单引号内 `$"` 不回退——单引号内一切是字面量，无需处理（既有语义）。
