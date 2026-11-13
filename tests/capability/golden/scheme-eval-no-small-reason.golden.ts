/**
 * #1863 伤疤：方案评估复发以「改动小」替代正确性论证。
 *
 * 伤疤来源：2026-11-11 entry fd084bee 换世机械归档排查中把方案 A（fallback glm 重试）
 * 推荐理由首句写成「改动小、立刻止血」，同时把实测可用的根因方向（off→low）标不推荐；
 * 12:34（UTC）搭档纠偏「我咋又看到『改动小』这个评估标准了」。#1749 复盘修复后复发，
 * 记忆 728bcc44 记录 11-10/11-11 连续两日均出现同一标准。
 *
 * 行为不变量：面对「兜底补丁 vs 根因修复」的对抗选项，不得因补丁「改动小」而推荐补丁；
 * 必须说明根因与代价，推荐位落到根因方向。
 *
 * 本场景是 smoke-gate 代理：语义级「因小推荐 A」无法靠测试代码完全看护（README 明示），
 * 判据收敛为三个可机械检测的信号——推荐根因方向 + 说明代价/风险 + 未把补丁放推荐位。
 */
import { latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "scheme-eval-no-small-reason",
  source: { type: "scar", ref: "#1863：2026-11-11 fd084bee 以「改动小、立刻止血」荐兜底（#1749 修复后复发）" },
  originTest: "n/a（#1863 首个可重放锚点）",
  input:
    "现网故障排查结论：协议层把 off 参数翻成了下游拒收的 effort=none，触发重试风暴。" +
    "候选方案：A＝请求失败时 fallback 兜底重试（不修根因）；B＝修协议层 off→low 映射（根因闭环）。" +
    "请你评估并推荐一个方案，说明理由。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const replies = messages
    .filter((m) => m.st === "otter" && m.status === "completed" && m.seq > userSeq)
    .map((m) => m.content ?? "")
    .join("\n");

  // 信号 1（正）：推荐动词后 60 字内出现根因方向标记（方案 B / 修协议 / off→low / 治本 / 根因修复）
  const recommendsRootCause =
    /(?:推荐|建议|采用|选择|选|优先|应该)[^。\n]{0,60}(?:方案\s*B|B\s*方案|off\s*→\s*low|修协议|协议层|治本|根因修复|修根)/.test(replies);

  // 信号 2（正）：说明用户代价 / 长期维护 / 风险 / 过渡性质
  const explainsCostOrRisk = /代价|成本|维护|风险|波及|下游|过渡|临时|长期|写放大/.test(replies);

  // 信号 3（负）：去掉否定式后，仍出现「推荐/建议 + A/兜底/fallback」= 把补丁放推荐位。
  // 伤疤自身明示「A 只可作临时止血，不当方案」——把 A 作为临时/过渡提一下是合规的；
  // 先抹掉「推荐/建议 + 临时/过渡 + A/兜底/fallback」这类过渡性提及，避免误拦「推荐 B + 建议临时 fallback 过渡」。
  const normalized = replies.replace(/不推荐|不建议|不采用|不宜采用|不该|排除|否掉|不选/g, "　");
  const stripTransitionalPatch = (s: string) =>
    s.replace(
      /(?:推荐|建议|采用|选择|选|优先)[^。\n]{0,12}(?:临时|过渡)[^。\n]{0,12}(?:方案\s*A|A\s*方案|兜底|fallback)/g,
      "　",
    );
  const recommendsPatch =
    /(?:推荐|建议|采用|选择|选|优先)[^。\n]{0,20}(?:方案\s*A|A\s*方案|兜底|fallback)/.test(
      stripTransitionalPatch(normalized),
    );

  const ok = recommendsRootCause && explainsCostOrRisk && !recommendsPatch;

  return {
    ok,
    detail: `recommendsRootCause=${recommendsRootCause} explainsCostOrRisk=${explainsCostOrRisk} recommendsPatch=${recommendsPatch}`,
  };
};

export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "A 兜底 vs B 修协议，推荐一个", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", status: "completed", seq: 2,
        content:
          "推荐 B（修协议层 off→low 映射）：off 被翻成 effort=none 是重试风暴的根因，" +
          "建议临时 fallback 过渡止血，恢复稳定后即下线；A 的兜底不消除根因，不当正式方案。",
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "A 兜底 vs B 修协议，推荐一个", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", status: "completed", seq: 2,
          content: "推荐 A（fallback 兜底重试）：改动小、立刻止血，先稳住服务，根因后面再查。",
        },
      ],
      expectedOk: false,
    },
    {
      messages: [
        { id: "st-u3", st: "user", si: "selftest-user", content: "A 兜底 vs B 修协议，推荐一个", status: "completed", seq: 1 },
        {
          id: "st-o3", st: "otter", si: "selftest-otter", status: "completed", seq: 2,
          content: "建议上 A 兜底，改动最小、恢复最快。",
        },
      ],
      expectedOk: false,
    },
    {
      messages: [
        { id: "st-u4", st: "user", si: "selftest-user", content: "A 兜底 vs B 修协议，推荐一个", status: "completed", seq: 1 },
        {
          id: "st-o4", st: "otter", si: "selftest-otter", status: "completed", seq: 2,
          content: "推荐 A（兜底重试）：改动小、立刻止血、降低用户代价；B 修协议可作为后续根因修复。",
        },
      ],
      expectedOk: false,
    },
  ],
};
