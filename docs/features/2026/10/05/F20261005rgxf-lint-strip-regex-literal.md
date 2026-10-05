---
id: F20261005rgxf
title: lint-prompt-anchors stripTsComments 正则字面量识别修复
summary: 修复 stripTsComments 手写状态机不识别正则字面量的缺陷——含裸引号正则内的引号被当字符串起始，后续真注释不再剥离、注释内锚点被误报注入面（PR #1126 踩坑现场：tool-factory.ts 被迫改用 RegExp 构造器规避）。方案：状态机新增 inRegex 状态 + 除法/正则区分启发式（回溯前一非空白 token：操作数结尾→除法，关键字/运算符→正则）+ 跨行自愈回退。抽独立模块 strip-ts-comments.mjs（同 #1089 anchor-hex-detector 先例），12 用例锁定含裸引号正则、正则内斜杠对、除法不误判、真锚点不回归。
capability_test: "tests/scripts/strip-ts-comments.test.ts（纯函数 12 用例：正则内裸引号注释剥离（#1126 现场复刻）/正则内斜杠对不误吞/字符类内斜杠不终止/标识符·闭括号·引号后除法不误判/return 后正则识别/跨行自愈/真锚点保留/行号保持）"
doc_type: feature
change_type: fix
intent:
  problem: "stripTsComments 不解析正则字面量——正则内裸引号被当字符串起始，后续注释不剥离致误报注入面；正则内斜杠对被当注释起始致误吞漏检。开发者被迫改写法绕工具缺陷（tool-factory.ts:402 注释为证）"
  expected_effect: "含正则字面量（含裸引号）的工具文件正常提交不再误拦；真锚点（description 字符串内 F 编号/issue 号）仍拦截；除法运算不受影响；lint:docs/lint:skills/lint:capability gates 不受影响"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [lint, false-positive, regex-literal, toolchain, ci]
modules:
  - scripts/lint-prompt-anchors.mjs
  - scripts/strip-ts-comments.mjs
causal_links:
  - F20260917pagd
  - F20260921anfp
  - PR1126
created_at: 2026-10-05
---

# F20261005rgxf stripTsComments 正则字面量识别修复

## 背景

### 问题现场（issue #1128，教训三要素）

- **现象**：PR #1126 在 tool-factory.ts 写 `WAIT_UNTIL_FORBIDDEN` 正则字面量（含裸引号）时，pre-commit lint 误拦——stripTsComments 把 `/["']/` 内的 `'` 当字符串起始，状态机进入字符串态，后续真注释不再剥离，注释里的锚点被误报注入面。
- **后果**：开发者被迫改用 `new RegExp()` 构造器规避（tool-factory.ts:402 注释自证「用 RegExp 构造避免字符类内裸引号——lint 的 stripTsComments 不解析正则字面量」）——写法被工具缺陷扭曲，后续加正则的开发者会重复踩坑。
- **定位**：scripts/lint-prompt-anchors.mjs（修复前 :115）手写状态机只有 code/字符串/行注释/块注释四态，缺正则态。另有对偶缺陷：正则内 `//`（如 `/\d\//`）被当注释起始 → 误吞后续内容 → **漏检**（原头部注释「已知限制」已声明）。

### 修法判定

机制识别检查点逐项核对：不新增配置/状态生命周期/定时任务/信号/持久化/跨模块调用——`inRegex` 是纯运行时解析分支 → 修法决策树①既有机制语义内修（缺啥补啥）。AST 方案（issue 原文建议之一）被否：typescript API 引入重依赖只为一处剥注释，过度工程；手写状态机补正则态 + 启发式足够，且有 12 用例 + gate 全绿锁定。

## 方案设计

### 状态机扩展：inRegex 状态

在既有 code/字符串/行注释/块注释四态上加第五态。code 态遇 `/` 且启发式判为正则起始时进入：内容原样保留（锚点扫描仍覆盖正则体内具体编号——正则本体不是注释），字符类 `[..]` 内 `/` 不终止，遇未转义 `/`（且不在字符类内）闭合。

### 除法/正则区分启发式（核心难点）

JS 中正则字面量只能出现在**表达式位置**，除法只能出现在**操作数之后**。区分靠回溯前一个非空白 token：

| 前一非空白字符 | 判定 | 例 |
|---|---|---|
| `)` `]` 闭引号 | 除法 | `(p+q)/2`、`arr[0]/2`、`"10"/2` |
| 标识符/数字，且构成关键字（return/typeof/case 等 15 个） | 正则 | `return /re/` |
| 标识符/数字（非关键字） | 除法 | `total / count` |
| `}` 运算符 `(` `[` `{` `,` `;` 行首/文件头 | 正则 | `{} /re/.test()`、`= /re/` |

### 跨行自愈回退

`}` 后的 `/` 被判正则（块结束→新语句位置启发式），但 `const o = {}\n/ 2` 实为除法跨行写法——真正则不跨行，扫描遇 `\n` 未闭合即回退：把 `/` 当普通字符重扫，行内后续内容正常识别。误判只损失精度（该 `/` 当除法处理后重新进入 code 态），不产生状态错乱。

### 模块化（同 #1089 先例）

stripTsComments 抽独立模块 `scripts/strip-ts-comments.mjs` + `strip-ts-comments.d.mts`（TS 测试 import 用）——主脚本顶层 `process.exit` 有副作用无法安全 import，纯函数抽出后测试直接 import 断言，不走 execFile 黑盒。

## 验证

### 修复前失败证据（先固化后修复）

worktree 内构造 #1126 现场复刻 fixture（正则 `/["']/.source` + 行注释含 `F20260921vsds`），git add 后跑 gate：

```
[lint-prompt-anchors] 发现注入面锚点（F 编号/issue 号）：
  src/interface-adapters/agent-runtime/tools/regex-anchor-fixture.ts:7  F20260921vsds
EXIT=1   ← 误报：锚点在 // 注释里，本应被剥离
```

### 修复后验证矩阵

- 同 fixture 重跑 gate：EXIT=0，误报消除
- `tests/scripts/strip-ts-comments.test.ts` 12 用例全绿：正则内裸引号/正则内 `//`/正则内 `/*`/字符类内 `/`/标识符后除法/`)`/`]`/引号后除法/关键字后正则/跨行自愈/真锚点保留/行号保持
- 全量 `npm run test`：4528 passed
- gate 实跑：lint:docs OK（3 warnings 存量 ratchet）/ lint:skills OK（13 warnings）/ lint:capability OK（68 warnings 存量）
- 主脚本头部「已知限制」声明同步删除（含正则部分），`name:` 属性跨行窗口限制保留（另一独立缺陷，未修）

## 影响范围与残留风险

- 改动：`scripts/lint-prompt-anchors.mjs`（删内联函数改 import + 头注释更新）、新增 `scripts/strip-ts-comments.mjs` + `.d.mts` + `tests/scripts/strip-ts-comments.test.ts`
- 白名单与既有豁免逻辑零改动；hex 色值判别器（#1089）不受影响
- **残留 1**：`name:` 属性关闭状态机跨行窗口（原已知限制声明保留，独立缺陷未修）
- **残留 2**：启发式覆盖常见形态，极端形态（如 `a++ /2/ b` 的 ++ 后正则、模板字符串内嵌表达式）未覆盖——当前注入面文件无一命中，测试固化的是回归保护而非全语言覆盖
