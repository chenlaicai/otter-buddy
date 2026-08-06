# 测试指南

Otter Buddy 测试分两层（F20260806tstr）。核心原则：**软件边界内验证代码逻辑用传统测试；
涉及 LLM 行为必须真模型，mock 即自欺；embedding（本地 bge-m3）永远不 mock。**

## 两层结构

| | A 类（代码逻辑） | B 类（能力/LLM 行为） |
|---|---|---|
| 命令 | `npm test` | `npm run test:capability` |
| 环境 | 无外部依赖，CI 跑 | 本地跑，需 LLM 端点 + 本地 bge-m3 |
| 位置 | `tests/`（除 capability/） | `tests/capability/**/*.capability.test.ts` |
| 断言 | 精确断言 | 行为不变量（工具轨迹/协议合规/关键 token），禁止措辞断言 |
| DB | 真 sqlite `:memory:`（`tests/helpers/createTestDb`） | 真 sqlite 临时文件 |

## A 类约定

- DB 一律 `createTestDb()`（生产 initSchema），**禁止手写 DDL**（会与生产 schema 静默漂移）
- 共享设施在 `tests/helpers/`：logger / fakeAgentGateway / SSE 读取器。禁止再抄副本
- 不写这些测试：mapper/DTO 字段抄送、pass-through 委托、实现细节镜像
  （判别：断言失败时用户/调用方能否感知）

## B 类（能力层）配置

LLM 端点三选一（优先级从低到高合并）：

1. `config/config.test.yaml`（入库，零机密占位）
2. `config/config.test.local.yaml`（gitignored，整段替换顶层键——从 `config/config.yaml` 复制 LLM 段即可）
3. 环境变量：`OTTER_TEST_LLM_PROVIDER` / `OTTER_TEST_LLM_MODEL` / `OTTER_TEST_LLM_API_KEY` / `OTTER_TEST_LLM_BASE_URL`

无 LLM 配置时：非 LLM 用例照常真跑（自动注入 faux models），LLM 用例显式 skip 并打印原因（exit 0）。

```bash
npm run test:capability        # 先 build（embedding worker 需要 dist 产物）再跑
npm run test:capability:only   # 跳过 build（已构建过时）
npm run test:all               # 两层全跑
```

## B 类写作约定

- **行为不变量，不断言措辞**：`toolCallNames` / `expectToolUsed`（含顺序）/
  `expectSpeakCompliance` / 关键 token 包含
- **LLM 行为用统计采样**：`expectSampledBehavior(label, 3, 1, fn)`——mimo 行为不稳定
  （issue #160），单次断言会把套件打成长红；采样明细全量打印，成功率归零才失败
- **embedding 禁止静默降级**：boot 强等待 available，缺失直接失败（本层降级等于撒谎）
- 每文件独立进程（forks 池）、串行执行；boot 默认 rootDir=空目录
  （真实 docs 同步的 fire-and-forget embedding 会挤爆 worker 串行队列）
- **cwd 沙箱**：boot 把进程 cwd 切到临时沙箱（只软链 .pi/prompts/models）——
  獭的 read/bash/write 工具默认落点在沙箱内，防能力测试的真獭误写仓库
  （实测：獭曾自发建 worktree 完整实现被要求的"功能"）
- `waitForOtterMessage` 等的是**回合终局**（优先 completed；speak 未收尾的失败会触发自动重试）
- session jsonl 解析集中在 `tests/capability/helpers/session-file.ts`（SDK 格式变化只改这里）

## F 文档 capability_test 约定

`change_type` 为 `feature`/`prompt` 的 F 文档，frontmatter 声明：

```yaml
capability_test: tests/capability/xxx.capability.test.ts   # 或 "n/a: 纯代码逻辑改动（A 类）"
```

`node scripts/lint-capability-docs.mjs`（pre-commit 接入）：缺字段警告、路径不存在报错。

## 常见坑（都是实测踩过的）

1. **embedding worker 路径依赖 dist**：vitest 跑 src 树，worker 只在编译产物里
   → 测试配置 `workerPath` 指向 dist（harness 已处理）
2. **vitest fork 的 execArgv 污染 worker**：`--conditions development` 会被 worker 线程继承，
   导致 @huggingface/transformers 解析错乱、推理挂起 → harness 已设 `workerExecArgv: []`
3. **config yaml 的 DB 键名是 `database` 不是 `db`**：写错静默回退 `./otter-buddy.db` 污染仓库根
4. **participant 有 otter FK**：种子数据必须先建 otter 行；join/leave 的系统消息会触发
   tryCloseTurn 关回合，连续操作前须开新 turn
5. **turn 是"一跳"不是"一轮问答"**：用户消息终态即关 turn，otter 回复开新 turn
