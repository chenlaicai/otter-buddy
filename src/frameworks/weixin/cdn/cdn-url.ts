/**
 * CDN 上传/下载 URL 拼接（协议审计来源：openclaw-weixin src/cdn/cdn-url.ts，MIT）。
 * upload_full_url / full_url 服务端直出时优先；缺失时按此拼接。
 */
import { WEIXIN_CDN_BASE_URL } from "../types";

/** 下载 URL：encrypt_query_param 拼 CDN base */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl = WEIXIN_CDN_BASE_URL): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 上传 URL：upload_param + filekey 拼 CDN base */
export function buildCdnUploadUrl(params: { uploadParam: string; filekey: string; cdnBaseUrl?: string }): string {
  const base = params.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL;
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
