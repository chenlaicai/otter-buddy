---
id: F20261102docfx
title: lint-historical-docs amend 抹除 .doc-fix 场景的缺口核查与行为锁定（issue #1164）
summary: |
  issue #1164（2026-09-24 立项，PR #1162 实证）：配对 .doc-fix 声明 commit 经
  git rm .doc-fix && git commit --amend 可抹除声明、绕过「理由强制留痕」，issue
  给出三条修法。现状核查（2026-11-02 三组探针实证）：修法 1（CI range 检查）已被
  #1384（F20261009hcig --base 逐 commit 重放）以更强形态覆盖——amend 抹除产物
  commit 在 CI 模式实测 exit 1；修法 2（本地 staged 混合形态拒绝）已被现有
  fail-closed 满足——staged={M 历史文档, D .doc-fix} 实测 exit 1（声明读取失败
  →通道不开）；修法 3 的两路径断言此前无对应用例。本次交付：零生产代码变更，
  补 2 个行为锁定用例进既有 lint 测试族（cibase 套件 amend 重放红例 = issue
  关闭标准指定的验证断言；主套件同 staged 混合形态 fail-closed 锁定），
  既有 28 用例零回归。
change_type: fix
capability_test: "n/a: 纯 lint 行为锁定测试，无 LLM 参与路径（被锁定对象是 git 工作流门禁脚本）"
intent:
  problem: "issue #1164 指出 amend 抹除 .doc-fix 声明可绕过「理由强制留痕」防线。#1384 落地 per-commit CI 重放后该路径实质已被拦（实测），但案发路径（amend 抹除声明后 range 含无声明的历史文档变更 commit）无回归锁定用例——防线依赖隐式覆盖，未来重构 lint 判定链时可能无声退洞而无测试报警"
  expected_effect: "amend 抹除场景（git rm .doc-fix && git commit --amend 后跑 --base 模式）稳定 exit 1 且报配对语义错误；本地同 staged 混合形态（M 历史文档 + D .doc-fix）稳定 exit 1 fail-closed——两断言进 tests/lint 既有套件，任何人改动判定链破坏此覆盖时测试变红"
  verify_by:
    type: behavior_check
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-02
related_issues: ["#1164"]
causal_links:
  from:
    - F20261009hcig
    - F20260922dfch
tags: [tests, lint, lint-historical-docs, doc-fix, security, tech-debt]
modules: [tests]
---

# lint-historical-docs amend 抹除 .doc-fix 场景的缺口核查与行为锁定（#1164）

## 1. 来源与案发现场

issue #1164（P2 tech-debt，2026-09-24 立，发现来源：PR #1162 对抗审视建议发现 3）：
`.doc-fix` 声明 staged 进 commit 18182a68 后，`git rm .commit-msg-vbsu.txt .doc-fix && git commit --amend --no-edit` 把声明从 commit 中抹除（reflog 可回溯 18182a68 → a8642089）。结果：lint-historical-docs 承诺的「声明文件随 commit 历史与 PR commits 可见」在 PR 可见面落空，当时无任何环节拦截。

issue 给出三条修法：①CI 端补 commit-range 检查；②本地 pre-commit 补同 commit 约束；③测试补两路径用例。**issue 立项（09-24）早于 #1384 落地（10-09）**——修法的时效性需要核查而非照单实现。

## 2. 现状核查（动手前实证，非推断）

三组探针（临时 git 仓库，脚本同测试 fixture 形态，2026-11-02 跑）：

| # | 场景 | 执行面 | 实测 | 结论 |
|---|------|--------|------|------|
| P0 | 配对声明 commit → `git rm .doc-fix` → `git commit --amend --no-edit` → 对终态跑 `--base origin/main` | CI per-commit 重放 | **exit 1**，报「本 commit 未携带配对的 .doc-fix 声明——声明必须与历史文档变更在同一个 commit 内」 | **修法 1 的目标已达成**（amend 抹除产物对逐 commit 重放而言与「未配对声明的篡改 commit」同形，配对语义天然拦截） |
| P1 | amend 时点 staged={D .doc-fix, D 临时文件}（无历史文档变更）→ 主模式（pre-commit 语义） | 本地 staged 区 | **exit 0** | 本地面确实无感知——但见 §3.2 不可区分性论证：这不是可修的洞 |
| P4 | staged={M 历史文档, D .doc-fix} 同 commit 混合（修法 2 字面规则）→ 主模式 | 本地 staged 区 | **exit 1**，hint「.doc-fix 已在变更集中但读取失败」 | **修法 2 的字面规则已被现有 fail-closed 满足**（readDocFixDeclaration 读 index `:.doc-fix` 失败 → 声明通道不开 → 历史文档修改按无声明拦） |

真正的缺口只剩一个：**以上拦截行为没有任何测试锁定**——修法 3 指定的两路径断言（「amend 抹除声明 → range 检查报错」「独立删除 commit → 通过」）中，前者无用例；后者 cibase 套件已有（「历史文档修改 + 同 commit 配对声明 + 后续 commit 删 .doc-fix → 全 range 放行」）。

## 3. 修法裁定（为何零生产代码）

### 3.1 修法 1 不再实现：已被更强形态覆盖，照做反而引入绕过面

issue 设想的「比对 range 全量 diff + range 内存在曾含 .doc-fix 的 commit 即放行」是 **range 聚合判定**——这正是 #1281/#1384（F20261009hcig）明确否决并论证过的退化形态：「无关 commit 塞声明 + 独立 commit 改历史文档 = 新绕过面」（cibase 套件核心红例锁定的就是这个攻击形态）。per-commit 重放（每个触历史文档的 commit 自己的 diff 里须同时含 .doc-fix 且边界合规）严格强于 range 聚合。在 #1384 已落地的今天回头实现 range 聚合不是补防线而是拆防线。

### 3.2 修法 2 不实施字面规则外的扩展：不可区分性论证

issue 修法 2 原文「staged 区含 .doc-fix 删除且同 staged 含已合入文档变更时拒绝」——P4 实测现状已 exit 1 满足。若把规则扩展为「staged 含 .doc-fix 删除即拒绝」（不论有无文档变更）以拦 amend 时点（P1 的 staged 形态），则必然误伤合法工作流：

- 本机制自己的提示文案要求「提交后由使用者删除 .doc-fix（git rm .doc-fix）」——独立删除 commit 的 staged 恰好只有 D .doc-fix，与 amend 抹除时点的 staged **完全同形**（P1：{D .doc-fix, D 临时文件} vs 合法删除：{D .doc-fix}）。
- pre-commit 结构上无法区分「这是 amend 还是新 commit」——hook 看不到 `git commit` 的调用参数，只看得到 staged 区终态。
- cibase 套件已有绿例锁定「后续 commit 删 .doc-fix → 全 range 放行」——扩展规则会让该合法路径本地必红。

amend 抹除路径的**真正拦截面在 CI per-commit 重放**：无论本地怎么过，push 后终态 commit（含历史文档变更、无配对声明）在 `--base` 模式下必拦（P0 实证）。本地门的职责边界是「不成为静默通道」——现状 fail-closed（P4）已保证。**这不是给「不想修」找理由，是两道门各司其职：本地门拦同框混合形态，CI 门拦终态历史重写。**

### 3.3 交付形态：行为锁定测试（修法 3 + 关闭标准）

清账獭 2026-09-29 给 issue 定的关闭标准：「CI 端补 commit-range 检查……合入 + 验证断言（补）：构造 amend 抹除场景 CI 拦截测试」。前半句 #1384 已达成（更强形态），后半句正是本次交付。

| 用例 | 套件 | 断言 |
|------|------|------|
| `#1164 amend 抹除重放（#1162 案发路径）：配对声明 commit 经 git rm .doc-fix + --amend 抹除声明 → CI 必拦` | tests/lint-historical-docs-cibase.test.ts（--base 模式族） | exit 1 + stderr 含 OLD_DOC + 匹配「同一个 commit」（配对语义报错） |
| `#1164 同 staged 混合形态：历史文档 M + .doc-fix D → 拦截（fail-closed，不经声明通道）` | tests/lint-historical-docs.test.ts（pre-commit 模式族） | exit 1 + stderr 含 OLD_DOC + 匹配「读取失败\|无 .doc-fix 声明文件」（拒绝且不在声明放行通道） |

两用例覆盖 issue 修法 3 的红路径；绿路径（独立删除 commit 放行）既有用例已锁定，不重复。

## 4. 机制识别检查点判定（动手前完成）

清单逐项：新增配置字段/枚举/开关 ✗ / 新增状态生命周期 ✗ / 新增定时任务 ✗ / 新增信号类型 ✗ / 新增持久化 ✗ / 新增决策分支 ✗ / 新增跨模块调用路径 ✗——**全部未命中**（零生产代码变更，纯测试文件追加）。默认修法决策树①（narrow-fix 语义：防线的既有行为缺锁定，补齐锁定）。 Modification-Class: narrow-fix（见 commit message）。

## 5. 变更清单

- `tests/lint-historical-docs-cibase.test.ts`：+1 用例（amend 抹除重放红例）+ 头注第 7 条
- `tests/lint-historical-docs.test.ts`：+1 用例（同 staged 混合形态 fail-closed 锁定）
- `docs/features/2026/11/02/F20261102docfx-*.md`：本文档

零生产代码变更（scripts/lint-historical-docs.mjs 与 .github/workflows/ci.yml 均未触碰）。

## 6. 验证

- 新用例 + 既有用例：`npx vitest run tests/lint-historical-docs-cibase.test.ts tests/lint-historical-docs.test.ts` → **30/30 通过**（28 既有零回归 + 2 新增）
- lint 测试族全套：`npx vitest run tests/lint/` → **78/78 通过**
- `npm run lint:docs` → 950 docs OK，警告数不变（存量 2，未新增——change_type 用合法枚举 fix）
- `npm run lint:intent` → 0 error
- **最简实现检查**：已过——零生产代码 + 2 用例为达成「amend 路径有回归报警」的最简形态；阶梯验证：仓库已有实现（#1384 per-commit 门）→ 复用其行为仅补锁定；无需新依赖/新脚本/新 fixture 体系（两用例复用既有套件的 freshRepo/commitFiles/git helper）。
- **Golden Gate: n/a**（非软代码改动——纯测试文件，不触 prompt/skill/协议层；无场景可跑）
- **锚点重放评审: n/a**（不触 prompt/skill/tool description 行为语义——豁免判据：改动不影响獭「什么时候做什么」的判断）

## 7. 残余风险与边界

- **merge commit / evil merge 路径不在本 PR 覆盖**：#1384 的既有取舍（merge commit 跳过，归 review 层），与 amend 路径正交，本 PR 不动。
- **reflog 可回溯不构成拦截**：amend 抹除后本地 reflog 仍见原 commit——审计可追溯性依赖 reflog 是既知边界（reflog 会过期、不随 PR 可见），本防线的设计锚点是「PR commits 可见性」，per-commit 重放已兑现。
- worktree 登记的产物 groupId 为 `F20261102docfix`（登记时预编）与最终规范 ID `F20261102docfx`（ID 规范=日期+5 小写字母）不一致——产物分组无碍，以本文档 frontmatter id 为准。
