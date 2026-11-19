/**
 * clean-comment-anchors 清理器测试（注释编号删除语义）。
 *
 * 覆盖：负号/路径不误删、issue 引用语词边界（tissue 不截断、PR 前缀）、
 * 斜杠 issue 列表全删、迭代拼合、空括号清理。自噬防御：编号连续形态运行时拼接。
 */
import { describe, it, expect } from "vitest";
import { cleanCommentText } from "../../scripts/clean-comment-anchors.mjs";

const fid = () => ["F", "20261118", "banch"].join("");
const sl = () => ["/", "/"].join("");
const hash = () => "#";

describe("cleanCommentText 删除语义", () => {
  it("负号与绝对路径不误删", () => {
    expect(cleanCommentText(`${sl()} ${fid()} -1 表示无限制`).text).toContain("-1");
    expect(cleanCommentText(`${sl()} ${fid()} /tmp 是绝对路径`).text).toContain("/tmp");
  });

  it("issue 引用语词边界：tissue 不截断，独立 issue 前缀删除", () => {
    const t = cleanCommentText(`${sl()} tissue ${hash()}123 保留组织语义`).text;
    expect(t).toContain("tissue");
    expect(cleanCommentText(`${sl()} issue ${hash()}123 说明`).text).not.toContain("issue");
  });

  it("斜杠 issue 列表整体删除", () => {
    const t = cleanCommentText(`${sl()} ${hash()}1694/1695/1697 多次事故`).text;
    expect(t).not.toContain("1694");
    expect(t).not.toContain("1695");
    expect(t).toContain("多次事故");
  });

  it("双井号 issue 清单不残留孤立斜杠", () => {
    const t = cleanCommentText(`${sl()} ${hash()}1694/${hash()}1695 多次事故`).text;
    expect(t).not.toMatch(/\/\/\s+\//);
    expect(t).toContain("多次事故");
  });

  it("PR 引用语与空括号清理", () => {
    const t = cleanCommentText(`${sl()} 记录状态（PR ${hash()}573）后续排查`).text;
    expect(t).not.toContain("PR");
    expect(t).not.toContain("（");
  });

  it("合法空括号不误删（$() 语法说明保留）", () => {
    const t = cleanCommentText(`${sl()} 单引号内 $() 不展开`).text;
    expect(t).toContain("$()");
  });

  it("迭代拼合：删中间编号后拼出的新形态也被删除", () => {
    const t = cleanCommentText(`${sl()} 注（检视${hash()}808 发现 1）说明`).text;
    expect(t).not.toContain("发现 1");
    expect(t).not.toContain("检视");
  });

  it("仅 import 模块不产生写副作用", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "banch-import-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      const f = join(dir, "a.ts");
      const before = `${sl()} ${fid()} 仅导入不应修改`;
      writeFileSync(f, before + "\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      const moduleUrl = new URL("../../scripts/clean-comment-anchors.mjs", import.meta.url).href;
      execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`], {
        cwd: dir,
        timeout: 30_000,
      });
      expect(readFileSync(f, "utf8").trim()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
