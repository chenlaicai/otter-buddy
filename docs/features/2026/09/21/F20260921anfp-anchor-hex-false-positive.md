---
id: F20260921anfp
title: lint-prompt-anchors hex 色值假阳性修复：紧邻 CSS 语境判别器
summary: 修复 ANCHOR_RE 的 #\d{3,} 把设计词典中的 CSS 色值（#000/#1a1a1a）误判为 issue 锚点、误拦合法 commit 的假阳性——新增紧邻 CSS 语境判别器（语境词+CSS 过渡带≤3 段），F 编号不受影响仍恒拦。判别取向宁漏放不误拦：漏放由白名单兜底，误拦直接阻塞合法提交（现场：visual-design 词典 #000 被拦三道，被迫占 3/10 白名单配额）。
doc_type: feature
change_type: fix
capability_test: "tests/scripts/anchor-hex-false-positive.test.ts（判别器纯函数 6 用例：CSS 语境放行/纯 issue 号拦截/窗口外不误放/同句混排分离判定）"
intent:
  problem: "ANCHOR_RE 的 #\\d{3,} 对 CSS hex 色值假阳性——#000（黑）与 #419（issue 号）结构同形，词典类 skill 文件色值密集，误拦合法 commit 且被迫消耗白名单配额（3/10）"
  expected_effect: "含色值的 skill/词典文件正常提交不再误拦；真 issue 锚点（无 CSS 语境）仍被拦截；F 编号判定不受影响；白名单配额释放"
  verify_by:
    type: behavior_check
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
tags: [lint, false-positive, css, hex-color, toolchain]
modules:
  - scripts/lint-prompt-anchors.mjs
  - scripts/anchor-hex-detector.mjs
causal_links:
  - F20260921vsds
created_at: 2026-09-21
---

# F20260921anfp lint-prompt-anchors hex 色值假阳性修复

## 背景

### 意图锚（搭档原话）

> 「1089是啥」……「那这个要提前合入吧」——搭档明确要求先修 lint 再合 skill PR，释放白名单配额。

### 问题现场（教训三要素）

- **现象**：F20260921vsds 词典提交时，`border: 2px solid #000` 中的色值 `#000` 命中 ANCHOR_RE 的 `#\d{3,}` 分支，被判为 issue 锚点，pre-commit 拦截三道（web/poster/slides 三词典）。
- **后果**：合法 commit 被迫走白名单放行（占 3/10 配额）；后续任何含色值的 skill 文件都会重复遭遇。
- **定位**：ANCHOR_RE（scripts/lint-prompt-anchors.mjs:25）正则层面 #000 与 #419 结构同形——**结构无法区分，只能靠上下文判别**。

## 方案设计

### 判别器：紧邻 CSS 语境（scripts/anchor-hex-detector.mjs）

色值在真实文本中总以 CSS 属性形态紧邻出现：`solid #000`、`1px #000`、`底 #0a0a0a`。判别规则：

- 匹配点前 20 字符内，末尾匹配「CSS 语境词 + CSS 过渡带」形态
- 语境词：solid/shadow/gradient/background/bg/color/border/fill/stroke/中文（色/底/块/线）
- 过渡带（≤3 段）：空白/冒号/等号/逗号，或数值+单位（1px/2%/0.5em）——CSS 标准形态中数值紧邻色值

### 关键取舍：宁漏放不误拦

- **漏放**（真 issue 号恰好带 CSS 前缀，如「border 规则见 #123」）→ 白名单机制兜底（既有通道）
- **误拦**（合法色值被拦）→ 直接阻塞合法 commit，无通道可走
- 大窗口方案（前 24 字符任意位置命中即放行）被测试否决：「solid #000 描边，验收标准见 #1089」的 issue 号也被误放——收窄到紧邻形态后同句混排可分离判定

### 集成方式

判定器抽独立模块（anchor-hex-detector.mjs），lint 脚本 import——单一真相源，测试直接 import 纯函数断言（不走 execFile 黑盒，避免脚本顶层 process.exit 干扰）。

## 验证

- 判别器单测 6 用例全过：CSS 语境放行（solid/中文语境/色块）/纯 issue 号拦截/过渡带窗口外不误放/同句混排分离
- 真实词典回归：visual-design 三个 styles.md + poster anti-patterns 共 4 处色值命中全放行，0 误拦
- lint 全树模式通过（52 注入面文件，白名单回到 2/10——释放 3 条待 skill PR rebase 后删白名单行生效）
- F 编号分支不受判别器影响（无色值同形问题，恒拦）

## 后续动作

本 PR 合入后：visual-design skill PR（#1083）rebase 本分支，删除其白名单 3 条临时条目，配额彻底释放。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| scripts/anchor-hex-detector.mjs | 新增 | 紧邻 CSS 语境判别器（纯函数，可测） |
| scripts/lint-prompt-anchors.mjs | 修改 | hits 过滤接判别器；F 编号不受影响 |
| tests/scripts/anchor-hex-false-positive.test.ts | 新增 | 判别器 6 用例 |
| docs/features/2026/09/21/F20260921anfp-anchor-hex-false-positive.md | 新增 | 本特性文档 |
