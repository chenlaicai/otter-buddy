/** Embedding 模型元信息（版本锚用，F20260811mrpy Part 3） */
export interface EmbedModelMeta {
  /** 模型标识，如 "Xenova/bge-m3" */
  modelId: string;
  /** 模型 revision。当前实现恒为 "unknown"（worker 未上报真实 revision，F20260821evaf 审视记录）。
   *  后果：本地 models/ 目录整目录替换时 modelId/dim 可能都不变，锚检测不到；将来实现真实 rev
   *  （本地 mtime 或 HF revision）时需一次性重写存量基线，否则必然 mismatch。 */
  modelRev: string;
  /** 向量维度（从实际加载的模型输出形状数组最后一维读取，不硬编码） */
  dim: number;
}

/**
 * F20261016ebrt：embed 超时错误（慢 ≠ 死）。
 * retry worker 见此错误不计入 maxAttempts——超时是「这批太慢」，
 * 不是「这条坏了」，不该 3 次就 dead-letter 埋掉。
 */
export class EmbedTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedTimeoutError";
  }
}

/**
 * F20261020slvg：背压错误——lane 占用（in-flight 满且调用方未要求排队）。
 * retry worker 见此错误不计入 maxAttempts：这是「现在忙」，不是「这条坏了」，
 * 任务保持 pending 按退避下次再来。
 */
export class EmbedBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedBackpressureError";
  }
}

/**
 * F20261020slvg：瞬态错误——worker 重建/崩溃/熔断期间 rejectAllPending 用的类型。
 * 对抗审视洞 2（埋单链）：claim 即 attempts+1，超时循环会把 attempts 撑到 ≥3；
 * 若 worker 重启的 reject 走普通 Error → markTaskAttemptFailed → 成批 dead-letter。
 * 瞬态错误与超时/背压同待遇：不计 attempts，任务保持 pending 重来。
 */
export class EmbedTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedTransientError";
  }
}

/**
 * F20261020slvg：embed 调用选项。
 *
 * 核心不变量（根治 #1521 后写 lane 活锁）：**超时 ≠ 取消**。
 * - 超时只是「调用者不再等待」（reject 调用方 promise），请求条目保留到 worker 响应为止，
 *   期间槽位不释放——准入门控量测的是 worker 真实占用，不是调用方耐心。
 * - worker 晚到的结果不丢弃：若提供 salvage 回调则交给调用方持久化（如 storeEmbedding）。
 */
export interface EmbedCallOptions {
  /**
   * 槽满时挂起排队而非 reject（写路径软限流用）。
   * 默认 false：查询路径必须 fail-fast 走 FTS5 降级，不该排队。
   */
  waitSlot?: boolean;
  /** 调用方超时放弃后，worker 晚到结果的持久化回调。service 包裹吞错（异步 fire-and-forget） */
  salvage?: (embedding: Float32Array) => void;
}

/** F20261020slvg：embedBatch 调用选项（语义同 EmbedCallOptions）。
 *  F20261023emct delta 复审：salvage 收「整批对齐」语义修正为携带 startIndex——
 *  分片闸门把巨批拆成子批后，子批晚到结果只携带该子批向量，startIndex 告知
 *  这批向量对应整批的第几条起（非分批路径不传 = 0）。调用方必须按 startIndex
 *  对位写入（见 store-memory fireAndForgetEmbedBatch），否则分片场景错位污染。 */
export interface EmbedBatchCallOptions {
  waitSlot?: boolean;
  salvage?: (embeddings: Float32Array[], startIndex?: number) => void;
}

/** Embedding 网关接口（由 frameworks/embedding/ 实现） */
export interface EmbeddingGateway {
  /** 模型是否已就绪可用来生成 embedding */
  readonly available: boolean;
  embed(text: string, opts?: EmbedCallOptions): Promise<Float32Array>;
  /**
   * F20261013ebps：等待一个空闲 in-flight 槽位（满时挂起至空出），
   * 供 sync 批量路径做流速控制——替代背压 reject 硬溢出入 retry 队列。
   */
  acquireSlot?(): Promise<void>;
  /**
   * F20261013ebps：批量 embed——一次调用处理多条文本，
   * 实现方内部走 batch 推理（吞吐远高于逐条 embed）。
   * 可选——mock 实现可不提供，调用方用 typeof === "function" 守卫。
   */
  embedBatch?(texts: string[], opts?: EmbedBatchCallOptions): Promise<Float32Array[]>;
  /**
   * 返回当前 worker 加载的模型元信息（F20260811mrpy Part 3）。
   * 可选——避免破坏现有 mock 实现。bootstrap 校验时通过 typeof === "function" 守卫。
   * worker ready 后才可用，内部会 waitForReady。
   */
  getMeta?(): Promise<EmbedModelMeta>;
}
