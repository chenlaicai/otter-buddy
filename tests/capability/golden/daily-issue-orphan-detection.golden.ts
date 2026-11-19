/**
 * 每日 issue 处理·孤儿检出行为回归（Golden Gate B 裁决产物，PR #1966）。
 *
 * 来源伤疤：issue #1963 + 搭档 2026-11-19 原话「忽略在途的pr，关注挂了好几天的……
 * 把孤儿事件拉出来」——此前每日清单把在途 PR 项照列（制造重复开工面）、挂多天停滞单
 * 无人曝光。prompts/scheduled/每日-issue-处理.md 新增「孤儿检出」置顶段 + 在途忽略规则。
 *
 * 行为不变量（清单组版规则）：
 *  1. 清单正文前置顶「孤儿检出」段，挂龄达标且无在途 PR 的停滞单（#1801/#1802）入段
 *  2. 有 open PR 引用的在途单（#1803/#1804）不进清单正文，至多尾部一行「在途 N 条（忽略）」
 *  3. 评论含搭档「别管/勿动/勿捞取」的拍板搁置单（#1805）不进清单不进孤儿段，只计数
 *  4. 「等搭档输入」类（#1806）不算孤儿，照列清单标「等输入」
 *  5. 今日新建单（#1807）正常入清单；孤儿段位置先于普通清单项
 *
 * 场景构造（restricted 路径）：systemPrompt = 真实任务 prompt 全文
 * （git 真相源直读），input = 调度器代采集的扫描数据内联。otterType 用
 * night-reviewer 档案（工具面 speak/yield + 三迁移、零编码工具——本场景不调
 * 迁移工具，借其「无 gh/bash」面防试探空调用烧采样轮；externalProfile 受限档
 * 实测在 golden runner 直调 invokeConversation 路径不产出消息终态，已回填弃用）。
 * 真实流程中獭自行跑 gh 取数，演练环境无后端，数据内联注入（与 scheduler
 * {{REGRESSION_DATA}} 占位符同构）。测的是清单组版规则遵循，不是 gh 取数能力。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MessageDto } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

/** 读真实任务 prompt（git 真相源），剥 frontmatter——与 scheduler loadTemplate 同构 */
function loadDailyIssuePrompt(): string {
  const p = path.join(process.cwd(), "prompts/scheduled", "每日-issue-处理.md");
  const content = fs.readFileSync(p, "utf8");
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  return fm ? content.slice(fm[0].length) : content;
}

/** 演练输入：扫描数据内联（日期锚定 2026-11-19——场景定格日，挂龄已预计算注入） */
const FIXTURE_INPUT = `【每日 issue 处理 · 演练输入】今日 = 2026-11-19。以下输入域扫描数据已由调度器代为采集并内联（本环境无 gh/bash 工具，禁止尝试调用任何工具取数——直接基于下方数据产出今日勾选清单全文）：

## 扫描数据（open issue 全量元数据）
1. #1801「[scheduler] 定时任务重复触发」open · 创建于 11-10（挂龄 9 天）· otter-claim 认领于 11-12，此后无后续 PR、无评论更新，对应对话近 48h 无活动
2. #1802「[memory] 检索偶发空结果」open · 创建于 11-08（挂龄 11 天）· 无认领无 PR · 非等输入类 · 最后活动 11-08（无评论以创建时间计），无对应对话
3. #1803「[ui] 卡片闪烁」open · 有 open PR #1955 引用，在途收尾中
4. #1804「[db] 迁移脚本幂等」open · 有 open PR #1958 引用，在途推进中
5. #1805「[eval] 评测机制去留」open · 挂龄 12 天无活动 · 评论含搭档原话「这个别管」
6. #1806「[memory] 排序口径确认」open · 挂龄 6 天 · 等搭档输入（最后评论为向搭档的提问，等的是搭档）
7. #1807「[healing] 今日新增：guard 拦截异常率升高」open · 今日新建 daily-review · 无 PR

请按任务要求产出今日勾选清单。`;

export const golden: GoldenModule["golden"] = {
  id: "daily-issue-orphan-detection",
  source: { type: "scar", ref: "issue #1963 + 搭档 2026-11-19 原话指令（孤儿检出）；PR #1966 Golden Gate B 裁决" },
  originTest: "prompts/scheduled/每日-issue-处理.md#孤儿检出段+在途忽略规则",
  input: FIXTURE_INPUT,
  sampling: { n: 10, minSuccess: 8 }, // B 裁决层：行为改动 PR 走 n=10 ≥8（README 采样协议分层）
  modelTag: "k3.1-pro", // 校准模型：mimo 套餐与 glm 均 429 配额耗尽（实测），kimi 端点顶班
  manualReview: false,
  settleMs: 120_000, // 单跳受限獭（speak/yield），无需长 settle 窗口
  timeoutMs: 4_500_000, // 预算算术：10×(300s+120s)=4200s ≤ 4500s−120s ✓
  restricted: {
    // 借 night-reviewer 档案拿「零编码工具」面（speak/yield + 三迁移在场但本场景不调）——
    // externalProfile:'restricted' 路径在 runner 直调 invoke 下实测不产消息终态（10/10 超时）弃用
    otterType: "night-reviewer",
    systemPrompt: loadDailyIssuePrompt(),
  },
};

/** 取最后一条 completed 獭消息（speak 产出的清单全文） */
function lastOtterContent(messages: MessageDto[]): string {
  const completed = messages.filter((m) => m.st === "otter" && m.status === "completed");
  return completed.length > 0 ? completed[completed.length - 1].content : "";
}

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const content = lastOtterContent(messages);
  // 「在途 N 条（忽略）」「拍板搁置 N 条」计数行合法含编号——剥离后再判正文缺席
  const body = content
    .split("\n")
    .filter((l) => !/在途.*忽略/.test(l) && !/拍板搁置/.test(l))
    .join("\n");

  const hasOrphanSection = /孤儿检出/.test(content);
  const orphan1 = body.includes("#1801");
  const orphan2 = body.includes("#1802");
  const orphanIdx = content.indexOf("孤儿");
  const firstChecklistIdx = Math.min(
    ...[content.indexOf("#1806"), content.indexOf("#1807")].filter((i) => i >= 0),
  );
  const orphanFirst = orphanIdx !== -1 && Number.isFinite(firstChecklistIdx) && orphanIdx < firstChecklistIdx;
  const noInflight = !body.includes("#1803") && !body.includes("#1804");
  const hasInflightTail = /在途\s*\d+\s*条（忽略）|在途[^\n]*忽略/.test(content);
  const noShelved = !body.includes("#1805");
  const hasShelvedCount = /拍板搁置/.test(content);
  const hasWaiting = body.includes("#1806") && /等输入/.test(content);
  const hasFresh = body.includes("#1807");

  const ok =
    hasOrphanSection && orphan1 && orphan2 && orphanFirst &&
    noInflight && hasInflightTail && noShelved && hasShelvedCount &&
    hasWaiting && hasFresh;

  return {
    ok,
    detail: `orphanSection=${hasOrphanSection} o1=${orphan1} o2=${orphan2} orphanFirst=${orphanFirst} noInflight=${noInflight} inflightTail=${hasInflightTail} noShelved=${noShelved} shelvedCount=${hasShelvedCount} waiting=${hasWaiting} fresh=${hasFresh} len=${content.length}`,
  };
};

/** selftest 参考序列：good = 合规清单；bad = 两种退化形态 */
function msg(id: string, seq: number, content: string, st = "otter"): MessageDto {
  return { id, st, si: `selftest-${st}`, content, status: "completed", seq };
}

const GOOD_CHECKLIST = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
- #1801 [scheduler] 定时任务重复触发 | 挂龄 9 天 | 已认领（11-12） | 最后活动 11-12 | 认领后停滞超 48h——动作：走 1b 回收，建议搭档拍去留
- #1802 [memory] 检索偶发空结果 | 挂龄 11 天 | 无认领 | 最后活动 11-08 | 建议搭档拍去留

## 今日勾选清单
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工 | 回复编号即开工
- #1806 [memory] 排序口径确认 | 等输入 | 等搭档回复排序口径

在途 2 条（忽略）
拍板搁置 1 条

issue 大盘：open 7 | bug:3 enhancement:2 tech-debt:1 question:1 | P0:0 P1:2 P2:5 | 无标签:0`;

const BAD_NO_ORPHAN_SECTION = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 今日勾选清单
- #1801 [scheduler] 定时任务重复触发 | actionable | 建议今日开工 | 回复编号即开工
- #1802 [memory] 检索偶发空结果 | actionable | 建议今日开工
- #1803 [ui] 卡片闪烁 | actionable | 建议今日开工
- #1804 [db] 迁移脚本幂等 | actionable | 建议排期
- #1806 [memory] 排序口径确认 | unclear | 请搭档判断
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工`;

const BAD_INFLIGHT_IN_BODY = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
- #1801 [scheduler] 定时任务重复触发 | 挂龄 9 天 | 已认领 | 停滞——建议拍去留
- #1802 [memory] 检索偶发空结果 | 挂龄 11 天 | 无认领——建议拍去留

## 今日勾选清单
- #1803 [ui] 卡片闪烁 | actionable | 建议今日开工（在途 PR #1955 可并行）
- #1804 [db] 迁移脚本幂等 | actionable | 建议今日开工
- #1806 [memory] 排序口径确认 | 等输入 | 等搭档回复
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工

拍板搁置 1 条`;

export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      msg("st-u1", 1, FIXTURE_INPUT, "user"),
      msg("st-o1", 2, GOOD_CHECKLIST),
    ],
    expectedOk: true,
  },
  bad: [
    {
      // 退化形态 1：旧行为——无孤儿检出段、在途单照列清单（搭档 11-19 点名前形态）
      messages: [
        msg("st-u2", 1, FIXTURE_INPUT, "user"),
        msg("st-o2", 2, BAD_NO_ORPHAN_SECTION),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 2：半采纳——孤儿段有了但在途单仍进清单正文（在途忽略规则失守）
      messages: [
        msg("st-u3", 1, FIXTURE_INPUT, "user"),
        msg("st-o3", 2, BAD_INFLIGHT_IN_BODY),
      ],
      expectedOk: false,
    },
  ],
};
