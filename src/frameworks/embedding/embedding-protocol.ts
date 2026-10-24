/**
 * F20261020slvg：embedding IPC 协议与请求簿记类型（从 embedding-service.ts 拆出，压文件行数）。
 * 主进程（EmbeddingServiceImpl）与 bge-m3 worker 子进程共享的消息形状 + pending 簿记结构。
 */

import type { EmbedModelMeta } from "@usecases/memory/embedding-gateway";

interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

/** F20261013ebps：批量 embed 请求——一次 send 传多条文本，
 *  worker 端 pipeline 原生支持数组输入（batch 推理共享权重加载/分词开销），
 *  吞吐从 1条/500ms 提升到 N条/~N×500ms（接近线性），同时减少 IPC 往返次数。 */
interface EmbedBatchRequest {
  type: "embed-batch";
  texts: string[];
  id: number;
}

/**
 * F20260811mrpy Part 3：ready 消息携带 meta（modelId/modelRev/dim）。
 * worker 加载完模型 + dummy embed 拿到 dims 后发送。
 */
export type EmbedResponse =
  | { type: "ready"; meta: EmbedModelMeta }
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "batch-result"; embeddings: Float32Array[]; id: number }
  | { type: "error"; error: string; id: number };

type PendingRequest = {
  resolve: (value: Float32Array) => void;
  reject: (error: Error) => void;
  /**
   * F20261020slvg：调用方已超时放弃。条目保留（槽位不释放）直到 worker 响应——
   * 响应到达时走 salvage（若有）而非丢弃。根治「白算的向量无人消费」。
   */
  abandoned?: boolean;
  /** F20261020slvg：晚到结果的持久化回调（超时前由调用方注入） */
  salvage?: (embedding: Float32Array) => void;
};

/** F20261013ebps：批量请求的 pending 结构 */
type PendingBatchRequest = {
  resolve: (value: Float32Array[]) => void;
  reject: (error: Error) => void;
  /** F20261020slvg：同 PendingRequest.abandoned */
  abandoned?: boolean;
  /** F20261020slvg：晚到整批结果的持久化回调 */
  salvage?: (embeddings: Float32Array[]) => void;
};

interface ReadyState {
  ready: boolean;
  loadError: Error | null;
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

export type {
  EmbedRequest,
  EmbedBatchRequest,
  PendingRequest,
  PendingBatchRequest,
  ReadyState,
};
