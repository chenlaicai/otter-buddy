/**
 * A3 模型可见内容重建比对（R20260817dshp / issue #289 / PR-C 前置）。
 *
 * 捕获机制：本地录音网关——伪 anthropic 端点（boot 时 llm 配置整体指向它）。
 * SDK/pi-ai/AgentSession 全链路照常运行，真实发出的 HTTP 请求体就是**模型可见输入
 * 的 wire 级最终真相**（system + messages + tools，含全部内存变换后的形态），
 * 比从 Context 或 session JSONL 重建都更保真。网关按脚本回放 SSE 响应驱动对话。
 *
 * 用法（见 model-visible-parity.capability.test.ts）：
 *   const gateway = await RecordingGateway.start();
 *   gateway.queue([speakScript("第一轮答复"), speakScript("第二轮答复")]);
 *   ctx = await bootCapabilityApp({ recordingGatewayUrl: gateway.url });
 *   ... 驱动对话 ...
 *   const canonical = canonicalizeRequests(gateway.requests, { tmpDir: ctx.tmpDir });
 *   // 快照工作流：旧分支 capture（A3_SNAPSHOT_CAPTURE=path）→ 新分支 compare（A3_SNAPSHOT_FILE=path）
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

/** 脚本化回复：文本块 + 工具调用块（驱动回合按 speak 协议收尾） */
export interface ScriptedReply {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
}

/** speak 工具调用回复（让回合正常收尾） */
export function speakScript(body: string): ScriptedReply {
  return { toolCalls: [{ name: "speak", input: { body, talkingStonePassedTo: ["user"] } }] };
}

/** 录音网关：记录 anthropic wire 请求体，回放脚本化 SSE 响应 */
export class RecordingGateway {
  /** 每次 LLM 调用的 wire 请求体（parsed JSON） */
  readonly requests: unknown[] = [];
  private replies: ScriptedReply[] = [];
  private server!: http.Server;

  private constructor() {}

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("录音网关地址获取失败");
    return `http://127.0.0.1:${address.port}`;
  }

  static async start(): Promise<RecordingGateway> {
    const gateway = new RecordingGateway();
    gateway.server = http.createServer((req, res) => gateway.handle(req, res));
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    return gateway;
  }

  async stop(): Promise<void> {
    /** close() 只停监听，keep-alive 持久连接会拖住回调——必须显式全断 */
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  queue(replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {
      res.statusCode = 500;
      res.end();
    });
    req.on("end", () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        this.requests.push(body);
        const reply = this.replies.shift();
        if (!reply) {
          /** 4xx 不触发 SDK 重试（5xx 会引起指数退避重试链，每次重试都会污染录音） */
          res.statusCode = 400;
          res.end(JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "录音网关：脚本化回复已耗尽（场景比预期的 LLM 调用多——可能是重试链或多打了一次网关）" },
          }));
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(anthropicMessageSse(reply, (body as { model?: string })?.model));
        res.end();
      } catch {
        res.statusCode = 500;
        res.end();
      }
    });
  }
}

/** 构造一条完整 anthropic-messages SSE 流（pi-ai 解析器逐事件消费） */
function anthropicMessageSse(reply: ScriptedReply, model?: string): string {
  const events: string[] = [];
  const emit = (type: string, data: Record<string, unknown>): void => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  emit("message_start", {
    message: {
      id: "msg_a3_replay",
      type: "message",
      role: "assistant",
      model: model ?? "recorder-1",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  let index = 0;
  if (reply.text) {
    emit("content_block_start", { index, content_block: { type: "text", text: "" } });
    emit("content_block_delta", { index, delta: { type: "text_delta", text: reply.text } });
    emit("content_block_stop", { index });
    index++;
  }
  for (const call of reply.toolCalls ?? []) {
    emit("content_block_start", {
      index,
      content_block: { type: "tool_use", id: `toolu_a3_${index}`, name: call.name, input: {} },
    });
    emit("content_block_delta", {
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    });
    emit("content_block_stop", { index });
    index++;
  }

  emit("message_delta", {
    delta: { stop_reason: (reply.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn" },
    usage: { output_tokens: 1 },
  });
  emit("message_stop", {});
  return events.join("");
}

// ─── 规范化 ────────────────────────────────────────────────────────────────

const DROP_KEYS = new Set(["metadata"]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

/**
 * 规范化：tmpDir 路径、UUID、ISO 时间戳按**首次出现序**编号替换（<TMP> / <UUID:n> / <TS:n>，
 * 编号制保持 tool_use id ↔ tool_result 的配对关系，不同 UUID 也不会互相抵消）。
 * wire 请求体本身无时间戳，但消息内容（workspace 路径、对话 ID）会嵌入。
 */
export function canonicalizeRequests(
  requests: unknown[],
  opts: { tmpDir: string },
): unknown[] {
  const uuidMap = new Map<string, string>();
  const tsMap = new Map<string, string>();
  const normalizeString = (s: string): string => {
    let out = opts.tmpDir ? s.split(opts.tmpDir).join("<TMP>") : s;
    out = out.replace(UUID_RE, (m) => {
      let token = uuidMap.get(m);
      if (!token) {
        token = `<UUID:${uuidMap.size + 1}>`;
        uuidMap.set(m, token);
      }
      return token;
    });
    out = out.replace(ISO_TS_RE, (m) => {
      let token = tsMap.get(m);
      if (!token) {
        token = `<TS:${tsMap.size + 1}>`;
        tsMap.set(m, token);
      }
      return token;
    });
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        if (DROP_KEYS.has(key)) continue;
        out[key] = walk((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return requests.map((r) => walk(JSON.parse(JSON.stringify(r))));
}

/** 稳定序列化（key 排序已在 canonicalize 完成） */
export function stableStringify(canonical: unknown[]): string {
  return JSON.stringify(canonical, null, 2);
}

// ─── 比对 ──────────────────────────────────────────────────────────────────

/** 深比较两棵 canonical 树，返回差异路径清单（最多 maxDiffs 条，含期望/实际值摘要） */
export function diffCanonical(
  expected: unknown[],
  actual: unknown[],
  maxDiffs = 20,
): string[] {
  const diffs: string[] = [];
  const full = () => diffs.length >= maxDiffs;
  const brief = (v: unknown): string => JSON.stringify(v)?.slice(0, 120) ?? String(v);

  type CompareFn = (exp: unknown, act: unknown, path: string) => void;
  const compareValues = (exp: unknown, act: unknown, path: string): void => {
    if (exp === act) return;
    diffs.push(`${path}: 期望 ${brief(exp)} 实际 ${brief(act)}`);
  };
  const compareArrays = (exp: unknown[], act: unknown[], path: string, compare: CompareFn): void => {
    if (exp.length !== act.length) diffs.push(`${path}: 数组长度 期望 ${exp.length} 实际 ${act.length}`);
    const n = Math.max(exp.length, act.length);
    for (let i = 0; i < n && !full(); i++) compare(exp[i], act[i], `${path}[${i}]`);
  };
  const compareObjects = (
    exp: Record<string, unknown>,
    act: Record<string, unknown>,
    path: string,
    compare: CompareFn,
  ): void => {
    for (const key of Object.keys(exp)) {
      if (!(key in act)) diffs.push(`${path}.${key}: 期望存在，实际缺失`);
    }
    for (const key of Object.keys(act)) {
      if (!(key in exp)) diffs.push(`${path}.${key}: 实际多出`);
    }
    for (const key of Object.keys(exp)) {
      if (full()) return;
      if (key in act) compare(exp[key], act[key], `${path}.${key}`);
    }
  };
  const compare: CompareFn = (exp, act, path) => {
    if (full() || exp === act) return;
    const bothObjects =
      exp !== null && act !== null && typeof exp === "object" && typeof act === "object";
    if (!bothObjects) {
      compareValues(exp, act, path);
      return;
    }
    if (Array.isArray(exp) && Array.isArray(act)) {
      compareArrays(exp, act, path, compare);
    } else if (Array.isArray(exp) !== Array.isArray(act)) {
      diffs.push(`${path}: 数组/非数组不匹配`);
    } else {
      compareObjects(exp as Record<string, unknown>, act as Record<string, unknown>, path, compare);
    }
  };

  compare(expected, actual, "$");
  return diffs;
}

// ─── 快照 IO ───────────────────────────────────────────────────────────────

export interface SnapshotFile {
  /** 快照格式版本（结构变更时递增，compare 报错提示重新 capture） */
  formatVersion: 1;
  createdAt: string;
  /** 场景标识（防止拿错场景的快照来比） */
  scenario: string;
  requestCount: number;
  canonical: unknown[];
}

export function buildSnapshot(scenario: string, canonical: unknown[]): SnapshotFile {
  return {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    scenario,
    requestCount: canonical.length,
    canonical,
  };
}

export function writeSnapshot(file: string, snapshot: SnapshotFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stableStringify([snapshot]) + "\n");
}

export function readSnapshot(file: string): SnapshotFile {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotFile[];
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`快照文件格式错误（期望单元素数组）: ${file}`);
  }
  const snap = parsed[0];
  if (snap.formatVersion !== 1) {
    throw new Error(`快照格式版本 ${snap.formatVersion} 不受支持，请在基线分支重新 capture`);
  }
  return snap;
}
