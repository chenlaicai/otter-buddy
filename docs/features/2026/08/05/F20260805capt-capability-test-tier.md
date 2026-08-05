---
id: F20260805capt
title: capability-test-tier
doc_type: feature

summary: |
  建立能力测试层（B 类）：真系统（buildApp 全装配）+ 真 embedding（bge-m3）+ 真 LLM，验证 LLM 参与的系统行为。
  动机：原测试体系全部是 mock 外围的代码逻辑测试（A 类），prompt/skill/工具选择等 LLM 行为从未被真实验证——
  记忆系统、重启獭生的能力缺失因此漏网。原则：软件边界内验证代码逻辑用传统测试；涉及 LLM 行为必须真模型，mock 即自欺。
  机制：vitest.capability.config.ts（forks 进程隔离/串行/retry）+ config.test.yaml（入库零机密）+
  local overlay/env 注入端点 + 行为不变量断言（工具轨迹/协议合规/关键 token，不断言措辞）+ 显式 skip 报告。

causal_links:
  from:
    - F20260805bapp   # P2 组装根可测试化（buildApp 是本层地基）
    - F20260805thlp   # P1 共享测试基础设施
    - F20260805mspk   # 本层首发捕获的发现：mimo speak 协议不稳定
  to: []

status: implemented
change_type: feature
tags: [test, capability-test, llm-behavior, embedding, vitest, e2e]
modules:
  - vitest.capability.config.ts
  - vitest.config.ts
  - config/config.test.yaml
  - tests/capability/helpers/boot.ts
  - tests/capability/helpers/assert-behavior.ts
  - tests/capability/helpers/skip-reporter.ts
  - tests/capability/memory-recall.capability.test.ts
  - src/frameworks/embedding/embedding-service.ts
  - package.json
---

# F20260805capt: 能力测试层（B 类真模型验证）

## 分层原则（与用户确认的判别标准）

- **A 类（软件边界内代码逻辑）**：传统测试，LLM 零介入。真 sqlite 作 DB seam。`npm test`，CI 跑。
- **B 类（LLM 参与的行为）**：必须真模型。断言行为不变量（工具轨迹/协议合规/枚举成员/关键 token），
  禁止断言具体措辞。`npm run test:capability`，本地跑。
- **embedding（bge-m3 本地确定性模型）**：永远不 mock。能力层启动时强断言 available，
  禁止静默降级 FTS-only（降级在本层等于撒谎）。

## 架构

```
config/config.test.yaml（入库，零机密，占位 LLM）
  ← config/config.test.local.yaml（gitignored，整段替换顶层键）
  ← OTTER_TEST_LLM_* 环境变量（覆盖 llm.models[0]）
tests/capability/helpers/
  boot.ts            每文件临时目录 + buildApp 真装配 + embedding 就绪强等待
                     + 无 LLM 时自动注入 initFauxModels（非 LLM 用例照常真跑）
  assert-behavior.ts sendUserMessage/waitForOtterMessage/toolCallNames/
                     expectToolUsed/expectSpeakCompliance/expectEventually
  skip-reporter.ts   运行结束显式打印 skip 计数与可操作原因（exit 0，不静默）
```

- 隔离：forks 池（每文件独立进程，隔离 config 单例与 pi SDK 缓存）、串行（一个本地端点 + 成本控制）。
- 全局副作用：`syncAuth:false`（不碰 ~/.pi/agent/auth.json）；DB/sessions/logs 全在临时目录；
  rootDir 默认空目录（见下文坑 3），.pi/skills 按 cwd 发现始终为真。

## 调试过程中发现并解决的四个坑（全是真实环境差异）

1. **embedding worker 路径依赖 dist**：vitest 跑 src 树，worker 只在编译产物里。
   → `embedding.workerPath` 覆盖；`test:capability` 先 build。
2. **boot 快得反常（3.4s）的假象**：syncDocuments 期间 embedding 未就绪，StoreMemory 跳过向量化，
   看起来"快"实际是 vec 全缺。→ 启动后强等待 available。
3. **fire-and-forget embedding 挤爆队列**：真实 docs 同步在 embedding 就绪后瞬时排入 ~546 个
   串行 embed（StoreMemory 的 M16 设计），测试的 embed 排队超时假死。
   → boot 默认 rootDir=空目录；需要真文档库的用例显式传入并接受排队时间。
4. **embedding worker 退出无事件**：onnxruntime 原生崩溃时 `error` 事件可能不触发，embed 永久挂起。
   → EmbeddingServiceImpl 补 `exit` 监听，拒绝所有 waiters/pending（生产级健壮性修复，不限于测试）。

## 旗舰测试：memory-recall.capability.test.ts

验证能力：「告诉獭一个事实 → 全新对话里问，獭能查记忆答出来」。
1. embedding 就绪（禁止降级）
2. StoreMemory 落事实 → `/api/memory/search` 真混合检索召回（真 bge-m3 + FTS RRF）
3. **统计断言**（F20260805mspk）：3 次采样 ≥1 次全链路成功（search_memory 先于 speak + 答案含事实 token）。
   采样明细全量打印。首轮实测 2/3 成功——失败的 1 次正是"搜到了没发言"的真实缺陷现场。

## 运行方式

```bash
npm test                # A 类，85 文件/1045 用例，CI 安全
npm run test:capability # B 类，先 build 再跑；无 LLM 配置时非 LLM 用例照常真跑 + 显式 skip 报告
npm run test:all        # 全部
```

## 验证记录

- 有 LLM（mimo）：3/3 用例绿（LLM 用例统计断言 2/3 采样全链路，明细见 F20260805mspk）
- 无 LLM：2 真跑 + 1 显式 skip（SKIP REPORT 打印原因），exit 0
- A 类套件无回归：85 文件 / 1045 用例全绿
