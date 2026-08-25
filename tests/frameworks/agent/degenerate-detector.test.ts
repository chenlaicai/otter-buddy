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

/** 机制 B 视角的 distinct ratio（非重叠 windowLength 分段，与实现同参数）。
 * 阴性夹具用它断言 ratio 远离阈值（防未来夹具参数微调后贴阈值飞行）。 */
function distinctRatioOf(text: string): number {
  const w = DEFAULT_DEGENERATE_CONFIG.windowLength;
  const segs = new Set<string>();
  let total = 0;
  for (let i = 0; i + w <= text.length; i += w) {
    segs.add(text.slice(i, i + w));
    total++;
  }
  return total === 0 ? 1 : segs.size / total;
}

// ---------- #346：3-5KB 区间阴性夹具生成器 ----------
// 背景：F20260820d338 将 minBlockLength 5000→3000，3-5KB 块首次暴露于机制 B。
// 实测：高度模板化的合法结构（表格/日志/JSON/清单/段落）ratio 均 = 1.000，
// 安全边际充足；阈值语义 = "≥3KB 输出中逐字重复分段超 70% 才算退化"（见
// 下方边界语义用例）。

/** markdown 表格：行结构相同、字段值各异（种子决定组件/状态/日期/备注） */
function tableText(rows: number, seed: number): string {
  const rand = mulberry32(seed);
  const components = ["内存索引", "向量召回", "术语短路", "锚点定位", "分页摘要", "关系图遍历", "全文检索", "邻域扩展"];
  const statuses = ["pass", "warn", "fail", "skip"];
  let out = "| 检查项 | 组件 | 状态 | 日期 | 备注 |\n|---|---|---|---|---|\n";
  for (let i = 0; i < rows; i++) {
    out += `| CHK-${1000 + i} | ${components[Math.floor(rand() * components.length)]} | ${statuses[Math.floor(rand() * statuses.length)]} | 2026-08-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")} | ${randomText(8 + Math.floor(rand() * 8), Math.floor(rand() * 1e6))} |\n`;
  }
  return out;
}

/** 编号 checklist：bullet 前缀模式重复（"- [x] 检查项 N："）+ 8 条短内容池复用 */
function checklistText(items: number, seed: number): string {
  const rand = mulberry32(seed);
  const phrases = [
    "完成基础校验，未发现异常项",
    "索引健康度正常，无需重建",
    "命中缓存，直接返回结果",
    "跳过本轮，等待下个周期",
    "重试一次后成功恢复",
    "配置读取正常，值在预期范围",
    "连接池空闲，回收部分连接",
    "日志采样无新增错误",
  ];
  let out = "";
  for (let i = 0; i < items; i++) {
    out += `- [${rand() > 0.3 ? "x" : " "}] 检查项 ${i + 1}：${phrases[Math.floor(rand() * phrases.length)]}。\n`;
  }
  return out;
}

/** 固定宽度日志行：时间戳/等级/组件/消息取自小池子，序号与随机值各异 */
function logText(lines: number, seed: number): string {
  const rand = mulberry32(seed);
  const levels = ["INFO", "WARN", "DEBUG"];
  const comps = ["indexer", "recaller", "sanitizer", "paginator", "terminolog"];
  const msgs = ["heartbeat ok", "batch flushed", "cache warmed", "lock acquired", "queue drained", "segment merged"];
  let out = "";
  for (let i = 0; i < lines; i++) {
    const ts = `2026-08-24T${String(Math.floor(rand() * 24)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}.${String(Math.floor(rand() * 1000)).padStart(3, "0")}Z`;
    out += `${ts} ${levels[Math.floor(rand() * levels.length)]} [${comps[Math.floor(rand() * comps.length)]}-${1 + Math.floor(rand() * 4)}] ${msgs[Math.floor(rand() * msgs.length)]} seq=${String(i + 1).padStart(6, "0")} depth=${Math.floor(rand() * 9)} latency=${Math.floor(rand() * 200)}ms\n`;
  }
  return out;
}

/** JSON 数组：key 集合逐字重复，value 各异（pretty-print 格式） */
function jsonText(entries: number, seed: number): string {
  const rand = mulberry32(seed);
  const names = ["memoryRecall", "docSync", "termLookup", "ctxWindow", "digestCron", "vecIndex"];
  const arr = Array.from({ length: entries }, (_, i) => ({
    id: i + 1,
    name: names[Math.floor(rand() * names.length)],
    enabled: rand() > 0.2,
    priority: Math.floor(rand() * 10),
    retries: Math.floor(rand() * 4),
    note: randomText(12, Math.floor(rand() * 1e6)),
  }));
  return "```json\n" + JSON.stringify(arr, null, 2) + "\n```\n";
}

/** 中文段落：过渡词/主语/谓语从小池子随机组合（复述式但组合各异） */
function proseText(paras: number, seed: number): string {
  const rand = mulberry32(seed);
  const transitions = ["首先，", "其次，", "此外，", "另外，", "同时，", "最终，", "综上，", "在此基础上，"];
  const subjects = ["检索链路", "分段策略", "哈希计数", "阈值边界", "内存保护", "流式路径", "离线分析", "会话边界"];
  const verbs = ["保持稳定", "按预期工作", "覆盖了关键分支", "验证了设计假设", "留出了安全边际", "复用了既有实现"];
  let out = "";
  for (let i = 0; i < paras; i++) {
    out += `${transitions[Math.floor(rand() * transitions.length)]}${subjects[Math.floor(rand() * subjects.length)]}${verbs[Math.floor(rand() * verbs.length)]}；从${Math.floor(rand() * 900 + 100)}个样本的实测数据看，${subjects[Math.floor(rand() * subjects.length)]}${verbs[Math.floor(rand() * verbs.length)]}，置信度标注为${["高", "中", "低"][Math.floor(rand() * 3)]}。该结论与既有记忆链的记录一致，未发现相互矛盾的锚点。\n\n`;
  }
  return out;
}

/** 混合报告：段落 + 表格 + 清单（最接近真实小獭汇报输出的形态） */
function reportText(seed: number, tableRows: number, checklistItems: number): string {
  return (
    "## 结论\n\n" +
    proseText(2, seed + 1) +
    "## 过程\n\n" + tableText(tableRows, seed + 2) + "\n" +
    "## 下一步\n\n" + checklistText(checklistItems, seed + 3)
  );
}

/** 对齐分段压测：每行恰好 100 字符（含换行）且取自 n 个逐字模板轮转——ratio = n/行数 */
function alignedPoolText(lines: number, templateCount: number): string {
  const templates = Array.from({ length: templateCount }, (_, i) => {
    const head = `- [x] 模板${i}：固定内容逐字重复，仅模板编号区分，用于对齐分段压测。`;
    return head + "·".repeat(100 - head.length - 1) + "\n";
  });
  let out = "";
  for (let i = 0; i < lines; i++) out += templates[i % templateCount];
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

  it("精确重复在秒级触发（F20260820d338：K=20，~2KB 累积量）", () => {
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

  it("抓住 thinking 泄漏型循环（#424 型，f19a4a4e：532 字符周期 ×49，机制 B 盲区）", () => {
    // 真实事件 #424（8/24 11:54 UTC，mimo）：speak 完成后继续生成的裸 text
    // block 把 thinking 内容逐字复制后循环 49 遍（周期 532，总 26171 字符）。
    // 匿名化复现：周期与总量保持原值重、措辞去人名/去项目专名。
    const cycle = `the user is asking two things:\n\n1. What's the medium/long-term solution? Explain it in detail.\n2. A serious statement: "already working" (已跑通) is NOT a valid reason to merge a PR. Long-term correctness > short-term efficiency.\n\nThis is a good point from the user. Let me address both:\n\n1. The medium/long-term solution is "runtime semantic fingerprinting" - I need to explain this concretely.\n2. I need to acknowledge the user's principle and not just default to "merge first, fix later".\n\nLet me also dissolve the idle reviewer agent and clean up the planning agents. `;
    expect(cycle.length).toBe(569);
    const text = cycle.repeat(49) + cycle.slice(0, 103);
    // 机制 B 盲区断言：周期与分段长度互素 → 非重叠分段相位错开，ratio 远离阈值
    // （原始样本周期 532 与 100 的 gcd=4，ratio=0.510；匿名化后 569 为质数，ratio=1.000——
    // 两种情形均 > 0.3，机制 B 无法捕获，机制 A 是唯一防线）
    expect(distinctRatioOf(text)).toBeGreaterThan(0.3);
    // 流式喂入（37 字符/块，模拟 OutputGuard delta）必须被机制 A 拦住
    const detector = new DegenerateDetector();
    let verdict: ReturnType<DegenerateDetector["add"]> | null = null;
    let fed = 0;
    for (let i = 0; i < text.length && !verdict; i += 37) {
      const v = detector.add(text.slice(i, i + 37));
      fed = i + 37;
      if (v.degenerate) verdict = v;
    }
    expect(verdict).not.toBeNull();
    expect(verdict && verdict.degenerate && verdict.mechanism).toBe("repeat_window");
    // K=20 下 ~10.9K 字符即触发（运行时旧阈值 K=50 时拖到 26171）
    expect(fed).toBeLessThan(12_000);
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

describe("DegenerateDetector 3-5KB 区间阴性夹具（#346，F20260820d338 阈值回归）", () => {
  // minBlockLength 5000→3000 后，3-5KB 块首次暴露于机制 B（distinct-ratio）。
  // 阴性断言：verdict = { degenerate: false } 且 distinctRatioOf(text) > 0.5
  //（实测全部 = 1.000，安全边际约 3.3 倍；0.5 护栏防止夹具参数微调后贴阈值飞行）。
  // 对照 F20260820d338 的 ≥5KB 实测最低 0.838。
  // 断言长度下限统一 >= 3000：表达“样本必须落在被测区间”的设计意图，
  // 而非迁就个别样本的实际长度（否则低于 minBlockLength 机制 B 不介入、断言空转）。

  it("伪随机文本跨 3-5KB 边界扫描不触发（6 个尺寸档）", () => {
    for (let i = 0; i < 6; i++) {
      const text = randomText(3000 + i * 400, 9000 + i);
      expect(text.length).toBeGreaterThanOrEqual(3000);
      expect(text.length).toBeLessThanOrEqual(5000);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("markdown 表格：行结构重复、字段各异，3.2-4.1KB 不触发（3 种子）", () => {
    for (let i = 0; i < 3; i++) {
      const text = tableText(57 + i * 8, 500 + i);
      expect(text.length).toBeGreaterThanOrEqual(3000);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("编号 checklist：重复 bullet 前缀 + 8 条内容池复用，3.1-4.2KB 不触发（3 种子）", () => {
    // kimi-分析獭-v2 在 #346 建议的高危形态：前缀模式重复但内容各异
    for (let i = 0; i < 3; i++) {
      const text = checklistText(118 + i * 20, 700 + i);
      expect(text.length).toBeGreaterThanOrEqual(3000);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("固定宽度日志行：时间戳/组件/消息取自小池子，4-5KB 不触发（3 种子）", () => {
    // 日志是结构最模板化的合法输出：格式 token 完全相同，仅数值字段变化
    for (let i = 0; i < 3; i++) {
      const text = logText(48 + i * 4, 200 + i);
      expect(text.length).toBeGreaterThan(4000);
      expect(text.length).toBeLessThanOrEqual(5200);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("JSON 数组：key 集合逐字重复、value 各异，3-5KB 不触发（3 种子）", () => {
    for (let i = 0; i < 3; i++) {
      const text = jsonText(24 + i * 6, 300 + i);
      expect(text.length).toBeGreaterThanOrEqual(3200);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("中文段落：重复过渡词/主语/谓语池组合，3-4.5KB 不触发（3 种子）", () => {
    for (let i = 0; i < 3; i++) {
      const text = proseText(45 + i * 8, 400 + i);
      expect(text.length).toBeGreaterThanOrEqual(3000);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("混合报告：段落+表格+清单，3.5-5KB 不触发（3 种子）", () => {
    // 最接近真实小獭汇报输出（speak 正文常见形态）
    for (let i = 0; i < 3; i++) {
      const text = reportText(300 + i, 38 + i * 6, 55 + i * 10);
      expect(text.length).toBeGreaterThanOrEqual(3500);
      expect(text.length).toBeLessThanOrEqual(5000);
      expect(analyzeText(text).degenerate).toBe(false);
      expect(distinctRatioOf(text)).toBeGreaterThan(0.5);
    }
  });

  it("流式分块喂入（37 字符/块）与整段喂入判定一致", () => {
    const text = reportText(321, 52, 80);
    const chunked = new DegenerateDetector();
    for (let fed = 0; fed < text.length; fed += 37) {
      const v = chunked.add(text.slice(fed, fed + 37));
      expect(v.degenerate).toBe(false);
    }
    expect(analyzeText(text).degenerate).toBe(false);
  });

  it("阳性对照：3KB 精确重复触发 repeat_window（新阈值下灵敏度保留）", () => {
    const unit = "x".repeat(60) + " "; // 61 字符周期
    const verdict = analyzeText(unit.repeat(50)); // ~3.1KB
    expect(verdict.degenerate).toBe(true);
    if (verdict.degenerate) {
      expect(verdict.mechanism).toBe("repeat_window");
    }
  });

  it("阳性对照：3.2KB 近似重复（6 变体池）流式喂入中途触发 distinct_ratio（运行时路径）", () => {
    // OutputGuard 的真实工作路径是流式增量喂入、首次命中即介入——
    // 阳性方向也须验证流式与整段判定一致
    const variants = Array.from({ length: 6 }, (_, i) => randomText(100, 1000 + i));
    const text = nearDuplicate(variants, 3_200);
    const chunked = new DegenerateDetector();
    let degenerate = false;
    let mechanism = "";
    let consumed = 0;
    for (let fed = 0; fed < text.length; fed += 37) {
      consumed = fed + 37;
      const v = chunked.add(text.slice(fed, fed + 37));
      if (v.degenerate) {
        degenerate = true;
        mechanism = v.mechanism;
        break;
      }
    }
    expect(degenerate).toBe(true);
    expect(mechanism).toBe("distinct_ratio");
    // 触发点在首次跨过 minBlockLength=3000 的 add（阈值语义）
    expect(consumed).toBeGreaterThanOrEqual(3000);
    expect(consumed).toBeLessThanOrEqual(text.length);
  });

  it("阈值语义边界（3KB/5KB 双点）：逐字重复分段 ≤70% 触发，>1/3 唯一不触发", () => {
    // 每行恰好 100 字符（含换行）按 n 个逐字模板轮转——分段与行完全对齐，
    // ratio = n/行数（轮转保证每个模板至少出现一次，数值确定性）。
    // 这是机制 B 在 3-5KB 的判定语义：逐字重复才是退化，模板化结构
    // （字段各异）即使大量行同构也不误伤。5KB 点单分段影响降至 0.02。
    const d30 = analyzeText(alignedPoolText(30, 8)); // 3KB，8/30 ≈ 0.27 ≤ 0.3
    expect(d30.degenerate).toBe(true);
    if (d30.degenerate) {
      expect(d30.mechanism).toBe("distinct_ratio");
    }
    const l30 = analyzeText(alignedPoolText(30, 12)); // 3KB，12/30 = 0.40 > 0.3
    expect(l30.degenerate).toBe(false);
    const d50 = analyzeText(alignedPoolText(50, 15)); // 5KB，15/50 = 0.30 恰好压阈值等值点（≤ 语义）
    expect(d50.degenerate).toBe(true);
    if (d50.degenerate) {
      expect(d50.mechanism).toBe("distinct_ratio");
    }
    const l50 = analyzeText(alignedPoolText(50, 16)); // 5KB，16/50 = 0.32 > 0.3
    expect(l50.degenerate).toBe(false);
  });
});

describe("默认配置", () => {
  it("DEFAULT_DEGENERATE_CONFIG 常量符合设计文档（F20260820d338 更新阈值）", () => {
    expect(DEFAULT_DEGENERATE_CONFIG.windowLength).toBe(100);
    expect(DEFAULT_DEGENERATE_CONFIG.maxWindowRepeats).toBe(20);
    expect(DEFAULT_DEGENERATE_CONFIG.minBlockLength).toBe(3000);
    expect(DEFAULT_DEGENERATE_CONFIG.distinctRatioThreshold).toBe(0.3);
  });
});
