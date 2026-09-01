import type { Logger } from "@usecases/ports/logger";
import type { WeixinAccountStore } from "./account-store";
import type { WeixinApiClient } from "./api-client";
import { WeixinMessageType, WeixinItemType, type WeixinMessage } from "./types";
import type { ChannelStatusRegistry } from "@usecases/channel/channel-status";
/**
 * 微信长轮询 ingress（monitor 语义，照 openclaw-weixin monitor.ts 平移）。
 *
 * 循环：getupdates(游标) → 逐条归一化 → 回调处理 → 落游标。
 * 失败语义（平移自协议插件）：
 * - errcode/ret = -14（stale token）：暂停轮询 1 小时（服务端语义：token 过期
 *   需重新扫码，继续轮询只会持续报错）
 * - 其余错误：连错 3 次 backoff 30s，否则 2s 重试
 * - 客户端长轮询超时（35s 无消息）视为正常空转，续拉
 */
export interface WeixinInboundMessage {
  /** 发送者 ilink user id（对端人类用户） */
  fromUserId: string;
  /** 归一化文本（text item / 语音转写 text / 引用拼接；媒体消息为空串，PR③ 扩展） */
  body: string;
  /** 出站回信所需的会话上下文令牌 */
  contextToken?: string;
  /** 协议消息 id（入站去重用） */
  messageId?: string;
  /** 原始 item 列表（PR③ 媒体支持扩展用） */
  raw: WeixinMessage;
}

/** 轮询循环内部状态（失败计数与退避） */
class BackoffState {
  failures = 0;
  static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly BACKOFF_MS = 30_000;
  private static readonly RETRY_MS = 2_000;

  /** 记一次失败，返回本次应等待的毫秒 */
  recordFailure(): number {
    this.failures += 1;
    if (this.failures >= BackoffState.MAX_CONSECUTIVE_FAILURES) {
      this.failures = 0;
      return BackoffState.BACKOFF_MS;
    }
    return BackoffState.RETRY_MS;
  }

  reset(): void {
    this.failures = 0;
  }
}

export class WeixinPollingChannel {
  private static readonly STALE_PAUSE_MS = 60 * 60_000;
  private static readonly LONG_POLL_TIMEOUT_MS = 35_000;

  private abort?: AbortController;
  private running = false;
  /** F20260901wxnt 发现3：recordContextTokenWarned 落盘失败时的内存级 warnedAt 补偿——
   *  disk 丢失后内存保底，下个 tick 冷却判断不旁路（防成功的预警每 35s 重发） */
  private warnedAtMemoryCache = new Map<string, number>();

  constructor(
    private readonly deps: {
      api: WeixinApiClient;
      accountStore: WeixinAccountStore;
      accountId: string;
      /** 消息回调（ingress 处理链）；抛错只记日志不中断轮询 */
      onMessage: (msg: WeixinInboundMessage) => Promise<void>;
      logger: Logger;
      /** 通道状态注册表（可选注入，用于上报运行时状态） */
      registry?: ChannelStatusRegistry;
      /** context_token 过期预警配置（可选注入，缺省不启用检查） */
      contextTokenWarn?: { afterMs: number; cooldownMs: number };
      /** 时间注入（默认 Date.now，供测试控制时钟） */
      now?: () => number;
    },
  ) {}

  /** 本轮询通道对应的账号 id（issue #566：账号删除时定位停轮询用） */
  get accountId(): string {
    return this.deps.accountId;
  }

  /** 本通道归属的扫码人 ilink user id（F20260831wxsp：重新扫码后按人回收旧轮询用）。
   *  账号 id 每次扫码都新生成（weixin-<时间戳>），同一个人重新扫码后旧账号轮询
   *  无法靠 accountId 定位——用 ilinkUserId 识别「同一个人的旧轮询」。 */
  get ilinkUserId(): string | undefined {
    return this.identity?.ilinkUserId;
  }

  /** start 后由装配层调用一次（polling-channel 不依赖 account-store 全量 API） */
  setIdentity(ilinkUserId?: string): void {
    this.identity = { ilinkUserId };
  }

  private identity?: { ilinkUserId?: string };

  /** 启动轮询循环（幂等：已在跑则直接返回） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.reportStatus("starting");
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.reportStatus("stopped", { reason: "manual" });
  }

  private async loop(): Promise<void> {
    const { api, accountStore, accountId, logger } = this.deps;
    this.buf = accountStore.loadSyncBuf(accountId);
    let timeoutMs = WeixinPollingChannel.LONG_POLL_TIMEOUT_MS;
    const backoff = new BackoffState();

    logger.info("Weixin polling channel started", { accountId });

    while (this.running && !this.abort?.signal.aborted) {
      // Why: 每 tick 轮询开头做一次 context_token 过期检查（整体 try/catch 不干扰主路径）
      await this.checkContextTokenExpiry();
      try {
        const resp = await api.getUpdates(this.buf, timeoutMs);
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          timeoutMs = resp.longpolling_timeout_ms;
        }
        const waitMs = await this.handlePollResponse(resp, backoff);
        if (waitMs < 0) continue; // 正常路径已分发，无异常直接续拉
        await this.sleep(waitMs);
        continue;
      } catch (err) {
        // 客户端长轮询超时 = 空转，正常续拉
        if (err instanceof Error && err.name === "TimeoutError") continue;
        if (!this.running) return;
        const waitMs = this.handleFetchError(err, backoff);
        await this.sleep(waitMs);
      }
    }
    logger.info("Weixin polling channel stopped", { accountId });
  }

  private handleFetchError(err: unknown, backoff: BackoffState): number {
    const { accountId, logger } = this.deps;
    const waitMs = backoff.recordFailure();
    logger.warn("Weixin getupdates fetch error", {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    // 连错 3 次进 backoff 时上报 error_backoff 状态
    if (backoff.failures >= BackoffState.MAX_CONSECUTIVE_FAILURES) {
      this.reportStatus("error_backoff", { errorMsg: err instanceof Error ? err.message : String(err) });
    }
    return waitMs;
  }

  /**
   * 处理一次成功返回的响应。返回负值表示本轮无需 sleep；正值表示需要等待的毫秒。
   * 副作用：落游标、分发消息。
   */
  private buf = "";

  private async handlePollResponse(
    resp: { ret?: number; errcode?: number; errmsg?: string; get_updates_buf?: string; msgs?: WeixinMessage[] },
    backoff: BackoffState,
  ): Promise<number> {
    const { accountStore, accountId } = this.deps;
    const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
    if (isApiError) {
      return this.handleApiError(resp, backoff);
    }

    backoff.reset();
    // 首次成功 getupdates 转 running 状态（或持续刷新 since）
    this.reportStatus("running");
    if (resp.get_updates_buf) {
      this.buf = resp.get_updates_buf;
      accountStore.saveSyncBuf(accountId, resp.get_updates_buf);
    }
    for (const msg of resp.msgs ?? []) {
      await this.dispatchInbound(msg);
    }
    return -1;
  }

  private handleApiError(
    resp: { ret?: number; errcode?: number; errmsg?: string },
    backoff: BackoffState,
  ): number {
    const { accountId, logger } = this.deps;
    if (resp.errcode === -14 || resp.ret === -14) {
      logger.error(`Weixin token stale (errcode -14), pausing 1h — 需重新扫码登录`, undefined, { accountId });
      this.reportStatus("token_stale", { errmsg: "session timeout" });
      return WeixinPollingChannel.STALE_PAUSE_MS;
    }
    const waitMs = backoff.recordFailure();
    logger.warn("Weixin getupdates api error", { accountId, ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg });
    // 连错 3 次进 backoff 时上报 error_backoff 状态
    if (backoff.failures >= BackoffState.MAX_CONSECUTIVE_FAILURES) {
      this.reportStatus("error_backoff", { errorMsg: resp.errmsg || `API error ${resp.errcode || resp.ret}` });
    }
    return waitMs;
  }

  /** 归一化 + 落 context_token + 回调；单条失败不中断 */
  private async dispatchInbound(msg: WeixinMessage): Promise<void> {
    const { accountStore, accountId, logger } = this.deps;
    const inbound = this.normalize(msg);
    if (!inbound) return;
    // 入站消息的 context_token 是出站回信的唯一凭证——先落盘再处理
    if (inbound.contextToken && inbound.fromUserId) {
      accountStore.saveContextToken(accountId, inbound.fromUserId, inbound.contextToken);
    }
    try {
      await this.deps.onMessage(inbound);
      // 收到消息时刷新 lastInboundAt（UI 显示「上次收消息」时间）
      this.reportStatus("running", { lastInboundAt: Date.now() });
    } catch (err) {
      logger.error("Weixin inbound message handler failed", err instanceof Error ? err : undefined, {
        accountId,
        fromUserId: inbound.fromUserId,
      });
    }
  }

  /** 协议消息 → 归一化入站消息。过滤 bot 自身消息与无 item 消息 */
  private normalize(msg: WeixinMessage): WeixinInboundMessage | null {
    // 过滤：bot 自己发的（message_type=2）不进 ingress，防回环
    if (msg.message_type === WeixinMessageType.BOT) return null;
    const from = msg.from_user_id ?? "";
    if (!from) return null;
    const items = msg.item_list ?? [];
    if (items.length === 0) return null;
    return {
      fromUserId: from,
      body: bodyFromItems(items),
      contextToken: msg.context_token,
      messageId: items.find((i) => i.msg_id)?.msg_id ?? (msg.message_id !== undefined ? String(msg.message_id) : undefined),
      raw: msg,
    };
  }

  /**
   * context_token 过期预警检查（F20260901wxnt）。
   * 逐用户独立 try/catch：一个用户失败不阻断其他用户。
   * 发送失败记 error 日志 + warnedAt 止损不重试（ret=-2 = token 已死，重试必败）。
   */
  private async checkContextTokenExpiry(): Promise<void> {
    const warn = this.deps.contextTokenWarn;
    if (!warn) return; // 未配置则不启用检查
    const { accountStore, accountId, logger } = this.deps;
    const nowMs = (this.deps.now ?? Date.now)();
    try {
      const entries = accountStore.loadRawContextTokens(accountId);
      for (const [userId, entry] of Object.entries(entries)) {
        // Why: 每个用户独立 try/catch——recordContextTokenWarned 磁盘写失败不应阻断剩余用户检查
        try {
          await this.warnUserIfStale(userId, entry, warn, nowMs);
        } catch (err) {
          // 单用户处理失败（含 recordContextTokenWarned 磁盘异常）不阻断剩余用户
          logger.warn("context_token 预警用户处理异常", {
            accountId,
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // 整体 try/catch：不干扰轮询主路径
      logger.warn("context_token 过期检查异常", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 单用户预警判断 + 发送（被 checkContextTokenExpiry 调用，失败向上抛由调用方 catch） */
  private async warnUserIfStale(
    userId: string,
    entry: { token: string; receivedAt: number; warnedAt?: number },
    warn: { afterMs: number; cooldownMs: number },
    nowMs: number,
  ): Promise<void> {
    const { accountStore, accountId, api, logger } = this.deps;
    const age = nowMs - entry.receivedAt;
    if (age < warn.afterMs) return; // 未满阈值
    // 冷却期内（内存优先——disk 可能丢失）
    const warnedAt = this.warnedAtMemoryCache.get(userId) ?? entry.warnedAt;
    if (warnedAt != null && nowMs - warnedAt < warn.cooldownMs) return;
    try {
      await api.sendTextMessage({
        toUserId: userId,
        contextToken: entry.token,
        text: "我们有一阵子没聊天啦～微信的会话凭证快到期了，之后你发的消息我可能会收不到。\n随便回我一条（哪怕一个表情）就能续上，需要时随时喊我 🦦",
      });
    } catch (err) {
      // Why: ret=-2 = token 已死，重试必败且每 35s 一次是 hammering——记日志即止
      logger.error("context_token 预警发送失败（token 已失效），用户下次发消息即恢复", err instanceof Error ? err : undefined, {
        accountId,
        userId,
        tokenAgeMs: age,
      });
    }
    // 成败都记——防死 token 每 35s 被重锤（memory 优先防进程内存丢失，disk best-effort）
    this.warnedAtMemoryCache.set(userId, nowMs);
    try {
      accountStore.recordContextTokenWarned(accountId, userId);
    } catch {
      logger.warn("context_token 预警记录落盘失败，内存补偿已生效", { accountId, userId });
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  /** 上报通道状态到 registry（防御性调用：registry 可选注入） */
  private reportStatus(
    kind: "starting" | "running" | "token_stale" | "error_backoff" | "stopped",
    extra?: { errmsg?: string; errorMsg?: string; reason?: "manual" | "no_config"; lastInboundAt?: number },
  ): void {
    const registry = this.deps.registry;
    if (!registry) return;
    const channelId = `weixin-${this.deps.accountId}`;
    const now = Date.now();
    
    // 状态映射表（简化 switch 逻辑）
    // lastInboundAt 保留策略：无新值时合并旧值，防长轮询空转覆盖最近入站时间（#F20260901chun 发现7）
    const existing = extra?.lastInboundAt === undefined
      ? registry.snapshot().find(e => e.channelId === channelId)
      : undefined;
    const preservedLastInboundAt = extra?.lastInboundAt ?? (existing?.state.kind === "running" ? existing.state.lastInboundAt : undefined);

    const stateMap: Record<string, () => void> = {
      starting: () => registry.update(channelId, { kind: "weixin", state: { kind: "starting", since: now } }),
      running: () => registry.update(channelId, { kind: "weixin", state: { kind: "running", since: now, lastInboundAt: preservedLastInboundAt } }),
      token_stale: () => registry.update(channelId, { kind: "weixin", state: { kind: "token_stale", since: now, errmsg: extra?.errmsg || "" } }),
      error_backoff: () => registry.update(channelId, { kind: "weixin", state: { kind: "error_backoff", since: now, errorMsg: extra?.errorMsg || "" } }),
      stopped: () => registry.update(channelId, { kind: "weixin", state: { kind: "stopped", since: now, reason: extra?.reason || "manual" } }),
    };
    
    stateMap[kind]?.();
  }
}

/** item 列表 → 文本（协议语义：text item 直取；语音取转写 text；引用拼前缀） */
export function bodyFromItems(items: { type?: number; text_item?: { text?: string }; voice_item?: { text?: string }; ref_msg?: { title?: string; message_item?: { text_item?: { text?: string } } } }[]): string {
  for (const item of items) {
    if (item.type === WeixinItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const refBody = ref.message_item?.text_item?.text;
      const parts = [ref.title, refBody].filter(Boolean);
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    if (item.type === WeixinItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}
