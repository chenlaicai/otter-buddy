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
  hasDeferredCardReference,
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

describe("对抗检视回归：否定与无待办表述不误拦", () => {
  it("「无需/不是/无 + 请求词」组合剔除：speak 与 yield 双闸均放行", () => {
    expect(hasDecisionRequestNarrow("PR #1964 无需等你拍板，我继续收尾。")).toBe(false);
    expect(hasDecisionRequestNarrow("PR #1964 不是待拍板，只是同步进展。")).toBe(false);
    expect(hasDecisionRequestNarrow("PR #1964 已合入，无待拍板事项。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 无需等你拍板，我继续收尾。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 不是待拍板，只是同步进展。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 已合入，无待拍板事项。")).toBe(false);
  });
  it("宽表否定边界记录：单字「不」删除后「不可以合入」类仍命中（收窄决策——yield 语境下出阻塞说明卡也是合理呈递；speak 辅闸不拦）", () => {
    // 架构收窄终态：单字否定与语气断言不可收敛（三轮实证），删单字「不」后
    // 「要不/何不/不得不 X」全部自然正确，代价是「不可以合入」类单字否定形态
    // 在宽表命中——按宁漏勿误反向边界接受（yield to user 语境下被要求补一张
    // 阻塞说明卡不是伤害；窄表不含评价措辞故 speak 不拦）。
    expect(hasDecisionRequestWide("PR #1964 不可以合入，仍有阻塞项。")).toBe(true);
    expect(hasDecisionRequestNarrow("PR #1964 不可以合入，仍有阻塞项。")).toBe(false);
    expect(hasDecisionRequestWide("不建议合并")).toBe(false);
  });
  it("双字否定 + 副词窗：无需再/没必要再等副词间隙形态不再误拦", () => {
    expect(hasDecisionRequestWide("PR #1964 无需再等你拍板，我继续收尾。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 没必要再请你拍板，我继续收尾。")).toBe(false);
    expect(hasDecisionRequestNarrow("PR #1964 若不需要等你拍板，我继续收尾。")).toBe(false);
    expect(hasDecisionRequestNarrow("PR #1964 或不用等你拍板，我继续收尾。")).toBe(false);
  });
  it("建议/双重否定语气自然正确：何不/不得不/不能不 X 命中请求词（单字「不」删除后无需断言特例）", () => {
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，何不请你拍板。")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，不得不请你拍板。")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，不能不请你授权。")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，要不请你拍板。")).toBe(true);
  });
  it("否定不误伤肯定语义：否定词与请求词隔实义字时请求保留", () => {
    expect(hasDecisionRequestWide("这条不阻塞，#1964 可以合入")).toBe(true);
    expect(hasDecisionRequestWide("A 已合入，B 可以合入")).toBe(true);
  });
});

describe("对抗检视回归：词表直接变体", () => {
  it("请你拍板/请你授权/可以合并了均命中宽表", () => {
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，请你拍板。")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，请你授权合入。")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，可以合并了。")).toBe(true);
  });
  it("请你拍板/请你授权命中窄表；评价措辞仍不在窄表", () => {
    expect(hasDecisionRequestNarrow("PR #1964 请你拍板")).toBe(true);
    expect(hasDecisionRequestNarrow("PR #1964 请你授权")).toBe(true);
    expect(hasDecisionRequestNarrow("检视 #1959 通过，可以合并")).toBe(false);
  });
});

describe("对抗检视回归：稳定清理区（语法无嵌套歧义的展示区）不算决策卡", () => {
  it("HTML 注释 / code / pre / textarea 展示的 submit 不算", () => {
    const htmlComment = ["```html-card", "<!-- otterCard.submit({}) -->", "<div>详情</div>", "```"].join("\n");
    const codeBlock = ["#1964 可以合入了", "```html-card", "<div>写法：<code>otterCard.submit({})</code></div>", "```"].join("\n");
    expect(decisionCardPresent([htmlComment], cardFenceValues)).toBe(false);
    expect(decisionCardPresent([codeBlock], cardFenceValues)).toBe(false);
  });
  it("真实可执行调用命中（onclick 事件属性）", () => {
    const real = ["```html-card", "<button onclick=\"otterCard.submit({ summary: '1964合入' })\">合入</button>", "```"].join("\n");
    expect(decisionCardPresent([real], cardFenceValues)).toBe(true);
  });
});

describe("对抗检视回归：指代自足缺位（issue 补充现场样本）", () => {
  it("「卡片在上一条」+ PR 引用 + 无卡 → 辅闸拦", () => {
    expect(hasDeferredCardReference("#1941 现在真的可以合了（卡片在上一条，这里补最终状态）")).toBe(true);
    const err = checkSpeakGate("#1941 现在真的可以合了（卡片在上一条，这里补最终状态）", hasCardFences);
    expect(err).toContain("不复述载体");
  });
  it("指代语但本条有卡 → 放行（载体已复述）", () => {
    const body = ["#1941 可以合了（卡片在上一条）", "```html-card title=\"x\"", "<div>y</div>", "```"].join("\n");
    expect(checkSpeakGate(body, hasCardFences)).toBeNull();
  });
  it("无 PR 引用的日常指代（「见上面的分析」）→ 放行", () => {
    expect(checkSpeakGate("结论见上面，我们继续", hasCardFences)).toBeNull();
  });
});

describe("对抗检视回归：fail-open 口径（仅 speak 累计维度）", () => {
  it("speakBodies 缺失但 reason 带呈递形态 → reason 面仍拦（不 fail-open）", () => {
    expect(checkYieldGate([], "PR #1960 待拍板", cardFenceValues)).not.toBeNull();
    expect(checkYieldGate([], "收尾汇报，无拍板项", cardFenceValues)).toBeNull();
  });
});

describe("二轮检视回归：空壳卡边界终态（架构收窄记录）", () => {
  const fake = (inner: string) => [
    "#1964 可以合入了",
    "```html-card title=\"PR 1964\"",
    inner,
    "```",
  ].join("\n");

  it("稳定清理区：textarea 展示不算", () => {
    expect(decisionCardPresent([fake("<textarea>otterCard.submit({})</textarea>")], cardFenceValues)).toBe(false);
  });
  it("边界记录：JS 内嵌伪调用（缩进注释/字符串/data-* 属性/text-plain script）在弱信号下放行——机械不可证明，记已知边界", () => {
    // 收窄决策（三轮实证）：script 内注释/字符串语义判定不可收敛，弱信号只保
    // 「卡片整体缺位」拦截主目标；空壳卡由模板纪律+检视兜底（见特性文档边界节）。
    expect(decisionCardPresent([fake("  // otterCard.submit({ summary: '1964合入' })")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([fake("<script>const example = \"otterCard.submit({})\";</script>")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([fake("<button data-example=\"otterCard.submit({})\">合入</button>")], cardFenceValues)).toBe(true);
  });
  it("真实调用命中：script 直接调用与赋值回调", () => {
    expect(decisionCardPresent([fake("<script>const x = 'btn'; x.onclick = () => otterCard.submit({ summary: '1964合入' });</script>")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([fake("<button onclick=\"otterCard.submit({ summary: '1964合入' })\">合入</button>")], cardFenceValues)).toBe(true);
  });
});

describe("二轮检视回归：否定前缀扩充与语气词组保护", () => {
  it("不用/不需要/没必要/无须/不再 均不再误拦", () => {
    for (const s of [
      "PR #1964 不用等你拍板，我继续收尾。",
      "PR #1964 不需要等你拍板，我继续收尾。",
      "PR #1964 没必要请你拍板，我继续收尾。",
      "PR #1964 无须等你拍板，我继续收尾。",
      "PR #1964 不再等你拍板，我继续收尾。",
    ]) {
      expect(hasDecisionRequestNarrow(s), s).toBe(false);
      expect(hasDecisionRequestWide(s), s).toBe(false);
    }
  });
  it("不要批准合入/不要拍板吧 不再误拦", () => {
    expect(hasDecisionRequestWide("PR #1964 不要批准合入。")).toBe(false);
    expect(hasDecisionRequestNarrow("PR #1964 不要拍板吧。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 不要拍板吧。")).toBe(false);
  });
  it("「要不请你拍板/要不请你授权」建议语气：主闸命中（辅闸被单字「不」误剔漏拦——错误代价结构决定的双表口径：辅闸误拦代价高于漏拦，主闸兜底）", () => {
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，要不请你拍板。")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 CI 全绿，要不请你授权。")).toBe(true);
    // 辅闸层单字「不」剔除使语气词组被误剔——放行（可接受，主闸在 yield 拦住）
    expect(hasDecisionRequestNarrow("PR #1964 CI 全绿，要不请你拍板。")).toBe(false);
  });
  it("「要不要合入/要不要合并」疑问请求仍命中（「不要X」前缀不误剔词组）", () => {
    expect(hasDecisionRequestWide("PR #1964 要不要合入？")).toBe(true);
    expect(hasDecisionRequestWide("PR #1964 要不要合并？")).toBe(true);
  });
});

describe("二轮检视回归：指代判据引号豁免", () => {
  it("引用反模式字面量的修复通报/测试说明放行", () => {
    expect(hasDeferredCardReference("PR #1964 已修复『卡片在上一条』的漏报，回归测试通过。")).toBe(false);
    expect(hasDeferredCardReference("PR #1964 的测试确保「卡片在上一条」会触发拦截。")).toBe(false);
    expect(checkSpeakGate("PR #1964 已修复『卡片在上一条』的漏报，回归测试通过。", hasCardFences)).toBeNull();
  });
  it("真实指代（无引号）仍拦；「卡片见前文」同义形态覆盖", () => {
    expect(hasDeferredCardReference("#1941 现在真的可以合了（卡片在上一条，这里补最终状态）")).toBe(true);
    expect(hasDeferredCardReference("#1941 状态卡片见前文")).toBe(true);
  });
});

describe("二轮检视回归：指代判据决策语境门槛", () => {
  it("无引号纯讨论（修复通报无请求词）放行", () => {
    expect(checkSpeakGate("PR #1964 已修复卡片在上一条的漏报，回归测试通过", hasCardFences)).toBeNull();
  });
  it("决策节点指代（宽表措辞共现）仍拦——2725 原始形态", () => {
    const err = checkSpeakGate("#1941 现在真的可以合了（卡片在上一条，这里补最终状态）", hasCardFences);
    expect(err).not.toBeNull();
  });
});

describe("三轮检视回归：弱信号判定的边界记录与真实写法正确性", () => {
  const card = (inner: string) => [
    "#1964 可以合入了",
    "```html-card title=\"PR 1964\"",
    inner,
    "```",
  ].join("\n");

  it("真实写法全部命中（弱信号不误拒——submit 与括号间空白/字符串标记截断形态）", () => {
    expect(decisionCardPresent([card("<script>otterCard.submit ({ summary: '1964合入' })</script>")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([card("<button onclick=\"const label='x'; otterCard.submit({})\">")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([card("<script>const a = '/*'; otterCard.submit({}); const b = '*/';</script>")], cardFenceValues)).toBe(true);
  });
  it("边界记录：JS 内嵌伪调用（注释/字符串内的 submit）在弱信号下放行——机械不可证明，模板纪律与检视兜底", () => {
    // 架构收窄终态（同族先例：通用语义建模不可收敛则收窄为可证明模板）：
    // script 内注释/字符串中的伪 otterCard.submit 字样无法用正则可靠区分（三轮
    // 实证：缩进注释/转义引号/非 JS script/伪事件属性每轮修完又冒新语法上下文
    // 反例，真实写法反被误拒）。空壳卡风险按已知边界接受，由 get_html_card_contract
    // 模板纪律 + 独立检视兜底；运行时真相由卡片回执事后可证。
    expect(decisionCardPresent([card("<script>// otterCard.submit({})</script>")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([card("<script>const s = \"otterCard.submit({})\";</script>")], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([card("<script type=\"text/plain\">otterCard.submit({})</script>")], cardFenceValues)).toBe(true);
  });
  it("稳定清理区仍有效：HTML 注释/code/pre/textarea 展示不算", () => {
    expect(decisionCardPresent([card("<!-- otterCard.submit({}) --><div>x</div>")], cardFenceValues)).toBe(false);
    expect(decisionCardPresent([card("<code>otterCard.submit({})</code>")], cardFenceValues)).toBe(false);
    expect(decisionCardPresent([card("<textarea>otterCard.submit({})</textarea>")], cardFenceValues)).toBe(false);
  });
});

describe("三轮检视回归：指代豁免引号形态补全", () => {
  it("反引号/弯单引号/ASCII 单引号包裹的反模式字面量放行", () => {
    expect(hasDeferredCardReference("PR #1964 可以合了；回归用例 `卡片在上一条` 已固化。")).toBe(false);
    expect(hasDeferredCardReference("PR #1964 可以合了；回归用例 ‘卡片在上一条’ 已固化。")).toBe(false);
    expect(hasDeferredCardReference("PR #1964 可以合了；回归用例 '卡片在上一条' 已固化。")).toBe(false);
    expect(checkSpeakGate("PR #1964 可以合了；回归用例 `卡片在上一条` 已固化。", hasCardFences)).toBeNull();
  });
});

describe("四轮检视回归：单字否定的双表分层（辅闸恢复剔除，主闸维持无）", () => {
  it("辅闸窄表：我不等/暂不等/不请 X 不再误拦（单字「不」恢复剔除——误拦代价高于漏拦）", () => {
    for (const s of [
      "PR #1964 我不等你拍板，先继续收尾。",
      "PR #1964 暂不等你拍板，先继续收尾。",
      "PR #1964 不请你拍板。",
    ]) {
      expect(hasDecisionRequestNarrow(s), s).toBe(false);
    }
  });
  it("主闸宽表：单字「不批准」仍是已声明边界（yield 补阻塞说明卡）；「不予/不建议」双字及以上否定双表正确剔除", () => {
    // 主闸无单字「不」——这些负向结论在宽表命中，to user 语境被要求出卡：
    // 出一张「为什么不能合」的阻塞说明卡是合理呈递形态（非伤害性误拦），
    // 显式记录为收窄代价（不静默回归——首轮 R2 的完整否定样本已双表过闸）。
    expect(hasDecisionRequestWide("PR #1964 不批准合入，仍有阻塞项。")).toBe(true);
    // 「不予」「不建议」双字/三字无语气歧义，入基础否定表——主闸也正确剔除
    expect(hasDecisionRequestWide("PR #1964 不予批准合入，仍有阻塞项。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 不建议批准合入，仍有阻塞项。")).toBe(false);
    expect(hasDecisionRequestNarrow("PR #1964 不批准合入，仍有阻塞项。")).toBe(false);
  });
  it("「暂不等你拍板」双字「暂不」入基础否定表（双表都剔）", () => {
    expect(hasDecisionRequestWide("PR #1964 暂不等你拍板。")).toBe(false);
  });
});

describe("四轮检视回归：纯文本 submit 字样放行（弱信号最简边界）", () => {
  it("纯 div/button 文本里的 submit 字样放行——最简空壳形态，显式钉住", () => {
    const div = ["#1964 可以合入了", "```html-card", "<div>otterCard.submit</div>", "```"].join("\n");
    const btn = ["#1964 可以合入了", "```html-card", "<button>otterCard.submit</button>", "```"].join("\n");
    expect(decisionCardPresent([div], cardFenceValues)).toBe(true);
    expect(decisionCardPresent([btn], cardFenceValues)).toBe(true);
  });
});

describe("五轮检视回归：指代门槛与辅闸否定表统一（不暗换）", () => {
  it("否定句 + 指代组合：窄表正确剔除后不被指代分支的宽表拦回", () => {
    for (const s of [
      "PR #1964 我不等你拍板；卡片在上一条，先继续收尾。",
      "PR #1964 不请你拍板；卡片见上文。",
      "PR #1964 不批准合入；卡片在上一条。",
      "PR #1964 不建议批准合入；卡片在上一条。",
    ]) {
      expect(checkSpeakGate(s, hasCardFences), s).toBeNull();
    }
  });
  it("2725 事故形态保持拦截：评价措辞 + 无引号指代 + 无卡", () => {
    const err = checkSpeakGate("#1941 现在真的可以合了（卡片在上一条，这里补最终状态）", hasCardFences);
    expect(err).not.toBeNull();
    expect(err).toContain("不复述载体");
  });
});

describe("五轮检视回归：情态否定词补表", () => {
  it("不建议/不能/不许 X 不再误拦辅闸", () => {
    for (const s of [
      "PR #1964 不建议等你拍板，我继续收尾。",
      "PR #1964 我不能等你拍板，我继续收尾。",
      "PR #1964 不许等你拍板。",
    ]) {
      expect(hasDecisionRequestNarrow(s), s).toBe(false);
    }
  });
  it("「不能不请你授权」双重否定在辅闸漏拦（宁多剔）、主闸拦住", () => {
    expect(hasDecisionRequestNarrow("PR #1964 不能不请你授权。")).toBe(false);
    expect(hasDecisionRequestWide("PR #1964 不能不请你授权。")).toBe(true);
  });
});
