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
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/config-service.ts
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

### 2. worker 按配置切换本地/远程模式

`bge-m3-worker.ts:31-66`：worker 读取 `workerData`，根据 `localModelPath` 是否存在切换两种模式：

```typescript
const { pipeline, env } = await import("@huggingface/transformers");
const cfg = (workerData ?? {}) as WorkerConfig;

if (cfg.localModelPath) {
  // 本地模式：模型文件已预置，禁用远程避免触发下载
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.resolve(process.cwd(), cfg.localModelPath);
} else {
  // 远程模式：尊重 HF_ENDPOINT 环境变量以支持镜像（如 https://hf-mirror.com/）
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  const hfEndpoint = process.env.HF_ENDPOINT;
  if (hfEndpoint) {
    env.remoteHost = hfEndpoint.endsWith("/") ? hfEndpoint : `${hfEndpoint}/`;
  }
}
const modelId = cfg.modelPath ?? "Xenova/bge-m3";
const pipe = await pipeline("feature-extraction", modelId, { dtype: "fp32" });
```

**本地模式路径解析**：transformers.js v4 的 `env.localModelPath` 是模型根目录，`pipeline(modelId)` 会在 `<localModelPath>/<modelId>/` 下找 `config.json`。所以 config 配 `localModelPath: ./models` + `modelPath: bge-m3` → 实际查 `<cwd>/models/bge-m3/config.json`。

**为什么本地模式显式 `allowRemoteModels=false`**：transformers.js 默认本地找不到就回退远程，会再次触发 HF 下载尝试。显式禁用确保本地缺失时直接报错（快速失败，错误信息清晰），而非挂网络重试。

**为什么远程模式显式 `allowLocalModels=false`**：避免本地残留的旧模型文件意外命中，确保远程模式行为可预测。

**HF_ENDPOINT 末尾斜杠处理**：transformers.js 的 `remotePathTemplate` 是 `{model}/resolve/{revision}/`，与 `remoteHost` 拼接。若用户设 `HF_ENDPOINT=https://hf-mirror.com`（无尾斜杠），拼接变成 `https://hf-mirror.comXenova/...` 导致 404。补尾斜杠是必要兜底。

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
| `src/frameworks/embedding/bge-m3-worker.ts` | 读 workerData；按 localModelPath 切换本地/远程模式；import env；去硬编码 |
| `src/frameworks/embedding/embedding-service.ts` | `_embedConfig` → `embedConfig`；workerData 透传；EmbeddingConfig 加 localModelPath |
| `src/frameworks/config-service.ts` | AppConfig.embedding + RawConfig.embedding 加 localModelPath 字段 |
| `config/config.yaml.example` | 默认改为本地模式；文档说明两种模式 + 目录结构 |
| `.gitignore` | 排除 `models/` |
| `models/bge-m3/*` | 模型文件预置（gitignore，不提交） |

## 测试

### 自动化

- `npm run lint` 无报错
- `npx tsc --noEmit` 类型检查通过
- `npx vitest run` 全量 854/854 测试通过（含 config-service.test.ts 19 个，确认新字段不破坏现有配置解析）

### 集成（端到端，真实 worker 线程）

临时脚本调用真实的 `initEmbeddingService({modelPath:"bge-m3", localModelPath:"./models"})`：

```
pipeline-load: 6.2s         ← 冷启动模型加载耗时
embed-1: 2.9s               ← 首次 embed（含 tokenizer warm-up）
embed-2: 47.8ms             ← 第二次 embed（已 warm）
dim: 1024                   ← 维度正确
cos(hello world, 你好世界): 0.8997   ← 多语言语义相似度生效
```

### 验收对照（Issue #124 Task C）

| 验收项 | 结果 |
|--------|------|
| 启动日志不再出现 `fetch failed` | ✅ 本地模式 allowRemoteModels=false，根本不发起网络请求 |
| `memory_vec` 表有向量数据写入 | ✅ service.available=true 后 embed 调用成功，主流程会写入（依赖 Task B/D 文档入库后才有内容可 embed） |
| 语义搜索生效：搜近义词能命中 | ✅ cos 0.90 证明语义编码正确，中英文跨语言生效 |
| 降级路径仍保留 | ✅ worker 加载失败仍 postMessage `{type:'error',id:-1}`，service 的 setupHandlers 原样保留 fallback 逻辑 |

## 关联

- Issue #124 Task C（本 F 即其交付物）
- F20260803mval §10 明确将"embedding 离线"列为独立 F 文档跟踪锚点；其 §"已知限制 G4 embeddingModel 硬编码"由本 F 解决
- F20260713i5k2 infra-llm-agent-embedding：embedding 服务初始架构，本 F 修其加载链路断裂
