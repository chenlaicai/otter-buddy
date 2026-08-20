---
id: F20260820d338
title: degenerate-detection-threshold-tuning
doc_type: feature

summary: |
  降低退化检测阈值、增强 speak 签名去重、改进重试消息措辞。
  修复 Issue #338（小獭输出退化：单条消息中重复输出相同内容）。

causal_links:
  from:
    - F20260804dglp
    - F20260728cbwt
  references:
    - "#338"

status: development
change_type: bugfix
tags: [agent, degenerate, circuit-breaker, resilience, issue-fix]
modules:
  - src/frameworks/agent/degenerate-detector.ts
  - src/frameworks/agent/tool-call-circuit-breaker.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
capability_test: "n/a: 纯 A 类改动（阈值调整 + 签名增强 + 文案改进），无 LLM 行为依赖"
---

# F20260820d338: 退化检测阈值调优

## 背景

Issue #338 记录了 2026-08-19 的小獭输出退化事件：
- 9 个 degenerate 事件（输出异常重复）
- 2 个 circuit_break 事件（熔断重启）
- 4 次用户强制中断

根因分析：
1. **DegenerateDetector 阈值过松**：maxWindowRepeats=50 需 ~5000 字符才触发，重复内容 4 次已被用户感知但未及时捕获
2. **ToolCallCircuitBreaker 对 speak 不区分内容**：所有 speak 调用签名相同，无法区分不同内容
3. **重试消息被 LLM 复述**：系统消息 "[系统] 检测到输出异常重复，正在自我纠正" 被当作退化内容重复输出

## 实现内容

### 改进 1：降低 DegenerateDetector 阈值

**变更**：
- `maxWindowRepeats`: 50 → 20（~2000 字符触发 vs 原 ~5000 字符）
- `minBlockLength`: 5000 → 3000（distinct-ratio 机制更早介入）

**安全边际**：
- 实测 110 个 ≥5KB 合法块最低 distinct ratio 0.838，远高于阈值 0.3
- 良性复述 ≤2 次，新阈值 20 次仍远高于此
- **已知局限**：3-5KB 区间的阴性夹具未覆盖（建议建 issue 跟踪）

### 改进 2：增强 speak 签名去重

**变更**：`buildToolSignature("speak", { body })` 加入 body 内容指纹

**效果**：
- 连续 speak 不同内容 → 签名不同 → 不计为重复
- 同一 speak 内容反复输出 → 签名相同 → 正常累计
- 与 write/edit 工具的签名逻辑一致

### 改进 3：改进重试消息措辞

**变更**：
- `failBody`: "[系统] 检测到输出异常重复，正在自我纠正" → "[系统保护] 输出内容异常重复，已中断并自动重试"
- `retryMsg`: 更具体地描述问题，避免 LLM 复述系统消息

**设计意图**：
- 使用 "[系统保护]" 前缀统一系统消息风格
- 明确告知 LLM "不要重复输出之前已经说过的内容"
- 避免使用会被 LLM 当作输出模板的措辞

## 影响范围

### 直接影响
- 退化检测更灵敏（~2000 字符 vs ~5000 字符）
- speak 工具调用循环检测更准确
- 重试成功率预期提升

### 间接影响
- 可能增加假阳性（但安全边际充足）
- 熔断重启频率可能略有上升

## 验证

### 测试覆盖
- 45 个 DegenerateDetector 测试（含新阈值断言）
- 34 个 OutputGuard 测试
- 19 个 CircuitBreakerHelpers 测试
- 新增 speak 签名测试（2 个）

### CI 状态
- Lint：0 errors
- Build：通过
- 所有测试：通过

## 降级路径

重试失败 → 熔断重启的完整路径：
1. LLM 输出退化 → DegenerateDetector 检测 → abort
2. 首次退化 → handleDegenerateRetry → 新消息重试
3. 重试再次退化 → handleCircuitBreak → 熔断重启 session
4. 熔断重启后仍退化 → abortTerminal（上限保护）

## Discovered Issues

1. **阴性夹具覆盖不足**：3-5KB 区间的合法输出未测试，建议补充阴性夹具（建议建 issue）
2. **重试消息效果待验证**：新措辞是否能有效避免 LLM 复述，需要实际运行观察
