# F20260717q8kp -- 代码质量检视

## 元信息

- **特性编号**：F20260717q8kp
- **变更类型**：refactor
- **影响范围**：全仓库（src/、web/、reference/、tests/）
- **状态**：design-time

## 用户意图锚

不适用——本特性为架构师主导的代码质量检视，无用户需求表达。

## 背景

当前代码库经过快速迭代（2026-07-08 至 2026-07-16，共 37 个 PR），积累了多类质量问题。本次检视以"完整、完美，不残留兼容/迁移等临时代码"为目标，对全仓库进行系统性质量审计。

## 检视范围与方法

对以下区域执行深度扫描：
- `src/`（72 个 TypeScript 源文件，四层整洁架构）
- `web/src/`（前端 React 应用）
- `reference/`（旧代码归档目录）
- `tests/`（8 个测试文件）
- 构建配置（tsconfig、eslint、vitest、package.json）

---

## 发现汇总

### P0 -- 残留代码（必须删除）

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P0-1 | `reference/` 目录残留 | `reference/old-src/`（30 文件）、`reference/old-tests/`（14 文件） | 旧架构代码（domain/infra 模式），已被整洁架构完全替代。tsconfig.json 已 exclude，eslint 已 ignore，但代码仍在仓库中占据 45 个文件。违反"不残留兼容/迁移等临时代码"原则。 |
| P0-2 | `SkillLoader` 类完全未使用 | `src/interface-adapters/skill-adapter/skill-loader.ts` | 整个类从未被 import 或实例化。main.ts 中无引用。 |
| P0-3 | `web/src/mock/data.ts` 大部分死代码 | `web/src/mock/data.ts` | 仅 `skills` 和 `getAllOtters` 被 skills 页面引用。其余 8 个接口、8 个数据常量、颜色系统全部未使用。颜色系统与 `lib/otter-colors.ts` 完全重复。 |
| P0-4 | unused use case 方法 | 多处 | `ManageTerminology.updateTerm()`、`deprecateTerm()`、`getById()`；`ManageMemory.getBySource()`、`getWeight()`；`OtterContextRepository.delete()` —— 均无调用者。 |

### P1 -- 数据完整性 Bug

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P1-1 | `mapMessageDTO` 丢失字段 | `web/src/lib/mappers.ts:85-93` | 映射函数丢弃 `sp`（流式过程文本）、`ctx`（当前上下文 tokens）、`ctxMax`（最大上下文 tokens）。`MessageList.tsx` 依赖这些字段渲染流式过程区域和上下文进度条，导致功能完全失效。 |
| P1-2 | `sessions` 状态永远为空 | `web/src/pages/conversation/index.tsx:34` | `useState<Record<string, LocalOtterSession[]>>({})` 的 setter `_setSessions` 从未调用。且 `loadInitialData()` 未调用 `api.getSessionHistory()`——后端 API `/api/otters/:id/sessions` 已存在（router.ts:40-41），但前端从未请求数据。Otter Session Chain 表格永远渲染 0 行，该功能完全不可用。 |
| P1-3 | FTS5 触发器插入 NULL body | `src/frameworks/db/schema.ts:377-378` | 流式消息创建时 `body` 为 NULL，INSERT INTO messages_fts 会写入 NULL，可能导致 trigram 搜索异常。 |
| P1-4 | `handleError()` 基于字符串匹配推断状态码 | `src/interface-adapters/http/http-error.ts:21-33` | `msg.includes("not found")` 等子串匹配极其脆弱。任何包含 "not found" 的错误消息都会被当作 404 处理。`HttpError` 类存在但从未被 use case 使用。 |
| P1-2b | `_mapSessionDTO` 导入被别名掩盖 | `web/src/pages/conversation/index.tsx:6` | `mapSessionDTO as _mapSessionDTO` 导入后从未使用，是 P1-2 的连带症状。修复 P1-2 时应同时清理此导入。 |

### P2 -- 前端功能缺陷

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P2-1 | 5 个 `catch {}` 块无 console.error | `web/src/pages/conversation/index.tsx:78,143`、`memory/index.tsx:35,49`、`settings/index.tsx:62` | 其中 conversation/index.tsx 的 2 处（加载对话详情、发送消息）在核心流程。其余 11 个 catch 块虽无 console.error 但有 showToast 用户反馈。 |
| P2-2 | Skills 页面使用假数据 | `web/src/pages/skills/index.tsx` | 直接从 `mock/data.ts` 导入，未接入 API。`regSchema` 和 `regHandler` 表单状态收集后从未使用（registerSkill 函数忽略它们）。 |
| P2-3 | Settings 页面 `testConnection` 是假的 | `web/src/pages/settings/index.tsx:43-54` | 用 `setTimeout` 模拟网络调用，key 长度 > 5 就报告成功，从未实际测试 API 连接。 |
| P2-4 | `sendMessage` 绕过共享 `request()` 模式 | `web/src/api/client.ts:61-67` | 直接调用 `fetch()` 返回原始 Response。其他所有 API 函数使用 `request<T>()` 包装。**注**：这是 SSE 流式响应的合理设计——`request()` 封装了 `res.json()` 无法用于 SSE。不一致但有正当理由，降级为代码风格问题。 |
| P2-5 | 乐观更新无回滚 | `web/src/pages/conversation/index.tsx:197,206` | `confirmComplete` 和 `confirmArchive` 乐观更新对话状态但失败时不回滚。 |
| P2-6 | `useEffect` 依赖 `allMessages` 导致冗余调用 | `web/src/pages/conversation/index.tsx:83-87` | 任何对话的消息更新都会触发重新评估，可能导致不必要的 `loadConversationDetail` 调用。 |

### P3 -- 类型安全

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P3-1 | Mapper 中大量 `as` 强制类型转换 | `conversation-mapper.ts`、`otter-mapper.ts`、`memory-mapper.ts` | `as ConversationStatus`、`as SenderType` 等。数据库包含意外值时静默通过，无运行时类型守卫。 |
| P3-2 | `JSON.parse()` 结果无验证强转 | 同上 mapper 文件 | `JSON.parse(row.talking_stone_passed_to) as string[]` 等。JSON 结构不符预期时静默通过。 |
| P3-3 | Tool factory 中 `Record<string, unknown>` 无验证 | `tool-factory.ts` | `params.content as string` 等。LLM 发送非字符串时静默传播。 |
| P3-4 | `models.setProvider(providerModule as never)` | `models-factory.ts:55` | `as never` 完全绕过类型检查。 |
| P3-5 | 前端 mapper 中 4 处 `as` 强转 | `web/src/lib/mappers.ts:68,80,88,119` | 类型和状态字段的强制转换，API 返回意外值时静默通过。 |

### P4 -- 代码重复

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P4-1 | `escapeFtsQuery()` 重复 3 次 | `sqlite-conversation-repository.ts`、`sqlite-memory-repository.ts`、`sqlite-terminology-repository.ts` | 完全相同的函数复制粘贴。 |
| P4-2 | `tryCloseTurn()` 重复 2 次 | `send-message.ts:233-242`、`manage-participant.ts:168-177` | 完全相同的逻辑：按 turnId 获取消息、检查是否全部终端状态、关闭 turn。 |
| P4-3 | 术语搜索结果映射重复 | `search-memory.ts:78-112` 和 `159-197` | `searchTerminologyLibrary()` 和 `searchTerminologyEntries()` 包含近乎相同的映射逻辑。 |
| P4-4 | 内联渐变字符串重复 7+ 次 | `Modal.tsx`、`MessageInput.tsx`、`MessageList.tsx`、`RightPanel.tsx`、`skills/index.tsx`、`settings/index.tsx`、`memory/index.tsx` | `'linear-gradient(135deg,#A88260,#6B5638)'` 应提取为共享常量或 CSS 变量。 |
| P4-5 | Otter 颜色系统完全重复 | `lib/otter-colors.ts` 和 `mock/data.ts:165-177` | `otterColors` 对象和 `getOtterColor` 函数在两处完全相同。 |

### P5 -- 错误处理

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P5-1 | `AgentInvoker.buildDynamicContext()` 吞掉错误 | `agent-invoker.ts:188-191,206-208` | 两个 try/catch 块空 catch body，内存检索或会话查询错误完全静默。 |
| P5-2 | `handleInvokeError()` 吞掉 `fail()` 错误 | `agent-invoker.ts:152-156` | catch 块无日志输出，`fail()` 持续失败时无可见性。 |
| P5-3 | `handoffSession()` 回滚不处理回滚失败 | `manage-session.ts:196-206` | `rollbackArchive()` 自身抛出异常时，原始错误丢失。 |
| P5-4 | `console.warn` 未使用 logger | `agent-invoker.ts:107` | 直接使用 `console.warn` 而非项目 logger。 |
| P5-4b | 后端 8 个 `catch {}` 块静默吞错 | `agent-invoker.ts:154,189,206`、`pi-harness-factory.ts:158,170`、`schema.ts:156`、`database.ts:35`、`sqlite-memory-repository.ts:45` | 其中 agent-invoker 的 3 个空 catch 尤其危险——内存检索失败时 agent 静默降级，无任何日志。 |

### P6 -- 测试覆盖缺失

| ID | 问题 | 说明 |
|----|------|------|
| P6-1 | 72 个源文件中仅 8 个测试文件 | 覆盖率约 11%。 |
| P6-2 | 8/13 use case 类零测试 | ManageConversation、ManageParticipant、SendMessage（244 行，最复杂编排）、CreateOtter、DissolveOtter、ManageKeyInfo、QueryMessage、StoreMemory。 |
| P6-3 | 15/16 实体纯函数零测试 | canCompleteConversation、canArchiveConversation、isTerminalMessageStatus 等守卫函数均未测试。 |
| P6-4 | 整个 frameworks/db 层（19 文件）零直接测试 | 仅 SqliteTerminologyRepository 和 SqliteMemoryRepository 通过 manage-terminology 和 search-memory 测试获得间接覆盖。 |
| P6-5 | SearchEngine 评分数学无直接断言 | RRF 融合、时间衰减、频率提升公式仅通过端到端测试间接覆盖。公式变更不会被任何测试捕获。 |
| P6-6 | 关键回滚路径未测试 | CreateOtter 的 agentGateway.create() 失败回滚路径。 |

### P7 -- 架构违规

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P7-1 | frameworks 层导入 interface-adapters 类型 | `pi-harness-factory.ts:21-22` | `import type { OtterToolClient }` 和 `import type { AgentTool }`。外层依赖内层，违反整洁架构依赖方向。 |
| P7-2 | `seed-terminology.ts` 绕过 Composition Root | `seed-terminology.ts:114` | 直接 `new SqliteTerminologyRepository(db)` 而非通过 main.ts 注入。 |
| P7-3 | `main.ts` 使用 `{} as OtterToolClient` 占位 | `main.ts:321` | 循环依赖的已知 workaround，但 `invoke()` 在 `setOtterToolClient()` 前调用会导致晦涩的运行时错误。 |

### P8 -- 组件结构

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P8-1 | `ConversationPage` 357 行巨型组件 | `conversation/index.tsx` | 20+ useState、15+ 异步处理函数、上下文菜单、模态框编排、数据获取全在一个组件。 |
| P8-2 | 所有模态框接收完整 39 个 props | `Modals.tsx` | 每个模态框只使用 2-3 个 props，prop-drilling 反模式。 |
| P8-3 | 上下文菜单无无障碍支持 | `conversation/index.tsx:339-348` | 纯 div + onClick，无 role、aria 属性、键盘导航。 |
| P8-4 | Loading dots 模式重复 3 处 | `conversation/index.tsx`、`memory/index.tsx`、`MessageList.tsx` | 应提取为共享 LoadingDots 组件。 |

### P9 -- 魔法数字/字符串

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| P9-1 | 默认 limit 硬编码为 50 和 10 | `message-controller.ts:21`、`memory-controller.ts:22`、`main.ts:187` | 应提取为命名常量。 |
| P9-2 | 术语定义截断长度 100 未命名 | `search-memory.ts:85` | 与 `SNIPPET_FALLBACK_LENGTH = 200` 不一致。 |
| P9-3 | `+3` 硬限制溢出为魔法数字 | `pi-harness-factory.ts:125` | 应提取为命名常量。 |

---

## 交叉审视结论

架构师-2 对草稿方案进行了对抗审视，以下为收敛结果：

### 已采纳的修正

1. **数据修正**：src/ 文件数 63→72、reference/ 文件数 44→45
2. **P2-1 精确化**：13 个 catch 块→5 个真正静默（conversation/index.tsx 2 处在核心流程，memory/index.tsx 2 处、settings/index.tsx 1 处）
3. **补充 P1-2b**：`_mapSessionDTO` 导入未使用是 sessions 功能失效的连带症状
4. **补充 P5-4b**：后端 8 个空 catch 块（agent-invoker 3 个尤其危险——内存检索失败时 agent 静默降级）
5. **Phase 2 顺序调整**：handleError 重构放最后（影响面最大）
6. **Phase 1/2 可并行**：删除文件与修改代码无依赖，可分两个 PR
7. **P2-4 降级**：sendMessage 绕过 request() 是 SSE 流式响应的合理设计
8. **P8-1 降级**：ConversationPage 拆分移至"可以"级别，建议单独 feature
9. **D2 补充**：实施前需确认 unused 方法无"待接入"意图标记
10. **D5 补充约束**：测试必须使用真实 SQLite :memory:，不覆盖前端组件测试

### 未采纳的建议

- **D2 分类处理建议**（区分"死代码"与"预留 API"）：采纳为实施前检查步骤，但决策不变——无意图标记则删除

### 共识

架构师-2 确认核心发现（P0-2、P1-1~P1-4、P4-1、P4-2）经代码验证完全准确，方案可以锁定。

---

## 不兼容更新

本特性为纯重构，不涉及 API 契约变更或数据库 schema 变更。

唯一不兼容项：删除 `reference/` 目录。此目录已被 gitignore/tsconfig exclude/eslint ignore，不参与构建，删除不影响任何功能。

## 设计决策

### D1: `reference/` 目录处理

**决策**：删除整个 `reference/` 目录。

**理由**：
- 正面：消除 45 个死文件的维护噪音；符合"不残留迁移代码"原则
- 正面：旧代码可能被误认为当前架构的参考
- 反面：旧代码可用于理解系统演进历史（但 git log 已提供此信息）
- **结论**：git 历史保留完整记录，无需在工作目录中保留旧代码

### D2: unused use case 方法处理

**决策**：删除所有无调用者的方法和类。

**理由**：
- 正面：减少代码噪音，降低维护负担
- 正面：避免"看起来可用但实际未测试"的虚假安全感
- 反面：未来可能需要这些方法（但 YAGNI 原则适用，需要时可从 git 恢复）
- **结论**：删除。包括 ManageTerminology 的 updateTerm/deprecateTerm/getById、ManageMemory 的 getBySource/getWeight、OtterContextRepository.delete、SkillLoader 整个类

**实施前检查**：需确认上述方法在注释或 commit message 中无"待接入"意图标记。如有，应视为 P2-2 同类问题（预留 API 能力），标记为待实现而非删除。

### D3: `handleError()` 字符串匹配 → HttpError 结构化

**决策**：将 use case 层的错误抛出改为使用 `HttpError` 类，消除字符串匹配。

**理由**：
- 正面：类型安全的状态码推断
- 正面：消除子串误匹配风险
- 反面：需要修改所有 use case 的错误抛出点
- **结论**：use case 层抛出 `HttpError`（或 domain-specific error），controller 层统一 catch

### D4: 前端 mock 数据清理

**决策**：保留 `mock/data.ts` 中 skills 页面实际使用的 `skills` 和 `getAllOtters`，删除其余所有死代码。颜色系统统一使用 `lib/otter-colors.ts`。

### D5: 测试策略

**决策**：按优先级分层补充测试。

**优先级排序**：
1. 实体纯函数（最简单、最高 ROI）
2. 高复杂度 use case（SendMessage、ManageParticipant、ManageConversation）
3. 回滚路径（CreateOtter、DissolveOtter、ManageSession 已有部分覆盖）
4. SearchEngine 评分数学
5. frameworks/db 层（通过 use case 集成测试间接覆盖即可）

**约束**：
- 测试必须使用真实 SQLite `:memory:` 数据库（与现有测试风格一致）
- 本轮测试补充不覆盖前端组件测试（P8 组件结构是独立问题）
- 不引入新的外部依赖

## 行为条目

| ID | 预期行为 | 追溯 |
|----|----------|------|
| B1 | 删除 `reference/` 目录后，`npm run build` 和 `npm run test` 通过 | P0-1 |
| B2 | 删除 SkillLoader 类后，无编译错误 | P0-2 |
| B3 | 清理 `mock/data.ts` 死代码后，skills 页面功能不变 | P0-3 |
| B4 | 删除 unused use case 方法后，无编译错误，所有现有测试通过 | P0-4 |
| B5 | `mapMessageDTO` 映射 `sp`、`ctx`、`ctxMax` 字段，MessageList 流式过程和上下文进度条正常渲染 | P1-1 |
| B6 | `sessions` 状态从 API 获取并正确填充，Otter Session Chain 表格显示数据 | P1-2 |
| B6b | `_mapSessionDTO` 导入被正确使用或移除 | P1-2b |
| B7 | FTS5 触发器对 NULL body 不插入或插入空字符串 | P1-3 |
| B8 | 错误处理使用结构化错误类型替代字符串匹配 | P1-4 |
| B9 | 前端 5 个静默 catch 块 + 后端 8 个空 catch 块均添加 `console.error` 或 logger 输出 | P2-1, P5-4b |
| B10 | `escapeFtsQuery()` 提取为共享工具函数 | P4-1 |
| B11 | `tryCloseTurn()` 提取为共享工具函数 | P4-2 |
| B12 | 内联渐变提取为 CSS 变量或共享常量 | P4-4 |
| B13 | 为实体纯函数补充单元测试（16 个函数） | P6-3 |
| B14 | 为 SendMessage 补充单元测试（start/complete/fail/appendEvent/ensureActiveTurn/tryCloseTurn） | P6-2 |
| B15 | 为 ManageParticipant 补充单元测试（join/leave + 系统消息 + turn 关闭） | P6-2 |
| B16 | 为 CreateOtter 和 DissolveOtter 补充单元测试（含回滚路径） | P6-2, P6-6 |
| B17 | frameworks 层不直接导入 interface-adapters 类型（通过接口解耦） | P7-1 |
| B18 | ConversationPage 拆分为 hooks + 子组件 | P8-1 |
| B19 | 默认 limit 值提取为命名常量 | P9-1 |

## 验收标准

### 必须满足

- [ ] `reference/` 目录已删除
- [ ] 所有 unused 导出/方法/类已删除
- [ ] `mapMessageDTO` 保留 `sp`、`ctx`、`ctxMax` 字段
- [ ] FTS5 触发器处理 NULL body
- [ ] `handleError()` 不再依赖字符串匹配
- [ ] `escapeFtsQuery()` 不再重复
- [ ] `tryCloseTurn()` 不再重复
- [ ] 前端 5 个静默 catch 块 + 后端 8 个空 catch 块均添加错误日志
- [ ] `npm run build` 通过
- [ ] `npm run test` 通过
- [ ] `npm run lint` 通过

### 应该满足

- [ ] 实体纯函数有单元测试
- [ ] SendMessage 有单元测试
- [ ] ManageParticipant 有单元测试
- [ ] CreateOtter/DissolveOtter 有单元测试（含回滚）
- [ ] frameworks 层不直接导入 interface-adapters 类型
- [ ] 内联渐变提取为共享常量
- [ ] 默认 limit 值提取为命名常量

### 可以满足（评估后确认）

- [ ] SearchEngine 评分数学有直接断言
- [ ] frameworks/db 层有直接测试
- [ ] 前端模态框 props 拆分
- [ ] 上下文菜单无障碍支持
- [ ] ConversationPage 拆分（357 行巨型组件，拆分风险不低，建议单独 feature）
- [ ] Skills 页面接入真实 API（P2-2，当前使用 mock 数据，需后端 API 支持）
- [ ] Settings `testConnection` 接入真实 API（P2-3）

## [design-time] 实现指引

### 实施顺序建议

**Phase 1: 残留代码清理**（低风险，高确定性）
1. 删除 `reference/` 目录
2. 删除 `SkillLoader` 类
3. 清理 `mock/data.ts` 死代码
4. 删除 unused use case 方法

**Phase 2: Bug 修复**（高优先级）
5. 修复 `mapMessageDTO` 字段丢失
6. 修复 FTS5 触发器 NULL body
7. 修复前端 5 个静默 catch 块 + 后端 8 个空 catch 块
8. 重构 `handleError()` 为结构化错误（影响面最大，放最后）

**Phase 3: 代码去重**（中优先级）
9. 提取 `escapeFtsQuery()` 共享工具
10. 提取 `tryCloseTurn()` 共享工具
11. 提取内联渐变为 CSS 变量

**Phase 4: 测试补充**（高价值）
12. 实体纯函数测试
13. SendMessage 测试
14. ManageParticipant 测试
15. CreateOtter/DissolveOtter 测试

**Phase 5: 架构改进**（可选）
16. frameworks/interface-adapters 依赖解耦
17. ConversationPage 拆分
18. 魔法数字常量化

### 关键约束

- 每个 Phase 独立可合入，不产生中间态破坏
- Phase 1（删除文件）和 Phase 2（修改代码）无依赖关系，可分两个 PR 并行推进
- Phase 1 可直接自主执行（删除死代码）
- Phase 2 涉及行为变更，需审查
- Phase 4 测试必须使用真实 SQLite `:memory:` 数据库（与现有测试风格一致）
- 不引入新的外部依赖
