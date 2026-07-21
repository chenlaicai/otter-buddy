---
id: F20260717q8kp
title: 代码质量检视
doc_type: feature

# 记忆索引
summary: |
  全仓库代码质量检视，覆盖 src/、web/、reference/、tests/ 目录。
  识别 P0-P8 级别问题，包括静默错误处理、未使用代码、类型安全等。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716ttf7   # system-integration-and-startup

# 元数据
status: locked
change_type: refactor
tags: [code-quality, refactor, review, error-handling]
modules: [src/, web/, tests/]

# 时间
created_at: 2026-07-17
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
