---
id: F20261009hcig
title: 'lint:historical-docs 接入 CI（#1281）：--base 逐 commit 模式补齐执行面缺口'
summary: |
  历史文档不可变门禁（F20260831dgim 机械层）此前只挂 pre-commit，
  git commit --no-verify 可整体绕过（其余 7 个 pre-commit lint gate 全有
  CI 对应）。补齐：脚本新增 --base <ref> 参数模式（无参数时 pre-commit 行为
  零变化），CI fast gates 段接入 --base origin/main。核心语义——同 commit
  配对：.doc-fix 声明与历史文档变更必须同一 commit，CI 逐 commit 迭代校验
  （rev-list --parents base..HEAD，非 merge commit 各自重放 pre-commit 同等
  检查），禁止退化成「range 内存在 .doc-fix 就放行」（新绕过面）。merge
  commit 跳过（实测 PR merge main + squash 对消 .doc-fix 必红）。base 不可
  解析宽松放行，--base 缺参 exit 2。新增 10 用例锁定，既有 35 用例零回归。
change_type: feature
capability_test: tests/lint-historical-docs-cibase.test.ts
related_issues: ["#1281"]
causal_links:
  from:
    - F20260831dgim
    - F20260922dfch
    - F20261001lrbk
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-09
intent:
  problem: "历史文档不可变门禁只挂 pre-commit（.githooks/pre-commit:27），git commit --no-verify 可整体绕过；#1273 五轮审视加固的 rename 通道/位移守恒/血统判定全部只在本地执行面生效，CI 无对应检查（其余 7 个 pre-commit gate 均已接入）"
  expected_effect: "PR 含未配对声明的历史文档篡改 commit 时，CI 的 historical gate 变红（--no-verify 绕过失效）；正常 PR（含分支新建文档迭代、配对的 .doc-fix 元数据订正、merge main）CI 保持绿"
  verify_by:
    type: behavior_check
---

# F20261009hcig lint:historical-docs 接入 CI

## 问题与背景

`scripts/lint-historical-docs.mjs`（F20260831dgim 三层防线的机械层）只挂 `.githooks/pre-commit:27`。对比：其余 7 个 pre-commit lint gate 全部在 `.github/workflows/ci.yml` 有 CI 对应（F20260821kgts 接入的纪律：纪律≠机制，只挂 pre-commit 会被 `--no-verify` 绕过）。后果：`git commit --no-verify` 一次性绕过全部防线——#1273 五轮对抗审视加固的 rename 通道（F20261001lrbk）、闭合标记位移守恒、血统判定，全部只在本地执行面生效。

Issue #1281（终审检视獭-1273 建议 1，2026-10-05）。

## 方案设计

### 执行模式：--base <ref> 参数（无参数 = pre-commit 零变化）

`parseArgs` 解析 `--base <ref>`；无参数时走原 `main()`（staged 区检查），逐字节保持既有行为。有参数时走 `runBaseMode(baseRef)`：

1. `git rev-parse --verify --quiet <ref>^{commit}` 解析 base，失败 → 宽松放行 exit 0（见取舍）
2. `git rev-list --parents base..HEAD` 取 range 内全部 commit（每行 `sha parent1 [parent2...]`）
3. **逐 commit 迭代**：merge commit（≥2 父）跳过；非 merge commit 构造 `commitCtx(sha, parent, baseSha)`，对其 `parent..sha` 的 diff 重放与 pre-commit 完全相同的判定链（findViolations → readDocFixDeclaration → checkFrontmatterScope）
4. 任一 commit 违规 → exit 1（报错定位到具体 commit short sha）；全部通过 → exit 0

### ctx 上下文抽象（两模式语义等价的实现载体）

原有校验函数（findViolations / checkFrontmatterScope / checkRenameScope / readDocFixDeclaration / isAddedOnBranch）把「diff 来源 + 树引用 + log 上界」参数化为 `ctx` 对象：

| 语义角色 | stagedCtx（pre-commit） | commitCtx（--base） |
|---|---|---|
| diff 来源 | `git diff --cached` | `git diff <parent> <sha>` |
| 新版本树（index/commit 角色） | `:file` | `<sha>:file` |
| 旧版本树（HEAD/父角色） | `HEAD:file` | `<parent>:file` |
| log 上界（isAddedOnBranch） | `HEAD` | `<parent>` |
| 基准 base | baseRef()（origin/main 优先） | 传入的 base（sha） |
| .doc-fix 读取 | `:.doc-fix` | `<sha>:.doc-fix` |

**等价性锚点**：pre-commit 运行时 HEAD = 待提交 commit 的父、index = 即将提交的内容——commitCtx 的 parent/sha 恰好对应这两个角色。`git diff --cached` 与 `git diff <parent> <sha>` 在「待提交 commit」语义下是同一 diff（后者还显式 `-M` 保证 rename 检测不依赖环境 config）。

hunksWithinBounds / fmBoundaryShiftConsistent / parseStatusLine 等纯函数不动。

### 同 commit 配对语义（本任务最关键约束）

pre-commit 模式下 .doc-fix 与历史文档变更天然同 commit（同一 staged 区）。CI 若对 range 聚合判定（「range 内存在 .doc-fix 就放行」），则攻击者可：commit1 塞无关 .doc-fix（任意理由，≥10 字符即可），commit2 篡改历史文档——声明与篡改永不同框，配对语义崩塌。逐 commit 迭代使每个触历史文档的 commit 单独面对完整判定链（该 commit 自己的 diff 里须同时含 .doc-fix 且 fm 边界合规），配对语义与 pre-commit 严格一致。

红绿双向锁定用例（tests/lint-historical-docs-cibase.test.ts）：
- 红：无关 commit 塞 .doc-fix + 独立 commit 篡改历史文档 → exit 1
- 绿：.doc-fix 与 frontmatter 订正同 commit → exit 0 放行
- 红变体：同 commit 声明但正文篡改 → exit 1（fm 边界校验在 commit 树上工作）

### isAddedOnBranch 的 range 内自洽

判定「历史」时 base 用传入 ref（CI 模式下不走 origin/main 优先解析）。log 上界传 `<commit>^`（父）——精确重放 pre-commit 时点语义：文件在 `base..<commit>^` 无 Add 且存在于 base = 历史文档。测试锁定：分支新建文档连续多 commit 迭代 → 全程放行。

## 机制识别检查点判定（前置完成）与机制预算四问

**清单判定**（动手前完成）：命中三项——新增配置字段/枚举/开关（--base 参数模式）、新增决策分支（逐 commit 迭代路径）、新增跨模块调用路径（ci.yml→脚本）。→ 修法决策树④ 新增机制，`Modification-Class: mechanism-addition`，四问当场作答：

- **① 谁需要它**：CI 环境（无 staged 区概念的 base-diff 场景）——具体到流程：GitHub Actions 的 `check` job（本 PR 起）、以及未来任何想复用该门禁做 range 审计的脚本/獭。F20260821kgts 确立的纪律（只挂 pre-commit 会被 --no-verify 绕过）在本 gate 上一直未兑现，是存量缺口的补齐而非新增需求。
- **② 失败后果**：不做——`--no-verify` 后历史文档篡改无机械拦截（#1273 五轮加固的 rename/位移守恒/血统判定全部失效，防线只剩 review 肉眼）；做了出错（误报）——合法 PR 被 CI 拦住，开发者被迫加 .doc-fix 假理由或绕过，比现状更糟（F20260922rntc 的教训：误拦会把用户推向声明通道造假）。因此 merge commit 取「跳过」而非「宁拦」（见取舍）。
- **③ 后续机制**：新状态是「CI 模式下的逐 commit 判定」，可出错点：(a) base 解析失败被静默放行——已留 stderr 提示 + 本特性文档记录，未来可加 CI 显式 `git cat-file -e origin/main` 前置断言收紧；(b) main 上未来出现「合法但 squash 对消 .doc-fix」的合入（如 #1375 形态）导致 rebase 工作流红——当前实测不存在（rebase 后该 commit 不在 range 内），若 GitHub 改默认合并策略需回头审 merge commit 处置；(c) fork PR 宽松放行窗口——fork 仓库的 origin/main 是自己的 main，篡改可绕过 CI 门禁，但合入本仓时走本仓 CI（base=本仓 origin/main），窗口不进入主线。
- **④ 退役条件**：项目放弃「历史文档不可变」铁律（frontmatter from/supersedes 追加式演进约定整体废弃）时，本 gate 与 pre-commit 版一并退役；或迁移到统一的 commit-range lint 框架（若未来出现多 gate 共享 base..HEAD 迭代基础设施，--base 模式并入该框架）。

（重对抗门：与本 PR 的对抗审视合并执行——检视獭核验四问答案与治本/治标判断。）

## 设计取舍

| 取舍 | 决策 | 替代方案（否决理由） |
|---|---|---|
| CI 扫描粒度 | 逐 commit 迭代校验 | range 聚合（单次 diff base..HEAD）：**否决**——.doc-fix 配对语义崩塌，「无关 commit 塞声明+独立 commit 篡改」即绕过，新开绕过面 |
| merge commit 处置 | **跳过**（warn 提示，不进判定） | first-parent diff 检查：**实测否决**——本仓 CI up-to-date gate 强制 PR rebase/merge main，main 的 squash 合入会把 .doc-fix 创建/删除对消出净 diff（#1375 两个 R099 实证），「PR merge main」时 merge commit 的 first-parent diff 必然包含 main 来的合法历史文档变更 → 必红，误报面不可接受。**恣意口子定性（审视订正）**：跳过意味着 merge 路径无机械拦截，evil merge 成为与 --no-verify 同等易行的绕过通道（与普通 PR 恰在本 gate 分道——普通 PR 非 merge commit 逐个全量重放被拦，evil merge 放行）；不修的依据是所有廉价 evil-merge 检测器均有不可接受误报面：first-parent/net-diff 会因 .doc-fix 对消误拦合法配对订正，`git merge-tree` 会误报合法手工冲突解决 merge；误报优先级有 F20260922rntc 教训支撑。保护面归 review 层 |
| base ref 不可解析 | 宽松放行 exit 0 + stderr 提示 | fail-closed（exit 1/2）：**否决**——fork PR 的 origin/main 指向 fork 自己、浅克隆等非恶意场景会被误伤；此时 pre-commit 门禁仍在本仓内生效，缺口不会重新打开 |
| --base 缺参数 | exit 2（调用错误立即红） | 宽松放行：**否决**——这是 CI 配置写错（如 --base 拼错），静默放行等于 gate 假装在岗 |
| 退出码语义 | 0 通过（含宽松放行）/ 1 违规 / 2 调用错误 | 沿用原 0/1/2 骨架（原 2=环境异常宽松放行；新 2=调用错误红）。CI 模式下环境异常并入 0（宽松放行），调用错误独占 2——语义更精确且 pre-commit 路径零变化 |
| commitCtx nameStatus 显式 -M | 是 | 依赖环境默认：**否决**——CI 环境 config 干净，diff.renames 未来默认值变化会使 rename 检测漂移；stagedCtx 保持原命令零回归 |
| ci.yml 接入位置 | fast lint gates 段（build 前） | build 后：**否决**——本脚本只调 git + Node 内置，零构建依赖，早反馈 |

## 变更清单

- `scripts/lint-historical-docs.mjs`：
  - `parseArgs`（新）：--base 参数解析，缺参数 exit 2
  - `stagedCtx` / `commitCtx`（新）：变更集上下文抽象，校验链全部 ctx 参数化
  - `isAddedOnBranch` 增 `head` 参数（默认 HEAD，零回归）
  - `findViolations` / `checkFrontmatterScope` / `checkRenameScope` / `readDocFixDeclaration` 增 `ctx` 参数（默认 stagedCtx()，零回归）
  - `runBaseMode`（新）：--base 模式驱动——rev-list --parents 逐 commit、merge 跳过、逐 commit 判定链
  - 执行入口：--base 优先路由 runBaseMode，否则 main()
- `.github/workflows/ci.yml`：check job 的 fast gates 后新增独立 step `Run historical docs immutability gate (per-commit, base-diff mode)` → `node scripts/lint-historical-docs.mjs --base origin/main`
- `tests/lint-historical-docs-cibase.test.ts`（新，10 用例）

## 验证

- 新套件 `npx vitest run tests/lint-historical-docs-cibase.test.ts`：**10/10 绿**（同 commit 配对红/绿双向、同 commit 声明+正文篡改拒、分支新建迭代放行、配对后删 .doc-fix 放行、base 不可解析宽松放行、--base 缺参 exit 2、正常 merge 放行、merge 携带篡改跳过、多 commit 粒度佐证）
- 零回归：既有三套件 `npx vitest run tests/lint-historical-docs*.test.ts` **35/35 绿**（pre-commit 模式行为锁定）
- 真实仓库冒烟（临时分支，测后即删）：
  - main HEAD（e351f3c5）跑 `--base origin/main`：exit 0（main 自身干净）
  - 造真实篡改 commit（--no-verify 等价）→ `--base origin/main`：**exit 1，精确定位 commit short sha + 文件**
  - 「PR 分支 merge main（携带 #1375 squash）+ 特性提交」真实形态：**exit 0**（merge commit 跳过、特性 commit 全量校验通过）——该冒烟同时是 merge 处置取舍的实证依据
- lint gates：`node scripts/lint-tests.mjs` OK；`npx eslint` 两个改动文件 OK；`node --check` OK
- CI 三闸门（含新 historical gate 自身）：PR 推送后 CI run 绿（PR 链接见 issue #1281）
- **最简实现检查**：已过——未新增依赖/文件级基础设施，ctx 是 9 行对象字面量 × 2，runBaseMode 复用全部既有判定函数；替代方案「独立 CI 脚本复制判定逻辑」会引入双真相源，否决

## 已知边界

1. **fork PR 宽松窗口**：fork 仓库内 origin/main 指向 fork 自己的 main，--base 解析成功但基准是 fork 的——fork 内篡改不触发。合入本仓时走本仓 CI（actions/checkout 拉的是本仓 + PR head），窗口不进入主线。
2. **merge commit 不检查（已知恣意口子）**：evil merge（merge commit 手工塞内容）不被本 gate 拦截——实测取舍，保护面归 review 层。恣意口子定性（审视订正）：这是与 `--no-verify` 同等易行的绕过通道（本 PR 封了后者的 PR 路径，前者保持敞开）；不修的依据是廉价检测器误报面不可接受（见取舍表）。pre-commit 同样不拦 merge commit 的第二父内容（pre-commit 只看 staged 区，merge --no-ff 提交时 staged 含冲突解决结果，但正常流程下该内容来自两侧分支各自的已检 commit）。
3. **main 上 squash 对消 .doc-fix 的 commit 不再可见配对**：如 #1375 的 e351f3c5——它已在本仓 main 上（本 gate 的 base），不在任何 PR 的 range 内，不构成拦截对象；但「PR 分支 merge main」时它会进入 merge commit 的 first-parent diff——这正是 merge commit 跳过的直接原因（否则必红）。
4. **rebase 工作流不受 3 影响**：rebase 后 main 的 squash commit 不在新 range 内（up-to-date gate 要求 rebase or merge，两种形态都已实测/推演覆盖——merge 形态冒烟 exit 0）。

## 后续动作

- PR 推送后 watch CI 三闸门（historical gate 自身跑绿 = 接入验证）
- 交回大獭编排对抗审视（含重对抗门三问：本机制在演化史上治本/治标）
