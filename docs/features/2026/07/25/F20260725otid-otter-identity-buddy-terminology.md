---
id: F20260725otid
title: otter-identity-and-buddy-terminology
doc_type: feature

summary: |
  为海獭团队建立身份认知体系，并让身份注入在真实流程中真正生效：
  1. 身份文案：新增 prompts/identity/BIG_OTTER.md（海獭团队首领 + 搭档的
     工作+生活伙伴，生动但克制）与 SMALL_OTTER.md（大獭创建的专门执行者，
     编码只读 + 协作工具完整，干完即走），首次 invoke 按类型注入。
  2. 注入链路修复：旧实现以"无 session 记录"判定首次，但 create() 在创建时
     就持久化记录，身份注入（含改名前的旧版名称头部）从未在真实流程触发。
     改为 pendingIdentity 显式标记（create/reset）+ SessionRestore createdNew
     信号（文件丢失重建/进程重启兜底）双保险，注入成功才消费标记。
  3. 称呼统一：人类参与者在獭可见文本中统一为"搭档"（ protocol 关键字
     'user' 保留），平台 prompt 与术语库写明 user/用户=搭档 的映射。
  4. 平台层单一事实源：四条行为边界（不自我贬低/承认不确定/诚实优于服从/
     安全底线）适用于所有獭，放 .pi/SYSTEM.md；删除只写不读的死文件
     prompts/platform/SYSTEM_PROMPT.md 及其配置链，其独有好内容并入 .pi/SYSTEM.md。

causal_links:
  from:
    - F20260722ctx

status: draft
change_type: feature
tags: [identity, system-prompt, otter, buddy, terminology, session, injection]
modules:
  - prompts/identity/
  - .pi/
  - src/frameworks/agent/
  - src/interface-adapters/
  - data/terminology/
  - web/src/pages/conversation/
  - tests/

created_at: 2026-07-25
---

# F20260725otid Otter 身份认知体系 + 搭档术语统一

## 术语定义

| 术语 | 定义 |
|------|------|
| **搭档（buddy）** | 对话中的人类参与者（protocol 中的 `user`）。与 Otter 是一起干活的关系：拥有最终决策权，Otter 保持独立判断。不是主仆，也不是客服与客户 |
| **身份注入** | 首次 invoke 时把身份文案作为用户消息前缀注入 session（SDK 无公开 systemPrompt 覆盖 API，冷启动模型下只能走消息前缀） |
| **pendingIdentity** | PiSessionFactory 内的待注入标记集合：create/reset 时标记，注入成功才消费 |
| **createdNew** | SessionRestore 返回信号：本次恢复创建了全新 session（文件丢失/损坏重建），新上下文中没有身份内容 |
| **平台 prompt** | `.pi/SYSTEM.md`，SDK ResourceLoader 自动注入、所有獭共享。本 feature 后是平台层唯一事实源 |
| **身份文件** | `prompts/identity/BIG_OTTER.md` / `SMALL_OTTER.md`，按獭类型在首次 invoke 时注入 |

## 背景

搭档问大獭"你是谁"，得到的回答是"我是大獭，你的 AI 编程助手，可以帮你分析需求/写代码/审查代码"。不满意的两点：

1. **定位太窄**：otter 系统的初衷是帮搭档完成工作+生活的多场景事务（编程、对答、research 等），不是专门的编程助手
2. **没有个性与边界**：日常对话缺人味（但也不要浮夸）；身份认知不止于自我介绍，还要约束行为

讨论确认的定位：

- **大獭** = 海獭团队的首领 + 搭档的工作生活伙伴。持续在场，简单任务直接执行，专门硬活创建小獭（开发者/检视者等，各挂专门 skill/tool）
- **小獭** = 大獭按需创建的临时执行者，任务结束解散
- **人类** = 搭档。弃选"主人"（与"AI 是独立个体、有批判性思维"冲突，预设服从）和"用户"（SaaS 黑话，与语气目标不符）；项目名 otter-buddy 天然对应"搭档"

## 方案设计

### 1. 三层身份体系

| 层 | 位置 | 内容 | 作用范围 |
|----|------|------|----------|
| 平台层 | `.pi/SYSTEM.md` | 对话环境规则 + 身份认知（决策vs判断、验证来源、四条行为边界、搭档定义与 user 映射） | 所有獭（SDK 自动注入） |
| 类型层 | `prompts/identity/BIG_OTTER.md` / `SMALL_OTTER.md` | 大獭：首领角色、语气风格；小獭：被创建、聚焦本职、权限说明、干完即走 | 按类型，首次 invoke 注入 |
| 专属层 | create_otter 的 systemPrompt 参数 | 小獭的本职职责（由大獭编写） | 单只小獭 |

四条行为边界（不自我贬低、不确定就说不确定、诚实优于服从、守住安全底线）经搭档确认**适用于所有獭**，放平台层；身份文件只保留类型特有内容，不重复。

### 2. 注入链路修复（本 feature 最关键的 bug fix）

**旧链路（死代码）**：`_invokeInternal` 以 `!existingSession` 判定首次 invoke。但 `create()` 走 `createSessionAndPersist` 在创建时就持久化了 agent_sessions 记录 → 首次 invoke 时记录已存在 → `isFirstInvoke` 恒 false → 身份注入在真实流程中从未触发（改名前的旧版名称头部同样从未生效）。

**新链路（双保险）**：

```
create() / reset()          SessionRestore.restoreOrCreate()
      │                              │
      ├─ pendingIdentity.add()       ├─ 文件丢失/损坏重建 → createdNew=true
      ▼                              ▼
   _invokeInternal: needsIdentity = createdNew || pendingIdentity.has()
      │
      ├─ 成功 → pendingIdentity.delete()（失败保留，重试仍注入）
      ▼
   buildIdentityPrefix(otterId, otterType) → 消息前缀注入
```

- **显式标记**（pendingIdentity）：声明式意图，不依赖 SDK 行为细节
- **createdNew 信号**：覆盖进程重启（pendingIdentity 是内存集合）和 session 文件丢失/损坏的恢复路径；restore 先于注入判定执行，顺序保证信号可用
- **成功才消费**：invoke 失败（LLM 报错、搭档 abort）时标记保留，重试仍注入
- `options` 缺省时 `isFirstInvoke` 标志也保证传递（旧实现直接置 undefined 的隐藏 bug 一并修复）
- 类型判定以 `otterConfig.otterType` 为准（与工具门控同一事实源），DB 只查 name；未知类型按小獭处理（保守默认，schema CHECK 约束下不可达）
- 身份文件缺失/未配置目录时构造期打 warn（不再静默降级）；otters 表无记录时打 warn 并跳过

### 3. SDK 事实：parentSession 仅是血缘元数据

经 SDK 源码（pi-coding-agent 0.80.x, dist/core/session-manager.js）验证：

- `SessionManager.create(cwd, dir, { parentSession })` 只把 parentSession 写入新 session 文件 header，新 session 的 fileEntries 仅含 header，**不拷贝父 session 任何消息进上下文**
- 全 SDK 无读取父消息合并进子上下文的路径；parentSessionPath 唯一读取方是 session 列表 UI 的 buildSessionInfo

**推论**：reset/重启獭生后的新 session 上下文为空，身份必须显式重新注入（本 feature 的 pendingIdentity/createdNew 机制），且不存在"链带回旧身份导致重复注入"的问题。已知残余边界：首次注入的 invoke 被 abort 时 session 文件可能已含身份消息而标记保留，重试会在同 session 再注入一次——罕见且无害（身份文本稳定），有意不处理（代码注释已记录）。

**版本依赖**：createdNew 对"进程重启"的兜底成立的前提是 SDK 延迟写入（首条 assistant 消息前 session 文件不落盘，已在 0.80.10 源码验证 `_persist` 的 `hasAssistant` 检查）。package.json 为 `^0.80.10`，若 SDK 升级后改为提前写 header，open 将成功、createdNew=false、内存标记已丢 → 身份静默不再注入。SDK 升级后需重新验证此行为。

### 4. 搭档术语统一

- **獭可见文本全部改"搭档"**：发言石名册、对话历史标签 `[搭档]`、speak 参数说明与错误提示、abort 中断消息 `[搭档中断]`（含前端兜底）、3 处工具描述、2 处 skill references、平台 prompt
- **保留**：protocol 关键字 `'user'`（SenderType、speak 传参）、代码注释、日志——developer-facing
- **映射说明（两层兜底）**：`.pi/SYSTEM.md` 搭档段落明确"protocol、工具参数、代码与日志中的 `user`/"用户"均指搭档"（覆盖獭读代码场景）；术语库种子新增"搭档"词条（aliases 含"用户"）
- 术语库旧词条同步（大獭=搭档的唯一持久 Otter 等），manage-terminology 测试 fixture 同步

### 5. 平台层单一事实源

`prompts/platform/SYSTEM_PROMPT.md` 是死文件：`platformPrompt` 字段标注 @deprecated 且只写不读，实际注入的只有 `.pi/SYSTEM.md`。两份文件各自演化已形成实质分歧。

处理：死文件独有的好内容（边界判定、"可验证的错误事实"限定语与"无法验证的判断"兜底、完整安全风险列表、尊重但不盲从）并入 `.pi/SYSTEM.md` 并去重（"最终决策权"出现三次合并为一处，决策vs判断与边界判定合并，核心原则并入行为边界）；删除死文件及 `platformPromptFile` 全链路配置；`platform-prompt-loader.ts` 改名 `prompt-loader.ts`（平台 prompt 概念已删，避免误导）。

## 决策记录

| 决策点 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 人类称呼 | A. 用户 B. 主人 C. 饲养员 | **D. 搭档** | 项目名 otter-buddy 天然对应；"主人"与 AI 独立个体定位冲突（预设服从）；"用户"是 SaaS 黑话；protocol 关键字 'user' 保留、映射写清 |
| 行为边界位置 | A. 写进大獭身份文件 | **B. 平台层所有獭共享** | 搭档确认四条边界适用于所有獭；身份文件只留类型特有内容，避免重复漂移 |
| 死文件 SYSTEM_PROMPT.md | A. 保留继续维护两份 | **B. 合并后删除** | 只写不读，改了无效；双平台 prompt 各自为政比单文件缺失更危险（对抗检视 B1） |
| 首次判定 | A. `!existingSession` | **B. pendingIdentity + createdNew 双保险** | create 时记录已持久化，A 恒 false（feature 死代码）；显式标记声明意图，createdNew 覆盖进程重启与文件重建 |
| 标记消费时机 | A. 判定时即消费 | **B. 注入成功后消费** | invoke 失败（abort/LLM 报错）时重试仍需注入（对抗检视 B2） |
| abort 首次注入后重试重复 | A. 检测 session 文件是否已含身份 | **B. 不处理** | 罕见（abort 恰好打在首次 invoke）且无害（身份文本稳定）；检测复杂度不值 |
| 身份文件加载失败 | A. 静默降级 | **B. 构造期 warn** | 本特性核心内容无声消失不可接受（对比 ResourceLoader 对 0 skills 有 warn 的既有先例） |

## 对抗检视记录（两轮）

**第一轮**：B1 死文件 SYSTEM_PROMPT.md（阻塞，已删）；S1 speak 参数"人类接管"；S2 前端 `[用户中断]` 兜底；S3 reset 丢身份；S4 静默降级；S5 小獭权限描述失真（与工具白名单矛盾，可能误导小獭拒绝平台指令）；S6 类型双事实源；S7 零测试覆盖；O1/O4/O5 均已处理。

**第二轮**：B1 **create 路径不标记导致整个 feature 是死代码**（阻塞，根本修复）；B2 标记提前消费；S1 restore 重建路径；S2 destroy 不清理集合；S3 测试绕过 isFirstInvoke 接线；S4 frontmatter 引用已删概念；S5 平台 prompt 冗余稀释；S6 注释误导；O1-O5 均已处理或记录。

**第三轮**（合并 main #87 后）：无阻塞。S1 合并引入的前端 `[用户中断]` 残留（stopStream 乐观兜底，已改）；S2 B1 无回归锁（补真实 create/reset/destroy 路径测试）；S3 isFirstInvoke→消息前缀接线未覆盖（提取 buildUserMessagePrefix 并补测试）；O 级：小獭权限描述精确化（无 invite/dissolve）、skill 文件英文 user 残留、session-restore 非 ENOENT 路径测试、createdNew 兜底的 SDK 版本依赖（见上文"版本依赖"）。

## 改动清单

| 文件 | 改动 |
|------|------|
| `prompts/identity/BIG_OTTER.md` | 新增：首领角色、语气风格（生动但克制） |
| `prompts/identity/SMALL_OTTER.md` | 新增：被创建、聚焦本职、编码只读+协作工具完整、干完即走 |
| `.pi/SYSTEM.md` | 搭档段落（含 user 映射）、行为边界四条、合并死文件独有好内容并去重 |
| `prompts/platform/SYSTEM_PROMPT.md` | 删除（死文件） |
| `src/frameworks/agent/pi-session-factory.ts` | pendingIdentity 机制（create/reset 标记、成功消费、destroy 清理）；identityPromptDir 配置 + 加载 + 缺失 warn；buildIdentityPrefix（otterConfig 为准、未知类型保守、ghost warn）；options 缺省也传 isFirstInvoke；删 platformPromptFile 链 |
| `src/frameworks/agent/session-restore.ts` | SessionRestoreResult + createdNew（重建路径 true / open 成功 false） |
| `src/frameworks/agent/prompt-loader.ts` | 改名（原 platform-prompt-loader.ts）+ loadPromptFile |
| `src/main.ts` | 装配 identityPromptDir，删 platformPromptFile |
| `src/interface-adapters/http/controllers/message-controller.ts` | 名册/历史标签 → 搭档 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | speak 参数说明 + 错误提示 + 3 处工具描述 → 搭档 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | `[搭档中断]` |
| `web/src/pages/conversation/index.tsx` | abort 兜底 `[搭档中断]` |
| `.pi/skills/requirement-analysis/references/*.md` | 用户 → 搭档（意图锚语境） |
| `data/terminology/seed-terminology.json` | 新增"搭档"词条（aliases 含用户）；旧词条同步 |
| `tests/frameworks/agent/identity-prefix.test.ts` | 新增 11 用例：注入内容（big/small/未知类型/ghost/frontmatter 剥离/降级 warn）+ 触发链路（标记消费/失败保留/createdNew/旧 session 不注入/options 缺省） |
| `tests/frameworks/agent/session-restore.test.ts` | 新增 5 用例：createdNew 信号全路径 |
| `tests/interface-adapters/agent-invoker.test.ts` | 中断文案断言同步 |
| `tests/usecases/memory/manage-terminology.test.ts` | fixture 同步新种子文案 |

## 测试计划

**单元测试**（已实施，合并 main 后 567+ 全绿）：

- buildIdentityPrefix：大獭/小獭正文注入、frontmatter 剥离、otterConfig 优先于 DB type、未知类型按小獭、ghost 返回空+warn、目录缺失降级+warn
- 触发链路：pendingIdentity 标记→注入→成功消费；失败保留；createdNew 无标记也注入；旧 session 不注入；options 缺省标志仍传递
- 消息前缀拼接（buildUserMessagePrefix）：首次身份叠加在专属 prompt 之前、非首次仅 prompt、ghost 降级
- pendingIdentity 回归锁（真实路径）：create()/reset() 标记、destroy() 清理
- SessionRestore：无记录+有配置 → createdNew；无记录无配置 → 抛错；open 成功 → 非 createdNew；ENOENT → 重建 createdNew；open 无效状态 → 重建 createdNew；open 非 ENOENT 错误 → 重建 createdNew

**手工验收**：

1. 新建对话问大獭"你是谁" → 回答体现首领+搭档定位，不说"AI 编程助手"，不自我贬低
2. 让大獭创建小獭干活 → 小獭发言体现本职聚焦，被问身份时知道自己是小獭
3. 重启獭生/归档 session 后再对话 → 身份认知仍在（pendingIdentity/createdNew 生效）
4. 对话历史中人类消息显示 `[搭档]`；speak 传 'user' 正常交还发言权
5. 启动日志无"身份文案缺失"warn（prompts/identity 就位时）

## 验收标准

- [ ] 大獭自我介绍符合首领+搭档定位，语气生动不浮夸
- [ ] 小獭知道自己的来源、职责边界与生命周期
- [ ] create/reset/restore 重建三条路径首次 invoke 均注入身份
- [ ] 獭可见文本无"用户/人类操作者"残留，user=搭档 映射可查（SYSTEM.md + 术语库）
- [ ] 四条行为边界对所有獭生效（平台层单一事实源）
- [ ] 全部既有测试通过，新增 16 用例覆盖注入内容与触发链路
