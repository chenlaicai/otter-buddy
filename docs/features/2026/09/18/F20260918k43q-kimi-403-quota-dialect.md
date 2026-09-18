---
id: F20260918k43q
title: kimi 403 配额耗尽方言识别：修复首哑/告警/落账三链失效
date: 2026-09-18
change_type: fix
capability_test: "n/a: 纯函数正则库数据补充（verify_by=static_only：新增实证文本失败用例 + 负例，单测全绿即证据，无 prompt 行为面）"
created_in_conversation: e6489833-4eaa-444c-ae5d-33f3bf1477a0
summary: kimi 周配额耗尽报 403 + access_terminated_error 英文文案，不命中 matchRateLimitError 任何正则——识别失败导致 healing 落账、会话告警、首哑兜底（F20260916fst4）三条下游全静默，搭档被迫手动@大獭换模型。窄修：QUOTA_EXHAUSTED_PATTERNS 补 kimi 方言两条正则
tags: [rate-limit, first-dumb, kimi, model-fallback, orchestration]
modules: [src/usecases/conversation/agent-turn-orchestrator/rate-limit-error.ts, tests/usecases/conversation/agent-turn-orchestrator/rate-limit-error.test.ts]
---

# kimi 403 配额耗尽方言识别：修复首哑/告警/落账三链失效

## 预注册（troubleshooting 流程，动手前冻结）

- **预期根因方向**：kimi 403 错误文本不命中 `QUOTA_EXHAUSTED_PATTERNS` 正则族
- **验证标准**：实际 403 文本对全部 11 条既有正则 MISS → `matchRateLimitError` 返回 null → 首哑不触发
- **最强反例方向**：若正则命中但仍未触发，则查 `detectFirstDumb` 的 count/type 门（orchestrator.ts:289-305）
- **结果**：预期命中（验证脚本 11 条正则全 MISS，见下文证据链）

## 问题现象

2026-09-18 11:50:55，对话 ec99f4ab（「echo agent2」）中小獭「检视1280」（模型 kimi）首次 invoke 失败。搭档观察：报 403，未触发大獭切换小獭——首哑兜底机制（F20260916fst4，PR #988）没动作，只能手动发「@大獭 kimi暂无token，你换mimo来」补救（entry 585）。

## 根因分析

### 证据链（每步可复核）

1. **实际错误文本**（`.otter-buddy.log:1483`，2026-09-18 11:50:55）：
   ```
   LLM API error: OpenAI API error (403): {"message":"You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota","type":"access_terminated_error"}
   ```
2. **该 invoke 确为首次 invoke**（invokes 表，otter 59ce801b，该会话内仅 1 条 failed 记录）——若识别器命中，`detectFirstDumb` 的 count==1 + type=='small' 两道门全满足，首哑本应触发。排除「不是首 invoke」与「非 small」两个备择假设。
3. **识别器判定**：`matchRateLimitError`（rate-limit-error.ts:56）的 9 条 exhausted 正则 + 2 条 transient 正则，对上述文本**全部 MISS**（node 脚本逐条验证，11/11 MISS）→ 返回 null。
4. **null 的下游后果**（orchestrator.ts:253-283）：不落 healing 账、不发会话告警、不构造 `_firstDumb`——三条下游全静默，搭档只看到系统错误 entry（entry 584）。

### 根因定性

F20260916fst4 与 #543 设计时按 OpenAI/GLM 的 **429 语义**建模「配额耗尽」，但 kimi 用 **403 + `access_terminated_error` type + 英文 usage limit 文案**表达同一件事。「配额耗尽」在各 provider 的 API 表达不统一是根因；识别器是上游单点，它一断，落账/告警/首哑三条下游全灭。

## 修复方案（修法排序①：既有机制语义内补缺）

`QUOTA_EXHAUSTED_PATTERNS` 新增两条 kimi 方言正则：

```ts
/access_terminated_error/i,                                                // kimi 403 配额型终态 type
/(reached|hit|exceeded)[^\n]{0,40}usage[ _-]?limit/i,                      // "You've reached your weekly (7-day) usage limit"
```

双正则理由：`access_terminated_error` 是结构化 type 字段（稳定）；usage limit 文案是 message 字段（覆盖 type 变体）。两者独立命中任一即判 exhausted。

### 设计取舍

- **为什么两条而不是一条**：type 字段比 message 更稳定，但仅靠 type 一条，若 kimi 改用别的 type 名就再漏一次；文案条 `usage limit` 与 OpenAI 的 `usage_limit_reached`（下划线）形态不同（空格/连字符），`[ _-]?` 已兼容但前后动词锚（reached/hit/exceeded）防止「usage limit」出现在无关上下文误报。
- **403 权限类错误为何不误报**：负例测试覆盖 `permission denied` / `invalid api key` 形态——不含上述两 pattern，不命中。
- **不把 403 状态码整体加进 exhausted**：403 语义上多数是权限/鉴权错误，仅凭状态码会大面积误报；按 kimi 特有 type + 文案锚定，才是「配额耗尽」的可靠信号。
- **机制识别检查点**：不新增配置/状态/定时任务/信号类型/存储/决策分支/跨模块调用——纯数据（正则数组）补充，无净新增机制，修法①论证成立。

## 验证（bugfix 硬规则：失败证据链）

### 失败用例固化（troubleshooting 5a，先写先跑）

新增测试用例（tests/usecases/conversation/agent-turn-orchestrator/rate-limit-error.test.ts）：

- **正例**：kimi 403 实证文本（log:1483 原文）→ 期望 `exhausted=true`
- **负例**：`permission denied` 403 / `invalid api key` 403 → 期望 null

**修复前失败输出**（正例）：
```
FAIL tests/usecases/conversation/agent-turn-orchestrator/rate-limit-error.test.ts > matchRateLimitError > kimi 403 周配额耗尽（实证文本）判配额耗尽
AssertionError: expected null not to be null
 ❯ tests/usecases/conversation/agent-turn-orchestrator/rate-limit-error.test.ts:58:19
Tests  1 failed | 12 passed (13)
```

**修复后通过输出**：
```
Test Files  1 passed (1)
     Tests  13 passed (13)
```

### 回归验证

- agent-turn-orchestrator 全模块：**5 files / 67 tests 全绿**（含既有 429/GLM/OpenAI/智谱用例，无回归）

### 最简实现检查

已过最简检查：改一处正则数组（+2 行数据 + 注释），不动函数签名、不动调用方（`matchRateLimitError` 全仓唯一调用方是 orchestrator.ts）、不加抽象层。无更简实现形态——数据缺漏的最小修复就是补数据。

## 影响范围

- `matchRateLimitError` 唯一调用方 orchestrator.ts `handleApiError`：healing 落账（errorType=rate_limit, severity=high）、会话告警（buildRateLimitSystemMsg）、首哑判定（detectFirstDumb）三条下游随识别修复一并恢复。
- 修复后 kimi 403 配额耗尽会正确走 `exhausted=true` 路径：告警文案含「配额耗尽（429 终态）」——字面 429 与实际 403 不符属文案瑕疵（既有文案模板未区分状态码），不影响功能，不在本次窄修范围。

## 预期 vs 实际对照

预期命中：验证脚本 11 条既有正则全 MISS + 失败测试固化复现 → 实际与预期一致，无方向修正。
