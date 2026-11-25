/**
 * 每日 issue 处理·孤儿检出行为回归（Golden Gate B 裁决产物）。
 *
 * 来源伤疤：每日任务治理事项 + 搭档 2026-11-19 原话「忽略在途的pr，关注挂了好几天的……
 * 把孤儿事件拉出来」——此前每日清单把在途 PR 项照列（制造重复开工面）、挂多天停滞单
 * 无人曝光。prompts/scheduled/每日-issue-处理.md 新增「孤儿检出」置顶段 + 在途忽略规则。
 *
 * 行为不变量（清单组版规则）：
 *  1. 清单正文前置顶「孤儿检出」段，挂龄达标且无在途 PR 的停滞单入段
 *  2. 有 open PR 引用的在途单不进清单正文，至多尾部一行「在途 N 条（忽略）」
 *  3. 评论含搭档「别管/勿动/勿捞取」的拍板搁置单不进清单不进孤儿段，只计数
 *  4. 「等搭档输入」类不算孤儿，照列清单标「等输入」
 *  5. 今日新建单正常入清单；孤儿段位置先于普通清单项
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

  const hasOrphanSection = /孤儿检出/.test(content);
  // 段解析：孤儿检出段 = 「孤儿」首现到下一个节标题（##/清单段）之间的文本。
  // 终核发现假阳性：只查 includes 会让「孤儿段空、目标孤儿混普通清单」蒙混——
  // 必须判孤儿编号落在段内。注意段外不排除：实测合规输出会把孤儿再列入勾选表
  // （动作行要求搭档勾选授权，段是曝光位、表是授权位，重复非违规）——违例形态
  // 只有「段内缺失」（空段宣告/孤儿只混普通清单）。
  const orphanStart = content.indexOf("孤儿");
  const afterOrphan = orphanStart >= 0 ? content.slice(orphanStart) : "";
  const sectionEndMatch = afterOrphan.match(/\n#{1,3}\s|\n\*\*[^*]*清单|\n今日勾选清单/);
  const orphanSection = sectionEndMatch ? afterOrphan.slice(0, sectionEndMatch.index) : afterOrphan;
  const beforeOrphan = orphanStart >= 0 ? content.slice(0, orphanStart) : content;
  // 段外正文（普通清单所在面）：孤儿段之前 + 段结束之后
  const outsideOrphan = beforeOrphan + (sectionEndMatch ? afterOrphan.slice(sectionEndMatch.index) : "");
  const orphan1 = orphanSection.includes("#1801");
  const orphan2 = orphanSection.includes("#1802");
  const orphanIdx = orphanStart;
  const firstChecklistIdx = Math.min(
    ...[outsideOrphan.indexOf("#1806"), outsideOrphan.indexOf("#1807")].filter((i) => i >= 0),
  );
  const orphanFirst = orphanIdx !== -1 && Number.isFinite(firstChecklistIdx) && orphanIdx < firstChecklistIdx;
  // 在途/搁置判据（终核三轮）：只豁免**独立计数行**（「在途 N 条（忽略）」/「拍板搁置
  // N 条」完整行，可在冒号后列编号），其余一切含在途/搁置编号的行（含借同行关键词
  // 或完整计数短语蒙混的 actionable 条目）一律违例。
  const lines = content.split("\n");
  const normalizeCounterLine = (line: string) =>
    line.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim();
  const hasNonCounterAction = (line: string) => {
    const outsideQuote = line.replace(/「[^」\n]*」/g, "");
    // 否定豁免收窄为精确拒绝谓语（v9→v10 二轮复核）：只剥「否定前缀 + 白名单动词
    // + 名词补语」的完整谓语——补语只允许名词性宾语（清单/正文/孤儿段/编号等），
    // 动作副词（直接/立即/今天）不可入补语，故「不处理本条直接开工」「不重复开工
    // 今天处理」「不进入清单直接推进」「不再搁置直接修复」在剥谓语后残留动作词根
    // 仍拒；而「不进孤儿段及清单正文」「不重复呈报开工」等真实声明全剥后无残留。
    // 不再使用任意字符窗或转折边界启发——窗内保护词/边界字符枚举不完。
    const denyVerbs = "处理|开工|启动|执行|推进|修复|排查|合并|关闭|回收|列入|进入|进|呈报|判|授权|搁置|动|管|勾选|排期";
    const negPrefix = "不|未|勿|莫|非|禁止|避免|不再|不会|无须|无需|未获";
    const objTail = "(?:清单正文|孤儿段|清单|正文|编号|条目|本条|此单|孤儿|它|其)?";
    const negationStripped = outsideQuote.replace(
      new RegExp(`(?:${negPrefix})(?:重复(?:开工|呈报开工|呈报)?|(?:${denyVerbs}))${objTail}`, "g"),
      "",
    );
    const aspectualStripped = negationStripped.replace(
      /(?:开工|处理|执行|启动|合并|关闭|回收|修复)(?:前|时|中)/g,
      "",
    );
    return /actionable|建议|开工|处理|排期|去留|勾选|授权|启动|执行|回复|并行|收尾测试|补.*测试|应当|应该|立即|继续|推进|修复|排查|合并|关闭|回收/.test(aspectualStripped);
  };
  const isInflightCounter = (line: string) => {
    const normalized = normalizeCounterLine(line);
    return /^在途\s*\d+\s*条（忽略[^）\n]*）/.test(normalized) && !hasNonCounterAction(normalized);
  };
  const isShelvedCounter = (line: string) => {
    const normalized = normalizeCounterLine(line);
    // 裸骨架允许句读尾（v11 校准：真实产出「拍板搁置 1 条。」带句号被误拒）
    return /^拍板搁置\s*\d+\s*条(?:$|[。.；;，,：：（])/.test(normalized) && !hasNonCounterAction(normalized);
  };
  const noInflight = !lines.some(
    (l) => (l.includes("#1803") || l.includes("#1804")) && !isInflightCounter(l),
  );
  const hasInflightTail = lines.some(isInflightCounter);
  const noShelved = !lines.some((l) => l.includes("#1805") && !isShelvedCounter(l));
  const hasShelvedCount = lines.some(isShelvedCounter);
  // 等输入单与今日新建单必须在段外普通清单（终核二轮实证：等输入单只错列孤儿段曾蒙混）
  const waitingLine = outsideOrphan.split("\n").find((l) => l.includes("#1806"));
  const hasWaiting = waitingLine !== undefined && /等输入/.test(waitingLine);
  const hasFresh = outsideOrphan.includes("#1807");

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

在途 2 条（忽略）：#1803 → open PR #1955；#1804 → open PR #1958（不重复开工，开工前仍保留认领三问）
拍板搁置 1 条（#1805，搭档原话「这个别管」；不进孤儿段及清单正文，不处理）

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

const BAD_ORPHAN_SECTION_EMPTY = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
孤儿检出：无（open 7 条全部在途/等输入/拍板搁置/未清龄）

## 今日勾选清单
- #1801 [scheduler] 定时任务重复触发 | actionable | 建议今日开工 | 回复编号即开工
- #1802 [memory] 检索偶发空结果 | actionable | 建议今日开工
- #1806 [memory] 排序口径确认 | 等输入 | 等搭档回复
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工

在途 2 条（忽略）
拍板搁置 1 条`;

const BAD_INFLIGHT_WITH_TAIL = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
- #1801 [scheduler] 定时任务重复触发 | 挂龄 9 天 | 已认领 | 停滞——建议拍去留
- #1802 [memory] 检索偶发空结果 | 挂龄 11 天 | 无认领——建议拍去留

## 今日勾选清单
- #1803 [ui] 卡片闪烁 | actionable | 建议今日开工
- #1804 [db] 迁移脚本幂等 | actionable | 建议今日开工
- #1806 [memory] 排序口径确认 | 等输入 | 等搭档回复
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工

在途 2 条（忽略）
拍板搁置 1 条`;

const BAD_NOPIPE_INFLIGHT = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
- #1801 [scheduler] 定时任务重复触发 | 挂龄 9 天 | 已认领 | 停滞——建议拍去留
- #1802 [memory] 检索偶发空结果 | 挂龄 11 天 | 无认领——建议拍去留

## 今日勾选清单
- #1803 [ui] 卡片闪烁——明确闪烁回归，建议今日开工
- #1804 [db] 迁移脚本幂等——小件，建议今日开工
- #1805 [eval] 评测机制去留——挂龄 12 天，建议本周处理
- #1806 [memory] 排序口径确认 | 等输入 | 等搭档回复
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工

在途 2 条（忽略）
拍板搁置 1 条`;

const BAD_WAITING_IN_ORPHAN_SECTION = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
- #1801 [scheduler] 定时任务重复触发 | 挂龄 9 天 | 已认领 | 停滞——建议拍去留
- #1802 [memory] 检索偶发空结果 | 挂龄 11 天 | 无认领——建议拍去留
- #1806 [memory] 排序口径确认 | 挂龄 6 天 | 等输入——误判孤儿，建议拍去留

## 今日勾选清单
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工

在途 2 条（忽略）
拍板搁置 1 条`;

const BAD_KEYWORD_SMUGGLE = `净增熔断：open 7 | 昨日新增 1 / 关闭 0 | 状态：正常

## 孤儿检出（第一职责）
- #1801 [scheduler] 定时任务重复触发 | 挂龄 9 天 | 已认领 | 停滞——建议拍去留
- #1802 [memory] 检索偶发空结果 | 挂龄 11 天 | 无认领——建议拍去留

## 今日勾选清单
- #1803 [ui] 卡片闪烁——actionable，建议今日开工（在途 2 条（忽略））
- #1804 [db] 迁移脚本幂等——actionable，建议今日开工（在途收尾忽略同步）
- #1805 [eval] 评测机制去留——拍板搁置 1 条，但仍建议本周处理，开工前先问搭档
- #1806 [memory] 排序口径确认 | 等输入 | 等搭档回复
- #1807 [healing] guard 拦截异常率升高 | actionable | 建议今日开工

在途 2 条（忽略）
拍板搁置 1 条`;

const BAD_COUNTER_TAIL = GOOD_CHECKLIST
  .replace(
    "在途 2 条（忽略）：#1803 → open PR #1955；#1804 → open PR #1958（不重复开工，开工前仍保留认领三问）",
    "在途 2 条（忽略：#1803 ← PR #1955；#1804 ← PR #1958）：建议顺手补两个的收尾测试",
  )
  .replace(
    "拍板搁置 1 条（#1805，搭档原话「这个别管」；不进孤儿段及清单正文，不处理）",
    "拍板搁置 1 条：#1805——建议本周拍板定去留",
  );

// 退化形态 9（v7 校准）：借否定声明包裹真建议——「不进清单」被剥后「但建议直接开工」
// 残留命中词根，防否定豁免被滥用为洗白通道
const BAD_NEGATED_SMUGGLE = GOOD_CHECKLIST.replace(
  "拍板搁置 1 条（#1805，搭档原话「这个别管」；不进孤儿段及清单正文，不处理）",
  "拍板搁置 1 条：#1805——不进清单正文，但建议直接开工",
);

// 退化形态 10（v9 复核加固）：无逗号转折粘连与否定+建议混排——否定窗口在转折边界
// 停止、窗口含显式建议词时不剥，四形态均不得豁免
const BAD_NEGATED_SMUGGLE_V2 = GOOD_CHECKLIST
  .replace(
    "在途 2 条（忽略）：#1803 → open PR #1955；#1804 → open PR #1958（不重复开工，开工前仍保留认领三问）",
    "在途 2 条（忽略：#1803 ← PR #1955；#1804 ← PR #1958）——不重复开工但建议今天处理",
  )
  .replace(
    "拍板搁置 1 条（#1805，搭档原话「这个别管」；不进孤儿段及清单正文，不处理）",
    "拍板搁置 1 条：#1805——不是不处理而是建议立即处理",
  );

// 退化形态 11（v10 二轮复核）：否定豁免收窄为精确拒绝谓语后，剥谓语后残留动作词
// 仍拒（无逗号混排，不再依赖窗口/转折启发）
const BAD_NEGATED_SMUGGLE_V3 = GOOD_CHECKLIST
  .replace(
    "在途 2 条（忽略）：#1803 → open PR #1955；#1804 → open PR #1958（不重复开工，开工前仍保留认领三问）",
    "在途 2 条（忽略：#1803 ← PR #1955；#1804 ← PR #1958）——不进入清单直接推进",
  )
  .replace(
    "拍板搁置 1 条（#1805，搭档原话「这个别管」；不进孤儿段及清单正文，不处理）",
    "拍板搁置 1 条：#1805——不处理本条直接开工",
  );

const BAD_NEGATED_SMUGGLE_V4 = GOOD_CHECKLIST
  .replace(
    "在途 2 条（忽略）：#1803 → open PR #1955；#1804 → open PR #1958（不重复开工，开工前仍保留认领三问）",
    "在途 2 条（忽略：#1803 ← PR #1955；#1804 ← PR #1958）——不重复开工今天处理",
  )
  .replace(
    "拍板搁置 1 条（#1805，搭档原话「这个别管」；不进孤儿段及清单正文，不处理）",
    "拍板搁置 1 条：#1805——不再搁置直接修复",
  );

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
    {
      // 退化形态 3（终核假阳性实证）：孤儿段空态宣告 + 孤儿混进普通清单——段名在场即骗过 includes 检查
      messages: [
        msg("st-u4", 1, FIXTURE_INPUT, "user"),
        msg("st-o4", 2, BAD_ORPHAN_SECTION_EMPTY),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 4（终核假阳性实证）：在途单列 actionable 且同时有「在途 N 条（忽略）」尾行——
      // 整行剥离计数行的旧实现会把借尾行蒙混的正文项漏检
      messages: [
        msg("st-u5", 1, FIXTURE_INPUT, "user"),
        msg("st-o5", 2, BAD_INFLIGHT_WITH_TAIL),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 5（终核二轮实证）：无「|」的清单条目列在途/搁置单——管道格式判据被绕过
      messages: [
        msg("st-u6", 1, FIXTURE_INPUT, "user"),
        msg("st-o6", 2, BAD_NOPIPE_INFLIGHT),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 6（终核二轮实证）：等输入单被误列孤儿段、普通清单缺席——等输入类判孤儿失守
      messages: [
        msg("st-u7", 1, FIXTURE_INPUT, "user"),
        msg("st-o7", 2, BAD_WAITING_IN_ORPHAN_SECTION),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 7（终核三轮实证）：actionable 条目借同行「在途/忽略」关键词蒙混——
      // 只有独立计数行（「在途 N 条（忽略）」骨架）才豁免
      messages: [
        msg("st-u8", 1, FIXTURE_INPUT, "user"),
        msg("st-o8", 2, BAD_KEYWORD_SMUGGLE),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 8（终核四轮实证）：计数行尾部夹带词表外建议——结构文法不含任意文本尾段
      messages: [
        msg("st-u9", 1, FIXTURE_INPUT, "user"),
        msg("st-o9", 2, BAD_COUNTER_TAIL),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 9（v7 校准）：借否定声明包裹真建议——否定豁免不得成洗白通道
      messages: [
        msg("st-u10", 1, FIXTURE_INPUT, "user"),
        msg("st-o10", 2, BAD_NEGATED_SMUGGLE),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 10（v9 复核）：无逗号转折粘连与否定+建议混排不得豁免
      messages: [
        msg("st-u11", 1, FIXTURE_INPUT, "user"),
        msg("st-o11", 2, BAD_NEGATED_SMUGGLE_V2),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 11（v10 二轮复核）：剥精确谓语后残留动作词仍拒
      messages: [
        msg("st-u12", 1, FIXTURE_INPUT, "user"),
        msg("st-o12", 2, BAD_NEGATED_SMUGGLE_V3),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 12（v10 二轮复核）：另一组混排（不重复开工今天处理/不再搁置直接修复）
      messages: [
        msg("st-u13", 1, FIXTURE_INPUT, "user"),
        msg("st-o13", 2, BAD_NEGATED_SMUGGLE_V4),
      ],
      expectedOk: false,
    },
  ],
};
