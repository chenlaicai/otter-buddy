---
id: F20260915hcel
title: html-card 弹性化：合并 html-report + 默认展开 + 尺寸弹性
summary: "html-card 单一围栏弹性化——体积 MAX=64KB 无 MIN、新卡默认展开（cardSchemaVersion=2）、高度 clamp [100,4000] 海獭自控（data-height + otterCard.resize）、删除 html-report 分轨"
change_type: feature
capability_test: "n/a: 纯基建契约变更（常量+校验+UI 默认态），LLM 行为不变——单测覆盖 validateSpeakBody/clamp/schemaVersion 分流，capability 测试 html-card-proactive 已有覆盖出卡行为"
created: 2026-09-15
created_in_conversation: ee07dc1b-b195-4595-9b53-d927ec020f97
modules:
  - api-contract/api/html-card.ts
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - web/src/lib/html-card.ts
  - web/src/pages/conversation/HtmlCard.tsx
from:
  - F20260915hrpt
supersedes:
  - F20260915hrpt
intent:
  problem: "PR #955 的 html-report 与 html-card 分轨方案被搭档判定「看起来差不多、真实差异只有大小」，且「比例不应定死」——需要合并为单一围栏类型 + 弹性尺寸 + 默认展开"
  expected_effect: "只有 html-card 一种围栏；体积只限 MAX=64KB（无 MIN）；默认展开（新卡）；高度 clamp [100,4000] 海獭自控；老卡（合入前）保持折叠；单消息 2 张"
  verify_by:
    type: behavior_check
---

# html-card 弹性化：合并 + 默认展开 + 尺寸弹性

## 背景

2026-09-15 晚搭档在 demo 环境实测 PR #955（html-report 独立围栏）后反馈：「看起来很相似，除了大小限制还有其他区别吗」。大獭诚实承认「真实差异没之前吹的多」。搭档拍板新方向：

1. **合并**：只有 `html-card` 一种围栏，干掉 `html-report`
2. **尺寸弹性**：系统只约束最大/最小，真正大小由海獭按内容决定
3. **默认展开**：所有 html-card 默认展开（折叠是例外）

本特性 supersede F20260915hrpt（PR #955 已关闭）。

## 方案设计

### 新契约（合并后）

| 维度 | 旧 html-card | 新 html-card |
|---|---|---|
| 体积 | 固定 8KB | **MAX=64KB（无 MIN）** |
| 张数 | 2 张 | 2 张（保持） |
| 默认状态 | 折叠 | **展开（新卡）；老卡保持折叠** |
| 初始高度 | 固定 240px | **海獭自定（clamp [100, 4000]）** |
| 模型路由 | 无 | 无（删除——LLM 按内容自控体积） |
| 独立工具 | 无 | 无（删除 get_html_report_contract） |

### 「老卡保持折叠」实现

- DB 里 entries.created_at < 本特性合入时间 → 默认折叠
- 新卡 → 默认展开
- 实现方式：前端读 entry.created_at 与「合入时间戳常量」比较；或者简单点——**前端从 message metadata 读一个 schemaVersion 字段**（本特性引入），老消息没这个字段走旧逻辑

### 模型路由删除

PR #955 的「maxTokens<131072 自动降级」是过度设计——LLM 自己知道当前模型输出预算，让它自己决定卡片大小。

### 高度弹性化

- 废弃固定 REPORT_INITIAL_HEIGHT=600
- 海獭在卡片 HTML 里用 `data-height="800"` 属性或 otterCard.resize() 桥 API 自定
- 系统只 clamp [100, 4000]

## 改动范围

- `api-contract/api/html-card.ts`：常量重定义（CARD_MAX_BYTES=65536，新增 CARD_MIN_HEIGHT=100、CARD_MAX_HEIGHT=4000、SCHEMA_VERSION）
- `src/interface-adapters/agent-runtime/tools/tool-helpers.ts`：校验逻辑更新（删 html-report 相关）
- `src/interface-adapters/agent-runtime/tools/tool-factory.ts`：speak 描述更新
- `web/src/lib/html-card.ts`：围栏识别不变（html-card 一种）
- `web/src/pages/conversation/HtmlCard.tsx`：默认展开逻辑 + 高度弹性
- 删除 `src/interface-adapters/agent-runtime/tools/html-report-contract-tool.ts`（不新建）

## 测试

- 单测：新校验逻辑（MAX=64KB、无 MIN、张数 2）
- 单测：老卡/新卡默认状态分流
- 单测：高度 clamp [100, 4000]
- golden gate

## 非目标

- ❌ 不动 CSP/sandbox
- ❌ 不改围栏语法（仍是 ```html-card）
- ❌ 不改 otterCard.submit 桥协议
- ❌ 不改 html-card-reply 回执格式

## 验证

### 实现清单

| 模块 | 改动 | 状态 |
|---|---|---|
| `api-contract/api/html-card.ts` | CARD_MAX_BYTES 8192→65536，新增 CARD_SCHEMA_VERSION/CARD_MIN_HEIGHT/CARD_MAX_HEIGHT | ✅ |
| `src/interface-adapters/agent-runtime/tools/tool-helpers.ts` | measureCardFenceBytes 单卡体积校验（只量围栏内 HTML）、hasCardFences 导出 | ✅ |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | speak 描述 8KB→64KB、含卡条目写入 cardSchemaVersion metadata | ✅ |
| `src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts` | 契约文档更新（默认展开、data-height、otterCard.resize） | ✅ |
| `src/usecases/conversation/send-entry.ts` | CreateSpeakEntryInput 新增 metadata 字段 | ✅ |
| `src/usecases/ports/otter-tool-client.ts` | createSpeakEntry 接口新增 metadata 参数 | ✅ |
| `src/bootstrap/clients.ts` | 传递 metadata 到 send-entry | ✅ |
| `web/src/lib/html-card.ts` | re-export 新增 CARD_SCHEMA_VERSION/CARD_MIN_HEIGHT/CARD_MAX_HEIGHT | ✅ |
| `web/src/lib/mappers.ts` | LocalMessage 新增 cardSchemaVersion 字段、mapEntryDTO 透出 | ✅ |
| `web/src/lib/card-bridge.ts` | otterCard.resize(height) 桥 API | ✅ |
| `web/src/pages/conversation/HtmlCard.tsx` | schemaVersion≥2 默认展开、data-height 属性解析+clamp | ✅ |
| `web/src/pages/conversation/MessageList.tsx` | cardSchemaVersion 透传链路 | ✅ |

### 测试结果

- 后端单测：23 passed（validateSpeakBody 新校验 + hasCardFences）
- 前端单测：45 passed（html-card 常量 + card-bridge resize API + useCardBridge clamp [100,4000]）
- 全量测试：256 文件 / 3087 passed
- `cd web && npx tsc --noEmit`：0 错误
- ESLint：0 error
- `npm run lint:intent`：通过
- `npm run build`：成功

## 后续

- PR2：决策简报三层改造（decision-briefing.md + BIG_OTTER/SMALL_OTTER + 模板库）
