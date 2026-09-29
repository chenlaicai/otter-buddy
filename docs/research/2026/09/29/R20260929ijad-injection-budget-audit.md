---
doc_type: research
id: R20260929ijad
title: 注入面体积深入分析：工具精拆 + 按需加载可行性 + skill 索引审计
summary: 首请求注入面 ~26.7K token 中工具 schema 占 ~60%（39 个工具 ≈25K 字符）。逐工具实测显示体积呈长尾分布（top10 占 46%）。根因分析：schema 每轮全量重发是默认设计选择非必须（根 1），工具供需靠人维护映射表只胀不缩（根 2）。SDK 核实：setActiveToolsByName 公开方法 + transcript toolsAdded 持久化 + provider mid-convo 能力位齐备——根因级解法「轻目录+意图驱动按需激活」成立，大獭首请求 27K→~7K；预算闸/任务级白名单/元工具加载均否决（症状管理/映射表未动/三重代价）。
created_in_conversation: 1d3437f9-ae46-488f-824b-d67936791165
causal_links:
  issues: [1235, 1230]
  from: [F20260929tdrv]
tags: [injection-budget, tool-schema, skill-index, entropy-reduction]
modules:
  - src/interface-adapters/agent-runtime/tools/
  - src/frameworks/agent/
  - .pi/skills/
---

## 背景与口径

- 搭档 9/29 21:32：「1232已合入，你直接开工来继续深入分析这些工具/skill过大问题」
- 前置：#1230（27K 实测）、#1232/F20260929tdrv（39 条 description 合理性审视完毕，本文不再动文案）
- token 估算口径：中文密集文本按 字符/1.6 粗估；issue #1230 的「31,600 字符 ≈27K」实为含参数 schema 全文 + 序列化开销的实测，本文逐工具数据用源码块近似（desc+param 段），总量 25,056 字符与 issue 口径的差异来自序列化开销与 builtin 7 工具（~10K）

## 首请求注入面全景（大獭，2026-09-29 实测）

| 层 | 字符 | ≈token | 性质 |
|---|---|---|---|
| 工具 schema（39 自定义） | ~25.1K（源码块）+ builtin 7 件 ~10K | ~27K（issue 口径） | 每轮常驻 |
| SYSTEM.md | 6,923 | ~4.3K | 每轮常驻 |
| skill 索引（14 个 frontmatter） | 4,272 | ~2.7K | 每轮常驻 |
| 档案+保留段+未读 | — | ~3K | 换世首请求 |
| **合计** | | **~37K** | |

skill 全文懒加载（F20260724skch），SYSTEM.md 身份段（大獭定义/通信模型/编排职责等）未在本次单独计——本审计聚焦「工具 + skill 索引」两个搭档点名对象。

## 一、工具逐个体积分层（实测 39 个）

按 desc+param 段字符排序，**长尾分布明显：top10 占 46%（11.4K/25.1K）**：

| 分层 | 工具 | 字符 | 判定 |
|---|---|---|---|
| **重载头部（>900）** | search_memory 2047 / manage_healing_events 1794 / restart_otter 1175 / wait 1073 / get_related 1015 / merge_pr 952 / link_memory 929 / create_linked_resource 928 / triage_signal 912 / yield 911 | 11.4K | 多为参数 schema 重（search_memory 参数 1377 字符）而非 description 啰嗦；均为高频或硬校验工具，常驻合理 |
| **腰部（400-900）** | speak 787 / resolve_signal 742 / halt_otter 712 / list_rhi_signals 671 / query_dispatch_ledger 659 / add_terminology 595 / update_artifact_status 595 / query_signals 591 / sync_docs 572 / list_artifacts 547 / list_messages 518 / unhalt_otter 507 / search_messages 482 / dissolve_otter 476 / set_context 468 / get_memory_detail 450 / get_message 442 / workspace_write 437 | 9.7K | 混合区：高频（speak/记忆）+ 低频管理件（signals/artifacts/workspace） |
| **轻尾（<400）** | search_terminology / create_otter / unlink_memory / get_context / delete_context / get_active_participants / workspace_read / get_html_card_contract / workspace_list / create_scheduled_task / workspace_info | 3.5K | 裁无可裁 |

**关键发现：体积大头在参数 schema 不在 description**——search_memory 参数段 1377 字符（detail_level 枚举 + content_type 多选 + expand_context 等），manage_healing_events 参数 1327 字符（batch_resolve 五个 filter 参数）。tdrv 审视过的 description 文本反而不是体积主因。

## 二、按需加载可行性（根因级方案，SDK 链路核实）

**搭档 9/29 21:41 方向纠正**：「不要上来就搞一大堆兜底/限制机制，从第一性原理出发先分析根因」。根因分析：

- **根 1：schema 是序列化说明书，但每轮都在重发**——session 创建时静态塞入后每轮原样重发是默认设计选择，不是必须如此。schema 的价值集中在首次接触（学会怎么调）和调错时（纠正），后续轮次边际贡献趋零。
- **根 2：工具供需靠人维护映射表**（manifest/白名单），配置永远滞后于任务，映射表只胀不缩——这才是「只增不减」斜坡的真正来源。

### SDK 核实结论：根因级解法由公开 API 直接支持

核实锚点（node_modules/@earendil-works/pi-coding-agent/dist）：

| 能力 | 锚点 | 性质 |
|---|---|---|
| `AgentSession.setActiveToolsByName(names)` | core/agent-session.d.ts:327 | **公开方法**：运行时改活跃工具集，「Changes take effect on the next agent turn」 |
| `ExtensionContext.setActiveTools(names)` | core/extensions/types.d.ts:1005 | extension handler 内同样可用 |
| transcript 持久化 `toolsAdded/toolsRemoved` | pi-ai `SystemMessage` 协议；agent-session.js:848 `_restoreToolsFromTranscript` | 换 session 自动恢复工具集——跨换世一致 |
| provider 能力位 | `supportsMidConvoToolAdditions`（OpenAI Responses compat）/ `supportsMidConvoToolChanges`（Anthropic compat）/ `supportsToolSearch`（OpenAI Responses，客户端执行工具搜索） | 主流链路原生支持会话中途改工具 |
| 运行时注册 | `ExtensionContext.registerTool()`（types.d.ts:950）；无公开 unregister——但 setActiveTools 是「激活/失活」语义，规避了单向门问题 | 备用 |

### 方案：轻目录 + 意图驱动的按需激活（动摇根 1 + 根 2）

1. **首轮轻载**：活跃工具集 = 核心高频件（speak/yield/记忆三件套/bash/read 等 ~10 个，~5K），其余 29 个仅以「名字+一句话触发条件」轻目录进 prompt（~2K）
2. **按需激活**：獭输出未激活工具的调用 → 系统拦截 → `setActiveToolsByName` 就地激活该工具（完整 schema 下轮可见）→ 返回「已激活，请重试」的错误提示让模型重调。不断一拍工作流（错误-重试是 agent loop 原生语义）
3. **供需因果链**：工具供给由「模型实际调用意图」驱动，不靠人事先声明白名单——根 2 的映射表消失
4. **跨 session 一致**：`toolsAdded` 进 transcript，换世自动恢复

与此前否决的「A1 元工具」的本质区别：补全由系统在意图检测时自动完成，不依赖 LLM 主动喊 load_tool，无发现性问题、无断拍。

### 被取代的旧方案（留档）

- ~~路 B 预算闸~~：**不做**——症状管理（装栏杆承认失控）；根 1 解决后体积随需求自然涨落
- ~~A2 任务级白名单~~：**不做**——仍是人维护映射表（根 2 未动），被「意图驱动激活」完全取代
- A3 参数 schema 分层（枚举/filter 语义挪到调错时的错误提示里）：**保留**，与本方案正交——「调错时教会」正是信息归位到被需要的时刻，头部工具再省 3-5K

### 风险与开放问题

- 「调用未激活工具」的拦截点在 Otter 侧（buildCustomTools execute 包装）还是 SDK 侧（unknown tool 处理），实现期定
- 轻目录的「一句话触发条件」质量决定激活率——可直接复用 tdrv 审视过的 description 首句
- provider 不支持 mid-convo 工具变更的降级：fold into leading system message（SDK 自动处理，compat 位已声明）
- 大獭本体收益：核心 10 件 ~5K + 目录 2K ≈ 7K vs 现 27K，首请求省 ~20K

## 三、skill 索引审计（14 个 frontmatter，4,272 字符）

description 是触发门（模型靠它决定何时 read 全文），逐条看是否都是触发必需信息：

| skill | frontmatter 字符 | 判定 |
|---|---|---|
| adversarial-review | 431 | **偏长**：Precondition 段（异体执行原则+模型分配规则）是执行期约束不是触发信号，可移入正文（触发只靠 Use when），估省 ~150 字符 |
| otter-summon | 409 | **偏长**：Precondition（MUST search_memory 否决史）同理是执行约束，估省 ~120 字符 |
| post-merge-cleanup | 361 | 触发词列举（"已合入"/"合了"/"merged"）是触发必需，保留 |
| worktree-isolation | 348 | Precondition（MUST trigger BEFORE）是触发信号本身，保留 |
| 其余 10 个 | 219-307 | 合理（Use when/Not for/Output 三段式紧凑） |

**可省 ~270 字符（~170 token）——芝麻，不建议单独立 PR**；若做预算闸顺手带上即可。

## 四、预算闸方案（路 B）

**已否决**（搭档 9/29 21:41 方向纠正：不搞兜底/限制机制）。留档备查：若根因方案落地后体积仍异常增长，说明新工具真有需求，届时再讨论是否需要预算答辩机制。

## 建议落地顺序（根因优先，2026-09-29 21:41 后修订）

| 序 | 项 | 类型 | 收益 | 风险 |
|---|---|---|---|---|
| 1 | **轻目录 + 意图驱动按需激活**（根 1+2 结构性解法） | 架构改动：buildCustomTools 包装 + 轻目录生成 + setActiveToolsByName 激活流 | 大獭首请求 27K→~7K；小獭同步受益 | 中：激活拦截点选择、轻目录质量、provider 降级 |
| 2 | A3 参数 schema 分层（枚举/filter 语义挪到调错提示） | 头部 3-4 个工具参数改造 | 再省 3-5K | 首次调对率下降（用错误提示教学补偿） |
| 3 | skill frontmatter 2 处精简 | 顺手带入 | ~170 tok | 无 |

~~预算闸、任务级白名单、元工具动态加载~~：均否决（症状管理/人维护映射表/三重代价），理由见 §二。

## 未决（呈搭档）

- 根因方案（轻目录+按需激活）是否进入方案设计阶段——这是架构级改动，建议走 requirement-analysis 出正式方案
- 「核心常驻工具集」的边界（哪些算每轮必需——初判 speak/yield/记忆三件套/编码五件/healing/wait 约 10 个）
