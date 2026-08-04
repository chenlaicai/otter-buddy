---
id: F20260804dcnv
title: memory-degradation-root-cause
doc_type: feature

summary: |
  修复记忆系统启动后持续降级的多个根因。表层是 health 端点报"8 文档未入库 + 语义检索不可用"，深层是反馈链路多处断裂：JSON import 缺 type attribute 致启动崩溃；9 份文档违反 frontmatter 规则被静默丢弃；sync 只打 error count 不打内容导致根因不可观测；文档硬规则没在创建期可见。修方法补属性 + 完整错误日志 + docs/README.md 单一真相源 + 整改 9 份文档。

causal_links:
  from:
    - F20260803emlo   # embedding-model-local-load：JSON import 缺 attribute 是其遗漏的语法
    - F20260803mval   # memory-validator-design：500 字 / 路径规则是其引入，但创建期可见性未建立
    - F20260803frmt   # frontmatter-backfill：F20260803vmsg 缺 frontmatter 是该批回填遗漏
  to: []

status: implemented
change_type: fix
tags: [memory, sync, frontmatter, convention, observability, json-import, reconcile-gap]
modules:
  - src/frameworks/embedding/ensure-model.ts
  - src/usecases/document/sync-documents.ts
  - src/usecases/document/disk-id-scanner.ts
  - src/interface-adapters/http/controllers/health-controller.ts
  - web/src/api/client.ts
  - web/src/pages/memory/index.tsx
  - scripts/lint-docs.mjs
  - .githooks/pre-commit
  - package.json
  - docs/README.md
---

# F20260804dcnv: 记忆系统降级多根因修复

## 背景

启动系统后，访问 `/memory` 页面顶部出现红色 banner：

> 记忆系统降级：8 个文档未入库；语义检索不可用；搜索结果可能不完整

`/api/health/memory` 返回：
```json
{"healthy":false,"documentsOnDisk":93,"documentsInDb":85,
 "reconcileGaps":["F20260725otid","F20260727ui6x","F20260803chunk",
                  "F20260803emlo","F20260803fbit","R20260716x2k9",
                  "R20260717y3k8","R20260728c5xt"],
 "embeddingAvailable":false,"embeddingModel":"Xenova/bge-m3"}
```

## 根因分析（多源叠加）

### 根因 1：JSON import 缺 type attribute 致启动崩溃

`src/frameworks/embedding/ensure-model.ts:11` 的 `import FILES from "./bge-m3-files.json"` 在 Node.js ESM 模式下必须显式 import attribute，否则运行时抛 `ERR_IMPORT_ATTRIBUTE_MISSING`。F20260803emlo 引入该文件时遗漏。修复前系统根本起不来；该 bug 在 worktree 测试时通过手动 `node dist/src/main.js` 直接运行 dist 才暴露。

**修**：`import FILES from "./bge-m3-files.json" with { type: "json" };`

### 根因 2：9 份文档违反 frontmatter 规则被静默丢弃

启动 sync 跑 `SyncDocuments.execute()`，9 份文档校验失败进入 `result.errors`：

| 文档 | 违规 | 字符数 / 期望 |
|------|------|----------|
| F20260725otid | summary 超长 | 598 / ≤500 |
| F20260727ui6x | summary 超长 | 551 / ≤500 |
| F20260803chunk | summary 超长 | 796 / ≤500 |
| F20260803emlo | summary 超长 | 646 / ≤500 |
| F20260803fbit | summary 超长 | 1004 / ≤500 |
| F20260803vmsg | 完全没写 YAML frontmatter | — |
| R20260716x2k9 | 路径缺日期子目录 | 期望 `docs/research/2026/07/16/` |
| R20260717y3k8 | 路径缺日期子目录 | 期望 `docs/research/2026/07/17/` |
| R20260728c5xt | 路径缺日期子目录 | 期望 `docs/research/2026/07/28/` |

校验失败的文档不入库，但其中 8 份在磁盘上存在 → 被 `reconcileSync` 检测为 gap 报出来。F20260803vmsg 不在 gap 里（它从来没入过库，磁盘扫描时 frontmatter 解析直接抛错跳过，连 ID 都收集不到，所以根本没进 gap 比对集——是个隐藏 bug）。

### 根因 3：sync 只打 error count 不打内容

`sync-documents.ts:88` 原 log 只输出 `errors: result.errors.length`。result.errors 数组里有 `{file, error}` 但**内容从未打日志**。导致刚才定位 9 个根因时只能反推（写 standalone validator 跑全量扫），花了一轮 build + restart 才拿到真实错误清单。

这违反"运行时可观测"原则——错误数据已经在内存里，就是没落盘。

### 根因 4：文档硬规则没在创建期可见

最深层的设计缺陷。500 字 summary 上限、日期子目录路径规则都在 `frontmatter-validator.ts` 编码，但**只在启动 sync 时强制**。LLM 写文档时完全看不到这些约束 → 写完跑 sync 才知道违规 → 反馈延迟到运行时。

按"机制约束优先让 LLM 理解"原则，主手段应该是**创建期就能看到规则**，工程拦截（validator）只是兜底。

## 修复方案

### 修复 1：JSON import attribute（ensure-model.ts）

```diff
-import FILES from "./bge-m3-files.json";
+import FILES from "./bge-m3-files.json" with { type: "json" };
```

### 修复 2：sync 把 errors 数组完整打日志（sync-documents.ts）

```ts
// F20260804dcnv: 把 errors/warnings 内容也打到日志——
// 之前只打 count，导致 gap 根因只能反推（违反"运行时可观测"原则）
if (result.errors.length > 0) {
  this.logger.error('Sync errors detail', undefined, {
    errors: result.errors, action: 'sync_errors_detail',
  });
}
if (result.warnings.length > 0) {
  this.logger.warn('Sync warnings detail', {
    warnings: result.warnings, action: 'sync_warnings_detail',
  });
}
```

### 修复 3：docs/README.md 作为硬规则单一真相源

`docs/README.md` 重写为完整的文档规约，内容镜像 validator 的硬规则：
- 必填字段（id / title / summary）
- summary ≤500 字上限 + 蒸馏模板（"是什么 / 为什么 / 怎么做"三问，详细挪 body）
- 路径格式（ID 日期与目录日期必须对应）
- 软警告字段（status / change_type / exploration_type 未知值不阻断但记 warnings）
- supersedes 前缀校验
- 反例（这次踩的三个坑）
- 完整模板

### 修复 4：创建期可见性（memory pointer）

在用户 auto-memory 加 `reference_doc_convention.md`，索引到 MEMORY.md。下次任何 Claude 会话创建 F/R 文档前，会先 Read docs/README.md 对一遍模板。

### 修复 5：整改 9 份违规文档

- **5 份 F 文档 summary 蒸馏**（F20260725otid / F20260727ui6x / F20260803chunk / F20260803emlo / F20260803fbit）：summary 压到 ≤500 字符，详细根因/方案/验证保留在 body（蒸馏前确认 body 已有对应章节，未丢信息）。
- **3 份 R 文档路径统一**（R20260716x2k9 / R20260717y3k8 / R20260728c5xt）：`git mv` 到 `docs/research/YYYY/MM/DD/`，与 features 路径同构。
- **F20260803vmsg 补 frontmatter**：从原有"概述"章节蒸馏 summary，补齐 id/title/causal_links/status/change_type/tags/modules。

### 修复 6：embedding 配置示例对齐

`config/config.yaml` 历史配置是 `modelPath: Xenova/bge-m3`（HF 远程 id）。但按 `config.yaml.example` 约定，本地模式应该是 `modelPath: bge-m3 + localModelPath: ./models`，否则 ensureBgeM3Model 会把两者拼接成 `./models/bge-m3/Xenova/bge-m3/`（不存在），误触发下载。

`embeddingAvailable: false` 的根因就是这条——远程 HF 不可达 + 配置路径拼接错。主仓库 config 已改对。

## 设计反思：为什么这套问题能存在至今

1. **health 端点报 gap 但不报原因**。设计上只暴露**症状**（X 个未入库），不暴露**根因**（哪份文档违反什么规则）。用户看到 banner 不知道是什么、为什么、怎么修。本次补了 `gapReasons` 字段 + 前端展开列表。
2. **创建期无校验**。validator 是后置兜底，不是前置引导。LLM 写文档靠记忆/惯例，约束散落在代码里没有文档化的真相源。docs/README.md + lint:docs pre-commit hook 解决的就是这一条。
3. **F20260803vmsg 的隐藏 bug**：`parseFrontmatterFromContent` 抛 "Missing frontmatter" 时，`collectDiskIds` 也用同一份扫描逻辑，但它在 try/catch 里吞掉异常。结果是：缺 frontmatter 的文档既不在 DB 里，也不在 disk ID 集合里——双重消失。本次抽共享 scanner 走文件名兜底修掉。

Follow-up（原计划留给后续 PR，本次一并清掉）：

### Follow-up 1：health 端点补 `gapReasons`

`HealthController.memory` 对每个 gap ID 反查文件路径，跑 validator 拿失败原因，返回 `gapReasons: [{id, file, errors}]`。前端 `memory/index.tsx` banner 改成可展开列表，直接显示每个 gap 的具体违规（不再只看"8 个文档未入库"猜原因）。

### Follow-up 2：`collectDiskIds` 与 `parseFrontmatterFromContent` 解耦

抽 `src/usecases/document/disk-id-scanner.ts` 作为共享 scanner：
- 优先用 frontmatter（单一真相源）
- frontmatter 缺失/损坏时走**文件名正则兜底**（`F\d{8}[a-z0-9]{3,8}` / `R\d{8}[a-z0-9]{3,8}`）
- 返回 `Map<id, filepath>` 让 health 端点能反查文件做二次校验

`SyncDocuments.collectDiskIds` 和 `HealthController.collectDiskIds` 都改为委托给共享 scanner，消除两处实现分裂。缺 frontmatter 的文档现在会出现在 `reconcileGaps` 里（不再双重消失）。

### Follow-up 3：`lint:docs` + pre-commit hook

`scripts/lint-docs.mjs`：复用 dist/ 里编译好的 validator + parser（不重复规则），扫 `docs/features` + `docs/research` 全量校验。退出码 0/1，违规阻断 commit。

`package.json` 加 `lint:docs` 脚本；`.githooks/pre-commit` 在 `npm run check` 后追加 `npm run lint:docs`。反馈链路：**写完文档 -> commit -> 立刻知道违规**，从运行时（启动 sync）推到 commit 时。

顺手修了 4 份文档的枚举值违规（`change_type: bugfix` -> `fix`、`status: shipped` -> `implemented`、`change_type: feat` -> `feature`）--这些是 F20260803mval 决策 5"bugfix 统一为 fix"的漏网之鱼，lint:docs 一跑就暴露了。

## 验证

### summary 长度全量校验

```
455 F20260725otid
141 F20260727ui6x
396 F20260803chunk
394 F20260803emlo
357 F20260803fbit
```

全部 ≤ 500。

### lint:docs 全量通过

```
[lint:docs] 96 docs OK
```

0 errors, 0 warnings。

### 端到端 health

```
healthy: true
documentsOnDisk: 95 | documentsInDb: 95
reconcileGaps: []
gapReasons: []
embeddingAvailable: true
```

数量差异说明（`documentsOnDisk` 计的是**唯一 ID 数**，不是 .md 文件数）：
- 磁盘 .md 文件数：96（`find docs -name '*.md' | wc -l`）
- 唯一 ID 数：96--ID 冲突已修复（见下）
- `lint:docs` 报 96，与 health 一致

**ID 冲突修复**：scanner 的 warn 暴露了 `F20260722mk74` 被两份文件共用（`multi-otter-streaming.md` PR #79 和 `startup-reliability-fixes.md` PR #68）。PR #68 先发，保留 `F20260722mk74`；PR #79 的 `multi-otter-streaming.md` 改 ID 为 `F20260722mots`，文件名同步重命名，causal_links.from 补 `F20260722mk74` 标明继承关系。

### JSON import

`npm run build` tsc --noEmit 通过；启动时不再抛 `ERR_IMPORT_ATTRIBUTE_MISSING`。

## 后续可能改进（不在本 PR）

- `gapReasons` 字段已暴露但前端 banner 当前只在 `!healthy` 时显示。可加一个"查看详情"展开控件，长列表折叠。
- `lint:docs` 当前依赖 dist/ 已构建。可考虑用 `tsx` 直接跑 TS 源，去掉对 build 顺序的依赖（但会增加一个 devDep）。
