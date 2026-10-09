---
id: F20261009hefs
title: manage_healing_events 对不存在 eventIds 假成功修复：changes=0 fail-closed
summary: repo 层 resolve/updateStatus 对不存在 ID（UPDATE changes=0）抛错，工具层回执从假成功转为 isError + 失败 ID 清单——「消费即处置」闭环的回执可信度恢复机械保证
change_type: fix
capability_test: "n/a: DB 回执语义修复，验证走单测（healing-resolve-fake-success 三态 + repo 层防护），无独立 LLM 能力面"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-09
tags: [healing, self-healing, bugfix]
modules: [health]
---

# manage_healing_events 对不存在 eventIds 假成功修复

## 背景（#1370）

2026-10-09 每日体检实证：`manage_healing_events(action=resolve, eventIds=[...])` 对**不存在的 ID 返回假成功**——回执报「完成: N/N 成功」，库中无任何变更。两组现场：

1. 传 messageId（非 eventId）→ 回执「1/1 成功」，sqlite 精查该 ID 无记录
2. 错抄 ID 连续两轮 → 回执「成功」×2，直至第三轮用正确 ID 才真正关闭

危害：回执不可信 → 「消费即处置」闭环失去机械保证——所有定时任务的 healing 处置都靠这个工具，agent 可能带着假成功离开，事件被静默漏处置。

## 根因

`better-sqlite3` 的 `UPDATE ... WHERE id = ?` 在不匹配时返回 `changes: 0` 但**不抛错**。工具层（healing-tools.ts）用 `Promise.allSettled` 逐条执行，全部 fulfilled → 判定全成功。交接意图书曾提示「写错库/事务未提交」方向，实查否定——写入的就是唯一真相库，问题纯在静默 no-op。

根因点：`src/frameworks/db/healing/sqlite-healing-event-repository.ts` 的 `resolve()` / `updateStatus()` 不看 `result.changes`。

## 修法（narrow-fix）

**修法决策树①既有语义内修**：repo 层两方法 `changes === 0` 时抛 `Error('healing event 不存在: <id>')`——fail-closed，把静默 no-op 变为显式失败。工具层已有「部分失败 → errorResponse + 失败原因清单」逻辑（`Promise.allSettled` rejected 分支），无需改动即接住新抛错，回执从「N/N 成功（假）」变为「M/N 成功 + 失败 ID: 不存在」。

**设计取舍**：
- 落点在 repo 层而非工具层：护住**所有**调用路径（rhi-signal-aging-worker 等自动处置方同样受益），不只护工具入口。issue 建议的「usecase 前置查库」方案（先 findById 再 update）多一次往返且存在 TOCTOU 窗口；changes 检查原子零成本。
- 不破接口签名：返回值仍 `Promise<void>`，失败走异常——与既有调用方异常处理模型一致（signal-tools 的 resolve 同款）。
- **机制识别检查点判定（动手前完成）**：四问全部未命中——未新增机制/通道/状态，仅在既有 UPDATE 写路径上补 fail-closed 校验，属既有语义内修。
- **负面向验收**：本次变更破坏的旧契约 = 「resolve/updateStatus 对不存在 ID 静默成功」这一（错误的）宽容行为；未绕过任何既有保护。依赖静默成功的调用方会暴露——经全量测试扫描（964 用例）确认无此依赖。

## 影响范围

| 调用方 | 影响 |
|---|---|
| manage_healing_events 工具（healing-tools.ts） | 假成功 → isError + 失败 ID 清单（契约对齐工具描述） |
| rhi-signal-aging-worker（auto-resolve 归口事件） | 事件先经 findAll 过滤存在性，正常路径不触抛错 |
| batchResolveByFilter / batchBindIssue | 不动（走 IN 集合更新，无逐条 changes 语义问题） |

## 验证

- **失败用例证据（bugfix 硬规则）**：修复前 `healing-resolve-fake-success.test.ts` 5 失败 2 通过（全失败/部分失败/dismiss/repo 层抛错断言全红）；修复后 **7/7 通过**
- **回归面**：tools/ + db/ + health/ + api/ 共 85 文件 964 用例全绿——无调用方依赖「不存在 ID 静默成功」
- 三态覆盖：全失败（0/2 + 列明无效 ID + 库无变更）/ 部分失败（1/2 + 真 ID 已处置 + 假 ID 列明）/ 全成功（2/2 原路径不回归）
- lint / build 干净
- **最简实现检查**：已过——repo 层 changes 检查是最小落点（2 处各 1 行校验），不新增文件/依赖/状态
- Golden Gate: n/a（非 prompt/skill/协议层改动）
- 锚点重放评审：豁免（纯回执语义修复，工具描述契约句尾更新为对齐陈述，不改行为触发语义）

## 关闭标准对照（issue #1370）

- ✅ 单测覆盖全失败/部分失败/全成功三态
- ✅ 用不存在 ID 实调验证返回 isError（单测 + 工具层断言）
- ⏳ 修复 PR 合入
