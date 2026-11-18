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
// 围栏内正文根元素必须确为 <svg>（允许前导空白），否则（如普通 XML 或嵌套 svg 的 XML）保持普通文本不吞。
const SVG_ROOT_RE = /^\s*<svg[\s>]/i;

// 删除正文中的图片块时的整块匹配（含围栏或裸块），避免正则元字符注入。
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * 处理顺序：先摘除全部图片块（含超出发送上限的也要从正文删干净）→ 再对发送列表去重截断。
 * 非 SVG 的 ```xml / ```svg 围栏（如普通 XML 示例、或根元素非 svg 的嵌套 XML）整块原样保留，
 * 不吞、不误判；裸 <svg> 兜底只在围栏之外的正文里匹配，避免误摘保留围栏内部的嵌套 svg。
 * @returns {{ svgs: string[], text: string }} svgs 为最多 MAX_FORWARD_IMAGES_PER_TURN 个 SVG 文本，
 *          text 为移除全部图片块之后的剩余正文（用于 CoLink 消息正文）。
 */
export function extractSvgBlocks(text) {
  const source = typeof text === 'string' ? text : '';
  const fenced = [];
  const kept = new Map();
  let fenceSlot = 0;
  // 围栏替换：根元素是 <svg> 的摘除收集；非 SVG 围栏换成占位符（裸 svg 匹配不会误入其内部）。
  const work = source.replace(SVG_FENCE_RE, (_full, inner) => {
    if (SVG_ROOT_RE.test(inner)) {
      fenced.push(inner);
      return '';
    }
    const slot = `\u0000COLINK_FENCE_${fenceSlot++}\u0000`;
    kept.set(slot, _full);
    return slot;
  });
  // 裸 <svg>...</svg> 只在围栏之外的正文里找。
  const bare = [...work.matchAll(BARE_SVG_RE)].map(m => m[0]);
  const all = uniqueNonEmpty([...fenced, ...bare]);
  let remainder = work;
  for (const svg of bare) {
    remainder = remainder.replace(new RegExp(escapeRegExp(svg), 'g'), '');
  }
  // 还原非 SVG 围栏占位符。
  for (const [slot, original] of kept) {
    remainder = remainder.replace(new RegExp(escapeRegExp(slot), 'g'), original);
  }
  const svgs = all.slice(0, MAX_FORWARD_IMAGES_PER_TURN);
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