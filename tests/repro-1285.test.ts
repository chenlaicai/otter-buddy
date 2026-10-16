// #1285 三洞复现载荷的真断言回归（原修复前探针：13 载荷修复前实测全部 ALLOWED，
// 修复后全部应 BLOCKED——r1 检视 B 级处置：伪断言 expect(true).toBe(true) 改真断言）
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "../src/frameworks/agent/bash-safety-guard";

// F20261016grdl 1a'-B 行为变更适配：W 落点从硬编码 /repo 改为 projectRoot 真实路径——
// 「写动词 fail-closed 不看落点」翻转为「落点感知」后，/repo 字面路径落在测试 projectRoot
//（__dirname）树外会被（正确的）落点感知豁免放行；#1285 语义是「空赋值前缀绕过通道」，
// 落点改真主仓路径后该绕过面仍应拦（通道命中语义不变）。
import path from "node:path";
const MAIN = path.resolve(__dirname);
const W = `write payload: require('fs').writeFileSync('${MAIN}/config.yaml','x')`;
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
