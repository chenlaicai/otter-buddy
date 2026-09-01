---
id: F20260901dtfx
title: 优雅交接 LLM 合成 100% 误判失败修复——result.text 空串陷阱
summary: PR #618 上线后 70% 自动交接的 LLM 叙事合成 3/3 全部误判失败降级机械转储。根因是合成闭包只读 result.text（生产 invoke 结果中恒为占位空串），LLM 直出文本实际在 result.directText；测试 mock 形状与生产不同构（D1 教训重演）掩盖了 bug。修复为 directText 优先 fallback text，测试 mock 同构化 + 2 个回归用例。
change_type: fix
created_in_conversation: 9d326c9d-9818-40a2-9982-898315fe7aa4
from:
  - F20260831hndp
tags: [handoff, llm-synthesis, direct-text, mock-isomorphism]
---

# 优雅交接 LLM 合成 100% 误判失败修复——result.text 空串陷阱

## 背景与现象

F20260831hndp（PR #618）合入后，搭档在《微信对接》对话观察到：大獭 8 次世代重启的交接摘要**全部**是「LLM 叙事合成失败/超时，降级为机械转储」——防线①一次都没成功过。

日志证据（data/logs/otter-buddy.log）：

| 时间 | 模型 | 失败原因 | 实际情况 |
|------|------|----------|----------|
| 8/31 13:01 | mimo | `Synthesis timeout`（60s） | 超时（真实超时） |
| 8/31 13:14 | mimo | `LLM synthesis returned empty result`（33s 返回） | **摘要已生成，被误判丢弃** |
| 9/1 08:34 | glm | `LLM synthesis returned empty result`（50s 返回） | **摘要已生成，被误判丢弃** |

## 根因分析

### 直接原因：读错字段

- 生产 invoke 结果的 `text` 字段是 `buildInvokeResult` 的**占位空串**（circuit-breaker-helpers.ts:118 硬编码 `buildResult("", ...)`）
- LLM 直出文本实际由 pi-session-factory.ts:483-485 填入 `result.directText`（F20260821spcm 旁白流失检测引入的 turnText 缓冲）
- 合成闭包（agent-invoker.ts `buildSynthesisFunction`）检查的是 `result.text` → 恒空 → 每次抛 `LLM synthesis returned empty result` → builder 降级机械转储

即：**摘要每次都真的生成了，就在 directText 里躺着，被读错字段的代码扔了**。

### 为什么测试没抓住：D1 教训重演

D1 教训（PR #618 审视轮确立）：mock 参数形状必须与生产构造同构。本次测试 mock 返回 `{text: "Hello"}`——一个生产中**不存在**的形状（生产 text 恒空、内容在 directText）。三边（实现、测试、审视 kimi）都默认 invoke 返回 text，无人发现。

## 修复

### 代码（agent-invoker.ts，+7 行）

合成闭包的文本提取改为 fallback 链：

```ts
const synthesisText = result.directText?.trim() || result.text?.trim() || '';
```

- directText 优先（生产路径）
- text fallback（防御：若未来 SDK 形状变化直出进 text，仍能取到）
- 全空才抛 empty result（走防线②机械转储，降级链不变）
- Completed 日志加 `source: 'directText' | 'text'` 字段，后续观察可区分取数路径

### 测试（agent-invoker-handoff.test.ts）

1. **mock 同构化**：`mockSdkInvoke` 改为返回生产形状——`text: ""` + `directText: <内容>`；原 `text` 参数映射到 directText（兼容既有调用点）
2. **回归用例 ×2**：
   - 生产形状（text 空 + directText 有值）→ 真实闭包提取成功（旧代码下此用例失败，已用 git checkout 反向验证）
   - directText 与 text 全空 → 闭包抛 `LLM synthesis returned empty result`（防线②降级入口不变）
3. 反向验证记录：`git checkout -- agent-invoker.ts` 退回旧代码后，新用例 1 failed | 8 passed；恢复修复后 9 passed

## 验证

- [x] vitest agent-invoker-handoff：9/9 绿（含 2 个新回归）
- [x] tsc --noEmit：exit 0
- [x] eslint：exit 0
- [x] 全量 vitest + CI（PR 状态）

## 影响范围

- 仅 70% 自动交接路径的 LLM 合成提取逻辑；降级链（防线①→②→③）、熔断/手动路径红线（类型签名隔离）均不受影响
- 修复后微信对话等重度使用场景的交接摘要将恢复六分区叙事合成

## 教训沉淀

1. **D1 教训需要机械化**：mock 同构性靠人盯三轮都没盯住（mimo2 实现、kimi 审视、我编排复核），后续可考虑 contract test 或 mock 工厂从生产构造函数派生
2. **旁白流失检测（F20260821spcm）改变了 invoke 结果形状**：directText 是后加的字段，Phase 2 合成闭包写于其后但沿用了旧的 text 直觉——跨特性耦合的字段认知缺一处就翻车

## 关联

- from: F20260831hndp（Phase 2 引入合成闭包）
- F20260821spcm（directText 字段的引入者，间接根因）
