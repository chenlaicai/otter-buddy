/**
 * 海獭回复里的图片提取与转码（发送方向：海獭 → CoLink）。
 *
 * 模型不直接生成位图，但可以输出 SVG（矢量图，本质是文本）。约定格式：
 *
 *   ```svg
 *   <svg xmlns="http://www.w3.org/2000/svg" width="..." height="...">...</svg>
 *   ```
 *
 * App 从最终回复里提取这些块，渲染成 PNG（CoLink 平台只把 png/jpeg/gif/webp
 * 识别为可预览图片，SVG 不在白名单），再走 files.upload + messages.send 发回频道。
 */

/** 每轮发送图片上限（与接收方向对齐，避免单条消息塞满附件）。 */
export const MAX_FORWARD_IMAGES_PER_TURN = 2;

const SVG_FENCE_RE = /```(?:svg|xml)\s*\n([\s\S]*?)```/gi;
// 没有围栏但整段直接给 <svg>...</svg> 的兜底（模型偶发不包围栏）。
const BARE_SVG_RE = /<svg[\s\S]*?<\/svg>/gi;

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * 从回复文本提取 SVG 图片块。
 * @returns {{ svgs: string[], text: string }} svgs 为最多 MAX_FORWARD_IMAGES_PER_TURN 个 SVG 文本，
 *          text 为移除这些块之后的剩余正文（用于 CoLink 消息正文）。
 */
export function extractSvgBlocks(text) {
  const source = typeof text === 'string' ? text : '';
  const fenced = [];
  // 先摘除全部 ```svg / ```xml 围栏，围栏内正文收集为 fenced。
  const withoutFences = source.replace(SVG_FENCE_RE, (_full, inner) => {
    fenced.push(inner);
    return '';
  });
  // 剩余文本里还直接写 <svg>...</svg> 的作为兕底。
  const bare = [...withoutFences.matchAll(BARE_SVG_RE)].map(match => match[0]);
  const svgs = uniqueNonEmpty([...fenced, ...bare]).slice(0, MAX_FORWARD_IMAGES_PER_TURN);
  let remainder = withoutFences;
  for (const svg of svgs) {
    const escaped = svg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remainder = remainder.replace(new RegExp(escaped, 'g'), '');
  }
  return { svgs, text: remainder.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * SVG 文本渲染成 PNG 字节。渲染失败抛错，调用方降级为纯文本消息。
 * 限制输出尺寸，防止模型声明超大画布把内存打爆。
 */
export async function svgToPng(svgText) {
  const { default: sharp } = await import('sharp');
  const buffer = await sharp(Buffer.from(svgText, 'utf8'), { density: 150 })
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}
