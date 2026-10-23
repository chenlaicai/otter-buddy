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

// ———— delta1（检视獭1619 对抗审视严重 1/2/3 + 建议 4/5/6 处置）————
// 严重 1/2 同根：archiveFamilyTargets 长旗标值位污染——子串判只读 + 值词抢目标槽（放水面）。
// 严重 3：dirWrite 缺省 "." 点分量不折叠，配对面放水（提取面对照 BLOCK 坐实非取舍）。

describe("delta1 值位污染修复（发现 1/2）：长旗标值位不抢目标槽", () => {
  it("S1 rsync 长旗标不误判 dry-run——--numeric-ids 含 n 不再判只读", () => {
    expect(isBlock("rsync -a --numeric-ids /src/ /repo/dest/")).toBe(true);
    expect(isBlock("rsync -a --numeric-ids /src/ /tmp/d/ && . /tmp/d/g.sh")).toBe(true);
    expect(isAllow("rsync -a --numeric-ids /src/ /tmp/d/")).toBe(true); // 放行侧对称
  });
  it("S1 rsync 带值长旗标值位不占 dest 槽（尾置 --exclude 不改 dest 判定）", () => {
    expect(isBlock("rsync -a /src/ /repo/dest/ --exclude '*.log'")).toBe(true);
    expect(isAllow("rsync -a /src/ /tmp/d/ --exclude '*.log'")).toBe(true);
  });
  it("S1 对称变体：短旗标值位（-e 吞值）同洞同修", () => {
    expect(isBlock("rsync -a /src/ /repo/dest/ -e ssh")).toBe(true);
    expect(isAllow("rsync -a /src/ /tmp/d/ -e ssh")).toBe(true);
  });
  it("S2 tar 带值长旗标分写吞值位——值词不抢归档槽（pos[0]）", () => {
    expect(isBlock("tar --owner root -cz /repo/out.tar /src")).toBe(true);
    expect(isBlock("tar --files-from /tmp/list.txt -cz /repo/out.tar")).toBe(true);
    expect(isBlock("tar --exclude build -cz /repo/out.tar /src")).toBe(true);
  });
  it("S2 放行侧：良性 tar 带值/布尔长旗标不误拦（值位不乱归档槽）", () => {
    expect(isAllow("tar --exclude build -cz /tmp/o.tar /src")).toBe(true);
    expect(isAllow("tar --verbose -cz /tmp/o.tar /src")).toBe(true);
  });
  it("S2 fallback：未收录长旗标值位不可静态识别 → 保守拦（不被词面证洗白）", () => {
    expect(isBlock("tar --mystery val -cz /repo/out.tar /src")).toBe(true);
    expect(isBlock("rsync -a /src/ /repo/dest/ --mystery val")).toBe(true);
    // 怪形尾置歧义（--mystery x 可能是值位也可能是 dest）→ 同保守拦（误拦可接受面，
    // fail-closed 优先；不建值位猜测模型，#1513 不军备化之尺）
    expect(isBlock("rsync -a /src/ /tmp/d/ --mystery x")).toBe(true);
  });
  it("写目标槽不可求值（dyn）→ 保守拦（词面证盲区不洗白，探针 probe-wash 实证面）", () => {
    expect(isBlock("tar -xf /tmp/e.tar -C \"$D\"")).toBe(true);
    expect(isBlock("rsync -a /src/ \"$D\"")).toBe(true);
    expect(isBlock("unzip /tmp/e.zip -d \"$D\"")).toBe(true);
  });
  it("dyn 归档名槽不误伤（x 态良性：$A 是读面归档名）", () => {
    expect(isAllow("tar -xf \"$A\" -C /tmp")).toBe(true);
  });
});

describe("delta1 点折叠（发现 3）：缺省 cwd 目录性写面点分量归一", () => {
  it("S3 tar/unzip 缺省落 cwd（target=\".\"）+ dot 执行 → 前缀命中拒判", () => {
    expect(isBlock("tar -xf /tmp/e.tar && . g.sh")).toBe(true);
    expect(isBlock("unzip /tmp/e.zip && . g.sh")).toBe(true);
  });
  it("S3 不对称对照保持：ROOT 态同 target 提取面仍拦", () => {
    expect(isBlock("unzip /tmp/e.zip && . /repo/g.sh", ROOT)).toBe(true);
  });
});

describe("delta1 纯读集与分界钉（建议 4/5/6）", () => {
  it("A4 unzip -p/-c/-v 纯读 → ALLOW（原误拦），解包面不松", () => {
    expect(isAllow("unzip -p /repo/x.zip", ROOT)).toBe(true);
    expect(isAllow("unzip -c /repo/x.zip", ROOT)).toBe(true);
    expect(isAllow("unzip -v /repo/x.zip", ROOT)).toBe(true);
    expect(isBlock("unzip /repo/x.zip -d /repo/dir")).toBe(true);
  });
  it("A5 /tmp vs /tmp2 兄弟目录分界钉（双向，前缀匹配不吃兄弟目录）", () => {
    expect(isAllow("tar -xf /tmp/e.tar -C /tmp && . /tmp2/g.sh")).toBe(true);
    expect(isAllow("tar -xf /tmp/e.tar -C /tmp2 && . /tmp/g.sh")).toBe(true);
  });
  it("A6 tar xf/cf 传统无横线形态 → 保守 uncovered 拦（行为钉）", () => {
    expect(isBlock("tar xf /tmp/e.tar -C /tmp && . /tmp/g.sh")).toBe(true);
    expect(isBlock("tar cf /repo/out.tar /src")).toBe(true);
  });
});
