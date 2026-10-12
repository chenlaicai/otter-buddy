---
id: F20261012twin
title: "merge_pr 授权时间维度闸 + 通用短话术精确授权 + 注入区历史消息时间戳/历史标注（#1431）"
summary: "P0 事故修复：PR #1427 被 36 分钟前针对 #1422 的过期原话「合入了，你继续」误授权合入（原话真实存在但指向别的 PR）。三修法：A 时间维度闸（原话 createdAt 必须严格晚于 PR createdAt，过期一律拒）；C 通用短话术闸（实义 <6 且不含目标 PR 号 → 拒绝并引导带 PR 号二次确认）；B 注入区历史消息带时间戳与历史标注 + 段头解读规范（LLM 可按时间语义区分新旧授权）。"
change_type: fix
capability_test: "tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts「#1431 时间维度闸」describe（T1a/T1b/T1c/T1d/T2a/T2b/T2c/T2d 8 用例）+ S1/DS2 设计变更适配用例；tests/usecases/conversation/dispatch-chain-engine.test.ts 时间戳形态断言 +「历史 ·」/段头解读注记锁定断言（dispatch 41 用例全量）；tests/interface-adapters/http/dispatch-turn-loop.test.ts 同格式消费方适配"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
intent:
  problem: "merge_pr 授权校验只做文本命中不做时间维度：注入区/恢复路径重放的旧消息可被当新授权消费——2026-10-10 PR #1427 被 36 分钟前针对 #1422 的原话「合入了，你继续」误授权合入（seq 443 @2026-10-10T07:29:02Z vs PR createdAt 08:05:02Z）。且「合入了」「继续」类通用短话术天然易跨 PR 误配；注入区消息无时间戳，LLM 无法区分「刚说的话」与「86 分钟前的旧话」。"
  expected_effect: "原话时间早于 PR 创建的一律拒绝合入（含重放/注入区历史消息形态）；实义 <6 且不含目标 PR 号的短话术一律拒绝并引导「N合入」二次确认；注入区每行带时间戳与历史标注后，LLM 按时间语义把旧话当旧话，不再当新授权。回归锁：T1a 事故形态转拒绝、T1b 合法授权不回归、T2a 短话术引导、S1/DS2 整条等值机制不回归。"
  verify_by:
    type: behavior_check
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts
  - tests/usecases/conversation/dispatch-chain-engine.test.ts
  - tests/interface-adapters/http/dispatch-turn-loop.test.ts
tags:
  - merge-pr
  - authorization-gate
  - stale-approval
  - short-approval
  - injection-timestamp
  - "#1431"
  - "#1427"
causal_links:
  from:
    - F20260929mpav
    - F20260922pmgd
    - F20260928wxid
---

# merge_pr 授权时间维度闸 + 通用短话术精确授权 + 注入区历史消息时间戳/历史标注

## 1. 背景与事故

2026-10-10 17:15:55（北京时间），PR #1427（P1 海藻农场）被一句**针对 #1422 的过期授权**「合入了，你继续」误授权合入（squash d17d376e）：

- 该原话真实存在：entry seq 443，createdAt `2026-10-10T07:29:02.182Z`，紧跟 #1422 合入后 13 秒，语境明确指向 #1422
- PR #1427 创建于 `2026-10-10T08:05:02Z`——比原话晚 **36 分钟**，搭档当时不可能对它表态
- 校验层（F20260929mpav 真伪校验）逐字命中 → 放行——**文本命中 ≠ 语义授权**，缺的正是时间维度

issue #1431 由 8:30 健康检查开出（P0），搭档 2026-10-12 勾选授权开工。

## 2. 机制识别检查点与修法判定

逐项打勾：新增配置字段/枚举/开关 ✗；新增状态生命周期 ✗；新增定时任务/后台进程 ✗；**新增信号类型/消息格式 ✓**（注入区消息渲染格式变化：行内时间戳/历史标注 + 段头规范行）；新增持久化存储 ✗；新增决策分支（结果被记住并影响后续行为）✗（两道闸均为运行时校验拒绝即返回，不落库）；新增跨模块调用路径 ✗（checkPrMergeable 复用既有 gh 调用；fmtTime/标注在 buildMessageWithContext 同函数内）。

命中 1 项的论证（为何不涉净新增机制）：注入格式变化是**既有「历史消息」语义的信息完备化**——重放之所以致命是因为注入缺时间维度，补时间戳与解读规范是把既有语义修完整，无新信号类型、无新持久化结构、无新消费端。判定走修法决策树 **① 在既有机制语义内修**，`Modification-Class: narrow-fix`。

## 3. 方案设计

### 3.1 方案 A：merge_pr 时间维度闸（必做，本案主体）

`checkPrMergeable` 从拉 `state` 扩为拉 `state,createdAt`；execute 在真伪校验通过后追加：

```
hit.createdAt > pr.createdAt   （严格大于，同毫秒亦拒）
```

不满足即 `errorResponse`：报文含两个时间的对比 + 「疑似针对其他 PR 的过期授权」+ 引导「带 PR 号显式确认」。fail-closed：时间解析异常不放行不确定授权。

### 3.2 方案 C：通用短话术精确授权（必做）

`countSubstantive(partnerApproval) < 6` 且不含目标 PR 号 → 拒绝并引导（如「1427合入」）。issue 原文的触发条件是「原话时间线上先于本 PR 的关键事件」（条件拒），本实现取**严格变体**（无条件拒）——L1 记录：授权闸 fail-closed 取向，宁可多一轮确认不可错合；「1095合入」（实义 6）与一切带号话术不受影响。工具 description 同步（示例改为带 PR 号形态 + GOTCHA 补时间维度与短话术两条新拒绝路径）。

### 3.3 方案 B：注入区时间戳 + 历史标注（必做）

`buildMessageWithContext`：

- 未读行：`[label]（历史 · MM-DD HH:mm）body`——所有未读批消息相对触发消息都是「历史」，标注无误伤；时间取 entry.createdAt（F20260921urdo 契约必带，类型注解补 `createdAt?`）
- 触发行：`[label]（MM-DD HH:mm）body`，时间取当前时刻
- 段头规范行：「标注『历史』的行是本轮之前的消息（重启恢复/历史收缩路径可能重放），括号内为发言时间；旧消息不得作为新授权/新裁决依据」——issue 的「注入规范写明」落点

## 4. 失败证据（bugfix 红绿）

T1a（事故形态：原话 seq 443 @07:29:02Z vs PR #1427 createdAt 08:05:02Z）修复前跑 = **红**：`expect(...).toContain('过期授权')` 在 merge-pr-tool.test.ts:372 失败（旧实现无时间维度，把过期原话放行合入）。修复后转绿。T1b（合法授权晚于 PR 创建）为回归锁，修复前后皆绿。

## 5. 断言调整理由（非验证漂移）

S1/DS2 两条 F20260929mpav 旧锁的正向用例从「裸短话术放行」调整为「含 PR 号精确授权放行」：

- **整条等值机制（防否定句断章）一字未动**——S1 的反向半（从长句抠「合吧」→ 拒）与 DS2 的邻字边界（3 字摘录 → 拒）原样保留
- 变的只是短话术的授权精确度要求（3.2 的显式设计变更）；裸「合吧」的新行为由 T2a 专门锁定（引导二次确认）
- 这是设计变更的断言同步，不是放宽验证

## 6. 验证

- `npx vitest run` 两域 **69/69 全绿**（dispatch-chain 41 + merge-pr 28）；`tsc --noEmit` 0 error
- 新增 8 用例：T1a 事故重放转拒 / T1b 回归锁 / T1c 同毫秒边界拒 / T1d 时间解析异常 fail-closed 拒 / T2a 短话术引导拒 / T2b 带号短话术放行 / T2c 长话术不误伤 / T2d 数字子串不算含号拒
- 既有 dispatch 断言全部适配时间戳形态（`toMatch(/\[X\]（[^）]*）text/)`），L2 安全词块断言不受影响；http 域 dispatch-turn-loop.test.ts 同格式消费方同步适配（首轮检视 S1），「历史 ·」/段头解读注记由锁定断言兜底

## 7. 设计取舍与已知限制（如实声明）

1. **重放判定盲区**：「真未读」与「消费游标回退重放」在数据面不可区分（issue 已注明待修复方核实）。本方案不猜根因：时间戳 + 历史标注把时间语义交给 LLM，最后一道物理闸由 3.1 兜底。治本（恢复逻辑不重放已消费消息 / 消费游标持久化）归 unread-reform 域（worktree 在场，未撞车——开工三问核实过）
2. **恢复路径的触发消息时间戳**：#613 恢复流重放的原始发言带当前时间而非原发言时间——授权面不受影响（3.1 按 entry.createdAt 判，恢复条目的 createdAt 是真实的）
3. **短话术阈值 6**：「可以合了」（实义 4）会被引导二次确认——多一轮往返换零误配，P0 后的取向；阈值可按使用反馈再校准（注意「这个可以合了」实义 6 已过线不拦，阈值卡在严格小于）
4. 健康检查曾疑「恢复侧 excludeMessageIds 与重放的关系」——本次不动该路径（scope 外）

## 8. 机制识别检查点命中项的回归保护

注入格式变化由 dispatch-chain 41 条断言 + http 域 dispatch-turn-loop 适配断言 +「历史 ·」/段头解读注记锁定断言共同锁定（时间戳形态 + 既有语义断言全部适配），未来格式回退（丢时间戳/丢标注）直接测试红。
