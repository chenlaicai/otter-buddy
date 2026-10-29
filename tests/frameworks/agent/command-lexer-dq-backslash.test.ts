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

/** 取第 1 个实参词的 evaluated（矩阵主体就是「词求值是否= bash 真值」）。 */
const argOf = (cmd: string): string | null => {
  const seg = parseOnce(cmd).segments[0];
  if (seg === undefined) throw new Error("no segment");
  return seg.words[1]?.evaluated ?? null;
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

});
