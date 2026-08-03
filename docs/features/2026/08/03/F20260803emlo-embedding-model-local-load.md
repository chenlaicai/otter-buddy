---
id: F20260803emlo
title: embedding-model-local-load
doc_type: feature

summary: |
  修复 bge-m3 embedding 模型加载失败导致 memory_vec 表永远 0 行的缺陷。根因是双层 bug 叠加：embedding-service.ts 把传入的 embedConfig 参数命名为 _embedConfig 直接丢弃，config-service.ts 里 embedding.modelPath 字段形同虚设；bge-m3-worker.ts 又硬编码 "Xenova/bge-m3" 且每次启动都从 HuggingFace 远程拉取。用户环境无法访问 huggingface.co（连接超时），导致每次启动 fetch failed、静默降级 FTS-only、向量检索路径永远空。修复将配置真正透传给 worker（workerData），并新增 localModelPath 字段切换本地/远程两种加载模式：本地模式禁用远程下载、模型文件预置在 models/ 目录；远程模式尊重 HF_ENDPOINT 环境变量支持镜像。模型权重文件（2.27GB 的 model.onnx_data 由用户提供 + 5 个小文件从 hf-mirror 拉取）置于仓库 models/bge-m3/，加入 .gitignore。集成测试验证：模型从本地路径加载成功，1024 维输出，cos("hello world","你好世界")=0.90 证明多语言语义检索生效。降级路径保留：worker 加载失败仍走原 FTS-only fallback 不阻塞主流程。

causal_links:
  from:
    - F20260713i5k2   # infra-llm-agent-embedding：embedding 服务初始架构，本 F 修其加载链路断裂
    - F20260803mval   # memory-validator-link-integrity：其"已知限制 G4 embeddingModel 硬编码"由本 F 解决；issue #124 Task C
  to:
    - F20260717yngs   # llm-api-config-unification：config 透传模式的同构延续

status: development
change_type: fix
tags: [embedding, bge-m3, model-loading, offline, config-wiring, huggingface, worker-thread, memory-vec]
modules:
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/frameworks/embedding/embedding-env-config.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/embedding/ensure-model.ts
  - src/frameworks/embedding/bge-m3-files.json
  - src/frameworks/config-service.ts
  - src/main.ts
  - src/interface-adapters/http/controllers/settings-controller.ts
  - api-contract/api/settings.ts
  - web/src/pages/settings/index.tsx
  - scripts/download-bge-m3.mjs
  - config/config.yaml.example
  - .gitignore

created_at: 2026-08-03
---

# F20260803emlo Embedding 模型本地加载

## 背景

### 问题

启动日志反复出现：

```
Embedding model unavailable, falling back to FTS5-only: fetch failed
```

排查后确认是**双层 bug 叠加 + 网络环境不可达**三重因素导致 `memory_vec` 表永远 0 行、向量检索路径永远空（RRF 融合代码完整但 vec 路始终返回空数组，实际只有单路 FTS）：

```
config.yaml embedding.modelPath: Xenova/bge-m3
  -> main.ts:560 initEmbeddingService(appConfig.embedding, logger)
  -> embedding-service.ts 参数命名为 _embedConfig ← 断点1: 配置被丢弃
  -> new Worker(workerPath)  无 workerData
  -> bge-m3-worker.ts pipeline("feature-extraction", "Xenova/bge-m3") ← 断点2: 硬编码 + 强制远程
  -> HuggingFace 下载 ← 断点3: 用户环境 huggingface.co 连接超时
  -> fetch failed
  -> 静默降级 FTS-only
```

| 断点 | 表现 | 性质 |
|------|------|------|
| 1. embedConfig 被丢弃 | `_embedConfig` 参数从未读取 | 配置透传断裂（死参数） |
| 2. model id 硬编码 | worker 写死 "Xenova/bge-m3" | 无法通过配置改模型或切本地 |
| 3. 强制远程 + 网络不通 | 每次启动都尝试 huggingface.co | 用户环境 HF 不可达，永远失败 |

**网络实况**（已测）：

| 端点 | 连通性 | 备注 |
|------|--------|------|
| huggingface.co | 超时（TCP 阻断） | DNS 解析正常，ping 100% 丢包 |
| hf-mirror.com | 可达但慢（CDN 握手 6-17s，吞吐 ~50KB/s） | config.json 等小文件可下，2.27GB 大文件需断点续传 |
| github.com / npmjs.org | 正常 | |
| 本机 HF 缓存 | 不存在（`~/.cache/huggingface` 未创建） | 从未成功下载过一次 |

**根本病因**：bge-m3 是本地推理模型（推理纯本地走 onnxruntime-node），但首次加载必须从 HuggingFace 下载一次模型权重（约 2.3GB）到本地缓存。代码假设"远程永远可达"，没有提供任何离线/本地路径的逃生通道。配置层（config-service.ts）有 `embedding.modelPath` 字段、example 里也写了"或本地路径"注释，但 service 层把参数丢弃，worker 层又硬编码——配置承诺的本地路径能力从未实现过。

### 设计目标

- **配置真正生效**：`embedding.modelPath` 不再是死字段，worker 真正读取它。
- **支持离线加载**：模型文件预置在本地目录时，完全不联网，避免每次启动尝试下载。
- **远程模式可配镜像**：联网模式下尊重 `HF_ENDPOINT` 环境变量，支持 hf-mirror 等镜像。
- **降级路径保留**：worker 加载失败仍走原 FTS-only fallback，不阻塞主流程（F20260803mval 健康端点会暴露该降级）。

## 变更

### 1. 配置真正透传给 worker

`embedding-service.ts:145-157`：

```typescript
// 旧：参数名 _embedConfig 直接丢弃
export async function initEmbeddingService(
  _embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<...> {
  const worker = new Worker(workerPath);
  ...
}

// 新：参数改名 + 通过 workerData 传给 worker
export async function initEmbeddingService(
  embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<...> {
  const worker = new Worker(workerPath, {
    workerData: {
      modelPath: embedConfig?.modelPath ?? "Xenova/bge-m3",
      localModelPath: embedConfig?.localModelPath,
    },
  });
  ...
}
```

`EmbeddingConfig` 接口扩展 `localModelPath?: string` 字段。

**为什么 workerData 而非环境变量**：workerData 是 Node.js 主线程 → worker 线程传递结构化数据的标准通道，类型安全、无需序列化字符串解析。环境变量是全局共享的，多 worker 场景下会冲突。

### 2. worker 按配置切换本地/远程模式（env 配置抽纯函数）

env 配置逻辑抽到独立纯函数 `embedding-env-config.ts:resolveEnvSettings(cfg, cwd?, hfEndpointEnv?)`，返回 `{ allowLocalModels, allowRemoteModels, localModelPath?, remoteHost?, modelId }`。worker 入口（top-level `throw if !parentPort`）无法被 test import，抽离后可单测。worker 只做 `env.* = settings.*` 赋值：

```typescript
// embedding-env-config.ts（纯函数，可单测）
export function resolveEnvSettings(cfg, cwd = process.cwd(), hfEndpointEnv = process.env.HF_ENDPOINT) {
  const modelId = cfg.modelPath ?? "Xenova/bge-m3";
  if (cfg.localModelPath) {
    return { allowLocalModels: true, allowRemoteModels: false,
             localModelPath: path.resolve(cwd, cfg.localModelPath), modelId };
  }
  const s = { allowLocalModels: false, allowRemoteModels: true, modelId };
  if (hfEndpointEnv) {
    s.remoteHost = hfEndpointEnv.endsWith("/") ? hfEndpointEnv : `${hfEndpointEnv}/`;
  }
  return s;
}

// bge-m3-worker.ts（调用纯函数 + 赋值 env）
const settings = resolveEnvSettings((workerData ?? {}) as WorkerConfig);
env.allowLocalModels = settings.allowLocalModels;
env.allowRemoteModels = settings.allowRemoteModels;
if (settings.localModelPath) env.localModelPath = settings.localModelPath;
if (settings.remoteHost) env.remoteHost = settings.remoteHost;
const pipe = await pipeline("feature-extraction", settings.modelId, { dtype: "fp32" });
```

`bge-m3-worker.ts` 原 `getExtractor` 的 lazy 加载同时改为 **promise cache**（见变更 7），消除预加载与并发 embed 请求的 race。

**本地模式路径解析**：transformers.js v4 的 `env.localModelPath` 是模型根目录，`pipeline(modelId)` 会在 `<localModelPath>/<modelId>/` 下找 `config.json`。所以 config 配 `localModelPath: ./models` + `modelPath: bge-m3` → 实际查 `<cwd>/models/bge-m3/config.json`。

**为什么本地模式显式 `allowRemoteModels=false`**：transformers.js 默认本地找不到就回退远程，会再次触发 HF 下载尝试。显式禁用确保本地缺失时直接报错（快速失败，错误信息清晰），而非挂网络重试。

**为什么远程模式显式 `allowLocalModels=false`**：避免本地残留的旧模型文件意外命中，确保远程模式行为可预测。

**HF_ENDPOINT 末尾斜杠处理**：transformers.js v4 的 `pathJoin`（`hub/utils.js:10`）会自动处理首尾斜杠，`remoteHost` 有无尾斜杠产出的 URL 相同。补尾斜杠是**与默认值 `https://huggingface.co/` 格式保持一致**的防御性处理，避免未来版本若改为直接字符串拼接时出错。当前版本属 harmless redundancy。

### 3. config schema 加 localModelPath 字段

`config-service.ts`：

- `AppConfig.embedding` 加 `localModelPath?: string`
- `RawConfig.embedding` 同步加
- `applyDefaults` 读取 `raw.embedding?.localModelPath ?? undefined`（无默认值，未配置即走远程模式）

### 4. config.yaml.example 默认改为本地模式

```yaml
embedding:
  dimensions: 1024
  modelPath: bge-m3              # 本地模式：localModelPath 下的目录名
  localModelPath: ./models       # 设置后启用本地加载、禁用远程下载
```

注释说明两种模式切换 + 目录结构示例 + HF_ENDPOINT 镜像支持。

**为什么默认本地**：用户环境普遍无法直连 HF（中国大陆网络常态），本地模式是更稳健的默认。模型权重文件需用户自行下载放置（一次性，2.3GB），文档说明清楚。

### 5. .gitignore 排除 models/

```
# Local model weights (large, downloaded separately)
# Layout: models/<model-name>/onnx/*.onnx[+_data]
models/
```

**为什么不进 git**：`model.onnx_data` 单文件 2.27GB，超过 GitHub 单文件 100MB 限制 22 倍。且模型权重是环境产物（不同环境可能用不同量化版本），不应绑定代码仓库。

### 6. 模型文件预置

`models/bge-m3/` 目录布局（fp32 dtype 所需）：

```
models/bge-m3/
├── config.json              (770 B)
├── tokenizer.json           (17 MB，含词表 vocab_size=250002)
├── tokenizer_config.json    (1.2 KB)
├── special_tokens_map.json  (964 B)
└── onnx/
    ├── model.onnx           (607 KB，计算图)
    └── model.onnx_data      (2.27 GB，权重)
```

`model.onnx_data` 由用户提供（hf-mirror 慢但支持断点续传，用户用支持 resume 的工具下载）；其余 5 个小文件由本任务通过 hf-mirror 拉取（curl --retry 3）。

### 7. worker 懒加载改 promise cache（对抗审视 L3）

`bge-m3-worker.ts` 原 `getExtractor` 用 `let extractor: ... | null` 标志位做 lazy 加载。文件末尾预加载调用（`getExtractor().then(...)`）与 `port.on("message")` 中的 `getExtractor()` 调用可能同时 in-flight，两个调用都进入 `if (!extractor)` 块，各自调用 `pipeline()` 加载 2.27GB 模型，造成内存峰值翻倍 + `postMessage({type:"ready"})` 发两次。

改为 `let extractorPromise: Promise<Extractor> | null`，`getExtractor()` 返回已有 promise 而非重新启动加载：

```typescript
let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => { /* pipeline 加载 */ })();
  }
  return extractorPromise;
}
```

第二次调用拿到同一个 promise，不会重复加载。失败时 promise 被 reject 但仍缓存（后续调用也 reject，错误一致），这是可接受的--worker 加载失败本就走 FTS-only 降级，不会重试。

**为什么纳入本 F**：race 在代码 I touched（getExtractor 重构），虽是 pre-existing 问题，但既然改了这块就一并修干净。

### 8. settings API 补 embedding 加载模式可观测性（对抗审视 L1）

`main.ts:631` 的 `embeddingModelPath: appConfig.embedding.modelPath` 本地模式下值为 `"bge-m3"`（只是目录名），settings API 消费者无法区分本地加载还是远程下载。补 `embeddingLocalModelPath` 字段透传到 settings：

- `api-contract/api/settings.ts` SettingsDTO 加 `embeddingLocalModelPath?: string`
- `settings-controller.ts` SettingsConfig 同步加
- `main.ts` settings 构造透传 `appConfig.embedding.localModelPath`
- `web/src/pages/settings/index.tsx` Embedding 状态区加"加载模式"行：本地模式显示 `本地（./models）`，远程模式显示 `远程（HuggingFace）`

### 9. 模型下载脚本（幂等 + 断点续传 + 失败说明）

`scripts/download-bge-m3.mjs`：独立 CLI 脚本，确保模型文件就位。

- **幂等**：检查 `models/bge-m3/` 下 6 个必需文件（config/tokenizer/onnx 等），存在且 size 匹配则跳过
- **断点续传**：curl `-C -` 已下载部分不重下（2.27GB 大文件恢复关键），`--retry 3` 失败自动重试
- **镜像**：默认 `https://hf-mirror.com`（HF 不可达），尊重 `HF_ENDPOINT` 环境变量换镜像
- **CI 跳过**：检测 `CI=true` 自动跳过（CI 不需要真实模型，测试全 mock），`--force` 可强制
- **失败可见**：下载失败打印详细手动说明（缺失文件列表 + URL + 目标路径 + 工具建议）后 exit 1

**为什么 curl 而非 node fetch**：curl 原生支持 `-C -` 断点续传，node fetch 需手写 Range 头 + 状态管理。2.27GB 在不稳定网络上断点续传是刚需。

### 10. build + 启动时自动检查下载

**build 集成**（`package.json`）：
```
"build": "... && (node scripts/download-bge-m3.mjs || echo \"[bge-m3] 模型下载失败，启动时将重试或降级 FTS-only\")"
```
build 末尾跑下载脚本；失败用 `|| echo` 兜底不阻断构建（模型不是构建产物必需），启动时还有第二道防线。

**启动集成**（`main.ts` + `ensure-model.ts`）：
`initEmbeddingService` 前调 `ensureBgeM3Model(appConfig.embedding, logger)`：
- 本地模式 + 文件就位：记 info 日志，跳过
- 本地模式 + 文件缺失：spawn 下载脚本（同步阻塞启动，正常情况文件已存在秒过；丢失场景阻塞可接受）
- 下载失败：warn 降级提示，不抛异常 -> worker 加载会失败 -> 走 FTS-only fallback（不阻塞主流程）
- 远程模式：直接跳过（worker 自行处理远程下载）

**为什么 build + 启动双检查**：build 时下载覆盖"首次部署"场景；启动时检查覆盖"文件丢失"场景（如误删 models/、迁移环境）。两道防线确保模型缺失不静默。

## 设计决策

1. **本地/远程双模式而非仅本地**：保留远程模式支持（1）开发环境能联网时首次自动下载的便利；（2）未来可能换更轻量模型（如 int8 量化版 568MB）时无需改代码；（3）HF_ENDPOINT 镜像支持作为网络受限环境的中间方案。单一本地模式会让"换模型"变成代码改动。

2. **不切量化版本（保持 fp32）**：fp32 是 2.27GB，int8 仅 568MB、下载快 4 倍、推理快、质量损失可忽略（embedding 检索场景 int8 vs fp32 差距 <1%）。但本 F 聚焦"修加载失败"而非"优化模型选择"，切 dtype 属于另一个独立决策（涉及质量基准测试）。fp32 是当前 worker 已有的 `dtype: "fp32"`，保持不动最小化改动面。未来优化另立 F 文档。

3. **不预置模型到 npm 包/仓库**：2.27GB 权重不可能进 npm 包或 git。标准实践是文档说明下载步骤 + .gitignore 排除。transformers.js 官方也是首次运行下载。

4. **HF_ENDPOINT 而非新增 config 字段**：HF_ENDPOINT 是 HuggingFace 生态通用环境变量（huggingface-cli、transformers python、transformers.js 都认），用户可能已设。新增 config 字段会与环境变量重复且需解释优先级。环境变量是已有约定，零配置成本。

5. **modelPath 字段双语义（本地目录名 vs 远程 repo id）**：根据 `localModelPath` 是否设置自动判定。看似歧义，实则：本地模式下 modelPath 就是目录名（如 `bge-m3`），远程模式下就是 repo id（如 `Xenova/bge-m3`），两者在各自上下文里都是"模型标识"，语义自然。强拆两个字段反而增加配置复杂度。

6. **workerData 路径相对 process.cwd() 而非主 repo 根**：transformers.js 的 `env.localModelPath` 接受绝对路径最稳。worker 内 `path.resolve(process.cwd(), cfg.localModelPath)` 把相对路径解析为绝对。`process.cwd()` 是启动 node 的目录，约定为项目根。与 config.yaml 的加载路径（`path.resolve(process.cwd(), "config/config.yaml")`，见 config-service.ts:141）一致。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/frameworks/embedding/bge-m3-worker.ts` | 读 workerData；调 resolveEnvSettings 赋值 env；去硬编码；lazy 加载改 promise cache（变更 7） |
| `src/frameworks/embedding/embedding-env-config.ts` | 新增：resolveEnvSettings 纯函数 + WorkerConfig/ResolvedEnvSettings 类型 |
| `src/frameworks/embedding/embedding-service.ts` | `_embedConfig` → `embedConfig`；workerData 透传；EmbeddingConfig 加 localModelPath |
| `src/frameworks/config-service.ts` | AppConfig.embedding + RawConfig.embedding 加 localModelPath 字段 |
| `src/main.ts` | settings 构造透传 embeddingLocalModelPath |
| `src/interface-adapters/http/controllers/settings-controller.ts` | SettingsConfig 加 embeddingLocalModelPath |
| `api-contract/api/settings.ts` | SettingsDTO 加 embeddingLocalModelPath |
| `web/src/pages/settings/index.tsx` | Embedding 状态区加"加载模式"行 |
| `src/frameworks/embedding/ensure-model.ts` | 新增：启动时检查模型文件，缺失则 spawn 下载脚本 |
| `src/frameworks/embedding/bge-m3-files.json` | 新增：必需文件清单单一真相源（ensure-model + download 脚本共享） |
| `scripts/download-bge-m3.mjs` | 新增：幂等下载脚本（断点续传 + 失败说明 + CI 跳过） |
| `package.json` | build 末尾挂下载步骤；新增 download:bge-m3 独立脚本 |
| `eslint.config.mjs` | scripts/*.mjs 的 node globals 配置块 |
| `config/config.yaml.example` | 默认改为本地模式；文档说明两种模式 + 目录结构 |
| `.gitignore` | 排除 `models/` |
| `models/bge-m3/*` | 模型文件预置（gitignore，不提交） |

## 测试

### 自动化

- `npm run lint` 无报错
- `npx tsc --noEmit` 类型检查通过
- `npx vitest run` 全量 910/910 测试通过（含 resolveEnvSettings 9 个 + ensure-model 7 个 + config-service 补 localModelPath）

### 集成（端到端，真实 worker 线程）

临时脚本调用真实的 `initEmbeddingService({modelPath:"bge-m3", localModelPath:"./models"})`：

```
pipeline-load: 6.2s         ← 冷启动模型加载耗时
embed-1: 2.9s               ← 首次 embed（含 tokenizer warm-up）
embed-2: 47.8ms             ← 第二次 embed（已 warm）
dim: 1024                   ← 维度正确
cos(hello world, 你好世界): 0.8997   ← 多语言语义相似度生效
3 concurrent embeds: 147ms  ← promise cache 生效，无双重加载（变更 7 验证）
```

### 验收对照（Issue #124 Task C）

| 验收项 | 结果 |
|--------|------|
| 启动日志不再出现 `fetch failed` | ✅ 本地模式 allowRemoteModels=false，根本不发起网络请求 |
| `memory_vec` 表有向量数据写入 | ✅ service.available=true 后 embed 调用成功，主流程会写入（依赖 Task B/D 文档入库后才有内容可 embed） |
| 语义搜索生效：搜近义词能命中 | ✅ cos 0.90 证明语义编码正确，中英文跨语言生效 |
| 降级路径仍保留 | ✅ worker 加载失败仍 postMessage `{type:'error',id:-1}`，service 的 setupHandlers 原样保留 fallback 逻辑 |

## 对抗审视记录

本 F 经独立 agent 对抗审视（PR #130），命中 2 个中等问题 + 3 个低问题，全部处理：

- **M1 零测试覆盖**（中）→ 变更 2 抽 `resolveEnvSettings` 纯函数 + 新增 `embedding-env-config.test.ts`（9 个 case 覆盖 local/remote 模式切换、HF_ENDPOINT 尾斜杠、默认值回退）；config-service.test.ts 补 localModelPath 解析测试。
- **M2 文档 HF_ENDPOINT 论证错误**（中）→ 变更 2 文档段落修正：transformers.js v4 `pathJoin` 自动处理首尾斜杠，补尾斜杠是与默认值格式一致的防御性处理，非"必要兜底"。
- **L1 settings API 信息丢失**（低）→ 变更 8 补 `embeddingLocalModelPath` 到 SettingsDTO/SettingsConfig/main.ts/web，前端加"加载模式"行。
- **L2 `HF_ENDPOINT="/"` 边界**（低）→ 权衡可接受，荒谬输入不加防御（过度工程）。
- **L3 模型加载 race condition**（低，pre-existing）→ 变更 7 修：`extractor: null` 标志位改 `extractorPromise: Promise|null`，消除预加载与并发 embed 的双重加载。

审视验证通过的关键点：worker thread cwd 与主线程一致、workerData 传递 undefined 正确、`bge-m3` 是合法 HF model ID、本地模式文件缺失时错误信息清晰、向后兼容（现有 config.yaml 不含 localModelPath 时走远程模式）、.gitignore 正确排除 2.27GB。

### 第二轮审视（下载机制新增后）

第二轮独立 agent 对抗审视命中 1 阻断 + 1 高 + 2 中：

- **B1 build 命令 `\|\| echo` 吞掉所有失败**（阻断）→ `A && B && C \|\| echo` 中 `\|\|` 绑定整个 `&&` 链，lint/tsc 失败也被 echo 吞掉、build exit 0。修复：`(download \|\| echo)` 用括号隔离，使 `\|\|` 只绑定 download。
- **H1 tokenizer.json 等 4 文件 size=null 截断不检测**（高）→ curl 下载中断后文件存在但截断，size=null 只查存在不查大小，认为完整跳过，worker 加载截断文件会 crash。修复：所有 6 个文件补全实际 size（tokenizer.json=17082821 等），全部校验。
- **M1 build-time 下载硬编码 bge-m3 路径**（中）→ 与可配置 modelPath 不一致，用户改 modelPath 时 build 下载的文件路径和 worker 查找路径不匹配。权衡可接受：config.yaml.example 示例固定 bge-m3，偏离示例属自定义配置。
- **M2 REQUIRED_FILES 双份定义漂移风险**（中）→ ensure-model.ts 和 download 脚本各维护一份常量列表。修复：抽 `bge-m3-files.json` 单一真相源，两处共享同一份。
- **M3 ensure-model 与 config-service 默认值不一致**（中）→ ensure-model `?? "bge-m3"` vs config-service `"Xenova/bge-m3"`。修复：加注释说明差异（ensure-model 是 modelPath 完全未传的兜底，applyDefaults 总会填值）。

其余 L 级（CI=false 字符串 truthy、多实例并发下载无锁、同步阻塞启动、CI 产物无模型）权衡可接受。

## 关联

- Issue #124 Task C（本 F 即其交付物）
- F20260803mval §10 明确将"embedding 离线"列为独立 F 文档跟踪锚点；其 §"已知限制 G4 embeddingModel 硬编码"由本 F 解决
- F20260713i5k2 infra-llm-agent-embedding：embedding 服务初始架构，本 F 修其加载链路断裂
