/**
 * F20261013csv3 T1：裸 URL 扫描纯函数（预抓取钩子的数据源）。
 * 从 send-entry.ts 拆出（max-lines 阈值）；口径与前端 bare-url 插件同一判定规则，
 * 前后端不漂移。抽成独立纯函数便于单测（不依赖 SendEntry 实例）。
 *
 * 口径：行内（含行首）http/https URL 独占一段才算裸链；```html-card 围栏体内不算
 * （由卡片自身渲染）。
 */

const BARE_URL_RE = /https?:\/\/[^\s<>()[\]{}'"]+/g;
/** 行内去除 URL 后仅剩空白/标点视为「独占一段」 */
const PUNCT_ONLY_RE = /^[\s。，、；;,.!?！？）)>」』"']*$/;
/** 尾部粘贴带入的中英文标点（从 URL 尾剥除） */
const TRAILING_PUNCT_RE = /[。，、；;,.!?！？）)>」』"']+$/;

export function scanBareUrls(body: string): string[] {
  const urls: string[] = [];
  const inFence = isInsideHtmlCardFence(body);
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (inFence(i)) continue;
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    // 围栏起始/终止行不算（围栏体内的 URL 由卡片渲染）
    if (/^```html-card/.test(line)) continue;
    // 独占一段判定：整行去掉 URL 后无其他非空白字符（允许多个空白分隔的 URL 同行）
    const matches = line.match(BARE_URL_RE);
    if (!matches) continue;
    const stripped = line.replace(BARE_URL_RE, "").trim();
    if (!(stripped.length === 0 || PUNCT_ONLY_RE.test(stripped))) continue;
    for (const m of matches) {
      const clean = m.replace(TRAILING_PUNCT_RE, "");
      if (clean.length > 0 && !urls.includes(clean)) urls.push(clean);
    }
  }
  return urls;
}

/**
 * 返回判定函数：给定行号是否在 ```html-card 围栏体内。
 * 围栏按行扫描：```html-card 或 ```html-card-play 开，单独 ``` 行闭。
 */
function isInsideHtmlCardFence(body: string): (lineIndex: number) => boolean {
  const lines = body.split("\n");
  const fenceState: boolean[] = new Array(lines.length).fill(false);
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^```html-card(-play)?\b/.test(line)) {
      inside = true;
      fenceState[i] = false; // 起始行自身不算体内
      continue;
    }
    if (inside && line === "```") {
      inside = false;
      fenceState[i] = false; // 终止行自身不算体内
      continue;
    }
    fenceState[i] = inside;
  }
  return (lineIndex: number) => fenceState[lineIndex] ?? false;
}

/** 预抓取触发（从 SendEntry 拆出降 send-entry.ts 行数）——异常仅 warn，永不阻断发送路径 */
export function triggerUnfurlPrefetch(
  body: string,
  prefetch: ((urls: string[]) => void) | undefined,
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): void {
  if (!prefetch) return;
  try {
    const urls = scanBareUrls(body);
    if (urls.length > 0) prefetch(urls);
  } catch (err) {
    logger.warn("unfurl prefetch scan failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
