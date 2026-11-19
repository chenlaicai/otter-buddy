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

describe("cleanCommentText 文档结构编号", () => {
  it("T 小节号删除，ISO 时间保留", () => {
    expect(cleanCommentText("T5：过程明细开关").text).toBe("过程明细开关");
    expect(cleanCommentText("'T10:00:00+08:00' 字面量").text).toContain("T10:00");
  });

  it("Part 分节号删除（含小数点、方案前缀）", () => {
    expect(cleanCommentText("Part 1：扩展契约。").text).toBe("扩展契约。");
    expect(cleanCommentText("provenance messages（Part 2.3）在工具层组合").text).toContain("工具层组合");
    expect(cleanCommentText("halt 语义（方案 Part 3）：打标").text).not.toContain("方案");
  });

  it("检查项号与方案节删除", () => {
    expect(cleanCommentText("（C4：UI 徽章数据源）").text).toBe("（UI 徽章数据源）");
    expect(cleanCommentText("注入全量 B1-B6 渲染文本").text).toContain("渲染文本");
    expect(cleanCommentText("配对策略（方案 D 节 + ）").text).not.toContain("方案");
  });

  it("阶段/章 节/方案版本删除", () => {
    expect(cleanCommentText("// （阶段 4 C1）：connector 网关").text).toContain("connector 网关");
    expect(cleanCommentText("守卫/说明（方案 §2 矩阵）").text).not.toContain("方案");
    expect(cleanCommentText("采样层（方案 v6.2 定案）").text).toContain("定案");
  });

  it("审视项号删除，日常词豁免", () => {
    expect(cleanCommentText("证据质量留给异体审 B9").text).not.toContain("B9");
    expect(cleanCommentText("A1 审视收口").text).not.toContain("A1");
    expect(cleanCommentText("A4 纸不误删").text).toContain("A4");
    expect(cleanCommentText("bge-m3 模型名不误删").text).toContain("bge-m3");
    expect(cleanCommentText("34 种索引：m0-8 p9-17").text).toContain("m0-8");
  });

  it("m 时间边界豁免：短句结尾的「m1 之前/之后/前/后」不误删", () => {
    expect(cleanCommentText("诞生于 m1 之前").text).toBe("诞生于 m1 之前");
    expect(cleanCommentText("诞生于 m1 之后").text).toBe("诞生于 m1 之后");
    expect(cleanCommentText("诞生于 m1 前").text).toBe("诞生于 m1 前");
    expect(cleanCommentText("诞生于 m1 后").text).toBe("诞生于 m1 后");
  });

  it("阶段缩写号删除，优先级豁免", () => {
    expect(cleanCommentText("P1：信号路由器").text).toBe("信号路由器");
    expect(cleanCommentText("priority 必有且仅 1 个：P0 / P1 / P2").text).toContain("P0");
    expect(cleanCommentText("打标拿不准时宁降一级（P1→P2）").text).toContain("P1→P2");
  });

  it("PR 代号与分号残渣", () => {
    expect(cleanCommentText("// （阶段 5 PR-A）：工具面路由").text).toContain("工具面路由");
    expect(cleanCommentText("多模态 Phase 1；终审修复").text).toBe("多模态；终审修复");
  });

  it("嵌套组合编号删除 + 孤立分隔符/空括号收敛", () => {
    expect(cleanCommentText(`/** ${fid()}（C2/R2）：远程动作五态段 */`).text).toBe("/** 远程动作五态段 */");
    expect(cleanCommentText("（预算闭合留裕量，D3/D6）").text).toBe("（预算闭合留裕量）");
    expect(cleanCommentText("（更新面与探测面对称，r1-S1）：").text).toBe("（更新面与探测面对称）：");
    expect(cleanCommentText(`fail-closed（D2/r1-S1）`).text).toBe("fail-closed");
  });

  it("git R 相似度不误删；D 子项与 issue 子项整体删", () => {
    expect(cleanCommentText("非 R100 rename 时 git plain 查询漏判").text).toContain("R100");
    expect(cleanCommentText("相似度>R50%，rename 检测存活").text).toContain("R50%");
    expect(cleanCommentText(`误伤面（${hash()}1653 D1-1）的唯一观测源`).text).toBe("误伤面的唯一观测源");
    expect(cleanCommentText(`只能荣和或过（${hash()}1564-2）`).text).toBe("只能荣和或过");
  });

  it("delta 简写形态整体删除不留残渣", () => {
    expect(cleanCommentText("// delta-r3：链内再按 | 拆管道段").text).toBe("// 链内再按 | 拆管道段");
    expect(cleanCommentText("D4（检视 delta-r3）：段首 fetcher").text).toBe("（检视）：段首 fetcher");
  });

  it("delta 简写大小写变体整体删除不留前缀", () => {
    expect(cleanCommentText("// Delta2：复核建议").text).toBe("// 复核建议");
    expect(cleanCommentText("// DeltaR3 处置后").text).toBe("// 处置后");
    expect(cleanCommentText("// DELTA-r3：链内再拆").text).toBe("// 链内再拆");
    expect(cleanCommentText("// Delta D1 回归锚").text).toBe("// 回归锚");
  });
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
