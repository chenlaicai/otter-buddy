/**
 * F20260903srfs / issue #726：skill references/ 引用可见性。
 *
 * 伤疤：SKILL.md 参考索引里列出的 references/ 文件（"详见 xxx" 只出现在索引节），
 * agent 执行 skill 时不会主动 read——writing-skills/references/skill-types.md 与
 * description-examples.md 在全量 session 扫描中零读取（其他索引-only 文件读取 ≤3 次），
 * 而工作流步骤内联绑定的文件被高频读取（20-190 次）。
 *
 * 修复：在对应工作流步骤中内联绑定（"选 category …… 见 references/skill-types.md"），
 * lint-skills.mjs 校验 9 机械拦截索引-only 引用。
 *
 * 行为不变量：agent 执行 writing-skills 工作流（选 category / 写 description）时，
 * 应 read 步骤内联引用的 references 文件（skill-types.md / description-examples.md），
 * 而不是仅凭 SKILL.md 表格内容直接作答。
 */
import type { GoldenModule } from "./golden.runner";
import type { MessageDto } from "../helpers/assert-behavior";
import { latestUserSeq } from "../helpers/assert-behavior";

/** 交换级收集全部工具调用参数文本（跨消息聚合，含重试跳） */
function toolCallArgsForExchange(messages: MessageDto[], afterSeq: number): string {
  const parts: string[] = [];
  for (const m of messages
    .filter((x) => x.st === "otter" && x.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)) {
    for (const ev of m.events ?? []) {
      if (ev.eventType !== "assistant_toolcall") continue;
      for (const item of ev.payload?.content ?? []) {
        if (item.type === "toolCall") parts.push(JSON.stringify(item.arguments ?? {}));
      }
    }
  }
  return parts.join("\n");
}

/** 判据：读取了步骤内联绑定的 references 文件（skill-types 或 description-examples） */
function readBoundReferences(messages: MessageDto[]): { ok: boolean; detail: string } {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const argsText = toolCallArgsForExchange(messages, userSeq);
  const readSkillMd = /writing-skills\/SKILL\.md/.test(argsText);
  const readSkillTypes = /writing-skills\/references\/skill-types\.md/.test(argsText);
  const readDescExamples = /writing-skills\/references\/description-examples\.md/.test(argsText);
  return {
    ok: readSkillTypes || readDescExamples,
    detail: `readSkillMd=${readSkillMd} skillTypes=${readSkillTypes} descExamples=${readDescExamples}`,
  };
}

export const golden: GoldenModule["golden"] = {
  id: "skill-references-visibility",
  source: { type: "scar", ref: "issue #726：references/ 索引-only 引用零读取（全量 session 扫描实证）" },
  originTest: "新增（agent-behavior.capability.test.ts 的 skill 触发用例是近邻覆盖）",
  input:
    "帮我为一个新的 skill「stock-alert」（用途：监 A 股自选股价格，触发条件时提醒）做前两步：选 category、写 description。按你的 skill 编写流程走，先不要创建任何文件，把选择和理由告诉我。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "glm-flash",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  return readBoundReferences(messages);
};

/**
 * F20260828gssf: selftest 参考序列。
 *
 * good = 修复后行为轨迹：读 SKILL.md 后继续读步骤内联绑定的 references 文件
 * bad  = 伤疤复现轨迹（多条）：
 *   - bad[0]: 只读 SKILL.md，references 零读取（索引-only 时代的行为）
 *   - bad[1]: 一个文件都不读，直接凭系统提示里的 description 作答（幻觉执行）
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "s726-u1", st: "user", si: "selftest-user", content: "选 category 并写 description", status: "completed", seq: 1 },
      {
        id: "s726-o1", st: "otter", si: "selftest-otter", content: "category 选 technique，description 如下……", status: "completed", seq: 2,
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/sandbox/.pi/skills/writing-skills/SKILL.md" } }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/sandbox/.pi/skills/writing-skills/references/skill-types.md" } }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      messages: [
        { id: "s726-u2", st: "user", si: "selftest-user", content: "选 category 并写 description", status: "completed", seq: 1 },
        {
          id: "s726-o2", st: "otter", si: "selftest-otter", content: "category 选 technique……", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/sandbox/.pi/skills/writing-skills/SKILL.md" } }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      messages: [
        { id: "s726-u3", st: "user", si: "selftest-user", content: "选 category 并写 description", status: "completed", seq: 1 },
        {
          id: "s726-o3", st: "otter", si: "selftest-otter", content: "category 应该选 technique，description 可以这样写……", status: "completed", seq: 2,
          events: [],
        },
      ],
      expectedOk: false,
    },
  ],
};
