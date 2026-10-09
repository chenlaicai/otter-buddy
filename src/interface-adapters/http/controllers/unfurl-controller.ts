import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";

/** F20261008csf1：链类 unfurl 预览卡数据端点——服务端代理抓取目标页 og 元数据。
 *
 * Why 服务端代理而非前端直连：①CORS——绝大多数外部站点不放行浏览器跨域读 HTML；
 * ②隐私/安全——目标站只见到服务端 IP，且可做 SSRF 防护（仅 http/https、禁内网段）。
 *
 * 降级原则（宪法「不点开就有信息增量」+ 任务要求失败降级）：任何一步失败（超时/非 2xx/
 * 解析不到 og）都返回 404 或 partial——前端拿到 404 即渲染普通链接样式，拿到 partial
 * 就渲染有什么显示什么（favicon+域名兜底总有）。
 */

/** 抓取预算：超时与体积上限。og 标签都在 <head>，512KB 足够覆盖巨型 head；
 *  到达上限即截断解析（stream 读法实现成本高，先整取+slice——上限内截断等价）。 */
const UNFURL_TIMEOUT_MS = 5000;
const UNFURL_MAX_BYTES = 512 * 1024;

/** SSRF 防护：仅放行 http/https，禁 localhost/内网段（点分十进制 + 非点分形式 + IPv6 本地面）。
 *  本系统是本地部署的搭档工具，内网段禁掉不损失真实用途（外部链接预览），但堵掉
 *  「用 unfurl 端点探内网」的滥用面。检视发现 5 收紧面：IPv4-mapped（::ffff:10.*
 *  点分与十六进制两形）、ULA（f[cd]xx:）、链路本地（fe[89ab]x:）、十六进制（0x7f000001）
 *  与十进制（2130706433）IPv4。治本（DNS 解析后按 IP 判）见特性文档 P2 项，本层纯收紧。
 *  拆四个小函数：段位判定/点分/非点分/IPv6 各自独立可测（eslint complexity 塑形） */

/** 整数 IPv4 是否内网段：127/8、10/8、0/8、172.16-31/12、192.168/16 */
function isPrivateIpv4Int(n: number): boolean {
  const b0 = (n >>> 24) & 0xff;
  const b1 = (n >>> 16) & 0xff;
  return b0 === 127 || b0 === 10 || b0 === 0
    || (b0 === 172 && b1 >= 16 && b1 <= 31)
    || (b0 === 192 && b1 === 168);
}

/** 点分十进制 IPv4（含 IPv4-mapped 尾段）是否内网段 */
function isBlockedDottedQuad(h: string): boolean {
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p))) return false;
  const n = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return isPrivateIpv4Int(n);
}

/** IPv4 非点分形式：全十六进制（0x7f000001 / 0x7f.0.0.1）与十进制整数（2130706433）。
 *  十六进制形判定：0x 开头且全串仅 [0-9a-f.]——域名必含 g-z 字母，天然不误拦 */
function isBlockedAltIpv4(h: string): boolean {
  if (/^0x[0-9a-f.]+$/.test(h)) {
    const segs = h.slice(2).split(".").map(s => parseInt(s, 16));
    if ((segs.length === 4 || segs.length === 1) && segs.every(n => !Number.isNaN(n))) {
      const n = segs.length === 4
        ? ((segs[0] << 24) | (segs[1] << 16) | (segs[2] << 8) | segs[3]) >>> 0
        : segs[0];
      return isPrivateIpv4Int(n);
    }
  }
  if (/^\d{8,10}$/.test(h)) {
    const n = parseInt(h, 10);
    if (n <= 0xffffffff) return isPrivateIpv4Int(n);
  }
  return false;
}

/** IPv6 面：IPv4-mapped（点分 + WHATWG 序列化把 ::ffff:127.0.0.1 归一成的十六进制形
 *  ::ffff:7f00:1）、ULA（fd00-fdff）、链路本地（fe80-febf） */
function isBlockedIpv6Form(h: string): boolean {
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedDottedQuad(dotted[1]);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
    return isPrivateIpv4Int(n);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // ULA
  return /^fe[89ab][0-9a-f]:/.test(h);           // 链路本地
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // 归一化 [::1] / [::ffff:10.0.0.1] 方括号形态
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "0.0.0.0" || h === "0x0.0.0.0") return true;
  return isBlockedDottedQuad(h) || isBlockedAltIpv4(h) || isBlockedIpv6Form(h);
}

export interface UnfurlResult {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  /** 归一化后的站点域名（favicon 兜底数据源） */
  host: string;
}

/** 从 <head> 片段提取 og 元数据。属性顺序两种形态都收：
 *  <meta property="og:title" content=".."> 与 <meta content=".." property="og:title">。
 *  正则而非 DOM 解析：服务端不引新依赖（cheerio/jsdom 均为重依赖），og 标签形态
 *  足够规整（meta 无嵌套），正则覆盖真实网页的绝大头——失败降级普通链接，不追求全量。 */
function pickMeta(html: string, key: string): string | null {
  // 匹配整个 meta 标签后从中取 content——避免 content 在 property 前/后两种顺序的分叉处理
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const propMatch = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!propMatch || propMatch[1].toLowerCase() !== key) continue;
    const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!contentMatch) continue;
    const val = decodeEntities(contentMatch[1].trim());
    return val.length > 0 ? val : null;
  }
  return null;
}

/** 最小 HTML 实体解码（&amp; &lt; &gt; &quot; &#39; &nbsp;）——og 内容里的高频实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** <title> 兜底：og:title 缺失时用文档标题（正则而非 DOM——同上不引依赖的理由） */
function pickTitleTag(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const val = decodeEntities(m[1].replace(/\s+/g, " ").trim());
  return val.length > 0 ? val : null;
}

export class UnfurlController {
  constructor(private readonly logger: Logger) {}

  /** GET /api/unfurl?url=<encoded> → UnfurlResult | 404（不可预览则前端降级普通链接） */
  async get(c: Context): Promise<Response> {
    try {
      const parsed = this.parseTarget(c.req.query("url"));
      if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);
      const target = parsed.url;

      const result = await this.fetchWithTimeout(target);
      if (!result.ok) return c.json({ error: "fetch failed" }, 404);

      const payload = this.extractPreview(result.body, target);
      if (!payload) return c.json({ error: "no preview" }, 404);
      // 60s 缓存——预览卡数据不可变性强（标题/截图不会秒变），且防同一会话多卡重复抓
      c.header("Cache-Control", "private, max-age=60");
      return c.json(payload);
    } catch (err) {
      // 超时/网络层失败走统一 404 降级（降级语义是「没预览」而非「服务出错」——
      // 前端只区分「有卡/无卡」）
      this.logger.warn(`[unfurl] failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: "unfurl failed" }, 404);
    }
  }

  /** 入参校验：URL 解析 + 协议白名单 + SSRF 内网段拦截。返回 {url} 或 {error,status} */
  private parseTarget(raw: string | undefined): { url: URL } | { error: string; status: 400 } {
    if (!raw) return { error: "missing url", status: 400 };
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return { error: "invalid url", status: 400 };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { error: "unsupported protocol", status: 400 };
    }
    if (isBlockedHost(target.hostname)) {
      return { error: "blocked host", status: 400 };
    }
    return { url: target };
  }

  /** 从 HTML 提取预览数据；og/title/description/image 全空时返回 null（前端降级普通链接） */
  private extractPreview(htmlFull: string, target: URL): UnfurlResult | null {
    const html = htmlFull.slice(0, UNFURL_MAX_BYTES);
    const title = pickMeta(html, "og:title") ?? pickTitleTag(html);
    const description = pickMeta(html, "og:description");
    const imageRaw = pickMeta(html, "og:image");
    const siteName = pickMeta(html, "og:site_name");
    // og:image 常为相对路径或协议相对——归一化为绝对 URL，前端 <img> 才能用
    let image: string | null = null;
    if (imageRaw) {
      try {
        image = new URL(imageRaw, target.href).href;
        if (isBlockedHost(new URL(image).hostname)) image = null;
      } catch {
        image = null;
      }
    }

    // og 全空且 title 也抓不到 → 无信息增量，让前端降级普通链接（宪法「不点开就有
    // 信息增量」的反例：空卡片比纯链接更碍眼）
    if (!title && !description && !image) return null;

    return {
      url: target.href,
      title,
      description,
      image,
      siteName,
      host: target.hostname,
    };
  }

  /** 带 AbortSignal.timeout 的抓取；Content-Type 非 HTML 直接判失败（PDF/图等无 og 可抓） */
  private async fetchWithTimeout(target: URL): Promise<{ ok: boolean; body: string }> {
    const resp = await fetch(target.href, {
      signal: AbortSignal.timeout(UNFURL_TIMEOUT_MS),
      redirect: "follow",
      headers: {
        // 声明桌面 UA 与接受 HTML——部分站对无 UA 请求返回 403/精简版
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) return { ok: false, body: "" };
    const ctype = resp.headers.get("content-type") ?? "";
    if (!ctype.includes("text/html") && !ctype.includes("application/xhtml")) {
      return { ok: false, body: "" };
    }
    const body = await resp.text();
    return { ok: true, body };
  }
}
