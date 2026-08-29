import type { Logger } from "@usecases/ports/logger";
import type { WeixinAccountStore } from "./account-store";
import type { WeixinApiClient } from "./api-client";
import { WeixinMessageType, WeixinItemType, type WeixinMessage } from "./types";

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
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
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

  constructor(
    private readonly deps: {
      api: WeixinApiClient;
      accountStore: WeixinAccountStore;
      accountId: string;
      /** 消息回调（ingress 处理链）；抛错只记日志不中断轮询 */
      onMessage: (msg: WeixinInboundMessage) => Promise<void>;
      logger: Logger;
    },
  ) {}

  /** 启动轮询循环（幂等：已在跑则直接返回） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    const { api, accountStore, accountId, logger } = this.deps;
    this.buf = accountStore.loadSyncBuf(accountId);
    let timeoutMs = WeixinPollingChannel.LONG_POLL_TIMEOUT_MS;
    const backoff = new BackoffState();

    logger.info("Weixin polling channel started", { accountId });

    while (this.running && !this.abort?.signal.aborted) {
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
        const waitMs = backoff.recordFailure();
        logger.warn("Weixin getupdates fetch error", {
          accountId,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(waitMs);
      }
    }
    logger.info("Weixin polling channel stopped", { accountId });
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
    const { accountStore, accountId, logger } = this.deps;
    const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
    if (isApiError) {
      if (resp.errcode === -14 || resp.ret === -14) {
        logger.error(`Weixin token stale (errcode -14), pausing 1h — 需重新扫码登录`, undefined, { accountId });
        return WeixinPollingChannel.STALE_PAUSE_MS;
      }
      const waitMs = backoff.recordFailure();
      logger.warn("Weixin getupdates api error", { accountId, ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg });
      return waitMs;
    }

    backoff.reset();
    if (resp.get_updates_buf) {
      this.buf = resp.get_updates_buf;
      accountStore.saveSyncBuf(accountId, resp.get_updates_buf);
    }
    for (const msg of resp.msgs ?? []) {
      await this.dispatchInbound(msg);
    }
    return -1;
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

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
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
