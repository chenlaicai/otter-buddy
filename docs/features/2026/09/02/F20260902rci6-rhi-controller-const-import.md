---
id: F20260902rci6
title: RHI controller 常量收口单一真相源（Issue #636 B4+B5）
summary: rhi-controller 本地复制的阈值常量/inFlight 白名单/信号中文标签全部改为 import 真相源：chain-builder 导出 DEFAULT_STALLED_DAYS/DEFAULT_ZOMBIE_DAYS，inFlight 判定收口 #646 契约函数，SIGNAL_TYPE_LABELS 收口 SIGNAL_REGISTRY.name
change_type: refactor
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
capability_test: "n/a: 纯重构零行为变化——tsc 通过 + 全量测试 220 文件 2787 用例绿（与 main 基线一致），信号标签 API 响应逐字不变（registry 覆盖全部 10 类 SignalType）"
related_issues:
  - "#636"
---

# RHI controller 常量收口单一真相源（Issue #636 B4+B5）

## 背景与需求

PR #633 对抗审视（检视獭-r633）发现 B4/B5 两处展示层复制常量的漂移隐患，经大獭裁决合并为 issue #636（重构级改动不塞展示层 PR）。

- **B4**：rhi-controller.ts 复制了 chain-builder 的阈值常量（`STALLED_DAYS = 14` / `ZOMBIE_DAYS = 30`）与 inFlight 文档状态集（硬编码 5 值数组）——usecase 改阈值，controller 不同步
- **B5**：rhi-controller.ts 的 `SIGNAL_TYPE_LABELS` 与 signal-registry.ts 的 `name` 字段逐字重复——真相源应是 signal-registry（Issue #399 已确立）

## 漂移实证（重构动机，非假设）

1. **阈值**：chain-builder 92-93 行的 `?? 14` / `?? 30` 是内联默认值非导出常量，controller 只能复制数字字面量——两边无任何机制防漂移
2. **状态集**：controller 硬编码 `["draft","proposed","design","development","active"]` 5 值，而 #646 值域契约已将 inFlight 扩到 7 值（+`review`/`reviewed`）并支持 `implemented+active` 子状态——controller 的 `stateReason` 文案对 review/reviewed 状态文档已判错「在途」属性（展示层轻微失真，不影响链状态判定本身）
3. **信号标签**：controller 与前端映射都停在 9 类，registry 已有 10 类（#645 新增 `snapshot_shift`）——signals 端点对 snapshot_shift 信号返回原始 type 字符串而非中文名

## 方案设计

### B4：阈值常量提取导出 + controller import

- chain-builder.ts：提取 `DEFAULT_STALLED_DAYS = 14` / `DEFAULT_ZOMBIE_DAYS = 30` 导出，`buildFeatureChains` 内联默认值改为引用常量（同值替换，行为零变化）
- rhi-controller.ts：删除本地 `STALLED_DAYS`/`ZOMBIE_DAYS`，`import { DEFAULT_STALLED_DAYS as STALLED_DAYS, DEFAULT_ZOMBIE_DAYS as ZOMBIE_DAYS }`——as 别名保文案代码不动
- inFlight 判定：controller 硬编码数组 → `classifyDocStatusWithSubstatus(...)`（@entities/document/doc-status，#646 契约函数，与 chain-builder 判定层同源）。chain 形状补 `substatus` 字段（CollectedFeatureDoc 已有此字段，调用点传完整 FeatureChain 无需改调用方）

### B5：SIGNAL_TYPE_LABELS 收口 registry

- controller 删除本地 `SIGNAL_TYPE_LABELS` 映射，新增 `signalTypeLabel(type)` 辅助函数：`SIGNAL_REGISTRY[type]?.name ?? type`（未收录类型回退原始字符串，与原 `?? s.signal_type` 语义一致）
- registry 覆盖全部 10 类 `SignalType`（`Readonly<Record<SignalType, SignalDefinition>>`），正常路径不触发回退

### 非目标

- **web 前端 SIGNAL_TYPE_LABELS 收口**：issue 留了「实施时一并评估」。评估结论：**不在本 PR 做**。web 是独立 vite 构建（无 tsconfig path 别名指向 src/usecases），跨包 import 需引入 monorepo workspace 机制或路径别名配置，属于构建架构变更，超出本重构小件范畴。前端自己的补充：9 类映射 + 未知类型回退 type 的行为在后端标签收口后依然成立（后端传来的 signalTypeLabel 已是中文名）。遗留项见 Discovered Issues
- 前端 CHAIN_STATE_META 等展示映射（已有 #649 PR3 收口先例，不在本 issue 范围）

## 影响范围

| 文件 | 变更 |
|---|---|
| src/usecases/health/chain-builder.ts | +2 导出常量，默认值改引用（+6/-2 行） |
| src/interface-adapters/http/controllers/rhi-controller.ts | 删本地常量/映射，改 import + 契约函数（约 -20/+20 行） |

纯重构零行为变化：唯一语义差异是 `stateReason` 对 review/reviewed/implemented+active 文档的 inFlight 判定与判定层对齐（修复漂移正是本 issue 目的）；signals 端点 snapshot_shift 补上中文名（同上）。

## 验证

- `npx tsc --noEmit` 通过
- `npx vitest run`：220 文件 / 2787 用例全绿（main 基线同水平，无新增失败）
- 零行为变化核查：grep 确认 controller 无 `SIGNAL_TYPE_LABELS`/本地阈值常量残留；34 个 rhi-api 测试（含信号标签断言）不改一行全过
- **最简实现检查**：已过——本方案就是「删复制、改 import」，无新代码路径；辅助函数 3 行是 TS 类型收窄的最小形态。备选（controller 直接内联 `SIGNAL_REGISTRY[s.signal_type as SignalType]?.name ?? s.signal_type`）可省函数但调用点类型断言重复，可读性更差，不采纳

## 本次变更对旧特性做了什么

- F20260824rhib（RHI 信号注册表）：不改变注册表语义，controller 展示消费点改为引用它
- F20260825rweb Phase 2（rhi-controller，#402）：controller 失去本地常量副本，全部引用真相源
- #646 值域契约：controller 状态原因文案消费点接入契约函数（此前仅 chain-builder 判定层接入）
