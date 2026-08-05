---
id: F20260805bapp
title: composition-root-buildapp
doc_type: feature

summary: |
  在 F20260805codx bootstrap 模块之上重建可测试装配入口 src/app.ts 的 buildApp()，main.ts 收缩为薄入口。
  动机：codx 拆分后 main.ts 仍保留 import 时副作用（mkdir/读死路径配置/自执行），测试仍无法真实启动系统——
  这是 B 类能力测试层（F20260805capt）的前置条件。
  机制：buildApp(options) 编排 bootstrap 模块，全部路径与副作用可注入（config/dataDir/syncAuth/staticRoot/
  models 等），返回 { app, db, usecases, dispose }；embedding worker 增加 workerPath/workerExecArgv 覆盖。

causal_links:
  from:
    - F20260805codx   # 上游 bootstrap 拆分（本工作在其结构上做可测试化接缝）
    - F20260805rsto   # restart 事故：mock 镜像导致 fake green，催生测试体系重构
  to:
    - F20260805capt   # 能力测试层（以 buildApp 为地基）
    - F20260805fmdb   # build-app 测试捕获的 fresh-DB 迁移回归修复

status: implemented
change_type: refactor
tags: [composition-root, testability, build-app, embedding, config, bootstrap]
modules:
  - src/app.ts
  - src/main.ts
  - src/bootstrap/database.ts
  - src/bootstrap/platforms.ts
  - src/bootstrap/server.ts
  - src/frameworks/config-service.ts
  - src/frameworks/config/index.ts
  - src/frameworks/embedding/embedding-service.ts
  - tests/app/build-app.test.ts
---

# F20260805bapp: 组装根可测试化（buildApp，基于 codx bootstrap 重建）

## 背景

本工作最初基于旧 main.ts（785 行单体）完成，开发期间上游合并了 F20260805codx
（main.ts 拆分为 8 个 bootstrap 模块）。codx 改善了代码组织但**未解决可测试性**：
import 时副作用（mkdir、loadConfig 死路径、main() 自执行）全部保留，测试依旧无法真实启动系统。
因此本工作在其结构上重建：bootstrap 模块是零件，buildApp 是按序组装 + 测试接缝。

## 相对 codx 的增量

### src/app.ts（新）

```ts
buildApp(options?: BuildAppOptions): Promise<BuiltApp>
// options: config | configPath、logger、dataDir、sessionDir、identityPromptDir、
//          rootDir、staticRoot: string|false、syncAuth、enableFeishu、
//          startScheduler、models（测试注入 faux models）
// 返回: { app, db, config, logger, controllers, usecases, repos, agentGateway,
//         agentInvoker, schedulerService, embeddingService, modelPool, dispose() }
```

- `createLogger(logDir)`：logger 工厂化，消除 import 时 mkdir。
- `initConfig(config)` 在任何 init 之前调用（PiSessionFactory 构造时捕获全局 config 的 circuitBreaker）。
- 飞书长连接副作用（原 startServer 内）收进 buildApp，由 `enableFeishu` 控制。
- main.ts 收缩为 ~20 行薄入口：createLogger → buildApp → listen → SIGINT dispose。

### bootstrap 模块接缝

- `database.ts initDatabaseAndModels`：加 `modelsOverride` 参数（无密钥环境 initModels 会抛错，
  测试注入 initFauxModels 的模型；未带 pool 时按 llm 配置合成单条目 ModelPool）。
- `platforms.ts createAgentGateway`：加 `sessionDir`/`identityPromptDir` 注入。
- `server.ts`：`buildHttpApp`（纯组装，staticRoot:false 可关静态路由）与 `listen` 分离；
  删除 startServer（职责被 buildApp + listen 覆盖，无调用方）。
- 全部 bootstrap 函数的 logger 参数从具体类 `PinoLogger` 放宽为接口 `Logger`
  （符合 logger.ts 自己的 DIP 注释；测试可注入 noop logger）。

### 框架层小改

- `loadConfig(logger?, configPath?)`：路径可覆盖（config-service.ts）。
- `resetConfigForTests()`：清空 config 单例（config/index.ts）。
- `embedding.workerPath` / `embedding.workerExecArgv`：worker 脚本路径与 execArgv 覆盖
  （vitest 下 dist 产物不在 src 树；vitest fork 注入的 --conditions 会污染 worker 内模块解析）。
- EmbeddingServiceImpl 补 worker `exit` 监听：onnxruntime 原生崩溃时 error 事件可能不触发，
  此前 embed 会永久挂起且无任何日志（生产级健壮性修复）。

### 与 codx main() 的唯一行为差异

buildApp await healing/recruiting 两个 ensure 再返回（原 fire-and-forget 后再启动 scheduler）。
ensure 无 LLM 调用、耗时极小，确定性更高。

## 验证

1. `tests/app/build-app.test.ts`（4 用例）：initFauxModels + stub embedding worker + 全临时目录——
   健康端点 200 / embedding 优雅降级不炸启动 / 建獭全链路真 sqlite 断言（含 F20260805rsto 不变量）/
   staticRoot:false 不挂页面路由。
2. 该测试**捕获上游 fresh-DB 迁移回归**（见 F20260805fmdb）——buildApp 测试价值的即时证明。
3. `npm test` 85 文件 / 1045 用例全绿；生产冒烟（全新 DB + 真 mimo + 飞书）health 200 正常启动。
