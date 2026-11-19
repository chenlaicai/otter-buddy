/**
 * PR 呈递拍板机械闸（PR 卡片闸事故/#1907）判定矩阵单测。
 *
 * 核心不变量：
 * - 守卫总则「明确拦、不明确放通」：否定/过去式剔除（「已合入」「不建议合入」不触发）；
 * - 辅闸窄表不含评价措辞（「可以合入」在 speak 侧放行——独立检视獭的检视报告常态无卡）；
 * - 主闸宽表在 yield-to-user 上下文收评价措辞（「可以合入了」正是 08:43 事故形态）；
 * - 决策卡判定只认围栏内 otterCard.submit。
 */
import { describe, it, expect } from "vitest";
import {
  hasPrReference,
  hasDecisionRequestWide,
  hasDecisionRequestNarrow,
  decisionCardPresent,
  checkSpeakGate,
  checkYieldGate,
} from "@usecases/conversation/pr-card-gate";
import { hasCardFences, cardFenceValues } from "@interface-adapters/agent-runtime/tools/tool-helpers";

describe("#1952 PR 引用检测", () => {
  it("命中：#三位数起与 pull URL", () => {
    expect(hasPrReference("PR #1960 待拍板")).toBe(true);
    expect(hasPrReference("https://github.com/chenlaicai/otter-buddy/pull/1959 开了")).toBe(true);
  });
  it("不命中：两位数以下编号与无引用文本", () => {
    expect(hasPrReference("第 2 步")).toBe(false);
    expect(hasPrReference("#42")).toBe(false);
    expect(hasPrReference("CI 全绿，检视通过")).toBe(false);
  });
});

describe("#1952 主闸宽表（yield 上下文）", () => {
  it("命中：拍板/授权/一句话/合入请求四族", () => {
    expect(hasDecisionRequestWide("CI 全绿，可以合入了")).toBe(true);
    expect(hasDecisionRequestWide("#1960 待拍板")).toBe(true);
    expect(hasDecisionRequestWide("等你授权后执行 squash")).toBe(true);
    expect(hasDecisionRequestWide("待你一句话")).toBe(true);
    expect(hasDecisionRequestWide("要不要合入由你定")).toBe(true);
  });
  it("剔除否定与过去式：检视报告与已合入通报不触发", () => {
    expect(hasDecisionRequestWide("检视未过，不建议合入")).toBe(false);
    expect(hasDecisionRequestWide("PR #1954 已合入 main")).toBe(false);
    expect(hasDecisionRequestWide("这个 PR 暂不合并")).toBe(false);
    expect(hasDecisionRequestWide("无法合入：CI 红")).toBe(false);
  });
  it("同回合多 PR 混排：已合入通报不影响在途呈递命中", () => {
    expect(hasDecisionRequestWide("#1954 已合入，#1960 可以合入")).toBe(true);
  });
});

describe("#1952 辅闸窄表（speak 单条）", () => {
  it("命中：纯请求措辞", () => {
    expect(hasDecisionRequestNarrow("等你拍板")).toBe(true);
    expect(hasDecisionRequestNarrow("请授权后推进")).toBe(true);
  });
  it("放行：评价措辞「可以合入」——独立检视獭的检视报告形态", () => {
    expect(hasDecisionRequestNarrow("检视通过，可以合入，无阻塞项")).toBe(false);
  });
});

describe("#1952 决策卡在场判定", () => {
  it("围栏内含 otterCard.submit 即在场（嵌套围栏同 remark 口径）", () => {
    const body = [
      "结论：可合入。",
      "```html-card title=\"PR 1960 决策卡\"",
      "<button onclick=\"otterCard.submit({ summary: '1960合入' })\">合入</button>",
      "```",
    ].join("\n");
    expect(decisionCardPresent([body], cardFenceValues)).toBe(true);
  });
  it("普通卡片（无 submit）不算决策卡", () => {
    const body = ["```html-card title=\"状态\"", "<div>CI 绿</div>", "```"].join("\n");
    expect(decisionCardPresent([body], cardFenceValues)).toBe(false);
  });
  it("纯文本无围栏不算", () => {
    expect(decisionCardPresent(["CI 全绿 #1960 可以合入"], cardFenceValues)).toBe(false);
  });
});

describe("#1952 辅闸 checkSpeakGate", () => {
  it("拦截：PR 引用 + 纯请求措辞 + 无卡（08:43 事故形态变体）", () => {
    const err = checkSpeakGate("#1960 检视完成，待你拍板", hasCardFences);
    expect(err).toContain("决策卡");
    expect(err).toContain("otterCard.submit");
  });
  it("放行：同措辞但带卡", () => {
    const body = ["#1960 待你拍板", "```html-card title=\"PR 1960\"", "<div>详情</div>", "```"].join("\n");
    expect(checkSpeakGate(body, hasCardFences)).toBeNull();
  });
  it("放行：检视报告（评价措辞不在窄表）", () => {
    expect(checkSpeakGate("检视 #1959 通过，可以合入，回执见 PR review", hasCardFences)).toBeNull();
  });
});

describe("#1952 主闸 checkYieldGate", () => {
  it("拦截：拆条规避——单条不共现，累计命中（先说 PR 再说可以合入）", () => {
    // 单条「检视完了」不触发辅闸；「可以合入了，等你」也不触发辅闸（无 PR 引用）
    expect(checkSpeakGate("CI 全绿，可以合入了", hasCardFences)).toBeNull();
    // 但 yield 时累计拼出呈递形态 → 主闸拦
    const err = checkYieldGate(["#1960 检视完成，CI 四 job 绿", "可以合入了，等你"], undefined, cardFenceValues);
    expect(err).toContain("决策卡");
  });
  it("拦截：reason 单独承载请求词（speak 只报状态）", () => {
    const err = checkYieldGate(["#1960 CI 绿"], "PR 待拍板，请授权合入", cardFenceValues);
    expect(err).toContain("决策卡");
  });
  it("放行：决策卡在场", () => {
    const card = ["```html-card title=\"PR 1960 合入决策\"", "<script>otterCard.submit({ summary: '1960合入' })</script>", "```"].join("\n");
    expect(checkYieldGate(["#1960 可以合入了", card], undefined, cardFenceValues)).toBeNull();
  });
  it("放行：已合入通报（过去式剔除）", () => {
    expect(checkYieldGate(["PR #1954 已合入 main，收尾完毕"], undefined, cardFenceValues)).toBeNull();
  });
  it("放行：无 PR 引用", () => {
    expect(checkYieldGate(["任务完成，可以合入了"], "等你拍板", cardFenceValues)).toBeNull();
  });
  it("fail-open：speakBodies 缺失时视为空（宁漏勿误）", () => {
    // 缺字段时不应抛异常——装配不完整的旧路径闸失效而非阻断
    expect(() => checkYieldGate([], undefined, cardFenceValues)).not.toThrow();
  });
});
