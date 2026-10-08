---
id: F20261006rgxf
title: lint-prompt-anchors stripTsComments 正则字面量识别修复
summary: 修复 stripTsComments 手写状态机不识别正则字面量的缺陷——含裸引号正则内的引号被当字符串起始，后续真注释不再剥离、注释内锚点被误报注入面（PR #1126 踩坑现场：tool-factory.ts 被迫改用 RegExp 构造器规避）。方案：状态机新增 inRegex 状态 + 除法/正则区分启发式（回溯前一非空白 token：操作数结尾→除法，关键字/运算符/语句位→正则）+ 跨行/EOF 自愈回填原文。抽独立模块 strip-ts-comments.mjs（同 #1089 anchor-hex-detector 先例），17 用例锁定含裸引号正则、正则内斜杠对、除法不误判、真锚点不回归。
capability_test: "tests/scripts/strip-ts-comments.test.ts（纯函数 17 用例：正则内裸引号注释剥离（#1126 现场复刻）/正则内斜杠对不误吞/字符类内斜杠不终止/标识符·闭括号·引号后除法不误判/return 后正则识别/if 语句位（含嵌套括号）/行首正则/跨行自愈回填·区间奇数引号不卡态/EOF 告警/真锚点保留/行号保持）"
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

# F20261006rgxf stripTsComments 正则字面量识别修复

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
| 标识符/数字，且构成关键字（return/typeof/case 等 14 个） | 正则 | `return /re/` |
| 标识符/数字（非关键字） | 除法 | `total / count` |
| `}` 运算符 `(` `[` `{` `,` `;` 行首/文件头 | 正则 | `{} /re/.test()`、`= /re/` |

### 跨行/EOF 自愈回填

`}` 后的 `/` 被判正则（块结束→新语句位置启发式），但 `const o = {}` 后换行接 `/ 2` 的除法跨行写法会被误判——真正则不跨行，扫描遇换行未闭合即回填**区间完整原文**继续扫描。

**回填原文而非重扫**是审视处置的关键修正：首版实现回填斜杠后重扫，但重扫会让误判区间内的裸引号触发字符串态错位、后续状态永久卡死（检视发现①实测：跨行除法误判区间内含奇数引号时，第二行整行被吞/注释不剥离）。回填原文保证区间内锚点仍被下游扫描覆盖（宁误报不漏检），且行号不乱。EOF 未闭合同理回填 + stderr 告警（守卫工具不可静默丢内容，检视发现④）。

### 模块化（同 #1089 先例）

stripTsComments 抽独立模块 `scripts/strip-ts-comments.mjs` + `strip-ts-comments.d.mts`（TS 测试 import 用）——主脚本顶层 `process.exit` 有副作用无法安全 import，纯函数抽出后测试直接 import 断言，不走 execFile 黑盒。

## 验证

### 审视处置（检视獭-1282，1 严重 + 5 建议 + rebase）

- **严重①（自愈重扫致字符串态错位）**：实测复现——改为回填区间完整原文不重扫，根除错位；锁定用例「自愈区间含奇数引号不得卡字符串态」
- **②（if 语句位正则未识别）**：`)` 前回溯平衡括号，`(` 前是控制流关键字（if/while/for/switch/catch/with）→ 正则；含嵌套括号变体用例
- **③（行首语句位正则误判除法）**：行首 `/` 判正则；锁定用例
- **④（EOF 未闭合静默吞剩余源码）**：原文保留 + stderr 告警；锁定用例验证锚点不丢
- **⑤（回溯穿注释取末 token 语义未声明）**：lastNonWhitespace 头注释补声明（含「改动前先跑测试」钩子）
- **⑥（name: 跨行窗口限制出处丢失）**：改为模块头注释声明
- rebase：分支已 rebase 到 origin/main（检视者指出的 CI 红原因：落后 #1280），rebase 后全量复验 + CI 绿

### 修复前失败证据（先固化后修复）

worktree 内构造 #1126 现场复刻 fixture（正则 `/["']/.source` + 行注释含 `F20260921vsds`），git add 后跑 gate：

```
[lint-prompt-anchors] 发现注入面锚点（F 编号/issue 号）：
  src/interface-adapters/agent-runtime/tools/regex-anchor-fixture.ts:7  F20260921vsds
EXIT=1   ← 误报：锚点在 // 注释里，本应被剥离
```

### 修复后验证矩阵

- 同 fixture 重跑 gate：EXIT=0，误报消除
- `tests/scripts/strip-ts-comments.test.ts` 17 用例全绿（12 基础 + 5 审视锁定）：正则内裸引号/正则内斜杠对/字符类内斜杠/标识符后除法/`)`/`]`/引号后除法/关键字后正则/跨行自愈回填/自愈区间奇数引号/if 语句位（含嵌套）/行首正则/EOF 告警/真锚点保留/行号保持
- 全量 `npm run test`：4533 passed（审视处置后）
- gate 实跑：lint:docs OK（3 warnings 存量 ratchet）/ lint:skills OK（13 warnings）/ lint:capability OK（68 warnings 存量）
- 主脚本头部「已知限制」声明同步删除（含正则部分），`name:` 属性跨行窗口限制移至模块头声明（独立缺陷未修）

## 影响范围与残留风险

- 改动：`scripts/lint-prompt-anchors.mjs`（删内联函数改 import + 头注释更新）、新增 `scripts/strip-ts-comments.mjs` + `.d.mts` + `tests/scripts/strip-ts-comments.test.ts`
- 白名单与既有豁免逻辑零改动；hex 色值判别器（#1089）不受影响
- **残留 1**：`name:` 属性关闭状态机跨行窗口（已移至模块头声明，独立缺陷未修）
- **残留 2**：启发式覆盖常见形态，极端形态未覆盖——① 自增后除法、模板字符串内嵌表达式、箭头函数体单表达式位正则；② **误判为除法方向无自愈兜底**（自愈只挂在正则态，glm 终检实证）：`if/while/for` 条件的字符串/正则内若含不平衡括号（如 `if (s.includes("(")) /re/`、`if (/[:(]/.test(s)) /re/`——字符串括号污染已由 matchingOpenParen 免疫修复（含转义奇偶判定与朴素降级）；正则内括号（`/[:(]/`）仍属遗留），语句位正则被误判为除法后，正则体内引号/斜杠对按裸语义扫描，可能吞掉后续行锚点（漏检方向）——当前注入面文件扫描零命中，属埋雷非空雷；误判为正则方向由自愈回填兜底（区间内容不丢、锚点仍被扫描）
