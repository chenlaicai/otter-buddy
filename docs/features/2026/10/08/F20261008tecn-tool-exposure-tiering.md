---
id: F20261008tecn
title: 工具面分层暴露（EazoTack 式工具瘦身 v1：deferred + tool_search 按需激活）
change_type: feature
capability_test: "n/a: prompt/配置层改动 + SDK 声明面行为，验证面 = 331 files / 4979 tests 全绿 + 真 LLM 冒烟（glm-5.3 全链路：tool_search→add_terminology→speak）"
status: implemented
created_at: 2026-10-08
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  - F20260820a4rt
  - F20260821a5cb
  - F20261008pi11
summary: 低频工具从每轮必达的 system prompt 声明面移出（exposure=deferred），由 pi 1.1 内置 tool_search（BM25）按需搜出激活——23 工具的常驻描述预算中约 10 个低频工具移出，真 LLM 冒烟验证全链路可用
intent:
  problem: "海獭 23 个工具全量 direct 注入，add_terminology/manage_healing_events 等低频工具占用每轮 token 预算（近 30 个 session 频率统计：此类工具调用 14-41 次 vs bash 2290 次），工具描述还持续膨胀（R4/R7 规则写入 description）"
  expected_effect: "低频工具移出常驻声明面 → 每轮 system prompt token 减约 15-25%；任务需要时 LLM 经 tool_search 搜索激活，功能无损；工具冷启动漏用风险由 tool_search 描述的触发词与观察期兜底"
---

# F20261008tecn 工具面分层暴露（EazoTack 式工具瘦身 v1）

## 背景

- 洞察来源：Eazo/Qoni 深入洞察（工作区 `eazo-insight-2026-10.md` + `eazo-to-otter-optimization.md`）——EazoTack 框架 15 核心工具 + 1 个 invoke_skill 元工具，成本降 1/3
- pi 1.1（F20261008pi11 刚升级）原生提供同型机制：`ToolExposure = direct | model-only | codemode | deferred | hidden`，SDK customTools 直接支持 `exposure` 字段
- 搭档 2026-10-08 拍板「三点合并开工，直接做」

## 频率分档依据（近 30 个 session 的 `"name":"..."` 调用统计）

| 档 | 工具（调用次数） | 处置 |
|---|---|---|
| 高频核心 | bash(2290) read(343) edit(311) speak(184) yield(177) write(104) grep(83) set_context(74) search_memory(74) | direct（现状） |
| 中频 | wait/workspace_*/create_linked_resource/manage_healing_events/sync_docs/get_html_card_contract 等 (31-55) | direct（v1 保守） |
| 低频 | halt_otter(14) resolve_signal(14) unhalt_otter(14) merge_pr(15) triage_signal(15) list_rhi_signals(17) query_dispatch_ledger(17) restart_otter(36) + schema 噪音组（30 整，实为极低频） | **deferred** |

deferred 名单（config/tool-manifest.json `toolExposure` 段）：add_terminology、delete_context、unlink_memory、update_artifact_status、create_scheduled_task、query_dispatch_ledger、list_rhi_signals、triage_signal、unhalt_otter、halt_otter、resolve_signal、merge_pr、restart_otter、workspace_info、get_html_card_contract——15 个。

## 变更清单

### 1. tool-manifest-loader.ts：toolExposure 段解析
- `ToolManifest` 接口新增 `toolExposure?: Record<string, "direct" | "deferred">`
- `validateToolExposure()`：值域校验（仅开放 direct/deferred，codemode/model-only/hidden 是 pi 内部语义不开放配置）；不合规 → error 日志 + 返回 null（fallback 硬编码默认 = 全 direct，fail-open）
- 导出 `TOOL_EXPOSURE_VALUES` 常量供 lint 与单测共用

### 2. config/tool-manifest.json：15 工具标 deferred
- schemaVersion 保持 2（toolExposure 可选字段，向后兼容 v2 读取方）

### 3. tool-builder.ts：打标
- `BuildCustomToolsParams` 新增 `toolExposure?`；map 转换时 deferred 工具带 `exposure: "deferred"` 字段
- **deferred 工具的 description 保留**——它是 tool_search BM25 的索引语料，不可为空

### 4. pi-session-factory.ts：接线 + 激活集重建（本 PR 最关键的机制细节）
- `loadToolExposureFromManifest()`：进程内缓存读取 manifest（仅首次读盘）；readOnly 合成路径不启用
- `_createSessionWithTools`：
  - **注册白名单**（tools 数组）仍传全量含 deferred——deferred 工具必须留在白名单内，否则被 `_isAllowedTool` 剔除出注册表，tool_search 永远搜不到
  - **激活集**：pi SDK 的 tools 数组同时充当初始激活清单（`initialActiveToolNames` 语义），deferred 工具留在数组里会被立即声明给模型（agent-session.js `_isActivatable` 对具名非 MCP 工具恒真）——**两者耦合无法在 SDK 入参层分离**，故创建后立即 `session.setActiveToolsByName([...coding, ...direct 自定义, "tool_search"])` 重建激活集
  - deferred 工具最终状态：已注册、未激活、可搜索——正是 tool_search 发现机制的前提（它只搜「非激活」工具）

### 5. model-runtime-registry.ts：注册 tool_search 扩展
- `DefaultResourceLoader` 的 extensionFactories 加 `createToolSearchExtension()`（pi 1.1 内置，BM25 检索）
- SDK 模式不自动加载内置扩展（pi docs/sdk.md），必须显式注册
- 已有 `await this.resourceLoader.reload()`（:149）——工厂加载依赖它，tool_search 工具注册进 registry

## 真 LLM 冒烟验证（glm-5.3，隔离实例）

场景：deferred 的 add_terminology + direct 的 speak，任务「把术语獭浴存进术语库然后 speak 说 done」。

结果（probe 脚本，worktree 内已清理，过程记录在对话）：
```
初始声明集: []（deferred 未声明 ✓）
PRE state.tools: speak, tool_search（激活集正确 ✓）
消息流: user → assistant(toolCall: tool_search) → toolResult → assistant(toolCall: add_terminology, toolCall: speak) → ...
```
**模型发现工具不在声明集 → 主动调 tool_search（BM25 命中 add_terminology）→ 激活 → 调用 → speak 汇报**——完整按需发现链路行为正确。

冒烟过程中定位并绕过的三个坑（记录供后续）：
1. pi SDK `model` 参数传 selector 对象 `{api, id, provider}` 会走 settings 默认解析路径并触发 `baseUrl undefined` 崩溃（provider-attribution.js `isOpenRouterModel`），传 `ModelRuntime.getModel()` 返回的完整对象正常——疑似 pi 1.1.0 SDK bug，规避即可
2. 外部传入的 ResourceLoader 必须自己 `await reload()`，SDK 只 reload 自建的——otter registry 已有该调用，纯 SDK 用户注意
3. mimo token-plan key 打 anthropic 端点 401——冒烟用 glm key + glm 端点

## 测试

- `tests/frameworks/config/tool-manifest-loader.test.ts`：+4 用例（合法解析/字段缺失/非法值/非对象），43 tests 总
- `tests/frameworks/agent/tool-exposure.test.ts`（新）：4 用例——deferred 打标、缺省全 direct（向后兼容）、description 保留（索引语料）、execute 路径不受影响
- 全量：331 files / 4979 tests 全绿；tsc 0 error；eslint 改动文件干净

## 风险与观察项

| 风险 | 缓解 |
|---|---|
| 工具冷启动漏用（LLM 不知道该搜） | tool_search 描述自带触发指引；deferred 名单刻意避开高频工具；观察期 1-2 周看 healing 台账是否出现「找不到工具」类反馈 |
| BM25 中文查询词被 tokenize 过滤（`[a-z0-9]`） | deferred 工具 description 中英混合写入（现有描述已含英文关键词）；观察期关注 |
| manifest toolExposure 与 types/tools 白名单漂移 | lint-tool-manifest.mjs 已校验工具名存在性；后续可加 exposure 键存在性校验（未做，v1 依赖单测） |

## 与相关机制的关系

- **F20260820a4rt/F20260821a5cb（manifest v2）**：toolExposure 挂在同一个 manifest 上，类型路由（otterType 白名单）管「谁能用」，exposure 管「何时对模型可见」——正交两维
- **F20261008pi11（pi 1.1 升级）**：本特性是 1.1 能力的首个消费
- **token 经济学方向**（eazo-to-otter-optimization.md 方向一）：本文档即方向一落地；方向二（缓存优先组装）另行推进
