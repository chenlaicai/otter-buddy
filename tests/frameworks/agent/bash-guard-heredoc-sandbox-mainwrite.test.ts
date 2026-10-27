import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

/**
 * F20261027hpex（#1542）：沙箱链（sandboxGuarded=true）heredoc 载荷写主仓接防 + 拷贝族目标落主仓窄规则。
 *
 * 修前基线（大獭 2026-10-27 06:22 修前实证 + 本 worktree 复现，main @e8e353a2）：
 * Y1/Y2/Y3/Y6 在 sg=true 链全 ALLOW（heredoc 写面负门随 writeChannelSkip="file-write"
 * 整体退役），sg=false 对照链全 BLOCK——Y 类贯穿性漏拦确认；Y6 二分 65c252d2（10-22）即存在。
 * E1 cp 面（案卷误拦项）已被后续 PR 顺带修复：E1a（cp $F /tmp/bak）双链放行，
 * 但 E1e（cp $F <主仓>/x）sg=true 也放行——目标落主仓应收紧。
 *
 * 修后断言：体内容/拷贝目标写主仓（projectRoot 树内，工作区/worktree 豁免区除外）
 * → BLOCK；树外/豁免区/只读体/数据体 → 放行。
 */

const ROOT = "/Users/orca/ai/otter-buddy";
const WS = "/Users/orca/ai/otter-buddy/data/workspaces/ws-1542-test";
const sg = { projectRoot: ROOT, sessionCwd: WS, sandboxGuarded: true as const };
const plain = { projectRoot: ROOT, sessionCwd: WS };

describe("#1542 Y 类：沙箱链 heredoc 载荷写主仓（修前全 ALLOW → 修后 BLOCK）", () => {
  it("Y1 wrapper（env python3）cd /tmp 写主仓 sg=true → BLOCK", () => {
    expect(checkBashCommandSafety(`cd /tmp && env python3 - <<'PY'\nimport os\nos.remove("${ROOT}/data/y1.txt")\nPY`, null, undefined, sg)).not.toBeNull();
  });
  it("Y2 管道馈送（cat | env python3 -）cd /tmp 写主仓 sg=true → BLOCK", () => {
    expect(checkBashCommandSafety(`cd /tmp && cat <<'PY' | env python3 -\nimport os\nos.remove("${ROOT}/data/y2.txt")\nPY`, null, undefined, sg)).not.toBeNull();
  });
  it("Y3 直挂 runner（python3 -）cd /tmp 写主仓 sg=true → BLOCK（案卷称直挂已覆盖系过时）", () => {
    expect(checkBashCommandSafety(`cd /tmp && python3 - <<'PY'\nimport os\nos.remove("${ROOT}/data/y3.txt")\nPY`, null, undefined, sg)).not.toBeNull();
  });
  it("Y6 无 cd 管道馈送（cat | python3 -）写主仓 sg=true → BLOCK（贯穿面，65c252d2 起存在）", () => {
    expect(checkBashCommandSafety(`cat <<'PY' | python3 -\nimport os\nos.remove("${ROOT}/data/y6.txt")\nPY`, null, undefined, sg)).not.toBeNull();
  });
  it("Y4 形态（无 cd、cwd=工作区）写主仓绝对路径 sg=true → BLOCK", () => {
    expect(checkBashCommandSafety(`python3 - <<'PY'\nimport os\nos.remove("${ROOT}/data/y4.txt")\nPY`, null, undefined, sg)).not.toBeNull();
  });
  it("node 同族：node - heredoc fs.writeFileSync 主仓 sg=true → BLOCK", () => {
    expect(checkBashCommandSafety(`cd /tmp && node - <<'JS'\nconst fs = require("fs");\nfs.writeFileSync("${ROOT}/data/n.txt", "x");\nJS`, null, undefined, sg)).not.toBeNull();
  });
  it("动态源拼接路径（os.environ）写形态 sg=true → BLOCK（#1309 同口径接防）", () => {
    expect(checkBashCommandSafety(`cd /tmp && python3 - <<'PY'\nimport os\nopen(os.environ["REPO"] + "/data/dyn.txt", "w").write("x")\nPY`, null, undefined, sg)).not.toBeNull();
  });
  it("sg=false 对照链：Y1/Y3/Y6 仍 BLOCK（回归防翻）", () => {
    expect(checkBashCommandSafety(`cd /tmp && python3 - <<'PY'\nimport os\nos.remove("${ROOT}/data/y3.txt")\nPY`, null, undefined, plain)).not.toBeNull();
    expect(checkBashCommandSafety(`cat <<'PY' | python3 -\nimport os\nos.remove("${ROOT}/data/y6.txt")\nPY`, null, undefined, plain)).not.toBeNull();
  });
});

describe("#1542 放行对照（不误拦正道）", () => {
  it("树外写（/tmp）heredoc sg=true → 放行", () => {
    expect(checkBashCommandSafety(`cd /tmp && env python3 - <<'PY'\nimport os\nos.remove("/tmp/ok.txt")\nPY`, null, undefined, sg)).toBeNull();
  });
  it("对话工作区（data/workspaces 豁免区）heredoc 写 sg=true → 放行", () => {
    expect(checkBashCommandSafety(`cd /tmp && python3 - <<'PY'\nimport os\nos.remove("${WS}/scratch.txt")\nPY`, null, undefined, sg)).toBeNull();
  });
  it("只读体 heredoc（print 探查）sg=true → 放行", () => {
    expect(checkBashCommandSafety(`cd /tmp && python3 - <<'PY'\nprint("readonly probe")\nPY`, null, undefined, sg)).toBeNull();
  });
  it("只读体含主仓路径（open read）sg=true → 放行（负门体只读豁免语义保持）", () => {
    expect(checkBashCommandSafety(`cd /tmp && python3 - <<'PY'\nprint(open("${ROOT}/package.json").read()[:10])\nPY`, null, undefined, sg)).toBeNull();
  });
  it("纯数据体 heredoc（cat 落树外，体含主仓字样）sg=true → 放行", () => {
    expect(checkBashCommandSafety(`cat > /tmp/data.txt <<'EOF'\nmentions ${ROOT}/src in data payload\nEOF`, null, undefined, sg)).toBeNull();
  });
  it("数据体 heredoc 落工作区 sg=true → 放行（F20261016gsbx 2b 既有退役面保持）", () => {
    expect(checkBashCommandSafety(`cat > ${WS}/notes.md <<'EOF'\nhello notes\nEOF`, null, undefined, sg)).toBeNull();
  });
});

describe("#1542 E1 面：cp 动态源误拦保持放行 + E1e 目标落主仓收紧", () => {
  it("E1a cp $F /tmp/bak sg=true → 放行（后续 PR 已修，防翻判断言）", () => {
    expect(checkBashCommandSafety("F=/tmp/a.txt; cp $F /tmp/bak.txt", null, undefined, sg)).toBeNull();
  });
  it("E1a sg=false 对照 → 放行", () => {
    expect(checkBashCommandSafety("F=/tmp/a.txt; cp $F /tmp/bak.txt", null, undefined, plain)).toBeNull();
  });
  it("E1 源取证变体：cp <主仓>/package.json /tmp sg=true → 放行（源不判）", () => {
    expect(checkBashCommandSafety(`cp ${ROOT}/package.json /tmp/pkg.bak.json`, null, undefined, sg)).toBeNull();
  });
  it("E1e cp $F <主仓>/x sg=true → BLOCK（修前 ALLOW，目标落主仓收紧）", () => {
    expect(checkBashCommandSafety(`F=/tmp/a.txt; cp $F ${ROOT}/x.txt`, null, undefined, sg)).not.toBeNull();
  });
  it("E1e 字面目标 cp /tmp/a <主仓>/y sg=true → BLOCK", () => {
    expect(checkBashCommandSafety(`cp /tmp/a.txt ${ROOT}/y.txt`, null, undefined, sg)).not.toBeNull();
  });
  it("E1e -t 目标前置 cp a -t <主仓>/data sg=true → BLOCK", () => {
    expect(checkBashCommandSafety(`cp /tmp/a.txt -t ${ROOT}/data`, null, undefined, sg)).not.toBeNull();
  });
  it("cp 目标落工作区 sg=true → 放行（豁免区）", () => {
    expect(checkBashCommandSafety(`cp /tmp/a.txt ${WS}/b.txt`, null, undefined, sg)).toBeNull();
  });
  it("mv 工作区→/tmp sg=true → 放行（树外目标）", () => {
    expect(checkBashCommandSafety(`mv ${WS}/draft.txt /tmp/draft.txt`, null, undefined, sg)).toBeNull();
  });
  it("cp 动态目标 cp a $D sg=true → 不拦（窄面：字面可见才判，沙箱物理接防兑底）", () => {
    expect(checkBashCommandSafety("D=/tmp/d.txt; cp /tmp/a.txt $D", null, undefined, sg)).toBeNull();
  });
  it("E1e sg=false 对照链 → BLOCK（求值器 argv 写面既有覆盖，防翻）", () => {
    expect(checkBashCommandSafety(`F=/tmp/a.txt; cp $F ${ROOT}/x.txt`, null, undefined, plain)).not.toBeNull();
  });
});
