/**
 * DegenerateDetector：退化重复输出检测器（F20260804dglp）。
 *
 * 双机制，运行时 OutputGuard（流式增量）与 session-sanitizer（离线整段）共用：
 *
 * 机制 A——非对齐精确重复检测（任意周期、相位免疫）：
 *   对累积文本做 stride-1 的 windowLength 字符滑窗，滚动哈希计数；
 *   **任一窗口的出现次数 ≥ maxWindowRepeats** 判退化。
 *   原理：周期 L 的失控循环中，同一窗口每 L 字符重现一次，块长 N 时单窗口
 *   计数 ≈ N/L，与分段相位无关（定长非重叠分段对 L≈67-200 互素周期存在
 *   结构性盲区）。判据取"单窗口计数"而非"累计重复位置数"，是为了区分
 *   失控循环与良性的"整段复述两遍"（后者单窗口计数=2，不误伤）。
 *
 * 机制 B——distinct-ratio（近似重复专用）：
 *   windowLength 字符非重叠分段，块 ≥ minBlockLength 且 distinct/total ≤
 *   distinctRatioThreshold 判退化。专抓换措辞的近似重复。
 *
 * 阴性安全距离（实测 110 个 ≥5KB 合法块）：最低 distinct ratio 0.838，阈值 0.3 无假阳性。
 */

export interface DegenerateConfig {
  /** 滑窗/分段长度（字符） */
  windowLength: number;
  /** 机制 A：同一窗口出现多少次触发（失控循环 ≈ 块长/周期；良性复述=2） */
  maxWindowRepeats: number;
  /** 机制 B：块最小长度（字符），低于此不做 ratio 判定 */
  minBlockLength: number;
  /** 机制 B：distinct/total ≤ 此值判退化 */
  distinctRatioThreshold: number;
  /** 内存保护：累积超过此长度后停止跟踪（合法超长块不吃内存） */
  maxTrackedLength: number;
}

export const DEFAULT_DEGENERATE_CONFIG: DegenerateConfig = {
  windowLength: 100,
  maxWindowRepeats: 50,
  minBlockLength: 5_000,
  distinctRatioThreshold: 0.3,
  maxTrackedLength: 1_000_000,
};

export type DegenerateVerdict =
  | { degenerate: true; mechanism: "repeat_window" | "distinct_ratio"; detail: string }
  | { degenerate: false };

const NOT_DEGENERATE: DegenerateVerdict = { degenerate: false };

/** djb2 字符串哈希（与 tool-call-circuit-breaker 的 contentDigest 同源） */
function djb2(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export class DegenerateDetector {
  private readonly config: DegenerateConfig;
  /** 机制 A：末尾 windowLength-1 个字符（拼接新字符成窗口） */
  private tail = "";
  private readonly windowCounts = new Map<number, number>();
  private maxWindowCount = 0;
  /** 机制 B：非重叠分段 */
  private pending = "";
  private readonly segmentHashes = new Set<number>();
  private segmentCount = 0;

  private totalLength = 0;
  private tracking = true;

  constructor(config?: Partial<DegenerateConfig>) {
    this.config = { ...DEFAULT_DEGENERATE_CONFIG, ...config };
  }

  /** 块边界重置（text_start/thinking_start 时调用） */
  reset(): void {
    this.tail = "";
    this.windowCounts.clear();
    this.maxWindowCount = 0;
    this.pending = "";
    this.segmentHashes.clear();
    this.segmentCount = 0;
    this.totalLength = 0;
    this.tracking = true;
  }

  get length(): number {
    return this.totalLength;
  }

  /** 追加文本，返回退化判定（首次命中后保持命中态由调用方管理） */
  add(text: string): DegenerateVerdict {
    this.totalLength += text.length;
    if (!this.tracking) return NOT_DEGENERATE;
    if (this.totalLength > this.config.maxTrackedLength) {
      this.tracking = false;
      this.windowCounts.clear();
      this.segmentHashes.clear();
      return NOT_DEGENERATE;
    }

    const a = this.addSlidingWindows(text);
    if (a.degenerate) return a;
    return this.addSegments(text);
  }

  /** 机制 A：stride-1 滑窗，按单窗口出现次数判定（每个新字符产生一个以它结尾的窗口） */
  private addSlidingWindows(text: string): DegenerateVerdict {
    const w = this.config.windowLength;
    let tail = this.tail;
    for (let i = 0; i < text.length; i++) {
      tail += text[i];
      if (tail.length < w) continue;
      if (tail.length > w) tail = tail.slice(-w);
      const h = djb2(tail);
      const count = (this.windowCounts.get(h) ?? 0) + 1;
      this.windowCounts.set(h, count);
      if (count > this.maxWindowCount) this.maxWindowCount = count;
      if (count >= this.config.maxWindowRepeats) {
        return {
          degenerate: true,
          mechanism: "repeat_window",
          detail: `window repeated ${count} times threshold=${this.config.maxWindowRepeats} totalLength=${this.totalLength}`,
        };
      }
    }
    this.tail = tail.slice(-(w - 1));
    return NOT_DEGENERATE;
  }

  /** 机制 B：非重叠分段 distinct-ratio */
  private addSegments(text: string): DegenerateVerdict {
    const w = this.config.windowLength;
    this.pending += text;
    while (this.pending.length >= w) {
      const segment = this.pending.slice(0, w);
      this.pending = this.pending.slice(w);
      this.segmentHashes.add(djb2(segment));
      this.segmentCount++;
    }
    if (this.totalLength < this.config.minBlockLength) return NOT_DEGENERATE;
    if (this.segmentCount === 0) return NOT_DEGENERATE;
    const ratio = this.segmentHashes.size / this.segmentCount;
    if (ratio <= this.config.distinctRatioThreshold) {
      return {
        degenerate: true,
        mechanism: "distinct_ratio",
        detail: `distinct ratio=${ratio.toFixed(3)} (${this.segmentHashes.size}/${this.segmentCount}) threshold=${this.config.distinctRatioThreshold} totalLength=${this.totalLength}`,
      };
    }
    return NOT_DEGENERATE;
  }
}

/** 离线整段分析（session-sanitizer 用）：与流式路径同一实现 */
export function analyzeText(text: string, config?: Partial<DegenerateConfig>): DegenerateVerdict {
  const detector = new DegenerateDetector(config);
  return detector.add(text);
}
