// #1285 三洞复现载荷的真断言回归（原修复前探针：13 载荷修复前实测全部 ALLOWED，
// 修复后全部应 BLOCKED——r1 检视 B 级处置：伪断言 expect(true).toBe(true) 改真断言）
// F20261016gses F1 修订：W 落点改为 projectRoot 动态拼接（旧固定 /repo 与测试的
// projectRoot=__dirname 不匹配——F1 落点语义判据下虚构落点不在主仓树内而放行；
// 空赋值前缀洞的本体是「赋值不破坏拦截」，落点对齐后语义判据同拦）。
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "../src/frameworks/agent/bash-safety-guard";
import { join } from "node:path";

const W = `require('fs').writeFileSync(${JSON.stringify(join(__dirname, "config.yaml"))},'x')`;
const cases: [string, string][] = [
  ["洞1a bash -c", `bash -c 'node -e "${W}"'`],
  ["洞1b sh -c", `sh -c 'node -e "${W}"'`],
  ["洞1c sudo bash -c", `sudo bash -c 'node -e "${W}"'`],
  ["洞1d echo|bash", `echo 'node -e "${W}"' | bash`],
  ["洞2a timeout", `timeout 5 node -e "${W}"`],
  ["洞2b watch", `watch -n 1 node -e "${W}"`],
  ["洞2c setsid", `setsid node -e "${W}"`],
  ["洞2d stdbuf", `stdbuf -o0 node -e "${W}"`],
  ["洞2e arch", `arch node -e "${W}"`],
  ["洞2f env -i", `env -i node -e "${W}"`],
  ["洞2g nice -n 5", `nice -n 5 node -e "${W}"`],
  ["洞3a 空赋值 one-liner", `FOO= node -e "${W}"`],
  ["洞3b 空赋值 git 写族", `FOO= git commit -m x`],
];
describe("1285 repro 真断言（修复前 13 载荷实测全 ALLOWED → 修复后应全 BLOCKED）", () => {
  for (const [name, cmd] of cases) {
    it(`${name} → 拦截`, () => {
      process.chdir(__dirname);
      const r = checkBashCommandSafety(cmd, 999999, undefined, { projectRoot: __dirname });
      expect(r, `${name} 载荷应被拦截：${cmd}`).not.toBeNull();
    });
  }
});
