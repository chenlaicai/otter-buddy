---
id: F20260920wxho
title: 微信 context_token 预警改为每静默期只提醒一次（去骚扰）
summary: F20260901wxnt 的冷却重发设计在生产演变为骚扰——token 实际存活远超 2h 预估（6h 仍在发），用户不回复就每小时一条无限循环；收窄预警管辖为「同一静默期只提醒一次」，重置资格的唯一路径是入站换新 token，cooldown 配置键退役
change_type: fix
capability_test: "n/a: 行为语义收窄，由 tests/frameworks/weixin/polling-channel-warn.test.ts 单测覆盖（非 prompt/软代码）"
created_in_conversation: a663a4b9-669f-4b7d-bece-0940af560660
causal_links:
  from: [F20260901wxnt]
tags: [weixin, context_token, notify, spam, scope-reduction]
modules:
  - src/frameworks/weixin/polling-channel.ts
  - src/frameworks/config-service.ts
  - config/config.yaml.example
---

# 微信 context_token 预警改为每静默期只提醒一次（去骚扰）

## 背景

搭档原话（2026-09-20，对话 a663a4b9）：

> 微信接入的断联提示每隔一个小时就发一次，成了骚扰这是，你优化下

**生产证据**（data/weixin/weixin-mu95nc3y/context-tokens.json，2026-09-20 15:49 读取）：

- 搭档最后一条入站消息 09:46（receivedAt），最近一次预警 15:47（warnedAt）
- 距最后入站 **361 分钟**，预警仍成功发送（token 未死），且此前每小时一条、已发 ~6 条

**根因**：F20260901wxnt 的预警设计假设「context_token 实测 <2h 死亡，预警发一两条后 token 自然死亡、重试必败止损」。生产现实推翻了该假设：

1. token 存活 6h+ 仍能成功出站——预警消息本身可能为出站保活，**预警成了续命机制**
2. cooldown 到期即重发（polling-channel.ts `warnUserIfStale`：`warnedAt != null && now - warnedAt < cooldownMs` 才跳过）——用户不回复 → 每冷却期一条，无限循环
3. 用户视角：一条提醒是贴心，每小时一条是骚扰——提醒的边际价值在用户知情后归零，只剩打扰

## 目标

- T1：同一静默期（两次入站消息之间）预警至多一条；用户回复（token 换新）后资格重置，下个静默期满阈值再提醒一次
- T2：cooldown 机制整体退役（配置键、内存缓存判断、文档说明），遗留旧配置文件不报错

## 非目标

- 不删预警机制本身——「断连前告知一次」的初衷保留（静默断连问题仍真实存在）
- 不动 warnedAt 落盘结构（context-tokens.json v2 格式不变，warnedAt 字段语义从「冷却起点」变为「本静默期已提醒」标记）
- 不做消息丢失补投递（F20260901wxnt 非目标中已列，另立）

## 方案设计

### 修法排序：② 收窄管辖（scope-reduction）

机制识别检查点 7 项逐项核对：新增配置字段 ✗（删字段）、新增状态生命周期 ✗（warnedAt 生命周期不变，语义收窄）、新增定时任务 ✗、新增信号类型 ✗、新增持久化 ✗（存储结构不变）、新增决策分支 ✗（分支减少：cooldown 比较删除）、新增跨模块调用 ✗。全部未命中 → 走②。

### 核心改动：warnUserIfStale 判断收窄

```ts
// 修复前（F20260901wxnt）：
const warnedAt = this.warnedAtMemoryCache.get(userId) ?? entry.warnedAt;
if (warnedAt != null && nowMs - warnedAt < warn.cooldownMs) return; // 冷却期内跳过

// 修复后（F20260920wxho）：
const warnedAt = this.warnedAtMemoryCache.get(userId) ?? entry.warnedAt;
if (warnedAt != null) return; // 本静默期内已提醒过——无条件跳过
```

重置资格的唯一路径保持不变：入站换新 token → `saveContextToken`（清 disk warnedAt）+ `warnedAtMemoryCache.delete`（清内存）→ 下个静默期满阈值再提醒一次。

### 配置退役

- `weixin.contextTokenWarnCooldownMinutes` 从 AppConfig/RawConfig 类型、`buildContextTokenWarnConfig`、`validateWeixinWarnConfig`、config.yaml.example 中移除
- 遗留兼容：旧配置文件带着该键启动**不报错**（validate 不再校验它，build 忽略它）——部署侧无需改配置
- `contextTokenWarnMinutes`（触发阈值）保留，显式 0 关闭预警的语义保留

### 内存缓存与止损语义保留

- `warnedAtMemoryCache`（磁盘落盘失败的内存补偿）保留——每静默期一次的判断同样需要它
- 发送失败（ret=-2）记 warnedAt 止损不重试——保留，且在新语义下天然加强（一次失败 = 本静默期不再尝试）

## 影响范围

- **行为变化**：微信用户在长时间不回复期间，从「每小时一条」变为「一条即止」——这是本次目的
- 配置面：`contextTokenWarnCooldownMinutes` 退役；不改配置的部署行为自动收敛为每静默期一次
- 出站/gateway/registry/UI 零改动；context-tokens.json 存储格式零改动
- 风险评估：若用户连续多个静默期都不回复，期间 token 死亡 → 静默断连回归原状（预警一条已发过，不再重发）。接受此取舍：一条已足够传达「需要时随便发条消息」的信息，重复发送只产生骚扰价值

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| cooldown 调长（如 24h） | ✗ 退役 | 保留调长 | 调长只是降低骚扰频率，不消除；且「第二次提醒」在用户已知情后无信息增量 |
| 每静默期一次 | ✓ | 完全删除预警 | 静默断连问题真实存在（F20260901wxnt 背景），第一次提醒有真实价值；删机制是③，问题回归不可接受 |
| 重置资格 = 入站换新 token | ✓ | 时间衰减恢复资格 | 时间衰减就是 cooldown 的马甲；「用户说话」是唯一有意义的资格恢复事件 |
| 遗留配置键静默忽略 | ✓ | 启动报错逼用户改配置 | 键已无语义，报错只会制造无意义的部署摩擦 |

## 验证

**失败用例证据（troubleshooting 5a 固化）**：

修复前新增测试跑红（2026-09-20 16:03，worktree wx-warn-once）：

```
× 跨冷却期不重发：同一静默期只提醒一次（F20260920wxho 修复核心断言）
× 入站换新 token 后重新获得预警资格（第二次静默期仍会提醒一次）
Test Files  1 failed (1)
      Tests  2 failed | 9 passed (11)
```

失败原因均为「cooldown 过期后旧实现重发」（expected 0, received 1）——精确对应生产骚扰行为。

修复后（16:12）：`tests/frameworks/weixin/polling-channel-warn.test.ts` 11/11 绿；全仓 vitest 268 files / 3681 tests 全绿；`npx tsc --noEmit` 无错误。

**旧用例调整记录**（与修复同 commit，理由）：

1. 「cooldown 期内抑制重复预警」→ 更名「已提醒过（warnedAt 存在）即抑制，无论过去多久」：cooldown 语义退役，30min 内抑制是其子集，保留原断言不变仅改标题语义
2. 「入站消息清除内存缓存 warnedAt（cooldown > after 场景不漏发）」→ 重构为「资格重置的内存侧」：cooldown > after 场景已不存在，改为先入站重置资格再验证第二次静默期提醒——内存清除链路的验证价值保留（防「用户回了消息却收不到下次预警」的漏发 bug）
3. 「recordContextTokenWarned 落盘失败时内存补偿止损」tick 3：原断言「冷却期过后有新发送」与每静默期一次矛盾，改为「快进 121min 后仍无新发送」——内存补偿的止损验证价值保留并加强

**config-service 测试**：「正常值」用例删 cooldown 字段断言；新增「遗留 cooldown 键不报错」兼容用例。

**最简实现检查**：已过——改动是净删除（cooldown 比较 + 配置链 4 处），无新增代码路径；`if (warnedAt != null) return` 是「同静默期只提醒一次」的最直接表达。

**负面向验收条目**：本次变更破坏了「冷却期过后自动重发提醒」这一旧契约（有意为之，即本次目的）；绕过的既有保护：无（warnedAt 落盘/内存补偿/失败止损保护全部保留）。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/weixin/polling-channel.ts | M | warnUserIfStale：warnedAt 存在即跳过（删 cooldown 比较）；deps.contextTokenWarn 类型删 cooldownMs；注释更新 |
| src/frameworks/config-service.ts | M | 删 contextTokenWarnCooldownMinutes（AppConfig + RawConfig + build + validate）；buildContextTokenWarnConfig 返回 { afterMs } |
| config/config.yaml.example | M | 删 cooldown 示例注释，说明改为每静默期一次 |
| tests/frameworks/weixin/polling-channel-warn.test.ts | M | 新增 2 用例（跨冷却期不重发 / 重置资格后二次提醒）；3 个旧用例按新语义调整（理由见上） |
| tests/frameworks/config-service-warn.test.ts | M | 删 cooldown 断言；新增遗留键兼容用例 |
| docs/features/2026/09/20/F20260920wxho-weixin-warn-once-per-silence.md | A | 本文档 |
