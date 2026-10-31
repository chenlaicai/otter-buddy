---
id: F20261031mrajd
title: merge_pr 拒绝路径补审计双通道留痕（AUTHORIZATION_REJECTED 事实可回查），判定语义零改动
summary: |
  issue #1440（源自 PR #1437 审视观察项 O1）：merge_pr 的闸门拒绝路径（原话未命中/
  时间闸/短话术闸）此前只落 warn 日志——过期授权尝试等可疑调用无法在对话内查询面回查，
  日志轮转即失证据面。本 PR 把 writeMergeAudit 泛化为 merge 授权事件双通道：拒绝路径
  同步写 linked_resources（AUTHORIZATION_REJECTED + 拒绝码 + 原话截断保头 100 字 + 命中锚点），
  与成功授权同 category=merge-authorization，单 PR 授权全景一次查全。fail-closed 判定
  语义零改动，审计写入失败不阻断主行为。
change_type: fix
capability_test: "n/a: fix 类（审计观测面补齐，不涉能力面）——回归由 tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts 34 条承担（4 处断言反转 + 4 条新增含 S1 长原话 R4）"
created_in_conversation: 12967086-9ce5-4cf8-8343-ce4b0fd31519
created_at: 2026-10-31
causal_links:
  - F20260922pmgd
  - F20260929mpav
---

## 背景

merge_pr 的授权审计此前只有**成功合入**走双通道（linked_resources + warn 日志，
F20260929mpav）；三条拒绝路径——原话未命中（verifyPartnerApproval fail-closed）、
时间闸（#1431：过期授权/解析异常）、短话术闸（#1431：通用短话术无 PR 号）——只落
warn 日志一条通道。PR #1437 首轮审视观察项 O1 指出：**拦截发生时恰是最需要留痕的
时刻**（过期授权尝试含事故重放形态的可疑调用），日志轮转后证据面即失。issue #1440
立案（P2 tech-debt，修复方案在案）。

## 变更内容

### writeMergeAudit 泛化（tool-factory.ts:957-1002）

- 新增 `rejected?: { reasonCode; reasonBrief }` 参数：有值时 content 首 token 为
  `AUTHORIZATION_REJECTED <reasonCode>`，title 为「合入授权拒绝记录」，仍落
  category=merge-authorization——**单 PR 授权全景（成功+拒绝）一次查全**；
- 拒绝码三个：`approval_not_found`（原话未命中/查询 fail-closed/无实义——子形态由
  返回獭的 userMessage 首句区分，审计码统一）、`stale_or_unparseable_approval`
  （时间闸）、`vague_short_approval`（短话术闸）；
- checkApprovalGates 返回值 `string | null` → `ApprovalGateRejection | null`
  （reasonCode + userMessage），判定逻辑与用户文案逐字未动；
- 时间闸/短话术闸拒绝的审计**附命中锚点**（entryId/seq/createdAt/原文截断）——
  过期授权重放形态「原话真实存在但指向别的 PR」，锚点让「过期原话出自哪条」可回查；
- 原话未命中路径无锚点（引用文本本来就没命中任何消息），审计文案显式说明。

### 审视处置（2026-10-31，检视獭-1719 初轮：1 严重 + 3 建议，全采纳）

- **S1（严重）长原话→fact 超 500 硬校验→审计静默丢失**：buildMergeAuditRecord 加
  双层截断——原话保头 100 字+截断计量标注（`…（截断，原 N 字）`），整串 480 封顶
  （AUTHORIZATION_REJECTED token / 拒绝码 / 锚点在模板前部天然保留）；reasonBrief
  60 字截断。新用例 R4（800 字事故重放形态）：审计仍落、content ≤500、截断标注在、
  REJECTED token 保前部、未走 non-fatal 兜底。边界实测（检视獭计算）：修复前
  approval_not_found 形态原话 >315 字 / 闸拒绝形态 >112 字即触发丢失。
- **A1 注释漂移**：「未命中不落审计」契约注释更新为拒绝也落审计；buildMergeAuditRecord
  挪到 writeMergeAudit 函数体之后（docblock 归位，writeMergeAudit 恢复直属 JSDoc）。
- **A2 token 语义倒挂**：`audit=linked_resource_fallthrough` 改 `audit=linked_resource`
  （写成功路径；写失败已有专门 `audit linked_resource failed (non-fatal)` 兜底标记，
  两态可区分）。
- **A3 fallback 失实**：锚点缺失文案中性化——「子形态见拒绝理由：未命中 / 查询
  fail-closed / 无实义」（不再断言「未命中任何搭档消息」，防 fail-closed 形态被
  误读为伪造）。

### 判定语义零改动（fail-closed 不变）

- 三条拒绝路径的判定条件、拒绝文案、执行顺序一律未动；
- 审计写入失败不阻断主行为：拒绝仍是拒绝、合入仍继续（non-fatal 同既有成功路径
  模式，日志兜底 `audit linked_resource failed (non-fatal)` 带 reasonCode）。

## 设计取舍

- **机制识别检查点判定**（issue 驱动未经 RA，动手前完成）：无新机制——不新增拦截、
  不改判定语义、不加配置面，纯给既有拒绝事件补观测通道。机制预算四问不触发（无
  「未来会忘记怎么关」面——审计是 append-only 事实，无开关无状态）。
- **拒绝与成功同 category**（vs 独立 category 如 merge-authorization-rejected）：
  查一个 PR 的授权历史时两类事件一次看全；content 首 token AUTHORIZATION_REJECTED
  已足够聚合过滤，无需靠 category 分裂。
- **approval_not_found 不细分子形态**：verifyPartnerApproval 有三种失败（未命中/
  查询炸/无实义），细分需要改其返回契约——收益（聚合粒度）不抵改动面，子形态由
  userMessage 进 reasonBrief 已可辨。
- **最简实现检查**：已过——泛化既有 writeMergeAudit（加一个可选参数）而非新建
  平行函数；拒绝码复用既有 warn 日志的 token 命名（stale_or_unparseable_approval/
  vague_short_approval 原样），无新概念。

## 验证

### 失败证据（改前基线）

既有 4 处 `expect(linkMock).not.toHaveBeenCalled()` 断言（v1 事故重放 / v3 查询
fail-closed / T1a 过期授权 / T1d 解析异常）——即「拒绝不落审计」是改前的显式行为，
本 PR 有意反转（issue 验证节预告：「既有 T1a/T1d 断言反转为落痕断言，理由写进 PR」）。

### 验收标准（机械断言）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 原话未命中拒绝落审计 | vitest merge-pr-tool v1 | linkMock 调用 1 次，content 含 `AUTHORIZATION_REJECTED approval_not_found` + 被拒原话（截断口径） |
| 长原话不丢审计（S1 修复） | vitest R4 | 800 字输入：审计仍落、content ≤500、截断标注在、REJECTED token 保前部 |
| 过期授权拒绝落审计（含锚点） | vitest T1a | content 含 `stale_or_unparseable_approval` + `ue-443` 锚点 |
| 短话术拒绝落审计 | vitest R1 | content 含 `vague_short_approval` + 锚点 + warn 带 `audit=linked_resource_fallthrough` |
| 审计写失败不阻断拒绝 | vitest R2 | 拒绝结果不变（「过期授权」），non-fatal 日志在 |
| 成功路径不受污染 | vitest R3 | 成功审计无 REJECTED token，title 不带「拒绝」 |
| 判定语义零改动 | vitest 全量 30 条既有 + 全量套件 | 30/30 + 421 文件 5582 passed |

### 负向自查（破坏了什么旧契约）

- 「拒绝不落审计」的既有注释承诺（v1 用例标题原文）被有意反转——设计变更本体，
  断言同步反转且 PR 内声明（issue 预告过）；
- writeMergeAudit 的 warn 日志格式在拒绝路径多 `audit=linked_resource_fallthrough`
  后缀（成功路径格式不变）——依赖日志格式的下游检索若无 token 边界匹配需适配，
  仓内无此消费方（grep 验证）。

## 影响面当场自检

- F20260922pmgd/F20260929mpav 的审计契约描述「只有成功合入走双通道」已被本 PR 扩展
  ——两文档为已合入历史文档不回改，本声明即追加说明；
- merge_pr 工具 description 未改（对外契约「授权原话落审计双通道」语义在拒绝侧
  补齐后更完整，description 原文「授权原话落审计双通道（linked_resources + 日志，
  附命中锚点），伪造留痕可追责」现在对拒绝路径同样成立——无需改写）。
