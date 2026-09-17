/**
 * F20260917asgv: 锚点 md frontmatter schema 校验测试。
 *
 * 验证 tests/capability/golden/anchors/*.md 的 frontmatter 符合契约：
 * - 必填字段：anchor_id, verdict, domain, meta_rule, source, judged_by, judged_at
 * - verdict 枚举：good | bad
 * - anchor_id 与文件名一致
 * - 正文包含必要章节：背景 / 獭产出 / 实际发生 / 判定
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ANCHORS_DIR = path.join(__dirname, "capability", "golden", "anchors");

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

const REQUIRED_FIELDS = ["anchor_id", "verdict", "domain", "meta_rule", "source", "judged_by", "judged_at"];
const VALID_VERDICTS = ["good", "bad"];
const REQUIRED_SECTIONS = ["## 背景", "## 獭产出", "## 实际发生", "## 判定"];

describe("锚点 md frontmatter schema 校验", () => {
  const files = fs.readdirSync(ANCHORS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");

  it(`锚点目录应有 26 个 md 文件（不含 README）`, () => {
    expect(files.length).toBe(26);
  });

  for (const file of files) {
    const filePath = path.join(ANCHORS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    const expectedId = file.replace(".md", "");

    describe(`${file}`, () => {
      it("frontmatter 存在", () => {
        expect(Object.keys(fm).length).toBeGreaterThan(0);
      });

      for (const field of REQUIRED_FIELDS) {
        it(`必填字段 ${field} 存在`, () => {
          expect(fm[field], `${file} 缺少必填字段 ${field}`).toBeDefined();
          expect(fm[field].length, `${file} 字段 ${field} 为空`).toBeGreaterThan(0);
        });
      }

      it(`verdict 为合法枚举（good | bad）`, () => {
        expect(VALID_VERDICTS).toContain(fm.verdict);
      });

      it(`anchor_id 与文件名一致`, () => {
        expect(fm.anchor_id).toBe(expectedId);
      });

      for (const section of REQUIRED_SECTIONS) {
        it(`正文包含必要章节 ${section}`, () => {
          expect(content).toContain(section);
        });
      }
    });
  }
});

describe("锚点集完整性校验", () => {
  const files = fs.readdirSync(ANCHORS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  const verdicts = { good: 0, bad: 0 };

  for (const file of files) {
    const content = fs.readFileSync(path.join(ANCHORS_DIR, file), "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.verdict === "good") verdicts.good++;
    if (fm.verdict === "bad") verdicts.bad++;
  }

  it("好锚点 14 条", () => {
    expect(verdicts.good).toBe(14);
  });

  it("坏锚点 12 条", () => {
    expect(verdicts.bad).toBe(12);
  });

  it("总计 26 条", () => {
    expect(verdicts.good + verdicts.bad).toBe(26);
  });
});
