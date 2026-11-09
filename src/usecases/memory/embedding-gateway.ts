/** Embedding 模型元信息（版本锚用，F20260811mrpy Part 3） */
export interface EmbedModelMeta {
  /** 模型标识，如 "Xenova/bge-m3" */
  modelId: string;
  /** 模型 revision。当前实现恒为 "unknown"（worker 未上报真实 revision，F20260821evaf）。
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
 * 埋单链防护：claim 即 attempts+1，超时循环会把 attempts 撑到 ≥3；
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
 * F20261109epqst：槽位等待超时错误——waitSlot 排队超过 waitTimeoutMs 上界。
 * 继承 EmbedTransientError（retry worker 对其不计 attempts，任务留 pending 重来）——
 * 「前面排满了」是系统忙不是任务坏，与 worker 重建/背压同待遇。
 * 修复背景：2026-11-09 生产实锤——doc 洪峰把 ~2000 条 bulk waiter 堆进
 * slotWaiters，retry worker 首条 embed 挂在队尾无限等待，tick 永久挂起、
 * 旧任务 0 出队。所有后台等待必须有界（根治验收不变量 ①活性）。
 */
export class EmbedSlotTimeoutError extends EmbedTransientError {
  constructor(message: string) {
    super(message);
    this.name = "EmbedSlotTimeoutError";
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
  /**
   * F20261105embqg S2a：槽位排队优先级（0=live 消息 1=默认 2=bulk 重算，数值小先属）。
   * 仅 waitSlot 挂起时生效：积压泄洪期间 live 消息可插队，入库延迟从
   * retry tick 周期降到单批时长。默认 1。
   */
  priority?: number;
  /**
   * F20261109epqst：waitSlot 排队等待上界（ms）。超时 reject EmbedSlotTimeoutError
   * 并从等待队列摘除。不传则用 service 层默认（60s）——所有等待必须有界，
   * 不允许无限挂起（生产实锤：无限等待的 waiter 把 retry tick 永久挂死）。
   * 仅 waitSlot=true 时生效；不排队（槽空闲直接入）时无作用。
   */
  waitTimeoutMs?: number;
  /** 调用方超时放弃后，worker 晚到结果的持久化回调。service 包裹吞错（异步 fire-and-forget） */
  salvage?: (embedding: Float32Array) => void;
}

/** F20261020slvg：embedBatch 调用选项（语义同 EmbedCallOptions）。
 *  F20261026emct：salvage 收「整批对齐」语义修正为携带 startIndex——
 *  分片闸门把巨批拆成子批后，子批晚到结果只携带该子批向量，startIndex 告知
 *  这批向量对应整批的第几条起（非分批路径不传 = 0）。调用方必须按 startIndex
 *  对位写入（见 store-memory fireAndForgetEmbedBatch），否则分片场景错位污染。 */
export interface EmbedBatchCallOptions {
  waitSlot?: boolean;
  /** F20261105embqg S2a：同 EmbedCallOptions.priority（槽位排队优先级） */
  priority?: number;
  /** F20261109epqst：同 EmbedCallOptions.waitTimeoutMs（waitSlot 等待上界） */
  waitTimeoutMs?: number;
  salvage?: (embeddings: Float32Array[], startIndex?: number) => void;
}

/** F20261109epqst：service 层可观测快照——RAM 侧在飞/等待深度。
 * 后台任务统一落库后，RAM 只剩实时短通道；本快照让「RAM 是否真的只剩有限在飞」
 * 可被周期观测（验收不变量 ③有界性），不再只靠日志撞见。 */
export interface EmbeddingServiceStats {
  /** 在飞请求数（单条 + 批量 map 总和） */
  readonly inFlight: number;
  /** 挂起在槽位等待队列的 waiter 数 */
  readonly pendingWaiters: number;
}

/** Embedding 网关接口（由 frameworks/embedding/ 实现） */
export interface EmbeddingGateway {
  /** 模型是否已就绪可用来生成 embedding */
  readonly available: boolean;
  embed(text: string, opts?: EmbedCallOptions): Promise<Float32Array>;
  /**
   * F20261109epqst：RAM 侧在飞/等待深度快照（可观测性）。
   * 可选——mock 实现可不提供，消费方 typeof 守卫。
   * F20261109epqst 同时退役 acquireSlot：waitSlot 已内嵌 embed/embedBatch，
   * 独立槽位获取接口无调用方（遗留死接口，双账本时代的残留）。
   */
  readonly stats?: EmbeddingServiceStats;
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
