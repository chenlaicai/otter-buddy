---
id: F20260716sq6e
title: pi-agent-core-vs-coding-agent
doc_type: feature

# 记忆索引
summary: |
  - **特性编号**：F20260716sq6e - **变更类型**：research / design-decision / migration - **影响模块**：frameworks/agent、系统整体架构


# 元数据
status: locked
change_type: research / design-decision / migration
tags: [architecture, agent-framework, pi, design-decision, migration]
modules: [src/frameworks/agent/, src/interface-adapters/agent-runtime/]

# 时间
created_at: 2026-07-16
---


# pi-agent-core vs pi-coding-agent 技术选型重新分析

## 元信息

- **特性编号**：F20260716sq6e
- **变更类型**：research / design-decision / migration
- **影响模块**：frameworks/agent、系统整体架构
- **关联 ADR**：D14（S2 Capability Module Architecture Design）
- **关联研究**：docs/research/R20260716x2k9-pi-capability-analysis.md、docs/research/R20260717y3k8-pi-integration-analysis.md


## [design-time]

> 重新对比 pi-agent-core 与 pi-coding-agent 两条技术路径，覆盖 SDK 嵌入模式、开发成本、架构适配度、维护风险等多维度，产出推荐方案。
>
> **设计共识**：维持路径 A（pi-agent-core），接线已有 SkillLoader；路径 B 作为备选保留（需 V1-V3/V8 验证通过）。

## 1. 背景与动机

### 1.1 前序决策回顾

ADR D14（2026-07-09）记录了 Agent 框架选型决策：

> **最终决策**：使用 pi-ai + pi-agent-core 两个包，不使用 pi-coding-agent
>
> **反方论点**：Pi 主要是 coding agent，非通用 agent 框架；依赖第三方维护
>
> **决策依据**：用户明确要求（UA-S2-1/2/3），模块化设计允许按需使用

### 1.2 本次重新分析的原因

前序分析存在以下盲区：

1. **未分析 pi-coding-agent 的 SDK 嵌入模式**：pi-coding-agent 不仅是 CLI 产品，还导出了完整的 SDK API（`createAgentSession`、`AgentSessionRuntime`），可作为库嵌入应用
2. **未量化"自建成本"**：pi-agent-core 路径需要自建 Session 管理、Compaction、工具系统、Skills 等，这些成本在前序分析中被低估
3. **未评估 pi-coding-agent 的内置能力对 Otter 的适用性**：pi-coding-agent 的 Extensions/Skills/Prompt Templates 体系可能比自建方案更成熟

### 1.3 本次分析范围

对比两条技术路径：

| 路径 | 包依赖 | 集成方式 |
|------|--------|---------|
| **A: pi-agent-core（当前方案）** | `pi-agent-core` + `pi-ai` | 直接使用 AgentHarness API |
| **B: pi-coding-agent SDK 嵌入** | `pi-coding-agent`（内含 `pi-agent-core` + `pi-ai`） | 使用 AgentSession SDK API |

两条路径都是**进程内嵌入**（非 CLI 子进程），区别在于抽象层级和内置能力。


## 2. Pi monorepo 分层架构

```
@earendil-works/pi（monorepo, 71.6k stars, MIT）
├── pi-ai          -- LLM 抽象层（20+ Provider 统一 API）
├── pi-agent-core  -- Agent 运行时（Agent + AgentHarness，工具调用/状态/事件流）
├── pi-coding-agent -- 编码 Agent 产品（CLI + SDK，read/bash/edit/write + Session + Extensions + Skills）
└── pi-tui         -- 终端 UI 库（差分渲染）
```

依赖关系：

```
pi-coding-agent
  ├── pi-agent-core (^0.80.7)
  ├── pi-ai (^0.80.7)
  └── pi-tui (^0.80.7)

pi-agent-core
  └── pi-ai (^0.80.7)
```

**关键事实**：pi-coding-agent 包含 pi-agent-core，不是替代关系，而是上层封装。


## 3. 路径 A 详细分析：pi-agent-core（当前方案）

### 3.1 架构

```
┌─ Otter 进程 ─────────────────────────────────────────────┐
│                                                           │
│  frameworks/agent/                                        │
│    pi-harness-factory.ts  ← 自建：冷启动工厂              │
│    system-prompt-builder.ts ← 自建：Prompt 组合           │
│    agent-session-store.ts   ← 自建：Otter↔Pi session 映射│
│                                                           │
│  interface-adapters/                                      │
│    agent-runtime/tools/                                   │
│      tool-factory.ts       ← 自建：16 个 Otter 工具      │
│    skill-adapter/                                         │
│      skill-loader.ts       ← 自建：Skills 扫描和过滤     │
│                                                           │
│  pi-agent-core (npm)                                      │
│    AgentHarness            ← Pi 原生                      │
│    JsonlSessionRepo        ← Pi 原生                      │
│    NodeExecutionEnv        ← Pi 原生                      │
└───────────────────────────────────────────────────────────┘
```

### 3.2 当前实现代码量

| 文件 | 行数 | 职责 |
|------|------|------|
| `pi-harness-factory.ts` | 363 | 冷启动工厂、harness 创建、compaction 触发 |
| `system-prompt-builder.ts` | 38 | 动态 system prompt 组合 |
| `agent-session-store.ts` | 42 | Otter ID ↔ Pi Session ID 映射 |
| `tool-factory.ts` | 487 | 16 个 AgentTool 创建 |
| `skill-loader.ts` | 72 | Skills 扫描和按 Otter 类型过滤（已实现，未接入） |
| **总计** | **1002** | 全部自建 |

### 3.3 自建能力清单

| 能力 | 状态 | 说明 |
|------|------|------|
| Session 管理 | Pi 原生 | JsonlSessionRepo，Otter 只存 session ID |
| Compaction | **自建触发逻辑** | 监听 token 用量，超阈值调用 `compact()` |
| System Prompt | **自建组合器** | 静态层 + 动态层，函数模式 |
| 事件流映射 | **自建** | Pi 事件 → SSE 事件 → 前端 |
| Skills | **已实现（未接入 Agent）** | `skill-loader.ts`（72 行）已实现目录扫描 + otterType 过滤，但未接入 `pi-harness-factory.ts` |
| Extensions | **不适用** | pi-agent-core 无 Extension 概念 |
| 自动 Compaction | **自建** | 需要手动判断阈值并调用 |
| Abort | 自建 | 通过 activeHarnesses Map 管理 |

### 3.4 优势

1. **包体积小**：pi-agent-core 1.2MB vs pi-coding-agent 12.5MB
2. **无冗余依赖**：不引入 pi-tui（终端 UI，Otter 不需要）
3. **完全可控**：每个集成点都是自建代码，可精确适配 Otter 需求
4. **抽象层级低**：直接操作 AgentHarness，无中间层开销
5. **已被验证**：已实现并跑通，有 21 条修订记录支撑

### 3.5 劣势

1. **自建成本持续累积**：Compaction 触发、Session 生命周期、工具权限等都需要自建
2. **Skills 未接入 Agent**：`skill-loader.ts` 已实现（72 行），但未接入 `pi-harness-factory.ts`，需要接线工作
3. **无 Extension 机制**：未来扩展需要自建插件系统
4. **升级耦合**：pi-agent-core API 变化时，自建适配层需要同步更新
5. **Compaction 触发粗糙**：当前仅基于 token 阈值，无上下文溢出自动处理


## 4. 路径 B 详细分析：pi-coding-agent SDK 嵌入

### 4.1 架构

```
┌─ Otter 进程 ─────────────────────────────────────────────┐
│                                                           │
│  frameworks/agent/                                        │
│    pi-session-factory.ts   ← 薄封装：调用 createAgentSession│
│    tool-factory.ts         ← Otter 自定义工具              │
│                                                           │
│  pi-coding-agent SDK (npm)                                │
│    createAgentSession()    ← 工厂函数                      │
│    AgentSession            ← 核心会话类                    │
│      .prompt()             ← 发送消息                      │
│      .subscribe()          ← 事件监听                      │
│      .compact()            ← 手动压缩                      │
│      .abort()              ← 中断生成                      │
│      .setActiveToolsByName() ← 动态工具切换                │
│      auto-compaction       ← 内置自动压缩                  │
│    SessionManager          ← 内置会话管理                  │
│    loadSkills              ← 内置 Skills 加载              │
│    createCodingTools       ← 内置编码工具工厂              │
│    ExtensionRuntime        ← 内置扩展系统                  │
│    ModelRegistry           ← 内置模型注册                  │
│    SettingsManager         ← 内置设置管理                  │
└───────────────────────────────────────────────────────────┘
```

### 4.2 SDK API 关键接口

```typescript
// 创建会话
const { session, extensionsResult } = await createAgentSession({
  cwd: process.cwd(),
  model: myModel,
  thinkingLevel: "medium",
  tools: ["read", "write", "edit", "bash"],  // 内置编码工具
  customTools: [myOtterTool],                // 自定义工具注入
  sessionManager: mySessionManager,          // 可覆盖
  settingsManager: mySettingsManager, // 可覆盖
  resourceLoader: myResourceLoader,   // 可覆盖
});

// 核心操作
session.prompt(text, options);         // 发送消息
session.subscribe(listener);           // 事件监听
session.abort();                       // 中断
session.compact(customInstructions);   // 手动压缩
session.setActiveToolsByName(names);   // 动态工具切换
session.getTools();                    // 获取工具列表

// 事件类型（AgentSessionEvent）
// - message_update, turn_end, agent_end
// - compaction_start, compaction_end
// - tool_execution_start, tool_execution_end
// - entry_appended, session_info_changed
// - auto_retry_start, auto_retry_end
```

### 4.3 内置能力 vs Otter 需求

| 能力 | pi-coding-agent 内置 | Otter 适配方式 |
|------|---------------------|---------------|
| Session 管理 | SessionManager（JSONL） | 直接使用，可自定义 SessionManager |
| Compaction | 自动 + 手动，含阈值检测 | 直接使用自动 compaction |
| Skills | loadSkills + formatSkillsForPrompt | 直接使用，从 skills/ 目录加载 |
| Extensions | 完整扩展系统 | 可选使用，Otter 工具通过 customTools 注入 |
| 编码工具 | read/bash/edit/write | **Otter 需要**（完善自身），通过 `tools` 配置启用 |
| 模型管理 | ModelRegistry + 多 Provider | 直接使用 |
| Prompt Templates | 内置模板系统 | 可选使用 |
| 事件流 | AgentSessionEvent（扩展了 AgentEvent） | 直接映射到 SSE |
| Abort | 内置 | 直接使用 |
| 信任管理 | ProjectTrustStore | 可选使用 |

### 4.4 优势

1. **自建代码大幅减少**：
   - Compaction 触发逻辑 → 内置自动 compaction
   - Session 生命周期 → 内置 SessionManager
   - Skills 加载 → 内置 loadSkills
   - 工具权限 → 内置 tools/excludeTools/noTools 配置
   - 事件流映射 → AgentSessionEvent 已扩展

2. **更成熟的 Session 管理**：
   - 分支（branching）、恢复（resume）、fork/clone
   - 自动 compaction（阈值 + 上下文溢出检测）
   - Session 迁移和版本管理

3. **Skills 和 Extensions 生态**：
   - 与 Claude Code 共享 Skills 格式（SKILL.md）
   - 可复用社区 Skills（pi-skills 仓库）
   - Extension 机制支持未来扩展

4. **升级友好**：SDK API 比底层 AgentHarness API 更稳定

5. **RPC 模式可选**：未来可切换到 RPC 模式实现进程隔离

### 4.5 劣势

1. **包体积大**：12.5MB（含 pi-tui、图片处理等 Otter 不需要的依赖）
2. **抽象层级高**：AgentSession 封装了 Agent + Session + Extensions + Skills，调试链更长
3. **耦合风险**：pi-coding-agent 的设计目标是编码 Agent，可能引入 Otter 不需要的行为
4. **内置工具需按需配置**：read/bash/edit/write 对 Otter 有用（完善自身），但需按獭类型差异化启用
5. **pi-tui 依赖**：终端 UI 库对 Web 应用完全无用，但作为依赖被引入
6. **已有实现需重写**：当前 pi-harness-factory.ts 已跑通，切换需要重写


## 5. 维度对比

### 5.1 开发成本

| 维度 | 路径 A（pi-agent-core） | 路径 B（pi-coding-agent SDK） |
|------|------------------------|------------------------------|
| 初始集成 | 已完成（1002 行自建代码，含 SkillLoader） | 需要重写（预计 ~200 行薄封装） |
| Session 管理 | Pi 原生 + 自建映射 | 内置 SessionManager |
| Compaction | 自建触发逻辑（~30 行） | 内置自动 compaction |
| Skills 体系 | 已实现 SkillLoader（72 行），需接线到 Agent | 内置 loadSkills |
| Extensions | 需要从零设计 | 内置 ExtensionRuntime |
| 工具系统 | 自建 ToolFactory（487 行） | customTools 注入 + tools 配置 |
| 事件流 | 自建映射（~50 行） | AgentSessionEvent 直接映射 |
| **总自建代码量** | **1002 行（含 SkillLoader） + 未来 Extensions** | **~200 行薄封装** |

### 5.2 运行时性能

| 维度 | 路径 A | 路径 B | 说明 |
|------|--------|--------|------|
| 启动延迟 | 低（懒加载 pi-agent-core） | 低（createAgentSession 3.4-6.6ms，V8 实测） | 模块首次加载 1839ms 为一次性开销，非每次冷启动 |
| Tool 调用延迟 | 极低（函数调用） | 极低（函数调用） | 两者相同 |
| 内存占用 | 低（1.2MB 包 + harness 实例） | 中（12.5MB 包 + session 实例） | 差异主要在初始加载 |
| 包安装大小 | ~2MB（pi-agent-core + pi-ai） | ~15MB（含 pi-tui 等） | 部署镜像影响 |

### 5.3 架构适配度

| 维度 | 路径 A | 路径 B |
|------|--------|--------|
| 整洁架构兼容 | 高（Gateway 接口精确适配） | 中（SDK API 需要适配层） |
| Otter 工具模型 | 完全自定义 | `tools` 启用编码工具 + `customTools` 注入 Otter 工具 |
| 多獭差异化 | activeToolNames 精确控制 | tools + excludeTools 组合控制 |
| 冷启动模型 | 已实现（R17） | 已验证（§6.3 V8：3.4-6.6ms） |
| Session Chain | 自建 previousSessionId | 需自定义 SessionManager（§6.4 V4） |

### 5.4 维护风险

| 维度 | 路径 A | 路径 B |
|------|--------|--------|
| API 稳定性 | 低层 API，变化频率高 | 高层 API，更稳定（但 pre-1.0 均无稳定性保证） |
| 升级成本 | 自建适配层需要同步更新 | SDK 封装层吸收变化 |
| 功能遗漏风险 | 高（需要自建的能力多） | 低（内置能力丰富） |
| 过度封装风险 | 低 | 中（coding agent 的设计假设可能不匹配） |

### 5.5 API 稳定性详细分析

两个包当前均为 `^0.80.x`（pre-1.0），**均无 API 稳定性保证**。

| 包 | 版本 | 导出规模 | pre-1.0 风险 |
|---|------|---------|-------------|
| pi-agent-core | ^0.80.6 | 小（AgentHarness、Agent、JsonlSessionRepo 等核心类型） | 中：API 小而精，变化影响面可控 |
| pi-coding-agent | ^0.80.7 | 大（200+ 类型导出，含 Extensions/Tools/Session/UI） | 高：API 大而广，变化影响面大 |

**关键区别**：pi-agent-core 的 API 是 Otter 直接使用的底层接口（AgentHarness、Session、Events），变化时 Otter 必须适配。pi-coding-agent 的 SDK API 是更高层的封装，内部吸收了 pi-agent-core 的变化，但 SDK API 本身也可能变化。

**结论**：两条路径在 pre-1.0 阶段都面临升级风险，但风险性质不同——路径 A 是"底层 API 直接暴露"，路径 B 是"中间层 API 可能变化"。路径 B 的中间层理论上提供缓冲，但 pre-1.0 阶段缓冲效果有限。


## 6. 关键决策点分析

### 6.1 Otter 是否需要编码工具（read/bash/edit/write）？

**需要**。用户明确指出：Otter 系统搭建起来后，第一件事情是完善自身。这意味着 Otter 需要读写自己的代码、执行构建和测试。

| 场景 | 需要的工具 | 路径 A 支持方式 | 路径 B 支持方式 |
|------|-----------|----------------|----------------|
| 读取自己的代码 | read | 需要自建 | 内置 |
| 修改自己的代码 | edit/write | 需要自建 | 内置 |
| 执行构建/测试 | bash | 需要自建 | 内置 |
| 分析代码结构 | read + grep | 需要自建 | 内置 |

路径 A 要支持"完善自身"，需要自建 4 个编码工具。路径 B 开箱即用。

**这个需求变化直接影响推荐方案**：之前我论证"路径 B 的核心价值（编码工具）对 Otter 无用"，现在这个论点不再成立。路径 B 的价值从"Skills + Compaction"变为"**编码工具 + Skills + Compaction + Extensions**"，性价比显著提升。

### 6.2 Otter 是否需要 Skills 体系？

**需要但不紧急**。当前 Otter 的"指导性指令"通过 system prompt 静态层注入。未来可能需要：
- 按獭类型加载不同 Skill
- 运行时动态切换 Skill
- 社区 Skills 复用

**现有实现 vs pi-coding-agent 内置能力对比**：

| 能力 | 现有 SkillLoader（72 行） | pi-coding-agent loadSkills |
|------|--------------------------|---------------------------|
| 目录扫描 | ✅ 扫描 skills/ 下 SKILL.md | ✅ 相同 |
| Otter 类型过滤 | ✅ 按 otterType 配置过滤 | ✅ 按配置过滤 |
| 变量替换 | ❌ 不支持 | ✅ 支持模板变量 |
| 条件加载 | ❌ 不支持 | ✅ 支持 frontmatter 条件 |
| Prompt 模板化 | ❌ 不支持 | ✅ formatSkillsForPrompt |
| 社区 Skills 兼容 | ❌ 自定义格式 | ✅ 与 Claude Code 共享格式 |
| 代码量 | 72 行 | 内置（无需维护） |

**结论**：现有 SkillLoader 是基本实现，满足当前需求。pi-coding-agent 的 loadSkills 提供更丰富功能（变量替换、条件加载、模板化），但这些功能对 Otter 当前阶段非必需。"补充 Skills"的工作量从"自建 50 行"修正为"接线已有 72 行实现 + 按需增强"。

### 6.3 冷启动模型是否兼容 pi-coding-agent SDK？

**兼容**。两条路径都支持冷启动模型，核心流程相同：

```
路径 A: JsonlSessionRepo.open() → AgentHarness → prompt → 丢弃 → 数据已持久化
路径 B: createAgentSession() → AgentSession → prompt → 丢弃 → 数据已持久化
```

Session 数据通过各自的持久化机制（JsonlSessionRepo / SessionManager）保存在 JSONL 文件中，session 对象丢弃后不丢数据。冷启动不是路径 A 的排他优势。

**差异在于初始化开销**：

| | 路径 A | 路径 B |
|---|--------|--------|
| 创建对象 | AgentHarness（轻量） | AgentSession（含 Extensions/Settings/Skills/ModelRegistry 初始化） |
| 初始化开销 | 低（session.open + harness 创建） | 较高（Extensions 发现+加载 + Settings 解析 + Skills 扫描 + ModelRegistry 初始化） |
| 自动 Compaction | 不适用（harness 已释放） | 不适用（session 在 compaction 触发前已丢弃） |

**V8 验证结果**（2026-07-16 实测）：

| 场景 | 耗时 | 判定 |
|------|------|------|
| 模块加载（一次性） | 1839ms | 可接受（应用启动时懒加载） |
| createAgentSession（noTools） | 6.6ms（首次 18ms，后续 3-4ms） | **优秀** |
| createAgentSession（noTools + customTools） | 3.5ms | **优秀** |
| createAgentSession（默认配置） | 3.4ms | **优秀** |

**结论**：`createAgentSession()` 初始化开销 < 50ms，远低于阈值。冷启动模型与路径 B 完全兼容。路径 B 的 TCO 优势明确。

### 6.4 Session Chain（previousSessionId）是否兼容？

**需要验证**。Otter 使用自建的 `previousSessionId` 引用链实现 session chain。pi-coding-agent 的 SessionManager 是否支持这种模型，还是只支持 fork/branch。

### 6.5 包体积是否可接受？

pi-coding-agent 12.5MB 包含 pi-tui（终端 UI）和图片处理库（`@silvia-odwyer/photon-node`）。对 Web 应用完全无用。

**Tree-shaking 分析**：pi-coding-agent 的 SDK 入口（`dist/index.js`）导出了 pi-tui 的组件类型（如 `AssistantMessageComponent`、`FooterComponent` 等），但如果 Otter 代码不导入这些类型，打包工具（如 esbuild/rollup）可能将 pi-tui 排除。需要实际打包验证。

**部署场景分析**：
- Docker 镜像（通常 200MB+）：13MB 增量影响约 6%，可接受
- 单机部署（直接运行）：npm install 下载量增加 13MB，一次性开销
- CI/CD：npm install 时间增加约 2-3 秒

**结论**：包体积在现代部署环境下**不是关键决策因素**，但 pi-tui 的引入仍是技术债。建议通过 tree-shaking 验证实际增量。


## 7. 决策矩阵

| 评估维度 | 权重 | 路径 A（pi-agent-core） | 路径 B（pi-coding-agent SDK） |
|---------|------|------------------------|------------------------------|
| 初始开发成本 | 中 | ✅ 已完成（1002 行） | ⚠️ 需要重写（~200 行） |
| 后续开发成本 | 高 | ⚠️ 需接线 Skills + 自建 Extensions | ✅ 内置能力丰富 |
| 运行时性能 | 中 | ✅ 更轻量 | ⚠️ Extensions 初始化开销 |
| 架构适配度 | 高 | ✅ 完全可控 | ⚠️ 需要适配层，但无架构不兼容 |
| 维护成本 | 高 | ⚠️ 自建代码多 | ✅ SDK 封装吸收变化 |
| 生态兼容性 | 低 | ⚠️ 需要自建 | ✅ Skills/Extensions 生态 |
| API 稳定性 | 中 | ⚠️ pre-1.0，API 小而精 | ⚠️ pre-1.0，API 大而广 |
| 包体积 | 低 | ✅ 2MB | ⚠️ 15MB（tree-shaking 后待验证） |


## 8. 待验证项

在做出最终决策前，需要验证以下关键假设：

| # | 假设 | 验证方法 | 阻塞决策 |
|---|------|---------|---------|
| V1 | createAgentSession 冷启动初始化开销可接受 | PoC：测量 createAgentSession → prompt → 丢弃 循环的耗时 | 是 |
| V2 | `tools` + `customTools` 可完全控制工具集 | 检查 createAgentSession 返回的 session.getTools() | 是 |
| V3 | customTools 可注册 Otter 自定义工具 | PoC：注册 send_message 工具并调用 | 是 |
| V4 | SessionManager 支持 Otter 的 session chain 模型 | 检查 SessionManager API 是否支持 previousSessionId | 否（可自定义 SessionManager） |
| V5 | 自动 compaction 阈值可配置 | 检查 SettingsManager 的 compaction 配置 | 否（可手动触发） |
| V6 | AgentSessionEvent 包含足够的信息用于 SSE 映射 | 检查事件类型和数据结构 | 否（可扩展映射） |
| V7 | pi-tui 可被 tree-shaking 排除 | 实际打包验证 SDK 入口不导入 pi-tui 组件时的产物大小 | 否（影响包体积评估） |
| V8 | createAgentSession 初始化开销可接受 | **已验证**：3.4-6.6ms（远低于 50ms 阈值） | 已验证，路径 B 冷启动完全可行 |


## 9. 方案建议

### 9.1 推荐方案：转向路径 B（pi-coding-agent SDK），V8 已验证

**推荐路径 B 的理由**（性价比视角，基于"Otter 需要编码能力"需求）：

1. **编码工具是必需品**：Otter 需要完善自身（读写代码、执行构建/测试）。路径 B 开箱即用提供 read/write/edit/bash，路径 A 需要自建 4 个编码工具。

2. **内置能力叠加**：路径 B 提供编码工具 + Skills + 自动 Compaction + Extensions 生态，路径 A 需要逐一自建。

3. **包体积可接受**：15MB 中编码工具是 Otter 需要的，不是冗余。pi-tui 仍可通过 tree-shaking 排除（V7）。

4. **V8 验证通过**：`createAgentSession()` 初始化 3.4-6.6ms，远低于 50ms 阈值，冷启动完全可行。

**补充行动**：

1. 集成 `createAgentSession`（薄封装）
2. 注册 16 个 Otter 自定义工具（customTools：send_message、pass_talking_stone、search_memory、store_memory 等）
3. 配置混合工具集（编码工具 + Otter 工具共存）
4. 迁移现有 1002 行代码中的 Otter 逻辑到新集成层

### 9.2 替代方案：维持路径 A（pi-agent-core）

**适用条件**：

1. 路径 B 的 pre-1.0 API 稳定性风险不可接受
2. 团队决定暂不实现"完善自身"能力
3. 包体积是硬性约束

**路径 A 补充工作**：自建 read/write/edit/bash 四个编码工具 + 接线 SkillLoader + 升级 Compaction 策略


## 10. 用户意图锚

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-SQ6E-1 | Issue: 重新对比pi agent core和pi coding agent，重新做一次完整的技术选型分析 | 重新对比pi agent core和pi coding agent，重新做一次完整的技术选型分析 | 动作：重新对比；对象：pi agent core vs pi coding agent；范围：完整 | 对两条路径进行全面重新评估，不局限于前序分析已覆盖的维度 |


## 11. 决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| Agent 框架包 | 转向推荐 pi-coding-agent SDK（待 V8 验证） | 编码工具是必需品（完善自身），开箱即用能力更多，V8 初始化开销 < 50ms 时优势明确 |
| pi-agent-core | 备选方案 | 已有 1002 行代码，但需自建编码工具，长期维护成本更高 |
| Skills 体系 | 接线已有 SkillLoader 到 Agent | 已有 72 行实现，需接线而非从零自建 |
| Compaction 策略 | 升级为阈值 + 溢出检测 | 当前仅基于 token 阈值过于粗糙 |


## 12. 交叉审视修订记录

| # | 修订内容 | 来源 |
|---|---------|------|
| R1 | 代码行数修正：总计从 ~684 修正为 863（含 SkillLoader 72 行），tool-factory.ts 从 ~150 修正为 287 | 架构师-2 S1 |
| R2 | Skills 状态从"未实现"修正为"已实现（未接入 Agent）"，推荐方案从"自建"修正为"接线" | 架构师-2 S2 |
| R3 | 推荐理由重构：移除沉没成本论证，改为 TCO 视角 | 架构师-2 S3 |
| R4 | 包体积分析补充 tree-shaking 和部署场景分析，降级为非关键决策因素 | 架构师-2 S4 |
| R5 | 推荐方案标注为"有条件推荐"，待验证项与推荐关系明确 | 架构师-2 S5 |
| R6 | 新增 §5.5 API 稳定性详细分析，两个包均为 pre-1.0 | 架构师-2 S6 |
| R7 | §6.3 冷启动分析从"需要验证"升级为"语义冲突分析"，识别架构层面不匹配 | 架构师-2 S7 |
| R8 | §6.2 补充 SkillLoader vs pi-coding-agent loadSkills 能力对比 | 架构师-2 S8 |
| R9 | §6.3 从"语义冲突分析"修正为"初始化开销分析"——两条路径都支持冷启动，差异在初始化开销而非架构兼容性 | 用户纠正 |
| R10 | 决策矩阵架构适配度行路径 B 从 ❌ 恢复为 ⚠️ | 用户纠正 |
| R11 | 推荐理由移除"架构层面不匹配"论点，聚焦于性价比分析 | 用户纠正 |
| R12 | 决策矩阵架构适配度行路径 B 从"冷启动兼容，初始化开销待验证"修正为"需要适配层，但无架构不兼容"；§6.3 补充"冷启动不是排他优势"结论 | 用户纠正 |
| R13 | 推荐方案从"维持路径 A"改为"有条件推荐路径 A，待 V8 验证"；路径 B 从"备选方案"改为"等价方案"；§6.3 补充"V8 可能改变结论" | 架构师-2 审视 |
| R14 | §6.1 从"不需要编码工具"修正为"需要编码工具（完善自身）"；推荐方案从"有条件推荐路径 A"转向"推荐路径 B" | 用户纠正：Otter 需要完善自身，编码工具是必需品 |
| R15 | V8 验证通过：createAgentSession 初始化 3.4-6.6ms（远低于 50ms 阈值），路径 B 冷启动完全可行 | 实测验证 |
| R16 | §9.1 标题更新为"V8 已验证"、正文移除待验证措辞、补充行动替换为路径 B 集成工作项 | 架构师-2 指出 3 处不一致 |
| R17 | 代码行数修正：总计从 863 更新为 1002，tool-factory.ts 从 287 更新为 487，pi-harness-factory.ts 从 343 更新为 363，删除已移除的 tool-registry.ts（81行），skill-loader.ts 路径修正为 src/interface-adapters/skill-adapter/ | 审查者-1/审查者-2 指出行数与 HEAD 不一致 |
| R18 | 新增 §13 开发任务规划：将推荐方案（路径 B）转化为 8 个可执行开发任务，含验收标准；变更类型扩展为 migration | 架构师-1：用户指出分析完成后应推进代码实现 |
| R19 | §13.4/13.5 移除兼容性思维：删除回退方案、feature flag、渐进迁移，改为直接替换 | 架构师-1：用户指出不应考虑兼容性 |
| R20 | 架构师-2 对抗审视 7 项修正：P1 T2 从 noTools 改为 tools+customTools（§4.3/§4.5/§5.3/§13.3 同步修正）；P2 工具数量 8→16（§3.1/§3.2/§5.1/T3/§9.1）；P3 §5.2 启动延迟改为 V8 实测数据；P4 T1 移除 pi-agent-core 直接依赖；P5 Session Chain 补充到 T8 和验收标准；P6 行数 1002→1007/487→488；P7 验收标准补充框架层集成测试 | 架构师-2 对抗审视 |
| R21 | 审查者-2 第二轮 review 4 项修正：§4.2 移除 noTools: "builtin"（与 R20 tools+customTools 矛盾）；§9.1 pass_talking_stick→pass_talking_stone；§5.3 冷启动行更新为"已验证（§6.3 V8）"；§3.2 行数回退 R20 引入的错误（488→487/1007→1002），全局同步修正 | 审查者-1 第二轮 review |
| R22 | 审查者-2 第三轮 review 2 项修正：§5.3 Session Chain 行从"需要验证"更新为"需自定义 SessionManager（§6.4 V4）"（与 §6.4 结论一致）；§8 V2 验证项从 noTools 更新为 tools+customTools（与 R20/R21 方案一致） | 审查者-2 第三轮 review |


### 行为条目

| ID | 预期行为 | 来源 |
|----|---------|------|
| B-SQ6E-1 | 技术选型文档应覆盖 pi-coding-agent 的 SDK 嵌入模式，不仅限于 CLI 模式 | ← UA-SQ6E-1 "重新做一次完整的技术选型分析" |
| B-SQ6E-2 | 对比分析应包含开发成本、运行时性能、架构适配度、维护风险等多维度 | ← UA-SQ6E-1 "完整的" |
| B-SQ6E-3 | 文档应给出明确推荐方案和替代方案，而非仅列出选项 | 架构师设计原则 |

### 约束条件

| ID | 约束 | 理由 |
|----|------|------|
| C-SQ6E-1 | 不可引入 pi-tui 作为运行时依赖 | Otter 是 Web 应用，不需要终端 UI |
| C-SQ6E-2 | 工具系统必须支持按獭类型差异化 | 大獭/设计獭/检视獭需要不同工具集 |
| C-SQ6E-3 | 冷启动模型必须保留 | 用户决策 R17：每次发言创建 harness，完成后释放 |


## 13. 开发任务规划（路径 B 迁移实现）

基于 §9.1 推荐方案（转向 pi-coding-agent SDK），以下为具体开发任务：

### 13.1 迁移目标

将 Otter Agent 框架从 pi-agent-core（路径 A）迁移到 pi-coding-agent SDK（路径 B），保留冷启动模型和 Otter 自定义工具体系。

### 13.2 任务分解

| # | 任务 | 涉及文件 | 说明 | 依赖 |
|---|------|---------|------|------|
| T1 | 替换依赖 | `package.json` | 移除 `pi-agent-core` 直接依赖，添加 `pi-coding-agent`（内含 pi-agent-core + pi-ai） | 无 |
| T2 | 新建 `pi-session-factory.ts` | `src/frameworks/agent/pi-session-factory.ts` | 薄封装 `createAgentSession()`，替代 `pi-harness-factory.ts`。配置：`tools: ["read", "write", "edit", "bash"]` 启用编码工具，`customTools` 注入 Otter 工具，按獭类型差异化控制工具集 | T1 |
| T3 | 迁移工具注册 | `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 将 16 个 Otter 工具从 AgentTool 格式适配为 pi-coding-agent customTools 格式 | T2 |
| T4 | 迁移事件流映射 | `src/frameworks/agent/` 相关文件 | AgentSessionEvent → SSE 事件映射，替代现有 Pi 事件 → SSE 映射 | T2 |
| T5 | 迁移 Session 管理 | `src/frameworks/agent/agent-session-store.ts` | 适配 SessionManager，保留 Otter session ID 映射逻辑 | T2 |
| T6 | 接线 SkillLoader | `src/interface-adapters/skill-adapter/skill-loader.ts` | 将已有的 SkillLoader（72 行）接入 createAgentSession 的 skills 配置 | T2 |
| T7 | 清理旧代码 | `src/frameworks/agent/pi-harness-factory.ts` 等 | 移除路径 A 的自建代码（pi-harness-factory、system-prompt-builder 等） | T2-T6 |
| T8 | 验证测试 | 全量 | 确保冷启动模型、Otter 工具调用、事件流、Session Chain（previousSessionId）全部正常 | T1-T7 |

### 13.3 验收标准

1. `createAgentSession()` 替代 `AgentHarness` 作为 Agent 运行时入口
2. Otter 自定义工具（send_message、pass_talking_stone 等）通过 customTools 正常注册和调用
3. 编码工具（read/write/edit/bash）通过 `tools` 配置正确启用，按獭类型差异化控制
4. 冷启动模型保留：每次发言创建 session，完成后释放
5. 事件流映射正常：AgentSessionEvent → SSE → 前端
6. Skills 通过 SkillLoader 正常加载
7. Session Chain（previousSessionId）机制正常工作
8. 框架层集成测试覆盖核心路径

### 13.4 注意事项

- **直接替换，不保留路径 A 代码**：T7 清理与 T2-T6 同步进行，不做渐进迁移
- **不使用 feature flag**：路径 B 是唯一运行路径
- **不考虑向后兼容**：旧的 AgentHarness API 调用全部替换为 createAgentSession
