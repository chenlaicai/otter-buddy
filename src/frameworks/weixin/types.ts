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

/** CDN 媒体引用（协议 proto: CDNMedia；入站媒体消息携带，出站上传后回填） */
export interface WeixinCdnMedia {
  /** 下载加密参数（拼 CDN 下载 URL） */
  encrypt_query_param?: string;
  /** AES-128 key（base64；两种编码见 parseCdnAesKey） */
  aes_key?: string;
  /** 加密类型：0=只加密 fileid，1=打包缩略图/中图信息 */
  encrypt_type?: number;
  /** 完整下载 URL（服务端直出，优先于 encrypt_query_param 拼接） */
  full_url?: string;
}

export interface WeixinImageItem {
  /** 原图 CDN 引用（入站解密用；出站上传后回填） */
  media?: WeixinCdnMedia;
  /** 缩略图 CDN 引用 */
  thumb_media?: WeixinCdnMedia;
  /** 入站解密首选 key：hex 字符串（16 字节），优先于 media.aes_key */
  aeskey?: string;
  url?: string;
  /** 中图密文大小（出站上传后回填） */
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface WeixinVoiceItem {
  media?: WeixinCdnMedia;
  /** 语音编码类型：1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  /** 采样率 Hz */
  sample_rate?: number;
  /** 语音时长 ms */
  playtime?: number;
  /** 语音转文字内容（服务端 ASR 产物，入站可直接作文本用） */
  text?: string;
}

export interface WeixinFileItem {
  media?: WeixinCdnMedia;
  file_name?: string;
  md5?: string;
  /** 明文大小（字符串形式的数字） */
  len?: string;
  file_size?: number;
}

export interface WeixinVideoItem {
  media?: WeixinCdnMedia;
  thumb_media?: WeixinCdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
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

// ── 媒体支持（issue #567，协议平移自 openclaw-weixin cdn/）──

/** getuploadurl media_type 枚举（proto: UploadMediaType） */
export const WeixinUploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/** getuploadurl 请求体 */
export interface WeixinGetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  /** 原文件明文大小 */
  rawsize: number;
  /** 原文件明文 MD5（hex） */
  rawfilemd5: string;
  /** 密文大小（AES-128-ECB PKCS7 后） */
  filesize: number;
  /** 不需要缩略图上传 URL（单图上传用，默认 true） */
  no_need_thumb?: boolean;
  /** AES key（hex） */
  aeskey: string;
}

/** getuploadurl 响应 */
export interface WeixinGetUploadUrlResp {
  ret?: number;
  errmsg?: string;
  /** 原图上传加密参数（拼上传 URL） */
  upload_param?: string;
  /** 完整上传 URL（服务端直出，优先使用） */
  upload_full_url?: string;
}

/** CDN 上传产物：拼发送 item 的全部字段 */
export interface WeixinUploadedMedia {
  filekey: string;
  /** CDN 返回的下载加密参数（→ media.encrypt_query_param） */
  downloadParam: string;
  /** AES key hex（→ media.aes_key 需 base64（hex→raw→base64）） */
  aesKeyHex: string;
  /** 明文大小 */
  fileSize: number;
  /** 密文大小（→ mid_size / video_size / len 语义） */
  fileSizeCiphertext: number;
}

/** CDN base URL（上传/下载 URL 拼接用；与网关同域，协议审计值：openclaw-weixin auth/accounts.ts CDN_BASE_URL） */
export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
