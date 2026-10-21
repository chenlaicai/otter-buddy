/**
 * M-f89f1ff3 bash 双引号反斜杠语义矩阵（词法层根修）。
 *
 * bash 引用语义：双引号内反斜杠仅 $ ` " \ 换行前特殊（转义作用），其余（\' \a \x \n \; …）
 * 反斜杠字面保留两字符——修复前词法层按「任意 \X → X」丢反斜杠，evaluated 词义与 bash
 * 真值分歧（#1597 严重 2 假重建逃逸根因）。矩阵：五符特殊对 × 非特殊对 × 非双引号反证
 * × 混合共存 × 下游面（echo/printf 重建、evalPath 落点、治标闸降级）。
 */
import { describe, expect, it } from "vitest";
import { parseOnce } from "@frameworks/agent/command-model";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";
import { segmentStdoutContent } from "@frameworks/agent/write-target-evaluator";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";

/** 取第 1 个实参词的 evaluated（矩阵主体就是「词求值是否= bash 真值」）。 */
const argOf = (cmd: string): string | null => {
  const seg = parseOnce(cmd).segments[0];
  if (seg === undefined) throw new Error("no segment");
  return seg.words[1]?.evaluated ?? null;
};
const segOf = (cmd: string) => {
  const seg = parseOnce(cmd).segments[0];
  if (seg === undefined) throw new Error("no segment");
  return seg;
};

describe("双引号反斜杠语义矩阵（M-f89f1ff3：\\ 仅 $ ` \" \\ 换行前特殊，其余字面保留）", () => {
  // ===== 五符特殊对（不变形——反斜杠有转义作用，evalEscape 语义保持）=====
  it("特殊对：\\$ \\` \\\" \\\\ → 转义求值去反斜杠；反斜杠+换行 → 续行删除", () => {
    expect(argOf(String.raw`echo "a\$b"`)).toBe("a$b");
    expect(argOf(String.raw`echo "a\`b"`)).toBe("a`b");
    expect(argOf(String.raw`echo "a\"b"`)).toBe('a"b');
    expect(argOf(String.raw`echo "a\\b"`)).toBe("a\\b");
    expect(argOf("echo \"a\\\nb\"")).toBe("ab"); // 反斜杠+换行=续行，两者皆删
  });

  // ===== 非特殊对（根修面：反斜杠字面保留两字符=bash 真值）=====
  it("非特殊对：\\' \\n \\t \\x \\0 \\; \\/ → 反斜杠字面保留（修复前全部丢反斜杠）", () => {
    expect(argOf(String.raw`echo "a\'b"`)).toBe("a\\'b");
    expect(argOf(String.raw`echo "a\nb"`)).toBe("a\\nb");
    expect(argOf(String.raw`echo "a\tb"`)).toBe("a\\tb");
    expect(argOf(String.raw`echo "a\x41b"`)).toBe("a\\x41b");
    expect(argOf(String.raw`echo "a\0b"`)).toBe("a\\0b");
    expect(argOf(String.raw`echo "a\;b"`)).toBe("a\\;b");
    expect(argOf(String.raw`echo "a\/b"`)).toBe("a\\/b");
  });

  // ===== 反证（非双引号上下文语义不变——根修只动双引号分支）=====
  it("反证：未引 \\X → X（bash 正确语义，不受根修影响）", () => {
    expect(argOf(String.raw`echo a\'b`)).toBe("a'b");
    expect(argOf(String.raw`echo a\nb`)).toBe("anb");
    expect(argOf(String.raw`echo a\\b`)).toBe("a\\b");
  });

  it("反证：单引号内无转义语义（纯字面，不受根修影响）", () => {
    expect(argOf("echo 'a\\nb'")).toBe("a\\nb");
    expect(argOf("echo 'a\\\\b'")).toBe("a\\\\b");
  });

  // ===== 混合共存 =====
  it("混合：特殊对与非特殊对同词共存（各按各的语义）", () => {
    expect(argOf(String.raw`echo "x\'y\\z\$w"`)).toBe("x\\'y\\z$w");
  });

  // ===== 下游面（词义传导：重建/落点/治标闸降级）=====
  it("下游·echo 重建：echo \"a\\nb\"（无 -e）→ 字面 a\\nb（bash 真值）", () => {
    expect(segmentStdoutContent(segOf(String.raw`echo "a\nb"`))).toBe("a\\nb");
  });

  it("下游·echo -e 解码：echo -e \"a\\nb\" → a<LF>b（bash 真值——修复前词法层丢反斜杠谎报 anb）", () => {
    expect(segmentStdoutContent(segOf(String.raw`echo -e "a\nb"`))).toBe("a\nb");
  });

  it("下游·治标闸降级：echo \"it\\'s\" → 精确重建 it\\'s（#1597 分歧闸不再触发，纵深冗余兑现）", () => {
    expect(segmentStdoutContent(segOf(String.raw`echo "it\'s"`))).toBe("it\\'s");
  });

  it("下游·evalPath 落点：> \"d\\'ir/out.txt\" 落点=bash 真值 d\\'ir/out.txt（修复前丢反斜杠错位）", () => {
    const r = evaluateWriteVerdict(String.raw`cd ${WT} && echo x > "d\'ir/out.txt"`, ROOT);
    expect(r.verdict).toBe("ALLOW"); // 工作区落点
    if (r.verdict !== "ALLOW") throw new Error("expected ALLOW"); // 收窄 union：fail-closed 变体无 targets
    expect(r.targets.some(t => t.path.endsWith("d\\'ir/out.txt"))).toBe(true);
  });

  it("下游·#1597 attack 面不回退：单反斜杠吞命令结构端到端仍 fail-closed BLOCK", () => {
    const cmd = String.raw`echo -e "echo hi > /tmp/log \' ; touch /repo/data/pwn \' " > /tmp/g.sh && bash /tmp/g.sh`;
    const r = evaluateWriteVerdict(cmd, ROOT);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("fail-closed"); // 根修后重建转真值，echo -e 白名单外 \' → null fail-closed
  });
});
