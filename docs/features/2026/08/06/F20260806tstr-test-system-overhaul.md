---
id: F20260806tstr
title: test-system-overhaul
doc_type: feature

summary: |
  测试体系完整重构：A/B 分层 + 真模型能力测试层 + mock 全面真 sqlite 化 + 制度收口。
  动机：记忆系统、重启獭生等能力缺失（非 bug）在 84 文件全绿的测试体系下完全不可见——
  原体系全部是 mock 外围的代码逻辑测试，LLM 参与的行为从未被真实验证。
  机制：A 类（代码逻辑）传统测试真 sqlite 化；B 类（LLM 行为）新建能力测试层
  （buildApp 真装配 + 真 bge-m3 + 真 LLM，行为不变量 + 统计采样断言）；F 文档 capability_test 约定防退化。

causal_links:
  from:
    - F20260805rsto   # restart 事故：mock 镜像 fake green，重构缘起
    - F20260805codx   # 上游 bootstrap 拆分（buildApp 在其结构上重建）
  to:
    - F20260805fmdb   # 本工作捕获并修复的 fresh-DB 迁移回归
    - F20260805mspk   # 本工作发现的 mimo speak 协议不稳定

status: implemented
change_type: refactor
capability_test: tests/capability/memory-recall.capability.test.ts
tags: [test, capability-test, refactor, composition-root, llm-behavior]
modules:
  - src/app.ts
  - src/main.ts
  - src/bootstrap
  - tests/helpers
  - tests/capability
  - tests/app
  - config/config.test.yaml
  - vitest.capability.config.ts
  - scripts/lint-capability-docs.mjs
---

# F20260806tstr: 测试体系完整重构

> 本文档整合本次重构的全部内容（原为 8 个零碎 F 文档，应要求合并分 Part）。
> 关联文档：F20260805fmdb（捕获的 fresh-DB 回归修复）、F20260805mspk（发现的 mimo 行为问题）。

## 分层原则（与用户确认的判别标准）

- **A 类（软件边界内代码逻辑）**：传统测试，LLM 零介入；真 sqlite 作 DB seam。`npm test`，CI 跑。
- **B 类（LLM 参与的行为：prompt/skill/工具选择/协议遵从）**：必须真模型，mock 即自欺。
  断言行为不变量（工具轨迹/协议合规/枚举成员/关键 token），禁止断言具体措辞。
  `npm run test:capability`，本地跑。
- **embedding（bge-m3 本地确定性模型）**：永远不 mock；能力层启动强断言 available，禁止静默降级。
- **LLM 接缝只允许画在模型 API 边界**：上游 prompt 组装用 A 类断言产出物，
  下游解析用真实录制 fixture，中间"模型怎么想"要么真跑要么不宣称覆盖。

## Part 1：共享基建与组装根可测试化

### tests/helpers/（共享测试基础设施）

`createTestDb()`（:memory: + 生产 initSchema，消灭手写 DDL 漂移）、`createTestLogger()`、
`fakeAgentGateway()`（带调用记录 + onReset 竞态钩子）、`readSSEEvents()` 唯一实现。
替代了 24 份 mockLogger、4 份 fakeAgentGateway、2 份 SSE 读取器副本。

### src/app.ts buildApp（组装根可测试化）

原 main.ts 的 import 时副作用（mkdir/读死路径配置/自执行）使任何测试无法真实启动系统。
codx 拆分 bootstrap 模块后副作用仍在，本工作在其结构上重建：

```ts
buildApp(options?: BuildAppOptions): Promise<BuiltApp>
// options: config | configPath、logger、dataDir、sessionDir、identityPromptDir、
//          rootDir、staticRoot: string|false、syncAuth、enableFeishu、
//          startScheduler、models（测试注入 initFauxModels）
// 返回: { app, db, config, controllers, usecases, repos, agentGateway, ... , dispose() }
```

配套：`loadConfig(logger?, configPath?)` 路径覆盖；`resetConfigForTests()`；
bootstrap 函数 logger 参数放宽为 Logger 接口；server 拆 buildHttpApp/listen；
`createAgentGateway` 加 sessionDir/identityPromptDir；`initDatabaseAndModels` 加 modelsOverride；
embedding `workerPath`/`workerExecArgv` 覆盖（vitest 下 dist 产物 + fork execArgv 污染问题）；
EmbeddingServiceImpl 补 worker exit 监听（onnxruntime 原生崩溃时 embed 曾永久挂起）。
main.ts 收缩为 ~20 行薄入口。生产冒烟验证：全新 DB + 真 mimo + 飞书启动，对话全链路正常。

**与上游的时序差异（明示）**：buildApp 会 await healing/recruiting 两个 ensure 再返回
（上游是 fire-and-forget 后立即 listen）。ensure 无 LLM 调用、耗时极小；
影响是生产 listen 略晚于上游，换取装配确定性（测试可依赖"返回即就绪"）。

## Part 2：能力测试层（B 类）

- `vitest.capability.config.ts`：forks 池（每文件独立进程隔离 config 单例与 pi SDK 缓存）、
  串行、无 retry（采样内化抖动）、自定义 skip-reporter（无 LLM 时显式打印 SKIP REPORT，exit 0 不静默）。
- `config/config.test.yaml`（入库零机密）← `config.test.local.yaml`（gitignored 整段替换顶层键）
  ← `OTTER_TEST_LLM_*` 环境变量。无密钥时自动注入 initFauxModels，非 LLM 用例照常真跑。
- `tests/capability/helpers/`：boot（每文件临时目录 + buildApp 真装配 + embedding 就绪强等待）、
  assert-behavior（sendUserMessage/waitForOtterMessage/toolCallNames/expectToolUsed/
  expectSpeakCompliance/expectEventually/expectSampledBehavior）、session-file（pi jsonl 解析集中一处）。

### 调试解决的真实环境坑

1. worker 路径依赖 dist → workerPath 覆盖 + test:capability 先 build
2. syncDocuments 的 fire-and-forget embedding 挤爆 worker 串行队列 → boot 默认 rootDir=空目录
3. vitest fork 的 execArgv（--conditions development）被 worker 继承污染模块解析 → workerExecArgv: []
4. waitForOtterMessage 必须等"回合终局"：speak 未收尾的失败会触发自动重试且常成功，
   第一个 failed 不是终局

### 统计采样断言

mimo 行为不稳定（F20260805mspk），单次断言会把套件打成长红（长红=无回归价值）。
`expectSampledBehavior(label, samples, minSuccess, fn)`：采样明细全量打印，成功率归零则失败。

## Part 3：能力用例集（12 用例 / 5 文件）

| 文件 | 用例 | 断言方式 |
|---|---|---|
| memory-recall（旗舰） | embedding 就绪 / 混合检索召回 / 跨对话獭主动 search_memory 答出事实 | 严格 + 采样 3≥1 |
| otter-lifecycle | restart 全链路（账本+记忆转换严格，真 PiSessionFactory）/ 身份注入（session jsonl）/ speak 协议 | 严格 + 采样 |
| agent-collaboration | 召唤小獭（create_otter 决策 + 小獭 prompt 创作）/ dissolve 三层清理 | 采样 + 严格 |
| agent-behavior | 术语捕获入库 / skill 触发（read core-workflow SKILL.md） | 采样 3≥1 |
| multi-model | 别名落库 + ModelPool 解析非回退 + agent session 建立 | 严格（确定性） |

范围裁剪：memory-vs-messages 歧义测试删除（场景设计不诚实：同对话问题上下文可直答）；
recruiting 分类 / healing 上报留后续批次。

### 实测观测（真实行为数据）

- 记忆检索链路全部轮次正常；mimo speak 首试遵从率不稳（详见 F20260805mspk）
- speak-retry（F20260730sbrt）有效兜底：用户视角回合成功率显著高于首试遵从率
- repo-safety skill 真实生效：獭自发建 worktree 写代码，主树零污染
- 大獭为小獭撰写的 systemPrompt 与任务高度相关；术语入库率 3/3

## Part 4：套件瘦身与真 sqlite 化

### 删除覆盖填充（71 用例）

判别标准：断言失败时用户/调用方能感知才值得存在。删除：3 个 mapper 测试（~950 行，
已被真 sqlite 往返覆盖）、2 个 DTO 字段抄送、query-otter pass-through、schema 表名清单
（保留幂等性/CHECK/外键行为用例）、重复空列表、工具数量断言、"passes undefined fields"
（反向锁死验证缺失）。

### 真 sqlite 化（mock 副本归零）

5 份 65 方法手写 ConversationRepository mock 全转换为真仓库（SqliteConversationRepository
+ createTestDb）。转换即刻发现 4 个被 mock 长期掩盖的真实语义：

1. getMessagesBefore 返回倒序（mock 按 fixture 顺序）
2. join/leave 系统消息终态触发 tryCloseTurn 关回合（连续操作须开新回合）
3. turn 是"一跳"而非"一轮问答"（用户消息终态即关 turn，otter 回复开新 turn）
4. html-card 投影保留 `[html-card: 标题]` 占位符（不变量是源码不入索引）

其他：manage-session 删除 restart mock 镜像（能力层已覆盖）只留错误分支；identity-prefix
真 schema 化、删除内部件替换测试；ensure-model 魔法字节数改从 bge-m3-files.json 派生；
controllers.test.ts 删除（pin/unpin 独有用例迁入 tests/api 走真路由）；models-factory 保留
（auth 解析序有价值，custom-provider 路由由能力层真覆盖）；3 个错位文件归层。

## Part 5：制度机制（防退化）

准则要活着，必须进入獭们的必达信道 + 机械拦截兜底，三层：

1. **獭信道（prompt 层，主手段）**：A/B 分层硬规则写入
   `.pi/skills/code-implementation/references/testing-rules.md`（"写代码/写测试"必触达的 skill），
   判别表、禁止清单、判别口诀（"断言失败时用户能感知吗"）都在其中
2. **CC 信道**：仓库约定 CLAUDE.md 为本地文件（gitignore「Local agent config, managed by user」），
   不强制入库；准则单一真相源是被追踪的 CONTRIBUTING.md + docs/user-guide/testing.md + skill，
   本地 CLAUDE.md 只需指向它们
3. **机械拦截（兜底）**：
   - `lint-capability-docs.mjs`：capability_test 约定（缺字段警告、路径不存在报错、警告数 ratchet 只减不增）
   - `lint-tests.mjs`（新）：手写 CREATE TABLE / mockLogger 副本，commit 即拦
   - 均接入 pre-commit

执行记录：lint-tests 上线即抓到 20 个残留 mockLogger 副本与 2 处手写 DDL
（迁移测试的旧 schema 建表是合法形态，用 lint-tests:allow-ddl 标记豁免），已全部收敛。

- F 文档（change_type=feature/prompt）frontmatter 声明 `capability_test`（路径或 n/a 理由），
  写入 docs/README.md 与 CONTRIBUTING.md
- 运行方式：`npm test`（A 类 CI）/ `npm run test:capability`（B 类本地）/ `npm run test:all`

## 验证

- A 类：78 文件 / 936 用例全绿（原 85 文件 / 1045 用例，数字下降是收益）
- B 类：5 文件 / 11 用例全绿（真 mimo + 真 bge-m3）；无 LLM 配置时 2 真跑 + 显式 skip 报告
- 生产冒烟：全新 DB 启动 + 真 LLM 对话全链路

## 对抗审视记录（合并前独立 agent 检视）

独立 agent 对 PR #159 做对抗检视（实跑 A/B 两层 + 无 LLM 对照 + 生产 diff 逐行比对），
结论"可合并但先修 P1"。用户拍板全修含机制改动：

| 级别 | 发现 | 处置 |
|---|---|---|
| P1 | multi-model 用例在无 LLM 环境红色失败（synthesizePool 只合成单别名池），与"无 LLM 照常真跑"宣称矛盾 | 修：faux 池按全部别名构建且每别名独立实例（保 ModelPool 非回退断言） |
| P2 | 身份注入触发链确定性回归锁被删，CI 零守护（与分层原则自相矛盾） | 恢复 5 个 A 类触发链用例（pendingIdentity 标记/失败不消费/createdNew 注入） |
| P2 | apiKey 明文落 /tmp 无权限位、中断残留 | 修：0o600 + 进程退出兜底清理 |
| P2 | sn/dur DTO 字段 A 类覆盖归零（前端依赖 sn） | 补 tests/api/message.test.ts 断言 |
| P2 | agent 工具可在能力测试中写真实仓库 | 机制：cwd 沙箱（软链只读资产，bash/write 落点沙箱内） |
| P3 | retry 与采样叠加（3≥1 × retry1 = 实际 6 采 1，成功率退化无信号） | 机制：retry: 0，抖动全部由采样内化 |
| P3 | worker exit 监听缺 disposed 守卫（正常关停误报 ERROR） | 修 |
| P3 | lint 脚本引号/CRLF 解析脆弱、skip-reporter apiKey 空判、boot 注释过时、turnNumber 断言丢失 | 全修 |

检视同时证伪的嫌疑（"检查过没问题"）：倒序/turn-per-hop 两处断言改动是发现真相而非迁就实现
（生产 SQL 实证）；旗舰测试无上下文泄漏；删除会计算平；buildApp 与上游初始化逐步无差异。

## 对抗审视记录（第二轮，修复后复审）

第一轮修复完成后又做一轮独立检视（实跑 A/B 两层 + 无 LLM 对照），本轮抓到两个 P1 且正中要害——
**能力测试自身的假绿**：

| 级别 | 发现 | 处置 |
|---|---|---|
| P1 | restart「新獭生可用」与身份「不重复注入」断言命中第一轮的陈旧 completed 消息（waitForOtterMessage 未传 afterSeq），核心回归锁空转 | 修：afterSeq 锚定上一轮终态；身份用例加 userMsgCount≥2 证明第二轮 invoke 真实发生。修复后等待时间从 4s/2s 变 20s/12s——证明此前在空转 |
| P1 | memory-recall 工具轨迹只看最终 completed 消息；speak-retry 首试的 search_memory 落在 failed 消息且**重试是新的一跳（不同 turnId）**，系统健康但重试时确定性红 | 修：toolCallNamesForExchange 交换级聚合（跨消息跨 turn） |
| P2 | skill 用例 150s 超时 < 熔断预算（120s/事件 + 重试翻倍）；采样异常炸掉整个采样 | 修：超时 300s + 采样内 try/catch 记失败样本 |
| P2 | 沙箱软链可被 write 穿透，「只读资产」宣称不实 | 修：小资产（.pi/prompts/种子）改复制；models 4.2G 保留软链并诚实标注残余风险 |
| P2 | createTestDb 只有 initSchema，缺 migrateDatabase 补的列（session_file/model_alias）——A 类库落后于生产 | 修：createTestDb 补 migrateDatabase（幂等） |
| P3 | 废弃的 forks.execArgv 死配置、F 档 retry 文案、boot 失败路径 chdir 泄漏、capability_test 警告无收敛机制 | 全修；lint 加 ratchet（警告数只减不增，上限 62） |

本轮同时实证：交换级聚合后的旗舰采样轨迹完整（search_memory→speak 3/3 全链路）、
otter-summon 委派率存在真实波动（0/3 ~ 3/3 跨运行）——mimo 行为不稳定（F20260805mspk）的又一数据点。

**两轮检视的元教训**：第一轮"检查过没问题"的旗舰无泄漏结论漏掉了空转断言——
对抗检视的价值与测试相同：只有真实执行（含对照实验）才算数。
