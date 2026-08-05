---
id: F20260805p7rw
title: test-suite-rework-real-sqlite
doc_type: feature

summary: |
  测试套件改造：5 份 65 方法手写 ConversationRepository mock 全部转换为真 sqlite 仓库，
  mock 镜像类测试删除或收敛，错位文件归层。936 用例全绿，mock 副本收敛为零。
  转换即刻兑现价值：发现 mock 长期掩盖的 4 个真实语义（getMessagesBefore 倒序、
  join/leave 系统消息触发 tryCloseTurn 关回合、turn 是"一跳"而非"一轮问答"、
  html-card 投影保留占位符）——全部是手写镜像从未表达过的生产真相。

causal_links:
  from:
    - F20260805thlp   # 共享测试基础设施（createTestDb 等，本次转换的地基）
    - F20260805rsto   # mock 镜像 fake green 事故（转换的根本动机）
    - F20260805p6dl   # 覆盖填充删除（pass-through 用例的删除标准）
  to: []

status: implemented
change_type: refactor
tags: [test, refactor, real-sqlite, mock-elimination, conversation]
modules:
  - tests/usecases/conversation/turn-utils.test.ts
  - tests/usecases/conversation/query-message.test.ts
  - tests/usecases/conversation/manage-participant.test.ts
  - tests/usecases/conversation/manage-conversation.test.ts
  - tests/usecases/conversation/send-message.test.ts
  - tests/usecases/manage-session.test.ts
  - tests/frameworks/agent/identity-prefix.test.ts
  - tests/frameworks/embedding/ensure-model.test.ts
  - tests/usecases/memory/search-memory.test.ts
  - tests/usecases/memory/manage-terminology.test.ts
  - tests/api/conversation.test.ts
  - tests/api/helpers.ts
---

# F20260805p7rw: 测试套件改造（真 sqlite 化 + mock 收敛）

## 核心转换：5 份 65 方法手写 mock → 真仓库

turn-utils / query-message / manage-participant / manage-conversation / send-message
五个文件的 ConversationRepository 手写 mock（每份 57-79 个 vi.fn）全部删除，
改用 SqliteConversationRepository + tests/helpers/createTestDb()。
种子与断言走与生产相同的 SQL 路径；pass-through 用例按 F20260805p6dl 标准同步删除。

### 转换发现的真实语义（mock 从未表达过的生产真相）

1. **getMessagesBefore 返回倒序**（最近的在前）——mock 按 fixture 顺序返回，与真 SQL 相反
2. **join/leave 的系统消息到达终态会触发 tryCloseTurn 关闭当前回合**——连续参与者操作
   必须开新回合（真实系统中进出发生在 agent 回合进行中）
3. **turn 是"一跳"而非"一轮问答"**——用户消息（completed）使全消息终态，turn 当即关闭；
   otter 回复开下一个 turn
4. **html-card 投影保留 `[html-card: 标题]` 占位符**而非完全抹除——不变量是"卡片源码不入索引"

## 其他改造

| 文件 | 处置 |
|---|---|
| manage-session.test.ts | 删除 restart mock 镜像（restart-flow.integration 与能力层已覆盖），只留真 sqlite 错误分支 |
| identity-prefix.test.ts | 真 schema + 真 repo；删除 _invokeInternal 内部件替换测试（能力层覆盖不变量）；文案钉死收敛为 2 个身份判别标记 |
| ensure-model.test.ts | 魔法字节数 → 从单一真相源 bge-m3-files.json 派生 |
| 2 个记忆测试 | 手写 DDL（漂移隐患）→ createTestDb() 生产 schema |
| controllers.test.ts | 删除（与 tests/api 重叠）；pin/unpin 5 个独有用例迁入 tests/api/conversation.test.ts 走真路由；顺手修了 api helpers 的 settingsRepo 硬编码 null（healing 403 因此可测） |
| models-factory.test.ts | 不动：auth 解析序测试有真实价值；custom-provider 路由现由能力层真覆盖（mimo 走 apiBaseUrl 路径） |
| 错位移动 | find-by-external-id → frameworks/db/conversation；created-after-filter → frameworks/db/memory；manage-key-info → usecases/conversation |

## 验收

- **mock 副本数 = 0**：65 方法 repo mock ×5、fakeAgentGateway ×4、mockLogger ×24、手写 DDL ×2 全部消除
- 78 文件 / 936 用例全绿；能力层 11 用例不受影响
