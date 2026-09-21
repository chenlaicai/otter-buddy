/**
 * #1089 hex 色值判别器——色值（#000/#1a1a1a）与 issue 号（#419/#1089）结构同形，
 * 只能靠上下文判别：色值总以 CSS 属性形态紧邻出现（solid #000 / 1px #000 / 底 #0a0a0a）。
 * 判别取向：宁漏放不误拦——漏放（真 issue 号恰好带 CSS 前缀）由白名单兜底，
 * 误拦（合法色值被拦）直接阻塞合法 commit（F20260921vsds 提交现场：词典色值 #000 被拦三道）。
 */
/** 紧邻前缀模式：CSS 语境词后允许 CSS 过渡带（空白/冒号/等号/逗号/数值单位如 1px、2%、0.5em）再接色值 */
const ADJACENT_CSS_RE =
  /(?:solid|shadow|gradient|background|bg|color|border|fill|stroke|色|底|块|线条?)(?:[\s:=,]|\d+(?:\.\d+)?(?:px|em|rem|%|s|ms)?){0,3}$/i;

/** 判别单个 #\d{3,} 命中是否为 hex 色值（带上下文）：匹配点紧邻前缀是 CSS 语境形态即视为色值。
 * 3 位/6 位 hex 同形（#fff 与 #123 同合法），结构无法区分，只认紧邻上下文——
 * 大窗口（前 24 字符任意位置）会把「solid #000 描边，验收标准见 #1089」的 issue 号也误放（测试实证），
 * 紧邻模式收窄到「语境词+CSS 过渡带」，色值的属性形态保持高判别力。
 * 过渡带含数值单位：CSS 标准形态「1px #000」「2px solid」中数值紧邻色值。 */
export function isHexColorHit(line, hit) {
  const idx = line.indexOf(hit);
  if (idx < 0) return false;
  const before = line.slice(Math.max(0, idx - 20), idx);
  return ADJACENT_CSS_RE.test(before);
}
