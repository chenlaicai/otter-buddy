---
id: F20260903srfs
title: skill references 引用可见性：实证修正 + 索引绑定 lint 门禁
summary: 实证修正 issue #726 的强命题：references/ 并非「写了等于没写」——全量 935 个历史 session 扫描显示被主动 read 568 次、成功率 100%；真实风险是引用形态差异（工作流内联绑定 vs 参考索引-only，后者读取 ≤3 次或零读取）。修复：① lint-skills 新增校验 9（绝对路径引用 error；无任何工作流绑定的索引-only 引用 error；跨 skill 工作流绑定 warning）；② 7 处索引-only 引用在对应工作流步骤内联绑定；③ golden 回归场景锁定「执行 skill 时读取内联 references」行为。
doc_type: feature
created: 2026-09-03
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
from: []
tags: [skills, lint, visibility, capability-test, adversarial-review]
modules:
  - scripts/lint-skills.mjs
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/otter-summon/SKILL.md
  - .pi/skills/requirement-analysis/SKILL.md
  - .pi/skills/writing-skills/SKILL.md
  - tests/scripts/lint-skills.test.ts
  - tests/capability/golden/skill-references-visibility.golden.ts
capability_test: "tests/capability/golden/skill-references-visibility.golden.ts（golden 3 采样 ≥2；selftest good 过 + 3 bad 全拦）；tests/scripts/lint-skills.test.ts（校验 9 八用例）"
intent:
  problem: "issue #726 声称 references/ 写了等于没写；实证证明真问题是引用形态决定读取概率（纯索引引用零读取），且 _shared/ 裸写法在 SDK 解析指引下必然 ENOENT（941 session 扫描 28 次失败、8/24 后仍持续），lint 与文档均未拦截"
  expected_effect: "① lint 校验 9 拦截绝对路径/裸 _shared 写法/索引-only 引用，新增违规在 commit-time 被拦；② 7 处索引-only 引用内联后 agent 执行 skill 时主动 read（golden 采样验证）；③ _shared/ 裸写法清零，改写为 ../_shared/ 可被正确解析"
  verify_by:
    type: capability_test
    target: "tests/capability/golden/skill-references-visibility.golden.ts + tests/scripts/lint-skills.test.ts"
  effect_window: "1w"
---

# skill references 引用可见性：实证修正 + 索引绑定 lint 门禁

## 背景（issue #726）

外部审视提出 F1：`.pi/skills/*/references/` 下 12 个文件 1026 行关键工作流内容
"实际上不会被 agent 读取"，SKILL.md 以 `详见 references/xxx.md` 引用的内容
LLM 可能从未 read，即"写了等于没写"。issue 自己标注了「F1 需要实证验证」。

## 诊断：机制层 + 行为层双实证

### 机制层（SDK 源码，非臆测）

- skill 发现（`@earendil-works/pi-coding-agent` dist/core/skills.js）：
  系统提示只注入 SKILL.md 的 name + description + **location**；
  `references/` 子目录不出现在系统提示中——**不可见但可读**。
- 系统提示同时注入一行解析指引："When a skill file references a relative path,
  resolve it against the skill directory (parent of SKILL.md)"——读到 SKILL.md
  正文中的相对引用后，agent 有足够信息解析出绝对路径。
- read 工具（dist/core/tools/read.js + path-utils.js）：无路径白名单、无目录限制，
  相对 cwd 解析、绝对路径直接读。
- otter 侧注入（model-runtime-registry.ts buildBeforeAgentStartResult）：只在 SDK
  base 上追加 otter prompt + identity，不裁剪 skill 相关指引。

结论：**不存在加载器拦截**；references/ 相对引用在 SDK 指引下可正确解析；但
`_shared/` 裸写法是**真实的路径解析故障**（agent 按「resolve against the skill
directory」指引解析到从未存在的 `<skill>/_shared/` 路径）——可达性由两个因素决定：
LLM 是否决定 read（引用呈现强度）× 路径写法在 SDK 指引下是否可解析。

### 行为层（全量 session 扫描，941 个文件，2026-07-27 → 2026-09-03；首次实现扫描宇宙只含 references/ 形态，检视发现 2 复跑扩至 _shared/ 形态并证伪「0 失败」，下文数字为修正后合并口径）

配对 toolCall(read, path 含 .pi/skills/*/references/*.md 或 _shared/ 形态) 与 toolResult 成败：

**references/ 目录形态：535+ 次成功、0 次失败**。读取分布由引用形态决定：

| 引用形态 | 文件例 | 读取次数 |
|---|---|---|
| 工作流步骤内联 | review-dimensions.md（步骤 3）、commit-convention.md（步骤 8） | **180 / 101** |
| 跨 skill 工作流内联 | author-response-protocol.md（code-implementation 步骤 10 绑定） | **48** |
| 步骤内联（弱措辞） | coding-principles.md、testing-rules.md、anti-patterns.md | 25-48 |
| 索引-only（自 skill 无绑定） | review-loop.md、collaboration-patterns.md | 12-28（绑定存在期/其他通道） |
| **索引-only（纯列表）** | **skill-types.md、description-examples.md** | **0（零读取）** |

**`_shared/` 裸写法形态（无 ../ 前缀）：28 次失败、全部 ENOENT**（检视独立复跑实证，实现者首次扫描漏计——正则只匹配 references/ 形态）：

- 失败机理：SDK 系统提示指引 agent「resolve against the skill directory」，agent 把 SKILL.md 中的 `_shared/signature-convention.md` 解析为 `<skill>/_shared/signature-convention.md`（从未存在）→ ENOENT；
- 时间分布：2026-08-10 → 09-02 持续发生（root `_shared/` 8/24 落位后仍 13 次），3 个 session 试错后放弃——签名规范实际没读到；
- 关键教训：**内联 ≠ 可达**。worktree-isolation 步骤 4 早已内联该文件，9/02 照样 ENOENT——工作流绑定保证「agent 会去读」，路径写法决定「读不读得到」。

## 方案（最小改动，三件）

1. **lint-skills.mjs 校验 9**（机械门禁，commit-time 拦截新增违规）：
   - E1：SKILL.md 内绝对路径 .md 引用（含 `/…/.pi/skills/…`）→ error
     （agent 在 worktree/沙箱 cwd 下必然解析失败）；
   - E1b：`_shared/` 裸写法（无 `../` 前缀）→ error——agent 按 SDK 指引解析到
     `<skill>/_shared/x`（从未存在）→ ENOENT（检视发现 2，实证 28 次失败）；
     引导改写为 `../_shared/x`（相对 skill 目录解析恰好命中 skills 根）；
   - E2：引用可见性按**解析后绝对路径**归一判定（同文件不同写法
     `references/x.md` vs `<skill>/references/x.md` 认出同一文件）：
     未被任何 skill 的「## 工作流」section 内联 → error；
     仅其他 skill 工作流绑定（跨 skill 绑定）→ warning（实证有效但不理想）。
   - 校验 7 同步共享引用宇宙（含跨 skill 与 `../_shared/` 形态），存在性校验覆盖变宽。
2. **存量 `_shared/` 裸写法改写 + 7 处索引-only 引用内联绑定**（每处一句，最小侵入）：
   `_shared/` 裸写法 10 处改写为 `../_shared/`（code-implementation ×4、
   requirement-analysis ×2、worktree-isolation ×2、writing-skills ×2，含本 PR 首轮
   新引入的 2 处——检视发现 2 指出修复本身埋了新形态）；
   索引-only 内联绑定：adversarial-review（author-response-protocol、review-loop → 步骤 6）、
   code-implementation（_shared/review-protocol → 步骤 10）、
   otter-summon（collaboration-patterns → 步骤 3，并修正漂移的索引注释）、
   requirement-analysis（intent-anchor-guide → 步骤 1、_shared/review-protocol → 步骤 7）、
   writing-skills（skill-types → 步骤 2、description-examples → 步骤 3）。
3. **回归测试两层**：
   - `tests/scripts/lint-skills.test.ts`：校验 9 八用例（索引-only error /
     内联合规 / 跨 skill warning / 路径归一 / 绝对路径 error / **裸 _shared error** /
     **`../_shared/` 归一不误报** / 校验 7 不回归）；
   - `tests/capability/golden/skill-references-visibility.golden.ts`：golden 场景
     锁定行为不变量「执行 writing-skills 工作流时读取步骤内联的 references，
     且无 _shared/ 裸写法伤疤」，selftest 含伤疤复现 bad 轨迹（只读 SKILL.md /
     完全不读 / **裸写法 ENOENT**，检视发现 5）。

## 取舍

- **不合并 references 进 SKILL.md**：issue 待确认项之二。实证显示内联绑定后
  agent 会主动读取，合并会加剧 SKILL.md 超长（adversarial-review 已 291 行，
  W1 警告存量）且丢失按需加载的上下文经济性。
- **不改 SDK 注入格式**（如把 references 列进系统提示）：SDK 是外部依赖
  （@earendil-works/pi-coding-agent），改注入需 fork SDK，成本远超收益；
  引用强度规范化在内容层即可达成同等效果。
- **E2 的 warning 级保留跨 skill 绑定**：author-response-protocol.md 的 48 次
  读取证明跨 skill 绑定有效，判 error 会迫使冗余内联。**但 E2 只保证「会去读」，
  不保证「读得到」——路径可达性另由 E1/E1b 保证**（检视发现 2 的核心洞察）。
- **E1b 选 error 而非 warning**：裸 _shared/ 写法在 SDK 指引下解析结果确定性失败
  （28/28 ENOENT），无灰区；与 E1 同构（「agent 解析后必然读不到」）。
- **不动 issue 中 F2-F5**：F2（审视流程重复）、F3（SKILL.md 超长）、F4
  （companion/core-workflow 边界）、F5（产出表语义）与 F1 可见性正交，
  且 issue 明确优先级 P1(F1) > P2(F2) > P3，避免单 PR 范围膨胀。
- **E2 结构假设**：可见性判定依赖「## 工作流」节名（workflowLineRange 只认
  `^##\s+工作流`），无该节而引用 references 的 skill 会被判索引-only error——
  属引导结构化的隐形契约，已在 lint 头注释中声明（检视发现 4）。

## 验证

- lint：`npm run lint:skills` → OK（0 error；W1/W3 警告均为存量）。
- 单元：`npm test` 2833 passed / 229 files，0 error（新增 8 用例全过）；
  golden selftest 12 passed（新场景判别力：good 过 + 3 bad 全拦，含裸写法伤疤复现）。
- **端到端（真 LLM golden）**：`skill-references-visibility` 3 采样 ≥2 全过
  （483s，首轮；delta 修复后复跑记录见 PR 评论），采样中 skill-types.md /
  description-examples.md **每次均被读取**（修复前零读取）——修复有效性有直接行为证据。
- 诊断数字经检视獭独立复跑交叉验证（941 session：references 形态 535+ 成功 0 失败、
  _shared 裸写法 28 失败全 ENOENT），首版「568/0 失败」的失实陈述已修正。
- lint-intent：本期文档 intent 1/1（检视发现 1 修复后）。
- 最简实现检查：已过。三件套（lint 门禁 + 内容绑定 + 行为回归）各司其职，
  无更简方案能同时覆盖「存量修正」与「增量防回归」。

## Discovered Issues

- （无新增 issue：F2-F5 属 issue #726 自身明列的待办，随 #726 讨论收敛，
  不另开票）
