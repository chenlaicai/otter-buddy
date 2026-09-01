---
id: F20260901fidc
title: "FID 形态契约单一真相源：commit-parser 旧字母表废弃与三处副本收口（#667）"
summary: |
  Issue #667 核实结论：仓库不存在「特性 ID 生成器」——F/R ID 由开发獭按
  commit-convention.md 的 FYYYYMMDDxxxx 占位符自编，无字母表约束；commit-parser
  自 8/25 起持有的 [a-kmnp-z][2-9a-kmnp-z] 字母表（排除 0/1/l/o）无任何成文约定
  出处，且与 frontmatter-validator 的 [a-z0-9]{3,10} 口径分裂。实测 377 个存量
  后缀中 5 个真实特性 commit（mtbl/o46s/scl1/dpao/evgl，含 l/o/1）被漏判
  no_f_prefix，featureId 提取不出。判定为漂移而非 intended，按 #646 doc-status.ts
  先例收口为 src/entities/document/fid-format.ts 单一真相源，四处消费方统一 import。
change_type: fix
status: development
tags: [health, commit-parser, document, contract, single-source-of-truth]
modules:
  - src/entities/document/fid-format.ts
  - src/entities/document/frontmatter-validator.ts
  - src/usecases/health/commit-parser.ts
  - src/usecases/document/disk-id-scanner.ts
  - .githooks/commit-msg
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
from:
  - F20260825hmvp
  - F20260901dstat
---

# FID 形态契约单一真相源（Issue #667）

> 作者：开发獭-667（glm）
> 日期：2026-09-01
> 触发：issue #667（PR #665 开发獭写测试 fixture 时踩到 F20260901aaa1 不合规）
> 先例：F20260901dstat（#646 doc-status.ts 值域契约，本方案的模式参照）

## 1. 核实结论（issue 疑问 1：生成器字母表）

**仓库不存在特性 ID 生成器。** 实查链路：

- `src/` 全仓无 ID 生成代码（generateId/makeId/nanoid 等命中项均与 FID 无关）
- ID 的实际生成方式：开发獭按 `.pi/skills/code-implementation/references/commit-convention.md` 的 `FYYYYMMDDxxxx` 格式**自编**，`xxxx` 是无字母表约束的占位符
- 入库把关在 `frontmatter-validator.ts:77`：`^F\d{8}[a-z0-9]{3,10}$`——全小写字母数字，**允许 0/1/l/o**

因此「parser 排除 0/1 是否与生成器一致」的答案是：**不一致**。生成侧（LLM 自编 + validator 放行）产出全字母数字后缀，parser 独自排除 0/1/l/o。

**l/o 防混淆「已知约定」查无出处**：commit-parser 的 `[a-kmnp-z]` 字母表随 F20260825hmvp（PR #417，8/25）出生即有，但其特性文档零记载；commit-convention.md、.pi/SYSTEM.md、.githooks 均无此约定。

## 2. 字母表对照表（issue 要求产出）

| 触点 | 旧正则 | 字母表 | 语义 | 收口后 |
|---|---|---|---|---|
| commit-parser.ts:33/59/74（三处） | `[a-kmnp-z][2-9a-kmnp-z]{3,9}` | 排 0/1/l/o，首字符限字母，后缀 4-10 位 | 解析识别 | 统一 `fid-format.ts` |
| .githooks/commit-msg:29 | `d{10} 或 d{8}+旧字母表` | 同上（+纯数字后缀分支，存量零使用） | 提交拦截（执行层） | 同步字母表（人工镜像） |
| frontmatter-validator.ts:77/83 | `[a-z0-9]{3,10}` | 全字母数字，后缀 3-10 位 | 入库校验（真相口径） | 统一 `fid-format.ts` |
| frontmatter-validator.ts:134 | `[a-z0-9]{3,10}` | 同上 | 文件名 slug 校验 | 统一 `fid-format.ts` |
| disk-id-scanner.ts:20 | `[a-z0-9]{3,8}` | 全字母数字，后缀 3-8 位（比契约窄） | 文件名兜底提 ID | 统一 `fid-format.ts` |
| .github/workflows/ci.yml PR 标题检查 | `[a-zA-Z0-9]{4,}` | 全字母数字含大写，≥4 位 | PR 标题拦截（宽松启发） | 不动（见 §5） |
| search-memory.ts:32 | `[a-z0-9]{4,6}` | 全字母数字，后缀 4-6 位 | 短路锚点（宽松启发，越界无副作用） | 不动（见 §5） |
| **fid-format.ts（新）** | `[a-z0-9]{3,10}` | 全字母数字 | **单一真相源** | — |

**判定：漂移而非 intended**（issue 疑问 2）。同一 ID 形态在仓内有四种口径（排 0/1/l/o / {3,10} / {3,8} / CI 宽松含大写），且 parser 侧与 hook 侧口径均造成实际拒绝/漏报。hook 侧是最重的一处：新 commit 带 0/1/l/o 后缀会被直接拒提。

## 3. 漏报实测证据

对 git log 全量 152 个 commit 用旧 parser 实测：**5 个真实特性 commit 被判 `no_f_prefix`**（featureId 提取不出，相关特性从 commit 合规统计中消失）：

| 漏判 ID | 含 | 后缀 |
|---|---|---|
| F20260827mtbl | l | 4 |
| F20260826o46s | o | 4 |
| F20260826scl1 | l, 1 | 4 |
| F20260826dpao | o | 4 |
| F20260825evgl | l | 4 |

这 5 个 ID 全部通过 frontmatter-validator 入库（docs/ 下有对应文档）——即「入库合法、commit 统计漏计」的口径分裂实锤。

另：存量后缀首字符 100% 字母（377 个实查），旧正则「首字符限字母」的事实破坏面为零；但存量大写混排无、3 位后缀 1 个（R20260805im）提示下限应为 3。

## 4. 方案（issue 选项 b：单一真相源常量）

参照 #646 doc-status.ts 先例（值域契约单一真相源），新建 `src/entities/document/fid-format.ts`：

```ts
export const FID_DATE_SEGMENT = "\\d{8}";
export const FID_SUFFIX_SEGMENT = "[a-z0-9]{3,10}";
export const FID_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}`;
export const FID_ANCHOR_REGEX = new RegExp(`^${FID_PATTERN_SOURCE}$`);
export function isValidFid(id: string): boolean;
```

**消费方收口（4 处）**：

1. `commit-parser.ts` 三处正则 → import 段常量拼接（旧字母表废弃，文件头注释记 #667 出处）
2. `frontmatter-validator.ts` validateFeatureId / validateResearchId / validateFilenameSlug → import 段常量
3. `disk-id-scanner.ts` ID_FROM_FILENAME → import 段常量（旧 `{3,8}` 顺带对齐到 `{3,10}`，消掉第三种口径）
4. `.githooks/commit-msg:29` ID 字母表 → 与契约同步为 `[a-z0-9]{3,10}`（保留纯数字后缀分支——存量零使用但保守不删）；hook 是 shell 内嵌 node -e 无法 import ts 源，只能人工镜像，已在两处注释互指（fid-format.ts 背景 + hook 内注释）；错误提示文案同步更新。回归验证：hook-regression-verify.py ALL OK + 含 l/o/1 ID 放行 + 2 位后缀拒绝实测通过

**设计取舍**：段常量（date/suffix 分开导出）而非整串常量——消费方需要 `F`/`R` 前缀变体和不同锚定方式（整串 `^$`、`[...]` 包裹、文件名后接 `-slug.md`），共享的是「日期段+后缀段」这两段，前缀和锚定由消费方按语义定。

## 5. 明确不做

- 不改 ID 生成约定（commit-convention.md 的占位符语义不动——l/o 防混淆若要成文应是另案讨论，本次只收敛「识别侧与校验侧口径」）
- 不动 search-memory.ts:32 的 ANCHOR_PATTERN：它是「从自然语言文本中识别锚点」的宽松启发式（后缀 {4,6} 居中、`(?<!\w)` 防截断），语义是召回而非校验，误伤面与漏报面均无实际危害，收口进严格契约反而会让记忆检索漏召回——异语义不该共用同一常量
- 不动 cost-output-collector.ts:576 的 `/^F(\d{8})/`：那是「从 ID 提日期」的前缀提取，不是完整形态校验
- 不重构 commit-parser 的类型标签白名单（实测另有 28 个 `non_standard_format` 来自 `[Feature]`/`[Enhancement]` 等类型标签不在白名单——与字母表无关的另一维度，未越界处理）

## 6. 测试

新增 `tests/entities/document/fid-format.test.ts`（21 例）：
- 5 个曾漏判的存量真实 ID 合法性回归
- 边界长度（后缀 3 位下界 / 10 位上界 / 存量 6 位真实值）
- 非法形态拒绝（短后缀 / 长后缀 / 小写前缀 / 日期位数 / 非 F/R 前缀 / 大写 / 下划线 / 连字符 / 空串）

扩展 `tests/usecases/health/commit-parser.test.ts`（+3 例）：含 0/1/l/o 的真实 ID 在三段标准格式下可解析且合规。

Hook 回归：`scripts/tmp-verify/hook-regression-verify.py` ALL OK；含 1/l/o 后缀放行、2 位后缀拒绝实测通过（见 §4）。

## 7. 验证

- vitest 全量：206 files / 2574 tests 全绿
- tsc --noEmit：零错误
- eslint：0 error（5 warnings 均在未触碰文件 cost-output-collector.ts / web/src/pages/conversation/index.tsx，路径可证）
- 旧→新 parser 对 git log 152 commit 复跑：5 个 no_f_prefix 漏报全部修复（no_f_prefix 判定清零）；non_standard_format 33→28，剩余均为类型标签白名单问题（见 §5 不做项）
- 最简实现检查：已过——不新建 validator 框架，纯常量 + 一个 is-valid 函数；未引依赖；四处消费方改动均为 import 替换，无逻辑分支变化
- capability_test: n/a（纯确定性正则常量与纯函数，无 LLM 行为变更）

## 8. 关联

- Issue #667（本任务）
- #646 / F20260901dstat：doc-status.ts 值域契约先例（模式参照）
- #636：controller 层复制常量同类模式（issue 引用的教训）
- F20260825hmvp：commit-parser 旧字母表的出生地（PR #417）
