import { describe, it, expect } from "vitest";
import {
  DegenerateDetector,
  DEFAULT_DEGENERATE_CONFIG,
} from "@frameworks/agent/degenerate-detector";

/** 离线整段分析：与流式路径同一实现 */
function analyzeText(text: string, config?: Partial<import("@frameworks/agent/degenerate-detector").DegenerateConfig>) {
  return new DegenerateDetector(config).add(text);
}

/** mulberry32 伪随机（确定性夹具） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成每个 100 字符窗口都唯一的伪随机文本（阴性夹具） */
function randomText(length: number, seed = 42): string {
  const rand = mulberry32(seed);
  const alphabet = "abcdefghijklmnop";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

/** 精确重复文本（周期 = unit.length），等价于真实 entry be2c597d（周期 67）的模式 */
function exactRepeat(unit: string, times: number): string {
  return unit.repeat(times);
}

/** 近似重复文本：从变体池随机抽取拼接（等价于真实 entry 4e8c3ff3 的模式） */
function nearDuplicate(variants: string[], totalLength: number, seed = 7): string {
  const rand = mulberry32(seed);
  let out = "";
  while (out.length < totalLength) out += variants[Math.floor(rand() * variants.length)];
  return out;
}

describe("DegenerateDetector 机制 A（非对齐精确重复）", () => {
  it("抓住周期 67 的精确重复（be2c597d 型，定长分段盲区）", () => {
    const unit = "Good, now let me create the .gitignore and then commit everything. "; // 67 字符
    expect(unit.length).toBe(67);
    const verdict = analyzeText(exactRepeat(unit, 200));
    expect(verdict.degenerate).toBe(true);
    if (verdict.degenerate) expect(verdict.mechanism).toBe("repeat_window");
  });

  it("抓住长周期精确重复（f676b3b0 型，87 字符单元 ×6344）", () => {
    const unit = "Good, the first commit is done. Now let me speak to the user with the progress update. ";
    const verdict = analyzeText(exactRepeat(unit, 500));
    expect(verdict.degenerate).toBe(true);
    if (verdict.degenerate) expect(verdict.mechanism).toBe("repeat_window");
  });

  it("精确重复在秒级触发（~5KB 累积量，K=50）", () => {
    const unit = "x".repeat(60) + " "; // 61 字符周期
    const detector = new DegenerateDetector();
    // 分段喂入，统计触发时的累积量
    let fed = 0;
    let trippedAt = -1;
    while (fed < 200_000) {
      const v = detector.add(unit);
      fed += unit.length;
      if (v.degenerate) { trippedAt = fed; break; }
    }
    expect(trippedAt).toBeGreaterThan(0);
    expect(trippedAt).toBeLessThan(20_000);
  });

  it("增量喂入与整段喂入结果一致（流式/离线同一实现）", () => {
    const unit = "abc123_重复单元测试。";
    const full = exactRepeat(unit, 2000);
    const detector = new DegenerateDetector();
    // 前 100 字符尚未攒满一个窗口，不可能触发
    let v = detector.add(full.slice(0, 100));
    expect(v.degenerate).toBe(false);
    v = detector.add(full.slice(100));
    expect(v.degenerate).toBe(true);
  });
});

describe("DegenerateDetector 机制 B（distinct-ratio 近似重复）", () => {
  it("抓住换措辞的近似重复（4e8c3ff3 型）", () => {
    // 15 个恰好 100 字符的变体随机拼接 20KB：相位对齐，distinct ratio ≈ 15/200 = 0.075
    // （变体等长保证非重叠分段相位对齐——真实近似重复含大量逐字相同的长跨度）
    const variants = Array.from({ length: 15 }, (_, i) => randomText(100, 1000 + i));
    for (const v of variants) expect(v.length).toBe(100);
    const text = nearDuplicate(variants, 20_000);
    const verdict = analyzeText(text);
    expect(verdict.degenerate).toBe(true);
    if (verdict.degenerate) expect(verdict.mechanism).toBe("distinct_ratio");
  });

  it("低于 minBlockLength 不做 ratio 判定", () => {
    const verdict = analyzeText("ab".repeat(1000), { minBlockLength: 10_000, maxWindowRepeats: 1_000_000 });
    expect(verdict.degenerate).toBe(false);
  });
});

describe("DegenerateDetector 阴性夹具（不误伤）", () => {
  it("正常伪随机文本不触发", () => {
    expect(analyzeText(randomText(50_000)).degenerate).toBe(false);
  });

  it("结构化但有信息量的文本不触发（模拟表格/代码）", () => {
    // 模拟 markdown 表格：每行结构相同但内容不同
    let table = "";
    for (let i = 0; i < 500; i++) {
      table += `| row-${i} | value-${i * 7 % 13} | 2026-08-0${i % 9 + 1} | desc-${randomText(20, i)} |\n`;
    }
    expect(analyzeText(table).degenerate).toBe(false);
  });

  it("maxTrackedLength 超限后停止跟踪（内存保护）", () => {
    const detector = new DegenerateDetector({ maxTrackedLength: 10_000 });
    detector.add(randomText(10_001));
    // 超限后即使喂退化内容也不触发
    const v = detector.add("z".repeat(5000));
    expect(v.degenerate).toBe(false);
  });

  it("块边界 reset 后重新累积", () => {
    const detector = new DegenerateDetector({ maxWindowRepeats: 10 });
    detector.add("q".repeat(500));
    detector.reset();
    expect(detector.length).toBe(0);
    expect(detector.add(randomText(5000)).degenerate).toBe(false);
  });
});

describe("默认配置", () => {
  it("DEFAULT_DEGENERATE_CONFIG 常量符合设计文档", () => {
    expect(DEFAULT_DEGENERATE_CONFIG.windowLength).toBe(100);
    expect(DEFAULT_DEGENERATE_CONFIG.maxWindowRepeats).toBe(50);
    expect(DEFAULT_DEGENERATE_CONFIG.minBlockLength).toBe(5000);
    expect(DEFAULT_DEGENERATE_CONFIG.distinctRatioThreshold).toBe(0.3);
  });
});
