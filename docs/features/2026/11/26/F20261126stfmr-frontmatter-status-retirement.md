---
id: F20261126stfmr
title: 特性文档 frontmatter status 字段整体退役
summary: status 与「文档合入即不可变」机制互斥，生命周期语义零消费方；validator 升 error 机械拦截，落库脱离 frontmatter 输入，存量 493 篇批量清理
change_type: refactor
tags: [docs, memory, health]
modules: [memory, docs]
created_at: 2026-11-26
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
intent:
  problem: "frontmatter 的 status 字段与「文档合入即不可变」互斥——状态只能写一次后永久冻结，生命周期无法演进；枚举/校验/落库三层残余会静默造假数据（非法值洗成 draft 落库），且作者写 archived 可让活文档无声排除出 sync 对账"
  expected_effect: "frontmatter 出现 status 字段（无论值）被 validator 以 error 阻断；落库 status 固定 active 与作者输入解耦；存量文档 status 行清零；DB 列唯一有效语义收敛为 archived 系统标记"
  verify_by:
    type: behavior_check
causal_links:
  from: ["F20260902sigm"]
---

# F20261126stfmr 特性文档 frontmatter status 字段整体退役

## 结论（#2050）

frontmatter 的 `status` 字段整体退役。文档合入即不可变（lint-historical-docs 机械拦截，唯一开口 `.doc-fix` 元数据订正），「工作流生命周期状态」（draft → development → implemented）在机制上无法演进——写下的那一刻就永久冻结，不能反映任何后续事实。2026-09-02 #720 已把 docStatus 从健康链判定退役、删除每日推进器，但枚举、校验、落库三层残余仍在，既拦不住误用（coLink 仓 15 篇 100% 违规无一被拦），又会把非法值静默洗成 `draft` 造假数据。

## 设计取舍

### 方向选择：彻底退役（issue 方向 2），否掉「只留 archived」（方向 1）

- **方向 1 的问题**：`archived` 是 sync 在磁盘文档消失时写入 DB 列的系统行为（sync-documents.ts 归档对账），不是作者行为。保留「作者可写 archived」= 保留一个纯负收益开口——作者手滑写 `status: archived` 会让一篇活文档被无声排除出 sync 对账（无告警）
- **方向 2 的规则最简**：frontmatter 出现 status 字段（无论值）→ validator **error 阻断**。机械拦截强于方向 1 的「非 archived 值 warning」，认知税归零（不用判断「该不该填、填什么」——答案永远是「别填」）
- **代价**：主仓 493 篇存量文档需批量订正（.doc-fix 通道，本 PR 第二个 commit）；DB `features.status` 列保留（archived 对账依赖），历史遗留值（locked/draft/implemented）不做数据迁移——它们无消费方，随存量清理后的下一轮 sync 因 fingerprint 含 status 自然收敛为 active

### 机制识别检查点判定（issue 驱动，动手前完成）

清单逐项：新增配置字段/枚举/开关 ✗（删枚举）；新增状态生命周期 ✗（删生命周期）；新增定时任务 ✗；新增信号类型 ✗；新增持久化存储 ✗（DB 列保留不加）；新增决策分支 ✗（validator 收紧既有分支、落库删分支）；新增跨模块调用路径 ✗。**全部未命中**——本次是删除机制+收窄语义，无净新增机制。

修法决策树：**③ 删除机制**（status 生命周期语义、9 值枚举、doc-status.ts 契约）+ **② 收窄管辖**（archived 语义收窄到 DB 列，writer 侧脱离 frontmatter 输入）。commit 声明 `Modification-Class: deletion`。

### 被否替代及理由

- **方向 1（只留 archived）**：见上，纯负收益开口
- **保留现值域等执行者写对**：事实 A（合入即不可变）决定了值永远只能写一次，写对写错不影响任何行为——等不来

## 变更清单

| 位置 | 变更 |
|---|---|
| `src/entities/document/known-values.ts` | 删 KNOWN_FEATURE_STATUSES/KNOWN_RESEARCH_STATUSES 枚举与 isKnownFeatureStatus/isKnownResearchStatus；FeatureStatus/ResearchStatus 类型收敛为 string（DB 列值域=active/archived/历史遗留） |
| `src/entities/document/frontmatter-validator.ts` | validateFeatureStatus/validateResearchStatus（warning 软通道）→ validateStatusRetired（**errors 阻断通道**）：status 字段出现即 error，文案含修复指引 |
| `src/usecases/document/sync-documents.ts` | buildFeatureDocument/buildResearchDocument 不再读 fm.status，落库固定 `active`；archived 仅由 sync 归档逻辑写 DB |
| `src/frameworks/db/document/feature-mapper.ts` `research-mapper.ts` | 读取侧不再归一到 draft，透传 DB 值 |
| `src/entities/document/doc-status.ts` | **删除**（classifyDocStatus 零真实调用点，头注释自称单一真相源实为悬空契约） |
| `src/usecases/health/feature-doc-collector.ts` | DocInfo.status 恒 null（接口保留兼容，健康链自 #720 起零消费）；注释更新 |
| `docs/features/` + `docs/research/` 存量 493 篇 | `.doc-fix` 元数据订正批量删 frontmatter status 行 |

## 影响面与级联（负面向验收）

**本次变更破坏了什么旧契约**：
1. **带 status 的 frontmatter 从「warning 放行」变「error 拒绝」**——存量清理前，sync 与健康链 collector 会跳过这些文档（sync 跳过不 throw、逐文件进 errors；collector 返回 null）。同 PR 原子交付（代码+清理同合入），生产部署无此窗口；PR 分支 alpha 实例若在清理 commit 前部署会看到 493 条 sync errors（无害噪音）
2. **健康链 collector 内部走同一 validator**——带 status 的文档被丢弃会影响 fdoc_count 等指标（同窗口，原子交付后消失）
3. **sync fingerprint 含 status**（sync-documents.ts featureFingerprint）——存量清理后首轮 sync，493 篇因 status 变化（locked→active）触发 update+reindex，DB 值自然收敛，一次性成本

## 验证断言

| 场景 | 操作 | 预期结果 |
|---|---|---|
| validator 拦截 | `npx vitest run tests/entities/document/frontmatter-validator.test.ts` | status 字段退役用例 4 项全 PASS（不写=无 error；写 active/in-progress/archived 均 error） |
| 落库解耦 | `npx vitest run tests/usecases/document/sync-documents.test.ts` | 「#2050 落库固定 active」用例 PASS；「带 status 跳过不入库」用例 PASS |
| 全量回归 | `npm test` | 6959 通过；5 失败为 pre-existing（memory-vec-hygiene 4 + durable-runtime 1，git stash 基线对照复现，见自检记录） |
| 存量清零（issue 断言 2） | `git grep -c "^status:" -- 'docs/features/**/*.md' 'docs/research/**/*.md'` | 输出为空（0 篇） |
| 契约删除（issue 断言 1） | `grep -rn "classifyDocStatus" src tests` | 0 命中 |
| 最简实现检查 | — | 已过：删除净量 ~90 行（枚举+契约文件+测试），新增仅 validator 1 函数与 4 条测试，无新依赖 |

## 非目标

- coLink 仓 15 篇非法值存量：另一仓库，由搭档侧另行处理（本 PR 机制对其生效——validator 是本仓 sync 的，coLink 用自己的 sync）
- DB `features.status` 历史值迁移：无消费方，靠 fingerprint 机制自然收敛，不做专门迁移脚本
- detect-signals.test 等健康链测试中 mock 的 status 值：对象层 mock 不走 validator，测试通过，不在本次范围

## 出处

- issue #2050（2026-11-26，P2 tech-debt）
- 搭档原话（2026-11-26 09:43，对话 colink3）：「特性文档合入的瞬间就不可变了，也代表了肯定是经过了检视、修正的处理的，所以这个status字段就是个错误的」
- 历史脉络：F20260901dstat（契约与推进器建立，#646/#659）→ #720（docStatus 退役、推进器删除）→ 本文档（frontmatter 字段整体退役收官）
