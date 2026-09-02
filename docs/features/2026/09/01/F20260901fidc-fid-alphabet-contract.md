---
id: F20260901fidc
title: "FID 形态契约单一真相源：commit-parser 旧字母表废弃与四处副本收口（#667）"
summary: |
  Issue #667 核实结论：仓库不存在「特性 ID 生成器」——F/R ID 由开发獭按
  commit-convention.md 的 FYYYYMMDDxxxx 占位符自编，无字母表约束；commit-parser
  自 8/25 起持有的 [a-kmnp-z][2-9a-kmnp-z] 字母表（排除 0/1/l/o）无任何成文约定
  出处，且与 frontmatter-validator 的 [a-z0-9]{3,10} 口径分裂。实测 main 147 个
  唯一 ID 中 5 个真实特性 commit（mtbl/o46s/scl1/dpao/evgl，含 l/o/1）被漏判
  no_f_prefix，featureId 提取不出。判定为漂移而非 intended，按 #646 doc-status.ts
  先例收口为 src/entities/document/fid-format.ts 单一真相源，四处消费方统一 import。
  后缀下限经 #670 审视回修收紧为 4（两个消费面实查最短均为 4，初版的 3 位兼容
  依据系幻影 ID），新增真相源锁死元测试防 hook 镜像漂移。
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
| **fid-format.ts（新）** | `[a-z0-9]{4,10}` | 全字母数字，后缀 4-10 位（#670 回修：实查最短 4） | **单一真相源** | — |

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

另：存量后缀首字符 100% 字母（147 个 main 唯一 ID 实查），旧正则「首字符限字母」的事实破坏面为零。

### 后缀下限的实查依据（#670 审视回修时重测，取代初版错误依据）

初版文档曾以「R20260805im（3 位后缀）」作为下限 3 的兼容依据——检视獭-670 指出该 ID 仓内查无实处，大獭独立复核确认（幻影 ID）。回修时全量重测，真实分布如下：

| 统计面 | 口径 | 唯一 ID 数 | 后缀长度分布 | 最短 |
|---|---|---|---|---|
| commit 侧（main） | `git log main` 方括号定界 | 147 | 4×134 / 5×12 / 6×1 | 4 |
| commit 侧（--all） | 含已删分支悬空 commit | 257 | 3×4 / 4×236 / 5×16 / 6×1 | 3（悬空） |
| 文档文件名侧 | docs/features + docs/research | 380 | 2×1 / 4×359 / 5×16 / 6×3 | 4（例外 2） |

两个「短后缀例外」的溯源：
- `git log --all` 的 4 个 3 位 ID（F20260721cap / F20260722ctx / F20260722hq1 / F20260724dsp）均不在任何分支（`git branch -a --contains` 为空），是 7 月下旬已删分支的悬空 commit，不影响 main 历史与文档库
- 文件名侧唯一 2 位 ID F20260729im 系文件名截断个例：其 frontmatter id 与合入 commit（501e9446）均为 **F20260729imlo（4 位，含 l+o）**——这反而是一个「文件名与真相源不一致」的存量漂移实例

结论：**commit 侧与文件名侧的真实最短后缀均为 4 位**，下限 3 无存量支撑；旧 commit-parser 正则下限本就是 4（首字符 1 位 + `{3,9}`），`{4,10}` 既非放宽也非收紧，是对既有事实边界的精确表述。

### 第三个消费面的例外：frontmatter id 侧（CI 实测发现，回修后补测）

上表统计的是 commit 引用与文件名两个消费面；回修提交跑 CI 时 docs lint gate 报错，补测第三个消费面发现：**frontmatter id 侧存在唯一一个 3 位后缀真存量 F20260731mmr**（382 个 frontmatter id 中仅此一个，7/31 多模型路由特性）。

处置：新增 `LEGACY_FID_IDS` 存量豁免清单（validator 入库层白名单，参照 known-values.ts 已知值清单模式）：
- F20260731mmr 的 DB 记录同 id（#637/#657 id 漂移修复的主角，sync-documents.test.ts 有其回归用例）——改文档 id 会触发 ID drift 检测报错，需先 DB 迁移（UPDATE features SET id）+ 文件名/commit 引用同步才能清退豁免，超出本 PR 边界
- 豁免仅作用于入库校验层（frontmatter-validator）；识别侧（commit-parser/hook/disk-id-scanner）不豁免——新 commit 仍强制 4 位+，该存量不再产生新识别需求
- 豁免清单自身被元测试锁死：清单项必须不匹配新契约（否则豁免无意义），避免清单腐化

## 4. 方案（issue 选项 b：单一真相源常量）

参照 #646 doc-status.ts 先例（值域契约单一真相源），新建 `src/entities/document/fid-format.ts`：

```ts
export const FID_DATE_SEGMENT = "\\d{8}";
export const FID_SUFFIX_SEGMENT = "[a-z0-9]{4,10}";
export const FID_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}`;
export const FID_ANCHOR_REGEX = new RegExp(`^${FID_PATTERN_SOURCE}$`);
export function isValidFid(id: string): boolean;
export const LEGACY_FID_IDS: ReadonlySet<string>; // 存量豁免（目前仅 F20260731mmr，见 §3）
```

**消费方收口（4 处）**：

1. `commit-parser.ts` 三处正则 → import 段常量拼接（旧字母表废弃，文件头注释记 #667 出处）
2. `frontmatter-validator.ts` validateFeatureId / validateResearchId / validateFilenameSlug → import 段常量
3. `disk-id-scanner.ts` ID_FROM_FILENAME → import 段常量（旧 `{3,8}` 顺带对齐到 `{4,10}`，消掉第三种口径）
4. `.githooks/commit-msg:29` ID 字母表 → 与契约同步为 `[a-z0-9]{4,10}`（保留纯数字后缀分支——存量零使用但保守不删）；hook 是 shell 内嵌 node -e 无法 import ts 源，只能人工镜像，已在两处注释互指（fid-format.ts 背景 + hook 内注释）；错误提示文案同步更新。回归验证：hook-regression-verify.py ALL OK + 含 l/o/1 ID 放行 + 3 位后缀拒绝实测通过。**镜像漂移防线（#670 回修新增）**：tests/entities/document/fid-format.test.ts 元测试用 fs 读 hook 源码，断言其内联 ID 正则与 FID_SUFFIX_SEGMENT 字符级一致，CI 即校验

**设计取舍**：段常量（date/suffix 分开导出）而非整串常量——消费方需要 `F`/`R` 前缀变体和不同锚定方式（整串 `^$`、`[...]` 包裹、文件名后接 `-slug.md`），共享的是「日期段+后缀段」这两段，前缀和锚定由消费方按语义定。

## 5. 明确不做

- 不改 ID 生成约定（commit-convention.md 的占位符语义不动——l/o 防混淆若要成文应是另案讨论，本次只收敛「识别侧与校验侧口径」）
- 不动 search-memory.ts:32 的 ANCHOR_PATTERN：它是「从自然语言文本中识别锚点」的宽松启发式（后缀 {4,6} 居中、`(?<!\w)` 防截断），语义是召回而非校验，误伤面与漏报面均无实际危害，收口进严格契约反而会让记忆检索漏召回——异语义不该共用同一常量
- 不动 cost-output-collector.ts:576 的 `/^F(\d{8})/`：那是「从 ID 提日期」的前缀提取，不是完整形态校验
- 不重构 commit-parser 的类型标签白名单（实测另有 28 个 `non_standard_format` 来自 `[Feature]`/`[Enhancement]` 等类型标签不在白名单——与字母表无关的另一维度，未越界处理）

## 6. 测试

新增 `tests/entities/document/fid-format.test.ts`（24 例）：
- 5 个曾漏判的存量真实 ID 合法性回归（含 0/1/l/o）
- 边界长度：存量真实 4 位（含 imlo 两个 l/o 同现）/ 6 位真实值 / 10 位上界 / R 前缀
- 非法形态拒绝：3 位与 2 位短后缀（下界 4 的两侧）/ 12 位超上界 / 小写前缀 / 日期位数 / 非 F/R 前缀 / 大写 / 下划线 / 连字符 / 空串
- 真相源锁死元测试 ×3（#670 回修）：fs 读 .githooks/commit-msg 源码，断言 hook 内联 ID 正则与 fid-format.ts 导出段字符级一致 + hook 无旧下限残留 + FID_PATTERN_SOURCE 自洽

扩展 `tests/usecases/health/commit-parser.test.ts`（+3 例）：含 0/1/l/o 的真实 ID 在三段标准格式下可解析且合规。

Hook 回归：`scripts/tmp-verify/hook-regression-verify.py` ALL OK（13 例，#670 回修补齐新字母表边界：imlo/o46s/scl1/纯数字 0123 放行 + 3 位下界拒收 + 10 位上界放行 + 11 位拒收）。

## 7. 验证

- vitest 全量：206 files / 2580 tests 全绿（#670 回修后：fid-format.test.ts 27 例含 3 元测试 + 豁免锁死；frontmatter-validator.test.ts +2；disk-id-scanner / sync-documents 测试数据中 3 位合成 ID 对齐 4 位契约）
- tsc --noEmit：零错误；eslint：0 error（涉及文件全部干净）
- 契约对全量存量的复验（#670 回修后重跑）：
  - git log main 147 个唯一 ID：新契约 {4,10} 下非法为零；旧字母表漏判 5 个全部救回（mtbl/o46s/scl1/dpao/evgl）
  - docs 文件名 380 个唯一 ID：仅 F20260729im 一个非法（截断个例，frontmatter 实为 4 位 imlo；validateFilenameSlug 只校验无 slug 的纯 ID 文件名，disk-id-scanner frontmatter 优先——零实际破坏面）
  - hook 回归：hook-regression-verify.py ALL OK（13 例含新字母表边界）
- 旧→新 parser 对 git log 152 commit 复跑：5 个 no_f_prefix 漏报全部修复；non_standard_format 33→28，剩余均为类型标签白名单问题（见 §5 不做项）
- 最简实现检查：已过——不新建 validator 框架，纯常量 + 一个 is-valid 函数；未引依赖；四处消费方改动均为 import 替换，无逻辑分支变化
- capability_test: n/a（纯确定性正则常量与纯函数，无 LLM 行为变更）

## 7.1 #670 审视回修记录（2026-09-01）

检视獭-670（mimo，异模型）发现 2 严重 + 4 建议，大獭裁决后回修：

| 发现 | 裁决 | 处置 |
|---|---|---|
| 严重 1：初版文档以幻影 ID R20260805im 作为下限 3 依据 | 成立，下限收紧 | `{3,10}`→`{4,10}`（真相源/hook/测试/文档四同步）；§3 重写为实查数据表：main commit 侧最短 4（147 个），--all 的 3 位均在悬空 commit，文件名侧唯一 2 位系截断个例（真实形态 imlo 4 位）。**补充**：回修提交跑 CI 发现 frontmatter id 侧唯一真存量 F20260731mmr（3 位），走 LEGACY_FID_IDS 豁免（见 §3 第三个消费面节），已同步告知大獭追认 |
| 严重 2：tmp-verify 脚本注释仍引旧字母表 | 成立 | 注释更新为新契约口径 |
| 建议 1+2（PR body 计数 21→20；真相源无锁死测试） | 合并处置 | 新增真相源锁死元测试 ×3（fs 读 hook 源码断言字符级一致，CI 即校验）；PR body 计数已修 |
| 建议 3（hook-ts 一致性无 CI 校验） | 合并处置 | 同上元测试覆盖 |
| 建议 4（hook 回归脚本缺新字母表边界 case） | 本 PR 修复 | 补 7 例：imlo/o46s/scl1/纯数字 0123 放行 + 3 位拒收 + 10/11 位边界 |

测试数据修正说明：disk-id-scanner / sync-documents 存量用例中 num/dup/mmr 三个 3 位合成 ID 在 {4,10} 下非法（原为测试自编数据，非真实特性 ID），改为 4 位（num1/dup1/mmr1）并同步注释。

## 8. 关联

- Issue #667（本任务）
- #646 / F20260901dstat：doc-status.ts 值域契约先例（模式参照）
- #636：controller 层复制常量同类模式（issue 引用的教训）
- F20260825hmvp：commit-parser 旧字母表的出生地（PR #417）
