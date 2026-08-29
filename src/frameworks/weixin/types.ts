/**
 * 微信 ilink bot 协议类型（frameworks 层，仅本目录内使用）。
 *
 * 协议来源：@tencent-weixin/openclaw-weixin@2.4.6 源码审计（MIT）+
 * 该包 README「后端 API 协议」节公开文档（2026-08-28 审计，见工作区
 * openclaw-weixin-protocol-notes.md / issue #564）。
 * 网关 https://ilinkai.weixin.qq.com，接口前缀 ilink/bot/。
 */

/** 通道配置（config.yaml weixin 段） */
export interface WeixinConfig {
  /** ilink 网关 base URL（默认 https://ilinkai.weixin.qq.com，测试可指向 mock） */
  baseUrl?: string;
  /** 账号/游标持久化目录（默认 ./data/weixin） */
  stateDir?: string;
  /** 搭档（本实例主人）的微信 ilink_user_id——命令门禁锚定（F20260826fpbd 同语义） */
  partnerUserId?: string;
}

/** 请求通用自声明信息（归因观测用，不参与鉴权） */
export interface WeixinBaseInfo {
  channel_version: string;
  bot_agent: string;
}

export interface WeixinTextItem {
  text?: string;
}

export interface WeixinImageItem {
  /** CDN 上传后引用（PR③ 媒体支持使用，此处仅保结构） */
  cdn_ref?: Record<string, unknown>;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface WeixinVoiceItem {
  cdn_ref?: Record<string, unknown>;
  duration_ms?: number;
  /** 语音转文字内容（服务端 ASR 产物，入站可直接作文本用） */
  text?: string;
}

export interface WeixinFileItem {
  cdn_ref?: Record<string, unknown>;
  file_name?: string;
  file_size?: number;
}

export interface WeixinVideoItem {
  cdn_ref?: Record<string, unknown>;
  thumb_cdn_ref?: Record<string, unknown>;
  duration_ms?: number;
}

export interface WeixinRefMessage {
  title?: string;
  message_item?: WeixinMessageItem;
}

/** MessageItem.type 枚举（协议固定值） */
export const WeixinItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** 微信消息 item（文本/图片/语音/文件/视频/引用） */
export interface WeixinMessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: WeixinRefMessage;
  text_item?: WeixinTextItem;
  image_item?: WeixinImageItem;
  voice_item?: WeixinVoiceItem;
  file_item?: WeixinFileItem;
  video_item?: WeixinVideoItem;
}

/** 微信入站/出站消息统一结构（proto: WeixinMessage） */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
  run_id?: string;
}

/** message_state 固定值：出站 bot 消息用 FINISH（一次性完整投递） */
export const WeixinMessageState = {
  FINISH: 2,
} as const;

/** message_type 固定值：BOT=2（bot 身份发出的消息） */
export const WeixinMessageType = {
  BOT: 2,
} as const;

export interface WeixinGetUpdatesResp {
  ret?: number;
  /** 服务端错误码（-14 = token 过期/stale） */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 同步游标，下次请求回传；空串表示无 */
  get_updates_buf?: string;
  /** 服务端建议的下轮长轮询超时（ms） */
  longpolling_timeout_ms?: number;
}

export interface WeixinSendMessageResp {
  ret?: number;
  errmsg?: string;
}

export interface WeixinGetConfigResp {
  ret?: number;
  errmsg?: string;
  /** sendTyping 所需 ticket（base64） */
  typing_ticket?: string;
}

/** 扫码登录：二维码申请响应 */
export interface WeixinQrCodeResp {
  ret?: number;
  errmsg?: string;
  /** 二维码内容（拼进扫码链接） */
  qrcode?: string;
  /** 二维码扫码链接（终端渲染成二维码图） */
  qrcode_img_content?: string;
}

/** 扫码状态枚举 */
export type WeixinQrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

/** 扫码登录：状态轮询响应 */
export interface WeixinQrStatusResp {
  status?: WeixinQrStatus;
  /** confirmed 后下发的 bot token（长效凭证） */
  bot_token?: string;
  ilink_bot_id?: string;
  /** 扫码人的 user id（即搭档微信） */
  ilink_user_id?: string;
  /** IDC 重定向时的新轮询网关 */
  baseurl?: string;
  redirect_host?: string;
  /** 状态轮询游标（长轮询续接用） */
  get_qrcode_status_buf?: string;
}

/** 服务端 stale token 错误码（session-guard 暂停语义） */
export const WEIXIN_STALE_TOKEN_ERRCODE = -14;
