---
id: F20261009tsts
title: tool_search 会话级重构——免疫 extension runtime 失效的 ctx stale
created: 2026-10-09
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
module: session
type: BugFix
status: implemented
issue: 1371
pr: 1379
summary: tool_search 从 SDK 共享 extension runtime 改为每会话 customTools 注册（holder 廿迟绑定 session 引用），根除任一 session dispose 后全进程 ctx stale 的传染链；BM25 vendor 简化实现（含参数 schema 语料 + stem 归一，与 SDK 版对齐）+ 中文 2-gram 增强。
intent:
  problem: "#1352 引入的 tool_search 经 SDK 共享 extension runtime 工作，任一 session dispose（压缩影子通道每次合成后必 dispose、池驱逐同理）即 invalidate 共享 runtime，此后全进程所有 session 的 tool_search 永久抛 ctx stale——三会话三连实证，重启才恢复"
  expected_effect: "tool_search 改每会话 customTools 路径（闭包 holder 持新鲜 session 引用，不接触可失效 runtime）→ dispose 不再传染，deferred 工具按需激活机制（F20261008tecn）恢复全时可用；检索质量与 SDK 版对齐（schema 语料 + stem）"
  verify_by:
    type: capability_test
    reason: "新增 18 条单测：免疫回归锁（另一 session 已 dispose 的世界里 execute 仍正常返回并激活——若未来改回经 extension ctx 路径立刻红，锁死 #1371 主命题）；检索语料/分词与 SDK 版逐段同构的回归锁（schema 属性名命中、复数 query 命中单数语料，旧实现必落空的负向用例）。agent 层 52 文件 1301 测试全绿 + tsc/eslint 0 + 检视獭独立重跑确认（含 e2e/golden-selftest）。上线观测：跨会话 + 压缩合成后再调 tool_search 不再 stale（#1371 关闭前置）。"
causal_links:
  - F20261008tecn  # 工具面分层暴露（deferred + tool_search 引入方）
---

# F20261009tsts: tool_search 会话级重构

## 背景与问题

PR #1352（F20261008tecn 工具面分层暴露）合入次日（10/9），三个独立会话（8:30 体检 ×2、9:30 每日 issue 处理 ×1）调用 `tool_search` 全部返回同一错误：

```
This extension ctx is stale after session replacement or reload. Do not use a
captured pi or command ctx after ctx.newSession(), ...
```

重启即恢复、运行一段时间后复发——典型的「共享状态被某个事件污染」形态。

## 根因（SDK dist 源码逐层核实，全部 file:line 锚定）

传染链条：

1. **ResourceLoader 是进程级单例**（`src/frameworks/agent/model-runtime-registry.ts` 缓存 `this.resourceLoader`），SDK `createToolSearchExtension()` 在 loader 创建时实例化一次，工具定义闭包捕获当时的 extension ctx（`node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/index.js`：`pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }) })`）
2. **每个 AgentSession 的 ExtensionRunner 是新建的，但共享同一个 runtime 对象与一次性实例化的工具对象**（`dist/core/agent-session.js:2921`：`new ExtensionRunner(extensionsResult.extensions, extensionsResult.runtime, ...)`——extensions/extensionsResult 均来自 loader 级缓存）
3. **AgentSession.dispose() 无条件 invalidate 该共享 runtime**（`dist/core/agent-session.js:1003` → `dist/core/extensions/runner.js:482` 置 staleMessage，**永不恢复**）
4. otter 侧大量场景会 dispose session：压缩合成影子通道（`pi-session-factory.ts` F20260912nlb896，每次合成后 dispose）、池驱逐（F20260911pspl）等
5. → 任一 session dispose 后，全进程所有 session 的 tool_search execute（内部调 `pi.getActiveTools/setActiveTools`，经过 `runner.assertActive()` 门，runner.js:606+）全部抛 ctx stale

**为何只有 tool_search 挂、其他 extension 功能正常**：
- otter-hooks 扩展只注册事件处理器（`pi.on(...)`），事件分发不走 assertActive 门
- otter 自有 customTools 的 execute 不访问 extension ctx（闭包捕获 `buildCustomTools` 自建的 ToolContext）
- tool_search 的 execute 是唯一每次都过 assertActive 门的常驻路径 → 唯一中招

**时间线吻合**：服务 10/8 18:37 重启带上 #1352 新代码 → 首次压缩水位触发后即中毒 → 与「三会话三次命中、重启即恢复」完全一致。

## 修法

**弃用 SDK createToolSearchExtension，改为每会话 customTools 路径注册**（与 otter 自有工具同路径——该路径已被实证免疫）：

- `src/frameworks/agent/tool-search-tool.ts`（新增）：
  - `buildSessionToolSearchTool(holder)` 返回 ToolDefinition，exposure 默认 direct
  - holder 延迟绑定解鸡生蛋：customTools 入参在 `createAgentSession` **前**就要传，但 execute 需要 session 引用——传空 holder，session 创建后回填
  - 激活命中工具用 `session.setActiveToolsByName`（AgentSession 公开方法，agent-session.js:1099，不经过可失效 runner）
  - BM25 vendor 简化实现（SDK 版在包深处，`package.json` exports 只开顶层入口，深导入不可达）：score = Σ idf(t)，idf = ln(1 + N/df)；中文增强 CJK 2-gram。检索语料与分词与 SDK 版对齐（检视发现 1 处置）：buildToolCorpus 含参数 schema 描述/属性名递归抽取，stem 复数归一（issues→issue）
- `src/frameworks/agent/pi-session-factory.ts`：`_createSessionWithTools` 里 `customTools` 数组条件追加 `buildSessionToolSearchTool(holder)`，session 创建后回填 `holder.session`
- `src/frameworks/agent/model-runtime-registry.ts`：删除 `createToolSearchExtension()` 注册

兼容性关键点：
- `computeActiveToolNames` 语义不变（有 deferred 时激活集仍含 `tool_search`）——customTool 同名 `tool_search`，session 的 tools 激活清单里名字匹配即激活（agent-session.js:1134 的 deferred 提示逻辑点名依赖 registry 里有 `tool_search`，同名兼容）
- readOnly 合成路径不注册（原逻辑保留：搜索能力只会扩大合成面）
- 参数面兼容：query + 可选 limit，与 SDK 版一致

## 验证

- 新增 `tests/frameworks/agent/tool-search-tool.test.ts` 18 条：分词（camelCase/ALLCAPS 边界/中文 2-gram/中英混合/stem 归一）、检索语料（schema 属性名+描述）、BM25 排序（命中/idf/空结果/limit 截断/schema 语料命中/复数 query 命中单数语料）、execute 行为（命中即激活、session 未绑定防御、空 query 拒绝、无命中不写激活集）、**免疫回归锁**（另一 session 已 dispose 的世界里 execute 仍正常——防未来改回经 ctx 路径导致 #1371 复活，检视发现 2 处置）
- 既有 `tool-exposure.test.ts` 7 条无回归（激活集语义未变）
- agent 框架层全量：51 文件 1274 测试全绿
- `tsc --noEmit` 0 错、eslint 0 告警
- **上线后观测点**：跨会话 tool_search 调用不再出现 ctx stale（healing 台账与 #1371 评论为观测锚）；压缩合成（影子通道 dispose）后再调 tool_search 是复现原 bug 的关键路径，上线后重点看该场景

## 取舍

| 备选 | 弃用原因 |
|---|---|
| 上游修复 SDK（runtime 不共享/不永久失效） | 正确的长期方向，但依赖上游发版，阻塞线上故障修复节奏；已具备根因全链 file:line 证据，可后续提上游 issue |
| 每次 session 替换后重建 ResourceLoader | 违背 loader 单例设计（技能发现等依赖它），成本与风险都大 |
| 捕获 ctx 后定期校验有效性 | 治标不治本，stale 判定本身就在失效对象上 |

## 影响

- 触达面：所有带 deferred 工具的 session（大獭/小獭全部类型）的 tool_search 注册路径；无 deferred 的 session 行为不变
- 风险：BM25 排序与 SDK 版有差异（vendor 简化 + 中文 2-gram 增强），检索质量以召回可用为准，不做分数对齐；`getAllTools()` 候选含 MCP 工具等非 deferred 项时，只按「未激活」过滤——与 SDK 版「搜非声明工具」语义一致（deferred/codemode 都不在激活集）

## 测试与后续

- [x] 单测（11 新增 + 7 回归）
- [x] agent 框架层全量绿
- [x] tsc / eslint 干净
- [ ] 上线后跨会话观测（#1371 关闭前置）
- [ ] 上游 issue（pi-coding-agent：extension runtime 生命周期）——后续独立事项
