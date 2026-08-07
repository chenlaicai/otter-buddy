/**
 * 能力测试启动器：真实装配整个系统（buildApp），真 sqlite（临时文件）、
 * 真 embedding（bge-m3，禁止 mock）、真 LLM（local overlay / 环境变量提供端点）。
 *
 * 隔离策略：每个测试文件一个临时目录（DB/sessions/logs），forks 池保证进程级隔离；
 * syncAuth=false（不碰 ~/.pi/agent/auth.json）；rootDir 默认空目录（真仓库 docs 同步会
 * 挤爆 embedding 队列）；cwd 沙箱（软链 .pi/prompts/models）防 agent 工具写真仓。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { buildApp, type BuiltApp } from "../../../src/app";
import { loadConfig } from "../../../src/frameworks/config";
import type { AppConfig } from "../../../src/frameworks/config";
import { initFauxModels } from "../../../src/frameworks/llm/models-factory";
import { ModelPool } from "../../../src/frameworks/llm/model-pool";
import { createTestLogger } from "../../helpers/logger";

export interface CapabilityContext {
  built: BuiltApp;
  tmpDir: string;
  /** LLM 端点是否已配置（有 apiKey 且非占位）。false 时 LLM 用例应 it.skipIf 并打印原因 */
  llmAvailable: boolean;
  skipReason?: string;
  /** dispose + 清理临时目录（afterAll 调用） */
  cleanup(): void;
}

export interface BootOptions {
  /**
   * 文档同步根目录。默认空目录（tmp 下新建）：真仓库 docs 同步会 fire-and-forget
   * ~500+ chunk embedding 挤爆 worker 串行队列，测试的 embed 排队超时。
   * 确实需要真实文档库的用例可显式传仓库根（并接受长启动与队列排空时间）。
   * 注意：.pi/skills 由 pi SDK 按 process.cwd() 发现，与本项无关，始终为真。
   */
  rootDir?: string;
  /** embedding 就绪等待上限，默认 240s（bge-m3 冷加载较慢） */
  embeddingTimeoutMs?: number;
}

function repoRoot(): string {
  return process.cwd();
}

/** 合并配置：config.test.yaml（基底）← config.test.local.yaml（整段替换顶层键）← 环境变量（llm 首模型） */
function resolveTestConfig(tmpDir: string): AppConfig {
  const root = repoRoot();
  const baseRaw = yaml.load(
    fs.readFileSync(path.join(root, "config/config.test.yaml"), "utf8"),
  ) as Record<string, unknown>;

  const localPath = path.join(root, "config/config.test.local.yaml");
  if (fs.existsSync(localPath)) {
    const localRaw = yaml.load(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(localRaw)) {
      baseRaw[key] = value;
    }
  }

  // 环境变量覆盖 llm.models[0]
  const envModel = process.env.OTTER_TEST_LLM_MODEL;
  const envKey = process.env.OTTER_TEST_LLM_API_KEY;
  if (envModel || envKey) {
    const llm = baseRaw.llm as { models: Array<Record<string, unknown>> };
    const first = llm.models[0];
    if (process.env.OTTER_TEST_LLM_PROVIDER) first.provider = process.env.OTTER_TEST_LLM_PROVIDER;
    if (envModel) first.model = envModel;
    if (envKey) first.apiKey = envKey;
    if (process.env.OTTER_TEST_LLM_BASE_URL) first.apiBaseUrl = process.env.OTTER_TEST_LLM_BASE_URL;
  }

  // __TMPDIR__ 替换后落临时 yaml，复用 loadConfig 的校验与默认值填充
  const substituted = JSON.parse(
    JSON.stringify(baseRaw).replaceAll("__TMPDIR__", tmpDir),
  ) as Record<string, unknown>;
  const mergedPath = path.join(tmpDir, "config.merged.yaml");
  /** 含 apiKey：0o600 权限 + 进程退出兜底清理（中断残留防泄漏） */
  fs.writeFileSync(mergedPath, yaml.dump(substituted), { mode: 0o600 });
  process.once("exit", () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 兜底清理失败无害 */ }
  });

  const config = loadConfig(createTestLogger(), mergedPath);

  // embedding worker 路径：vitest 跑 src 树，worker 只在 dist 编译产物里
  const workerPath = path.join(root, "dist/src/frameworks/embedding/bge-m3-worker.js");
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `能力测试需要 dist 编译产物（embedding worker）。请先执行 npm run build（或直接跑 npm run test:capability）。缺失: ${workerPath}`,
    );
  }
  config.embedding.workerPath = workerPath;
  /** vitest fork 的 execArgv（--conditions development 等）会被 worker 线程继承，
   *  导致 worker 内 @huggingface/transformers 解析到非生产构建、推理挂起。必须清空。 */
  config.embedding.workerExecArgv = [];

  return config;
}

function detectLlm(config: AppConfig): { available: boolean; reason?: string } {
  const first = config.llm.models[0];
  const apiKey = first?.apiKey;
  const model = first?.model;
  if (!apiKey || model === "__placeholder__") {
    return {
      available: false,
      reason:
        "未配置 LLM 端点：请创建 config/config.test.local.yaml（参考 config/config.test.yaml 注释）" +
        "或设置 OTTER_TEST_LLM_API_KEY / OTTER_TEST_LLM_MODEL 环境变量",
    };
  }
  return { available: true };
}

async function waitEmbeddingReady(built: BuiltApp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (built.embeddingService.available) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "embedding 在能力测试层禁止静默降级：bge-m3 未就绪。" +
    "请确认 ./models/bge-m3 模型文件完整（scripts/download-bge-m3.mjs 或本地预置）。",
  );
}

/** 无 LLM 时的 faux 模型池：每个别名独立实例，保证 ModelPool 解析语义可测 */
async function buildFauxModels(config: AppConfig): Promise<{ model: unknown; modelPool: ModelPool }> {
  const alias = config.llm.default;
  const configs = config.llm.models;
  const entries = new Map<string, { config: (typeof configs)[number]; model: unknown }>();
  let firstModel: unknown;
  for (const mc of configs) {
    const { model } = await initFauxModels([]);
    if (firstModel === undefined) firstModel = model;
    entries.set(mc.alias, { config: mc, model });
  }
  return { model: firstModel, modelPool: new ModelPool(alias, entries) };
}

export async function bootCapabilityApp(options: BootOptions = {}): Promise<CapabilityContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-capability-"));
  const config = resolveTestConfig(tmpDir);
  const llm = detectLlm(config);

  const emptyDocsDir = path.join(tmpDir, "empty-docs");
  fs.mkdirSync(emptyDocsDir, { recursive: true });
  const rootDir = options.rootDir ?? emptyDocsDir;

  /** LLM 未配置时注入 faux models：initModels 对占位模型无密钥会直接抛错，
   *  而 embedding/检索类用例不依赖 LLM，必须照常真跑。
   *  每个别名独立 faux 实例（ModelPool 解析"非回退"断言依赖对象区分） */
  const models = llm.available ? undefined : await buildFauxModels(config);

  /** agent 工具（read/bash/write）的 cwd 沙箱：fork 的 process.cwd() 默认是真仓库根，
   *  獭的编码工具可在真仓写文件（实测：曾自发建 worktree 完整实现功能）。
   *  小资产（.pi/prompts/种子数据）复制进沙箱——软链会被 write 穿透到真仓（第二轮检视发现）。
   *  models 是 4.2G 大模型无法复制，仍用软链：写穿透风险存在但獭没有对模型文件的合法写场景。 */
  const sandbox = path.join(tmpDir, "sandbox");
  fs.mkdirSync(path.join(sandbox, "data"), { recursive: true });
  const root = repoRoot();
  fs.cpSync(path.join(root, ".pi"), path.join(sandbox, ".pi"), { recursive: true });
  fs.cpSync(path.join(root, "prompts"), path.join(sandbox, "prompts"), { recursive: true });
  fs.cpSync(path.join(root, "data/terminology"), path.join(sandbox, "data/terminology"), { recursive: true });
  fs.symlinkSync(path.join(root, "models"), path.join(sandbox, "models"));
  const prevCwd = process.cwd();
  /** 必须在 buildApp 前 chdir：pi ResourceLoader、identity 目录、ensure-model 均按 cwd 解析 */
  process.chdir(sandbox);

  let built: BuiltApp | undefined;
  try {
    built = await buildApp({
      config,
      logger: createTestLogger(),
      dataDir: path.join(tmpDir, "data"),
      sessionDir: path.join(tmpDir, "sessions"),
      rootDir,
      models,
      staticRoot: false,
      syncAuth: false,
      enableFeishu: false,
      startScheduler: false,
    });
    await waitEmbeddingReady(built, options.embeddingTimeoutMs ?? 240_000);
  } catch (err) {
    /** 失败路径同样恢复 cwd + dispose：否则同 fork 后续文件以诡异 ENOENT 失败（chdir 泄漏） */
    built?.dispose();
    process.chdir(prevCwd);
    throw err;
  }

  if (!llm.available) {
    // 供 skip-reporter 打印显式原因（forks 池下经环境变量传递到主进程不可行，reporter 直接探测配置）
    process.env.OTTER_CAPABILITY_SKIP_REASON = llm.reason;
  }

  const ready = built;
  return {
    built: ready,
    tmpDir,
    llmAvailable: llm.available,
    skipReason: llm.reason,
    cleanup: () => {
      ready.dispose();
      process.chdir(prevCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
