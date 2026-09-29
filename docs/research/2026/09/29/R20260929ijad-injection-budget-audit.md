---
doc_type: research
id: R20260929ijad
title: 注入面体积深入分析：工具精拆 + 按需加载可行性 + skill 索引审计
summary: 首请求注入面 ~26.7K token 中工具 schema 占 ~60%（39 个工具 ≈25K 字符）。逐工具实测显示体积呈长尾分布（top10 占 46%）；SDK 核实运行时 registerTool 通道存在但无 unregister，给出三条裁剪路径的可行性结论；skill 索引 4.3K 字符逐条审计发现 2 处可精简。
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

## 二、按需加载可行性（路 A，SDK 链路核实）

核实锚点（node_modules/@earendil-works/pi-coding-agent/dist）：
- `ExtensionContext.registerTool()`（core/extensions/types.d.ts:950）——**运行时动态注册通道存在**，extension handler 内可注册新工具
- `AgentSession` 构造期 `customTools?: ToolDefinition[]`（core/agent-session.d.ts:118）+ 私有 `_customTools`（:225）+ 私有 `_refreshToolRegistry`（:580）——session 级一次注入
- **无公开 unregisterTool/removeTool**——注册了只能增不能减（同 session 内）

三条路径评估：

### 路径 A1：元工具动态注册（load_tool 模式）
做一个常驻 `load_tool(name)` 元工具，调用后通过 extension 的 registerTool 把目标工具注册进来，后续轮可用。
- ✅ SDK 机制支持（registerTool 运行时可用）
- ⚠️ **延迟一拍**：注册后下一轮 LLM 才看见——「獭想用 X → 先 load → 下轮才能调」，工作流被打断
- ⚠️ **发现性问题**（9/4 教训：可用≠会用）：LLM 不知道有哪些可加载工具，元工具 description 得内嵌工具目录——目录本身又是注入面（39 个名字+一句话 ≈1.5K，省 7K 花 1.5K+一拍延迟）
- ⚠️ 单向门：误注册无法撤销

### 路径 A2：任务级 session 白名单细化（派工即裁剪）
现状已有 manifest 按獭**类型**（big/small）裁剪；升级为按**任务**裁剪——派工简报声明任务类别（如「审视」→ 不含 workspace/write/bash；「干活」→ 不含 signals/healing），create_otter 时算白名单。
- ✅ 零 SDK 改造（白名单机制现成，getOtterToolNamesForType + buildCustomTools）
- ✅ 无发现性问题——裁剪的是「这个任务大概率用不到的」，不是藏起来
- ⚠️ 误判代价：派工时声明错了类别，小獭干到一半缺工具（需要兜底：小獭可申请补发/大獭重启改派）
- 📊 收益估算：审视类小獭可裁 ~10K（编码工具里留 read/grep/find，裁 write/edit/bash + workspace/signals/artifacts）；大獭本体收益小（编排者什么都可能用到）

### 路径 A3：参数 schema 瘦身（头部工具）
top10 里参数 schema 超重的是 search_memory(1377)/manage_healing_events(1327)/restart_otter(790)/wait(821)——这些是**参数级契约**（枚举值、filter 语义），tdrv 已判定为「删了直接调错」。可做的是：低频参数从 schema 挪到工具返回的错误提示里（调错时教会），但牺牲首次调对率。
- 判定：**个别可做（如 batch_resolve 的五个 filter 参数可合并为一个 filter 对象描述），整体收益有限（~1-2K）**

### 结论
**推荐 A2（任务级白名单）为主、A3 个别打磨为辅；A1 不推荐**（延迟一拍 + 发现性成本 + 单向门，三重代价换 5-7K 不值）。A2 是小獭侧优化（大獭本体裁不动），与「小獭首请求 17K」现状叠加后审视獭可降到 ~10K 以下。

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

对齐 lint-prompt-size 思路，两个闸：
1. **工具 schema 闸**：CI 实测 39 工具 desc+param 序列化总字符，超上限（建议 26K，现值 25.1K + ~4% 余量）即红；单工具超 2K 字符警告（现值 top1 search_memory 2047）
2. **skill frontmatter 闸**：单个 SKILL.md frontmatter 超 450 字符即红（现值 top1 431），总量超 4.5K 警告

闸的价值在**拦增长斜坡**——27K 是「只增不减」一年涨出来的，有闸后新增工具必须先过预算答辩。

## 建议落地顺序

| 序 | 项 | 类型 | 收益 | 风险 |
|---|---|---|---|---|
| 1 | 路 B 预算闸（双闸） | lint 脚本，小 PR | 防回弹 | 无 |
| 2 | A2 任务级白名单 | manifest 扩展 + 派工简报模板加「任务类别」字段 | 小獭侧 ~5-10K | 误判缺工具（需兜底流程） |
| 3 | A3 个别参数瘦身 | batch_resolve filter 合并等 2-3 处 | ~1-2K | 首次调对率下降 |
| 4 | skill frontmatter 2 处精简 | 顺手带入闸 PR | ~170 tok | 无 |

A1（元工具动态加载）**不推荐**，理由见 §二。

## 未决（呈搭档）

- A2 的「任务类别」 taxonomy 怎么定（审视/干活/研究三类够不够）——进入实现前需方案细化
- 预算闸上限数值（26K/450 是否合适）拍板
