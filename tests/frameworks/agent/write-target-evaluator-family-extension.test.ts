/**
 * M-f6762368 造-执对族外延收编 + dot-source 对称（P1 根修）矩阵。
 *
 * 背景：argv 写面 8 族（cp/mv/install/ln/tee/curl/wget/dd，F20261019wvcp）已进造-执对
 * 配对识别，族外延（sed -i/perl -pi/ruby -pi 原地编辑、tar/unzip 解包、rsync 同步）不进
 * 配对（写段造出的执行文件不被回扫）也不进写目标提取（tar/rsync 直写主仓 ALLOW）——
 * 实测基线见 /tmp/probe-f6762368-baseline.txt。附带 dot-source 执行段缺口根因：
 * canonicalExecName(".") 版本剥离正则把「.」吃成空名（F20261022vwfg 解析收敛回归），
 * source/dot 同义词不对称——收编族矩阵纪律（对称入口原则）正中此面。
 *
 * 修复语义：族外延写面进 writerContent（content=null fail-closed，tar/unzip/rsync
 * 目标为目录性写面前缀匹配）+ 写目标提取补齐 + canonicalExecName 空名护栏。
 */
import { describe, it, expect } from "vitest";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";

const verdict = (cmd: string, cwd: string = WT) => evaluateWriteVerdict(cmd, ROOT, cwd);
const isBlock = (cmd: string, cwd?: string) => verdict(cmd, cwd).verdict === "BLOCK";
const isAllow = (cmd: string, cwd?: string) => verdict(cmd, cwd).verdict === "ALLOW";

describe("M-f6762368 造-执对族外延（收编后造+执必须 BLOCK）", () => {
  it("sed -i 造段 + python 文件执行 → fail-closed 拒判", () => {
    expect(isBlock("sed -i 's/x/y/' /tmp/g.sh && python3 /tmp/g.sh")).toBe(true);
  });
  it("sed -i 造段 + source 执行 → fail-closed 拒判", () => {
    expect(isBlock("sed -i 's/x/y/' /tmp/g.sh && source /tmp/g.sh")).toBe(true);
  });
  it("sed -i 造段 + dot 执行 → fail-closed 拒判（dot 对称）", () => {
    expect(isBlock("sed -i 's/x/y/' /tmp/g.sh && . /tmp/g.sh")).toBe(true);
  });
  it("perl -pi / ruby -pi 同族对称（× source）", () => {
    expect(isBlock("perl -pi -e 's/x/y/' /tmp/g.sh && source /tmp/g.sh")).toBe(true);
    expect(isBlock("ruby -pi -e 's/x/y/' /tmp/g.sh && source /tmp/g.sh")).toBe(true);
  });
  it("tar 解包造段（-C /tmp）+ dot 执行 /tmp 内文件 → 目录性写面前缀命中拒判", () => {
    expect(isBlock("tar -xf /tmp/e.tar -C /tmp && . /tmp/g.sh")).toBe(true);
  });
  it("unzip 解包造段（-d /tmp）+ dot 执行 → 拒判", () => {
    expect(isBlock("unzip /tmp/e.zip -d /tmp && . /tmp/g.sh")).toBe(true);
  });
  it("rsync 同步造段 + dot 执行 dest 内文件 → 拒判", () => {
    expect(isBlock("rsync -a /src/ /tmp/d/ && . /tmp/d/g.sh")).toBe(true);
  });
});

describe("dot-source 对称（P1/P10 根修：canonicalExecName 空名护栏）", () => {
  it("cp 造段 + dot 执行 → 与 source 对称拒判（原 ALLOW 洞）", () => {
    expect(isBlock("cp /src/g.sh /tmp/g.sh && . /tmp/g.sh")).toBe(true);
    expect(isBlock("cp /src/g.sh /tmp/g.sh && source /tmp/g.sh")).toBe(true);
  });
  it("echo 内容造段 + dot 执行 → 内容判读命中主仓拒判（原 ALLOW 洞）", () => {
    expect(isBlock("echo touch /repo/hacked.txt > /tmp/g.sh && . /tmp/g.sh")).toBe(true);
    expect(isBlock("echo touch /repo/hacked.txt > /tmp/g.sh && source /tmp/g.sh")).toBe(true);
  });
});

describe("写目标提取族外延（写主仓必须 BLOCK）", () => {
  it("tar -xf -C 主仓目录 → 拦", () => {
    expect(isBlock("tar -xf /tmp/e.tar -C /repo && true")).toBe(true);
  });
  it("unzip -d 主仓目录 → 拦", () => {
    expect(isBlock("unzip /tmp/e.zip -d /repo/dir")).toBe(true);
  });
  it("rsync dest=主仓 → 拦", () => {
    expect(isBlock("rsync -a /src/ /repo/dest/")).toBe(true);
  });
  it("既有原地编辑提取不回退（sed/perl -i 写主仓）", () => {
    expect(isBlock("sed -i 's/x/y/' /repo/x.txt")).toBe(true);
    expect(isBlock("perl -pi -e 's/x/y/' /repo/x.txt")).toBe(true);
  });
});

describe("放行侧（收编不误拦）", () => {
  it("族外延单写无执行、落点外部 → ALLOW", () => {
    expect(isAllow("sed -i 's/x/y/' /tmp/g.sh")).toBe(true);
    expect(isAllow("rsync -a /src/ /tmp/d/")).toBe(true);
    expect(isAllow("tar -xf /tmp/e.tar -C /tmp && true")).toBe(true);
  });
  it("tar 列表/纯读形态 → ALLOW", () => {
    expect(isAllow("tar -tf /repo/x.tar")).toBe(true);
    expect(isAllow("unzip -l /repo/e.zip")).toBe(true);
  });
  it("rsync --dry-run → ALLOW（不写）", () => {
    expect(isAllow("rsync -an /src/ /repo/dest/")).toBe(true);
  });
  it("良性内容造+dot 执行 → 内容判读无写 ALLOW", () => {
    expect(isAllow("echo hi > /tmp/f && . /tmp/f")).toBe(true);
  });
  it("执行段不在写目录内 → 不配对，缺席证明放行", () => {
    expect(isAllow("tar -xf /tmp/e.tar -C /tmp && . /other/g.sh")).toBe(true);
  });
  it("worktree 落点写 → 既有豁免不回退", () => {
    expect(isAllow("sed -i 's/x/y/' out.txt")).toBe(true);
  });
});
