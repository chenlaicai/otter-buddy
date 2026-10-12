/**
 * F20261008gdcc：bash 守卫双链一致性测试（guard-mechanism-review 建议 3 落地，P1 治理项）。
 *
 * 背景（#1360 S1 的机制教训）：守卫入口 checkBashCommandSafety 按 modelParseOk 双链路由——
 * parseOk=true 走 V2 模型链（guard-model-judge 段级语义），false 走 V1 文本兜底链
 * （bash-safety-guard 正则语义）。两条链独立演化：#1170 的「管道杀豁免」修复只落 V2、
 * #1360 的 S1 修复只因 V1 正则未同步——「修复-回归循环」（#1207→#1304、#1170→#1360）
 * 的结构性根因就是双链语义割裂在生产现场才暴露。
 *
 * 本测试把割裂暴露点从生产前移到 CI：对同一命令**强制 parseOk=true/false 双跑**
 * （vi.mock 切换 modelParseOk），断言最终判定（放行/拦截）一致。判定一致≠语义相同
 * （V1/V2 内部语义允许不同），但**用户可见结论**不允许随解析器成败翻转——
 * S1 类割裂（V1 误拦而 V2 放行）在此红灯。
 *
 * 期望值口径：以**主链（V2, parseOk=true）语义为准**——V2 是设计上的判定主路径，
 * V1 是保守兜底。双跑判定一致 = 一致性达成；一致地 BLOCK（两链同拦）也是合法
 * 一致（保守兜底语义），一致地 ALLOW 同理。只在「真管道杀豁免」负门形态上，
 * 两链同拦是硬要求（不因 || 修复外溢）。
 *
 * 覆盖两族豁免（审视报告建议 3 原文）：
 * - cd 豁免族：worktree 写 + `||` 备用链（#1360 修复面）+ 真管道负门
 * - one-liner 豁免族：python/node 只读载荷 + `&&` 链 + 写载荷（保持拦）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@frameworks/agent/guard-model-judge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@frameworks/agent/guard-model-judge")>();
  return {
    ...actual,
    modelParseOk: vi.fn(() => true),
  };
});

import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { modelParseOk } from "@frameworks/agent/guard-model-judge";

const mainPid = 42877;
const projectRoot = "/repo"; // 假想主仓根，与 gduc 段同口径（避开 mainPid 短路分支）
const WT = "/repo/.otter/worktrees/wt";

/** 双链双跑探针：同一命令在 parseOk 强制 true / false 下各判一次。
 * 审视处置（PR #1368 §3.1）：断言 mock 真拦截（liveness 守卫）——vi.mock 用 alias 路径
 * 拦被测模块内部相对 import，靠 vitest alias 解析对齐（当前生效，升级易破坏）。若拦截
 * 静默失效 → 双跑同路径 → 一致性平凡成立 → 虚绿。本断言把「守卫失灵」从静默虚绿变红灯。
 */
function dualRun(command: string): { parseOk: string | null; fallback: string | null } {
  vi.mocked(modelParseOk).mockClear();
  vi.mocked(modelParseOk).mockReturnValue(true);
  const viaModel = checkBashCommandSafety(command, mainPid, undefined, { projectRoot });
  expect(vi.mocked(modelParseOk),
    "mock 失活：modelParseOk 未被调用——vi.mock 未拦截被测模块内部 import，双链一致性测试已静默虚绿（割裂回归不会报警）。检查 vitest alias 解析与 @frameworks/agent/guard-model-judge 路径对齐",
  ).toHaveBeenCalled();
  vi.mocked(modelParseOk).mockReturnValue(false);
  const viaFallback = checkBashCommandSafety(command, mainPid, undefined, { projectRoot });
  return { parseOk: viaModel, fallback: viaFallback };
}

/** 一致性断言 + 期望值断言（结果用 ALLOW/BLOCK 归一，不比对拦截文案——双链文案本就不同源）。 */
function expectDualConsistent(command: string, expected: "ALLOW" | "BLOCK"): void {
  const r = dualRun(command);
  const v2 = r.parseOk === null ? "ALLOW" : "BLOCK";
  const v1 = r.fallback === null ? "ALLOW" : "BLOCK";
  expect(v1, `双链判定割裂：parseOk=true(V2)=${v2} vs parseOk=false(V1)=${v1}\n命令：${command}`).toBe(v2);
  expect(v2, `主链(V2)期望值偏离：期望 ${expected} 实得 ${v2}\n命令：${command}`).toBe(expected);
}

describe("F20261008gdcc 双链一致性：cd 豁免族（同一命令 parseOk 双跑判定一致）", () => {
  beforeEach(() => {
    vi.mocked(modelParseOk).mockReturnValue(true);
  });

  it("worktree 写 + || 备用链（#1360 修复面）：双链一致放行", () => {
    // #1360 前的 S1 现场：多行载荷 parseOk=false 落 V1，裸 \| 杀豁免 → V1 BLOCK / V2 ALLOW 割裂。
    // 本用例在旧正则下红（V1 BLOCK vs V2 ALLOW），修复后双 ALLOW——S1 类割裂的 CI 探针。
    expectDualConsistent(
      `cd ${WT} && node -e "require('fs').writeFileSync('${WT}/data/x','1')"\nconsole.log('done') || node -e "console.log('fallback')"`,
      "ALLOW",
    );
  });

  it("worktree 写 + || 备用链（单行形态）：双链一致放行", () => {
    expectDualConsistent(
      `cd ${WT} && node -e "require('fs').writeFileSync('${WT}/data/x','1')" || node -e "console.log('f')"`,
      "ALLOW",
    );
  });

  it("worktree 只读 + || fallback：双链一致放行", () => {
    expectDualConsistent(`cd ${WT} && git status || echo "failed"`, "ALLOW");
  });

  it("worktree 写 + python one-liner || 备用链：双链一致放行", () => {
    expectDualConsistent(
      `cd ${WT} && python3 -c "open('${WT}/out.txt','w').write('x')" || echo "py failed"`,
      "ALLOW",
    );
  });

  it("真管道（node 写 worktree | tail）：双链一致拦截（delta eba7c738：载荷面不终局放——node -e 回落旧链两链同拦；非载荷面 rescue 由语料夹具钉住）", () => {
    // delta 收口：载荷证明门 6 形态击穿后退化为禁放闸——载荷段一律回落旧链关键词网，
    // 两链判定一致（old=BLOCK）。该形态为载荷面误拦残余，收编 #1438。主仓负门由下条钉住。
    expectDualConsistent(
      `cd ${WT} && node -e "require('fs').writeFileSync('${WT}/data/x','1')" | tail -1`,
      "BLOCK",
    );
  });

  it("写主仓绝对路径（无 cd 豁免歧义）：双链一致拦截", () => {
    expectDualConsistent(
      `node -e "require('fs').writeFileSync('/repo/data/metrics.json','{}')"`,
      "BLOCK",
    );
  });
});

describe("F20261008gdcc 双链一致性：one-liner 豁免族", () => {
  beforeEach(() => {
    vi.mocked(modelParseOk).mockReturnValue(true);
  });

  it("python 只读载荷 && 链：双链一致放行", () => {
    expectDualConsistent(
      `cd ${WT} && python3 -c "print(open('a.txt').read())" && git status`,
      "ALLOW",
    );
  });

  it("node 写主仓绝对路径载荷（cd WT 后）：双链一致拦截（F20261012gesw 换岗：#1363 灰区闭合——cd 豁免不再覆盖写主仓的落点事实，观察期 EVAL_GAIN 7 条同形态实证收益）", () => {
    // 旧灰区：cd 显式意图设计 + 写落点归属校验未实现时双链一致放行（#1363）。
    // 换岗后求值器主判：真写落主仓 → 拦。原注释预言「#1363 落地后本用例期望值应改
    // 为 BLOCK」——本次同步改两链，割裂红灯继续钉住双链同步。
    expectDualConsistent(
      `cd ${WT} && node -e "require('fs').writeFileSync('/repo/hacked.txt','x')"`,
      "BLOCK",
    );
  });

  it("node 只读载荷 + $() 命令替换（parseOk=false 天然形态）：双链一致放行", () => {
    // $() 使真实解析器 parseOk=false——正是 S1 的触发面形态；只读载荷应两链同放。
    expectDualConsistent(
      `cd ${WT} && node -e "console.log(require('child_process').execSync('git status').toString())"`,
      "ALLOW",
    );
  });
});
