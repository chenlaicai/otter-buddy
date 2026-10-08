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

/** 双链双跑探针：同一命令在 parseOk 强制 true / false 下各判一次。 */
function dualRun(command: string): { parseOk: string | null; fallback: string | null } {
  vi.mocked(modelParseOk).mockReturnValue(true);
  const viaModel = checkBashCommandSafety(command, mainPid, undefined, { projectRoot });
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

  it("真管道负门（node 写 worktree | tail）：双链一致拦截（管道杀豁免不因 || 修复外溢）", () => {
    // 管道形态在 V2 段级语义放行 git 写（#1170），但 node 写载荷 + 管道的保守拦截
    // 是两链共享的负门——此形态若一侧放行一侧拦即真割裂。
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

  it("node 写主仓绝对路径载荷（cd WT 后）：双链一致放行（issue #1363 已知灰区，非双链割裂）", () => {
    // 此形态当前双链一致放行——cd 显式意图设计 + 写落点归属校验未实现（issue #1363，
    // 独立收紧不进本批）。钉住「一致」面：若未来某一侧单独改拦（如只在 V2 收紧）
    // 而另一侧未同步，本用例以割裂红灯强制双链同步——这正是本测试的防御价值。
    // 注意：#1363 落地后本用例期望值应改为 BLOCK（同步改两链）。
    expectDualConsistent(
      `cd ${WT} && node -e "require('fs').writeFileSync('/repo/hacked.txt','x')"`,
      "ALLOW",
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
