// 修复前实测：三洞复现证据（process.chdir(worktree) → main-write 判定生效）
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "../src/frameworks/agent/bash-safety-guard";

const W = "write payload: require('fs').writeFileSync('/repo/config.yaml','x')";
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
describe("1285 pre-fix repro", () => {
  for (const [name, cmd] of cases) {
    it(name, () => {
      process.chdir(__dirname);
      const r = checkBashCommandSafety(cmd, 999999, undefined, { projectRoot: __dirname });
      console.log(name, "→", r ? "BLOCKED" : "ALLOWED(洞)");
      expect(true).toBe(true); // 仅记录，不断言（修复前洞应为 ALLOWED）
    });
  }
});
