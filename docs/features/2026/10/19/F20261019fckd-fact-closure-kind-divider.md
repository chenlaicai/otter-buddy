---
id: F20261019fckd
title: 事实型闭环分流：matters 表 closure_kind——fact 型 owner 携机器证据可直关 L2，decision 型保留搭档确认闸
summary: 「L2 闭环必须搭档确认」没有区分事实型（PR MERGED 等机器可验证）与判断型（效果/方向验收）闭环，把纯仪式的盖章转嫁给用户（#1457：都做完了为什么还要我来拍板）。matters 表加 closure_kind 列：fact 型 L2 闭环 owner 可直关，但 resolution 必含机器证据（#PR号 / 7-40 位 commit sha / mergedAt 关键词），缺证据照拒；decision 型与存量 null 件闸原样不动（保守视同 decision）。
doc_type: feature
change_type: feature
intent:
  problem: "2026-10-13「验收客观化」事项四块交付全部落地（PR 已合入、机器可验证），待办机制仍走「DONE_PENDING_CONFIRM→CLOSED 必须搭档确认」，要求用户给已完成的事实盖章。宣告权守卫的本意是防獭擅自宣称完成（完成是自我报告），但事实型闭环的完成状态由机器验证（PR MERGED/issue CLOSED），确认是纯仪式——拍板应该在决策前（做不做/合不合入），不该在收尾后（给台账盖章）。"
  why_now: "issue #1457（P1）10-16 立项，10-13 已发生一次实操翻车（机器可验证的交付仍转嫁人肉确认）——台账与记忆没接住，机制层缺显式分流规则。"
  expected_effect: "事实型闭环 0 次人肉确认请求（验收标准①）；判断型事项仍 100% 走搭档确认（防矫枉过正——验收标准②）；事实型自动关单 resolution 必含机器事实锚点，可审计（验收标准③）。"
  verify_by:
    type: capability_test
    note: "tests/usecases/matter/fact-closure.test.ts 19 用例锁死守卫矩阵：fact+证据直关/fact 缺证据拒/decision 拒/null 拒/partner 关 decision+fact 放行/L1 不受影响/补标一步直关/补标缺证据拒/非 owner 拒/roundtrip 持久化/证据三形态判定"
capability_test: "tests/usecases/matter/fact-closure.test.ts"
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
created_at: 2026-10-19
tags: [matter-loop, closure, guard, audit]
modules: [src/entities/matter/, src/usecases/matter/, src/interface-adapters/agent-runtime/tools/, src/frameworks/db/]
causal_links:
  - F20261006mtlp（matters 表/状态机/宣告权守卫的真相源——本特性在其 assertCloseAuthority 上做分流，decision 闸不动）
  - F20261006mlp2（register_matter 工具来源——本特性给它加 closure_kind 可选参数）
  - F20261008mlp3（未闭环扫描——fact 型件不进 WAITING_PARTNER 积压口径，扫描语义不受影响）
related_issues: [1457]
---

# 事实型闭环分流：closure_kind（#1457）

## 目标

1. matters 表加 `closure_kind` 列（`'fact' | 'decision' | NULL`），实体/仓储/DTO/工具全链路贯通
2. 宣告权守卫（`assertCloseAuthority`）分流：
   - **fact 型**（L2）：owner（或 `on_behalf_of=owner`）可直关，**resolution 必含机器证据**——`#PR号`（2-6 位）/ 7-40 位 hex commit sha / `mergedAt`|`mergeCommit` 关键词；缺证据抛 DomainError 并提示补证据
   - **decision 型 / 存量 null**（L2）：保持现行 partner 确认闸**一字不动**（不许弱化）
   - L1 / partner 路径不受影响
3. 补标机制：`register_matter` 登记时可标；`transition_matter` 迁移时可补标（补标 fact + 携证据一步直关合法，closure_kind 列留痕可审计）
4. 工具层三个工具的 params/description/GOTCHA ③同步改口径

## 非目标

1. **面板完整机器证据链 UI**（issue 方案第 2 层「回执/面板交互」——fact 型条目显示可点击证据链而非确认按钮）：改动面在 MattersPanel.tsx 的交互层（ConfirmActions 按钮组按 closureKind 分流 + 证据链渲染），超出本次守卫分流的范围，挂 tech-debt 待后续特性；本次仅打通 DTO 字段（closureKind 已进 MatterDTO，面板侧数据就绪）
2. **话术规范**（issue 方案第 3 层：獭汇报里事实型不再请求确认）——身份提示层改动，不随本 PR，待机制落地后按实际使用反馈调整 prompts
3. 自动判定 closure_kind（登记时由獭判断标注，不做内容启发式分类——防误判把判断型错标成 fact 绕闸）
4. GitHub API 实时校验证据真实性（PR 号存在性/merged 状态不回查——resolution 里的证据可人工点开验证，形式校验 + 审计留痕已满足验收标准③的可审计性）

## 方案

### 实体层（matter.ts）

```ts
export type MatterClosureKind = 'fact' | 'decision';
// Matter 接口加：closureKind: MatterClosureKind | null
```

存量 NULL 保守视同 decision——守卫只对显式 `fact` 放权。

### 守卫分流（transition-matter.ts assertCloseAuthority）

原守卫：`L2 + DONE_PENDING_CONFIRM→CLOSED + identity≠partner` 一律拒。

新守卫（同一函数内分流，矩阵守卫/触发者守卫不动）：

```
L2 闭环 & identity≠partner 时：
  effectiveKind = 本次补标 closureKind ?? 存量 closureKind ?? null
  effectiveKind === 'fact'
    → resolution 含机器证据（hasMachineEvidence）？放行 : 拒（提示补证据）
  否则（decision / null）
    → 拒（错误文案指引：fact 型可携证据直关——本件不是 fact 型或未补标）
```

补标优先于存量值的理由：存量件在闭环瞬间补标 fact 是主用例（登记时漏标，交付物合入后补标直关）；补标 decision 也会收紧（fact 存量件被补标 decision 后直关被拒——审计面以补标为准）。`resolvedBy` 仍记实际执行獭（N1 口径不变）。

### 机器证据判定（hasMachineEvidence）

```ts
/#[0-9]{2,6}\b/.test(text)              // ① PR/issue 号（#1535、#42）
|| /\b[0-9a-f]{7,40}\b/i.test(text)     // ② commit sha（短 7 位～完整 40 位）
```

**mergedAt/mergeCommit 关键词不单独构成证据**（对抗审视收紧）：初版把关键词当第三形态，检视指出「见上文 mergedAt」零锚点散文可直关——与验收标准③「必含机器事实锚点」偏差，采纳收紧为①②两形态（关键词与锚点同现时锤①②已独立成立，纯关键词拒）。

已知宽松边界（接受）：7 位纯数字同时是合法短 sha 形态（`#1234567` 超出 PR 号界但命中 sha 规则——宽松方向重叠无害，证据的可审计性靠人工点开验证兜底）；中文语境无 `\b` 词边界问题（hex 规则对连续 ASCII 串生效）。

### 持久化（schema.ts + sqlite-matter-repository.ts）

- 建表 DDL 加 `closure_kind TEXT`（可空）
- 存量库迁移：`ALTER TABLE matters ADD COLUMN closure_kind TEXT`（同 healing_events introduced_by_pr 幂等模式——列已存在时 SQLite 抛错静默忽略）
- INSERT 带列；UPDATE 用 `closure_kind = COALESCE(?, closure_kind)`（补标才覆盖，未传保留存量——patch 未给值不清空）
- matter-repository.ts 端口 transition patch 类型加 `closureKind`（接口-实现同宽）

### 工具层（matter-tools.ts）

- `register_matter`：`closure_kind` 可选参数（enum fact/decision，非法值不落库按 null——L2 拍板件默认仍走 partner 闸）
- `transition_matter`：`closure_kind` 可选参数（非法值显式报错不静默吞——它影响守卫行为）；GOTCHA ③改为「L2 闭环：decision 型（含未标注存量件）必须搭档确认；fact 型 owner 可直关但 resolution 必带机器证据，缺证据照拒」
- `list_matters`：状态行透出 closureKind（`· fact`）

### DTO 链路

`MatterDTO`（服务端 + web client）加 `closureKind: 'fact' | 'decision' | null`——面板侧数据就绪，UI 分流留后续。

## 验证

- `tests/usecases/matter/fact-closure.test.ts`（21 用例）：fact+证据直关（PR 号/sha/mergedAt+锚点复合三形态各一）/ fact 缺证据拒 / fact 空 resolution 拒 / 纯 mergedAt/mergeCommit 关键词无锚点拒（收紧后新增反例×2）/ decision 拒（含带证据仍拒——证据不豁免判断型）/ 存量 null 拒 / partner 关 decision+fact 放行 / L1 不受影响（null 与 decision 均自关）/ 补标 fact+证据一步直关（列留痕读回验证）/ 补标缺证据拒 / 非 owner 拒（触发者守卫兜底）/ 补标 decision 收紧 fact 存量件 / 非终态迁移补标持久化 / register fact roundtrip / decision+缺省登记 / hasMachineEvidence 两形态+边界（含纯关键词 false、关键词+锚点 true）
- 存量回归：`tests/usecases/matter/`（含 matter-state-machine 46 用例——decision 闸语义原样）、`tests/frameworks/db/matter/`、`tests/interface-adapters/http/matter-controller.test.ts`、`tests/interface-adapters/agent-runtime/tools/`（含 register/yield-registration/sweep 工具）合计 22 文件全绿；web 子包 tsc（MattersPanel.test helper 已同步 closureKind——对抗审视严重 2 修复）
- `npx tsc --noEmit` 全绿；`npm run lint` 全绿；`npm run lint:schema` DDL 同步检查通过

## 影响范围

| 文件 | 改动 |
|---|---|
| src/entities/matter/matter.ts | +MatterClosureKind 类型 +closureKind 字段 |
| src/entities/matter/matter-transitions.ts | DONE_PENDING_CONFIRM→CLOSED note 同步分流口径（矩阵条目本身不动——allowed 仍 owner/partner） |
| src/usecases/matter/transition-matter.ts | assertCloseAuthority 分流 + hasMachineEvidence + patch 补标透传 |
| src/usecases/matter/register-matter.ts | closureKind 可选入参 |
| src/usecases/matter/matter-repository.ts | transition patch 类型 +closureKind |
| src/frameworks/db/schema.ts | DDL +closure_kind + 存量迁移 |
| src/frameworks/db/matter/sqlite-matter-repository.ts | Row/create/transition 三处 |
| src/interface-adapters/agent-runtime/tools/matter-tools.ts | 两工具参数+文案+校验+透传，list 展示 |
| src/interface-adapters/http/dto/matter-dto.ts | DTO +closureKind |
| web/src/api/client.ts | web DTO +closureKind |

## 取舍

### 机制预算四问（Modification-Class: mechanism-addition 自答）

- **① 谁需要它**：owner 獭（交付物已合入/关单的机器可验证事实不再被迫等搭档盖章——干完即可关）；搭档（确认队列只剩真正需要人判断的验收型事项，注意力不再被纯仪式盖章稀释）；审计面（resolution 强制携带可点开验证的机器锚点，关单理由可追溯）。
- **② 失败后果**：可感知——若分流被滥用（判断型错标 fact 绕闸），搭档会在翻案/复盘时发现已关单事项质量不达标（翻案闸 CLOSED→OPEN 不变，损失可逆但信任成本高）；若证据正则过紧，fact 直关被拒退回人肉确认（退化到现状，无新增损失）；CI/测试锁死 decision/null 闸不放开，滥用的最大半径 = 獭诚实标注的前提下 fact 件自身。
- **③ 后续机制创造的新状态**：closure_kind 补标语义（迁移时补标 fact 可一步直关——审计面以补标后为准，补标 decision 同样收紧存量 fact 件）；证据形式校验的边界演进（初版 mergedAt 关键词可单独成立的口子已经对抗审视收紧，后续发现新口子同类处理：收紧从严、放宽须呈搭档）。
- **④ 退役条件**：若后续接入 GitHub API 实时回查（证据真实性机核），closure_kind 分流可简化为「机器验证通过即自动关单」——人工标注字段届时冗余可退役；若事实型闭环实践证明獭标注长期可靠且搭档确认队列持续为空，可评估把 decision 型中交付物客观化的部分也迁入 fact 口径（反向扩容，须新特性呈拍板）。

### 其余取舍

1. **证据形式校验而非真实性回查**——GitHub API 回查需要凭证/网络/限流，且 resolution 的证据人工可点开；形式校验 + 审计留痕满足可审计，真实性问题留给翻案闸（partner CLOSED→OPEN 不变）
2. **补标优先于存量值**——闭环瞬间补标是主用例；反向补标 decision 收紧也成立（防 fact 错标后无法降级）
3. **非法 closure_kind 工具层报错、register 层静默置 null**——transition 的 kind 直接影响守卫结果（吞了会让 fact 直关莫名失败，必须显式）；register 的 kind 只是标注（登记失败比错标代价高，非法值当未标注处理，L2 件默认仍走 partner 闸，安全方向）
4. **存量 NULL 视同 decision**——保守默认，绝不因加列放开存量件的闸
