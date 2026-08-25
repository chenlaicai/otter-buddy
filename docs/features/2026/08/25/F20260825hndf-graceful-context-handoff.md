# F20260825hndf 优雅上下文交接（Graceful Context Handoff）

> 状态：方案完成，待实现
> 作者：mimo2（工程）、kimi（信息设计）
> 日期：2026-08-25
> 触发：搭档"具体如何压缩需要深入设计"+"不一定就这三个"
> 审查：待异体审视

---

## 0. 摘要

**问题**：7/16 的 F20260716zq9q 设计过「Handoff 优先于 Compaction」但从未实现。当前系统只有两条路——搭档嘴喊重启，或等到 87% 被 Pi SDK 粗暴压缩。缺中间的优雅通道。

**方案**：三层触发 × 四件套上下文包 × 三道降级防线。

**核心设计决策**：
1. **Post-turn 记录 + Pre-invoke 检查**：每轮 invoke 后记录 ctxTokens，下轮 invoke 前超 70% 自动触发
2. **四件套上下文包**：摘要（LLM 合成）+ 文件轨迹（机械提取）+ 近期原文（借用式切取）+ 活状态盘点（机械 checklist），总 ~10.7k token（~8% 窗口）
3. **可扩展判定框架**：四问（存活→断链→枚举型→保真）定位任何新状态源的携带方式
4. **永不阻塞 restart**：摘要失败→机械转储→空 summary→仍然重启

---

## 1. 三层触发

| 层 | 触发条件 | 动作 |
|---|---------|------|
| **Token 阈值自动** | ctxTokens ≥ ctxMax × 70%（pre-invoke 检查） | 自动交接 |
| **LLM 语义主动** | 海獭判断阶段完成，调 restart_otter(self) | 套模板 summary |
| **搭档手动 + 熔断强制** | 现有机制 | 独立通道 |

**阈值设计**：
- 70% handoff / ~87% SDK compaction，17% 缓冲区
- 小模型（≤32k）阈值升至 80%
- 可配置 `OTTER_HANDOFF_THRESHOLD`，默认 0.7

**与 Pi SDK compaction 的关系**：Handoff 是主动管理，Compaction 是被动保护，不冲突可共存。

---

## 2. 四件套上下文包

### 2.1 总览

| 件 | 内容 | 生成方式 | token | 生命周期 |
|---|------|---------|-------|---------|
| ① 结构化摘要 | 任务、决策、协作、下一步 | LLM 合成（Phase 1: 机械转储） | 1.2k | 每代重写（session.summary） |
| ② 文件轨迹 | 改过哪些文件 + 工作区存量 | 纯机械 | 1k | 借用式（otter_context，消费即删） |
| ③ 近期原文 | 搭档最后几轮原话 | 纯机械切取 | 8k | 借用式（otter_context，消费即删） |
| ④ 活状态盘点 | 6 类状态 checklist | 纯机械 | 0.5k | 借用式（otter_context，消费即删） |

**注入位置**：`session-helpers.ts` 的 `buildMessageWithContext`，件①走 session.summary，件②③④走 otter_context（跨 session 存活，首次 invoke 后删除）。

### 2.2 件① 结构化摘要模板

8 分区（kimi 设计）：
1. **下一步**（最高优先）：立即动作 + 阻塞项
2. **当前任务与完成标准**：一句话 + 可判定标准 + 状态
3. **关键决策与理由**（最多 5 条）：含已排除路径
4. **产物与锚点**：PR/文档/记忆/worktree/otter_context keys
5. **协作状态**：在场成员 + 悬置 yield + 进行中小獭（**来源：件④机械数据，不靠 LLM 回忆**）
6. **搭档上下文**：原话引用 + 节奏信号
7. **交接谱系**：每代一行
8. **长青信息指针**：memory fact entry_id 列表

**核心原则**：锚点优于复制（引用 ID 不复述，防衰减）、有损通道只传可接受损失的。

### 2.3 件② 文件轨迹

**两层提取**：
- Layer 1（精确）：SDK 的 read/write/edit 工具 → 直接提取 path
- Layer 2（启发式）：bash 命令正则匹配写操作模式（cat >, sed -i, tee, heredoc, cp, mv）

**渲染**：修改/创建与只读参考分级，含 worktree/分支、产物登记行。超 30 条目截断 + 指针回查。

**工作区存量**：`workspaceGateway.getWorkspacePath` + `fs.readdirSync` 列根目录一层。

### 2.4 件③ 近期原文

**切取规则**：
- 从 session 末尾往前取满 8k token
- 按 turn 边界对齐（复用 SDK `findCutPoint` 语义，不切半轮）
- 搭档消息 + speak 文本全文保留；工具结果截断 500 字符

**借用式生命周期**：每代重新切取最新 8k，上一代旧原文直接丢弃。不跨代累积——避免把 compaction 的病搬进 handoff。

### 2.5 件④ 活状态盘点

**6 类状态**（纯机械 checklist，空行也打印）：

| B# | 状态源 | 查询方式 |
|---|--------|---------|
| B1 | 发言石/悬置 yield | 最近 completed 消息.talkingStonePassedTo |
| B2 | 调度任务 | scheduledTaskRepo.getByConversationId + filter active |
| B3 | 工作区存量 | workspaceGateway + fs.readdirSync |
| B4 | 产物生命周期态 | list_artifacts → count by status + flagged |
| B5 | 未解决 healing | healingEventRepo.findByConversation → filter open |
| B6 | 进行中派工 | Turn.status='open' + conversation.activityStatus |

**生成时机**：交接时刻一次性执行，不滚动更新。

**判定框架**（可扩展）：
```
Q1 跨 session 存活？ → 否 = 不携带
Q2 新 session 不感知会断链？ → 否 = 按需自取
Q3 枚举型且 ≤20 行？ → 是 = 进盘点段
Q4 必须保真？ → 是 = 独立机械携带
                  → 否 = 进 LLM 摘要
```

---

## 3. 三道降级防线

| 防线 | 动作 | 触发条件 |
|------|------|---------|
| ① LLM 叙事合成 | readOnly invocation 生成结构化摘要 | 正常路径 |
| ② 机械状态转储 | list_artifacts + get_context + 近 N 条消息首行 | 摘要 LLM 失败 |
| ③ 空 summary 硬重启 | summary = 空，仍执行 restartSession | 机械转储也失败 |

**核心原则**：永不阻塞 restart。每一步失败都有下一级降级。

---

## 4. 竞态处理

| 场景 | 处理 |
|------|------|
| 多獭并发 invoke 同 otter | lockManager 保证串行；第二个 restart 撞 conflict 走认领 |
| Handoff 期间搭档发新消息 | 新 invoke 等锁，自动等待 |
| 熔断与 handoff 同时触发 | 串行检查（先 circuit-break → 再 handoff）；熔断先触发时 handoff 跳过 |
| 进程重启后 lastCtxTokens 丢失 | 可接受：重启后 session 也重建 |

---

## 5. 代码变更清单

### 新增文件

| 文件 | 位置 | 职责 |
|------|------|------|
| `file-trail-extractor.ts` | `src/frameworks/agent/` | 文件轨迹提取（SDK 提取器 + bash 正则 + 工作区 ls） |
| `recency-window.ts` | `src/frameworks/agent/` | 近期原文切取（复用 SDK findCutPoint 语义） |
| `state-inventory.ts` | `src/frameworks/agent/` | 活状态盘点（6 个查询聚合 + 渲染） |
| `handoff-package-builder.ts` | `src/frameworks/agent/` | 四件套编排器 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `agent-invoker.ts` | +lastCtxTokens / handoffInProgress / handleHandoff / generateHandoffSummary / buildMechanicalDump / buildSynthesisPrompt |
| `session-helpers.ts` | buildMessageWithContext +fileTrail +recencyWindow +stateInventory sections |
| `sdk-invoke-port.ts` | InvokeOptions.readOnly?: boolean |
| `pi-session-factory.ts` | readOnly 模式支持 |
| `circuit-breaker-helpers.ts` | TOKEN_WARNING_THRESHOLD 改为可配置 |

### 不改动

| 文件 | 理由 |
|------|------|
| `manage-session.ts` | restartSession 已满足需求 |
| Pi SDK | 不改第三方依赖 |

**总代码量**：~250-300 行新增

---

## 6. 实施分期

### Phase 0（零代码，今天）

- set_context 滚动状态约定（task_status + next_step）
- 手动交接摘要模板写入约定
- 交接谱系追踪约定

### Phase 1（MVP）

- 触发链路（pre-invoke 检查 + post-turn 记录）
- 机械四件套（文件轨迹 + 原文切取 + 状态盘点）
- 摘要先用机械转储（不走 LLM）
- otter_context 注入 + 消费即删

### Phase 2（完整）

- readOnly invoke 模式
- LLM 合成摘要（synthesis prompt）
- 完整降级链（synthesis → mechanical → empty）
- handoff fact 检索桥（create_linked_resource）

---

## 7. 不确定性与验证

| 项 | 风险 | 验证 |
|---|------|------|
| bash 文件提取召回率 | 正则遗漏多样 bash 写法 | Phase 1 跑历史 session 统计 |
| 8k 原文窗口够不够 | 经验估值 | 2-3 次真实交接回看 |
| 500 字符工具截断 | 可能切掉关键输出 | 试点观察 |
| readOnly 在 Pi SDK 无原生支持 | 靠 prompt 约束 + 工具白名单 | Phase 2 实测 |
| 预算 10.7k 是否准确 | 估算 | Phase 1 实测校准 |

---

## 8. 与历史设计的关系

| 文档 | 关系 |
|------|------|
| F20260716zq9q（conversation-session-architecture） | 本方案实现了其「Handoff 触发机制」段的未实现设计 |
| F20260824srst（自重启无限循环修复） | 本方案的 handleSelfRestartSignal 是 handoff 的参考模式；handoff 与自重启是独立通道 |
| F20260818cbkr（连续退化熔断） | 熔断是独立通道，handoff 不干扰熔断逻辑 |

---

## 9. 工作区文件索引

| 文件 | 内容 |
|------|------|
| `kimi-handoff-info-preservation.md` | kimi：信息保全方案（模板/生成方式/记忆联动/衰减治理） |
| `kimi-handoff-compression-profile.md` | kimi：压缩配比设计（四类信息四种形态/三件套容量配比） |
| `kimi-handoff-state-inventory.md` | kimi：状态源普查（12 个状态源/判定框架/四件套升级） |
| `kimi-mimo2-convergence.md` | kimi×mimo2：讨论收敛记录（存疑核实/查询序列最终版） |
| `mimo-handoff-engineering.md` | mimo2：触发链路工程方案（Q1-Q5 五个核心问题） |
| `mimo-handoff-three-piece-engineering.md` | mimo2：三件套代码集成方案 |
| `mimo-handoff-four-piece-addendum.md` | mimo2：四件套升级补丁 |
| `phase0-conventions-draft.md` | mimo2：Phase 0 零代码约定草案 |
