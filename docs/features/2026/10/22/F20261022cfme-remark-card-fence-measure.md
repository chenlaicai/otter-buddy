---
id: F20261022cfme
title: measureCardFenceBytes 改 remark 解析修围栏嵌套 under-measure（issue #959）
summary: tool-helpers.ts 的 measureCardFenceBytes/countCardFenceBytes 弃正则改 remark（与投影层 message-body-projection.ts 同源解析），修复 html-card 嵌套围栏（开4内嵌3 反引号、反引号开波浪嵌）体积测量提前截断 under-measure 导致的超体积徽标漏报，计数与体积口径统一到 collectCardFenceNodes。
change_type: fix
capability_test: "tests/interface-adapters/tool-helpers.test.ts 新增 4 用例（嵌套开4内嵌3 超体积拒/小体积过、波浪嵌超体积拒、count 同源计数）+ 全量 35 用例绿；若回归到正则测量，嵌套超体积用例红（旧正则只量到内嵌围栏前 11 字节）。回归口径：npx vitest run tests/interface-adapters/tool-helpers.test.ts"
intent:
  problem: "issue #959（PR #958 检视 S1）：measureCardFenceBytes 用正则 /(?:```|~~~)html-card(?!-reply)[^\\n]*\\n([\\s\\S]*?)(?:\\n(?:```|~~~))/g 提取围栏内容，遇嵌套围栏（html-card 开围栏 4 反引号内嵌 3 反引号代码块、或反引号开围栏内嵌 ~~~）时惰性匹配在第一个内嵌围栏处截断——合法嵌套场景体积被低估（under-measure），超 64KB 卡片的超体积徽标漏报。影响低（只影响徽标显示，不绕过后端校验），与投影层解析口径不一致。"
  expected_effect: "嵌套围栏卡片体积被完整测量（remark 与投影层/渲染端逐字节对齐），超 64KB 的嵌套卡被 validateSpeakBody 拦截而非漏报；卡片计数与体积识别同源，不再有正则假阳性/口径分裂。"
  verify_by:
    type: capability_test
    detail: "tests/interface-adapters/tool-helpers.test.ts 新增 4 用例 + 全量 35 用例绿；tsc --noEmit 零错误；eslint 零错误；旧正则对照实测嵌套 case 只量 11 字节（under-measure 实证，修复后量全并拦截）。CI 由 PR checks 验证"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [web, agent, tech-debt, html-card, remark]
modules: [interface-adapters, agent-runtime]
---

# measureCardFenceBytes 改 remark 解析修围栏嵌套 under-measure（issue #959）

## 1. 来源

issue #959（P2 tech-debt，PR #958 对抗审视发现 S1；清账批次关闭标准：改 remark 解析（与投影层对齐）合入，与 #960/#961 同族顺手批）。

## 2. 问题现象

`speak` 工具的体积校验 `measureCardFenceBytes`（`src/interface-adapters/agent-runtime/tools/tool-helpers.ts`）用正则惰性匹配提取 html-card 围栏内容：

```js
/(?:```|~~~)html-card(?!-reply)[^\n]*\n([\s\S]*?)(?:\n(?:```|~~~))/g
```

`[\s\S]*?` 惰性匹配到**第一个** `\n``` ` 或 `\n~~~` 就停。当卡片内含**嵌套围栏**（合法 markdown）时，正则在内嵌围栏处提前截断，体积被低估：

| 场景 | 开围栏 | 内嵌围栏 | 旧正则量到 | remark 量到 | 结论 |
|---|---|---|---|---|---|
| 嵌套开4内嵌3 | ```` | ``` | 11 字节 | 全内容 | under-measure |
| 反引号开波浪嵌 | ``` | ~~~ | 11 字节 | 全内容 | under-measure |
| 同类型内嵌 | ``` | ``` | 提前提前闭合 | 提前闭合 | 一致（CommonMark 同类型围栏不可嵌套，非本 issue 范畴） |

**影响**：低——嵌套围栏场景少见，under-measure 只影响超体积徽标显示（>64KB 卡漏报），不绕过后端校验。

## 3. 根因

- 正则不理解 markdown 围栏语义：无法区分「闭合围栏」与「嵌套开围栏」，也处理不了开/闭围栏长度与字符类型（``` vs ~~~）的合法嵌套。
- 投影层（`src/entities/conversation/message-body-projection.ts:31`）用 remark（micromark）解析，与前端渲染（react-markdown + remarkGfm singleTilde:false）逐字节对齐，天然正确处理合法嵌套围栏。校验侧（正则）与渲染侧（remark）口径分裂，正是 under-measure 的来源。

## 4. 方案设计

### 4.1 机制判定（issue 驱动，动手前完成）

未命中机制识别清单——本次是纯 bug 修复，把 buggy 正则替换为**复用投影层已有的 remark 解析引擎**，不引入新机制（无新表/新协议/新调度/新守卫），无机制预算四问。一行留痕：**未命中机制清单，零新机制引入。**

### 4.2 变更要点

1. **`collectCardFenceNodes(body): Code[]`**（新增）：remark 解析 + walk code 节点，收集 `lang === "html-card" || lang === "html-card-play"`（排除 `html-card-reply`），lang 归一化口径与旧正则 `(?!-reply)` + 含 play 语义一致。
2. **`measureCardFenceBytes`** = `collectCardFenceNodes(body).map(n => utf8Bytes(n.value))`——改 remark，修 under-measure。
3. **`countCardFences`** = `collectCardFenceNodes(body).length`——与 measure 同源，计数与体积识别一致。
4. 解析管线 `parser = () => remark().use(remarkGfm, { singleTilde: false })` 与投影层 `message-body-projection.ts:31` **逐字节对齐**（注释锚定）。

### 4.3 设计取舍

- **为什么连 `countCardFences` 一起改（口径一致性）**：`validateSpeakBody` 先用 count 拦卡数（>2 拒）、后用 measure 拦体积（>64KB 拒），两处识别的「哪些是卡片」必须一致，否则会出现「count 数 3 张拒了、measure 只量 2 张」的混乱。同源 `collectCardFenceNodes` 消除口径分裂，且正则对正文文本里的 ```html-card 字样有假阳性（remark 只认真 code 节点）。
- **为什么本地定义 parser 而非复用投影层导出**：投影层 `collectFenceReplacements` 是内部函数、面向「替换」、lang 范围不含 play；复用需改 export + 扩 lang 范围，改动面更大且跨层（entities → interface-adapters）。本地 parser 注释锚定对齐点，风险最小、职责不外溢。
- **保留 `HTML_CARD_FENCE`（单数正则）**：仅用于 `validateSpeakBody` 的「卡片写在 speak 外」有无判定（`turnAssistantText` 检测），不涉及体积/计数测量，不受围栏嵌套影响。

### 4.4 最简实现检查

已过阶梯：仓库已有实现（复用投影层 remark 管线）→ **零新依赖**（remark/remarkGfm/unist-util-visit/mdast 均为投影层已装已用）→ 一处提取函数 `collectCardFenceNodes` 替代两个正则（删 `HTML_CARD_FENCE_GLOBAL` + measure 内联 fence 正则），代码净减且口径统一。确认已最简。

### 4.5 检视发现处置（PR #1621，检视獭-1621）

0 严重 + 2 建议，均采纳「改了更好」：
- **S1（性能）**：`validateSpeakBody` 内 count/measure 各自全量解析 + tool-factory 入库第三次。处置：`validateSpeakBody` 一次 `collectCardFenceNodes` 派生 count+size，body 侧 presence 复用 `cardCount === 0`——含卡消息校验路径从 2 次解析降到 1 次（入库 `hasCardFences` 因跨调用栈保留）。行为不变。
- **S2（口径分裂）**：「卡片写在 speak 外」检测用 `HTML_CARD_FENCE` 正则，与 count 的 remark 口径分裂（假阳性：散文提及围栏字样误判）。处置：presence 检测改 `hasCardFences`（remark 口径），与计数/体积同源；删 `HTML_CARD_FENCE` 正则，全文件统一 remark。非本 PR 引入的回归（修复前后一致），但口径分裂被显式化后收口。

## 5. 变更文件

| 文件 | 变更 |
|---|---|
| `src/interface-adapters/agent-runtime/tools/tool-helpers.ts` | `measureCardFenceBytes`/`countCardFences` 改用 `collectCardFenceNodes`（remark 解析）；`validateSpeakBody` 一次解析派生 count+size（S1）；「卡片写在 speak 外」检测改 `hasCardFences`（S2）；删 `HTML_CARD_FENCE`/`HTML_CARD_FENCE_GLOBAL`/measure 内联正则，全文件统一 remark |
| `tests/interface-adapters/tool-helpers.test.ts` | 新增 5 用例（嵌套开4内嵌3 超体积拒/小体积过、波浪嵌超体积拒、count 同源计数、S2 presence 反向不误报） |

## 6. 验证（验收标准断言化）

| 场景 | 操作 | 预期结果 | 判定 |
|---|---|---|---|
| 嵌套开4内嵌3 超体积 | `validateSpeakBody`（```` 开 + ``` 内嵌 + 70KB 后缀） | 返回含「超出」「体积限制」 | 机械 PASS |
| 嵌套开4内嵌3 小体积 | `validateSpeakBody`（同结构 + 小后缀） | 返回 null | 机械 PASS |
| 反引号开波浪嵌 超体积 | `validateSpeakBody`（``` 开 + ~~~ 内嵌 + 70KB 后缀） | 返回含「超出」 | 机械 PASS |
| count/measure 同源 | `hasCardFences(嵌套卡)` + 两张嵌套卡 message | true / 返回 null（不超限） | 机械 PASS |
| S2 presence 反向 | body 有卡时 `validateSpeakBody` 不报 speak 外 | 返回 null | 机械 PASS |
| 全量回归 | `npx vitest run tests/interface-adapters/tool-helpers.test.ts` | 36 passed | 机械 PASS |
| 广域回归 | `npx vitest run tests/interface-adapters/` | 585 passed | 机械 PASS |
| 类型 | `npx tsc --noEmit` | 零错误 | 机械 PASS |
| Lint | `npx eslint <改动文件>` | 零错误 | 机械 PASS |
| 修复前对照（bug 实证） | 旧正则量嵌套 case | 仅 11 字节（under-measure）→ 修复前测试红、修复后绿 | 机械 PASS |

- **最简检查**：已过（见 4.4）。
- **旧正则对照**：本地实测旧正则对两种嵌套 case 均只量到 11 字节（`<p>head</p>`），确认 under-measure 真实存在，新测试为有效回归测试（修复前红/修复后绿）。
