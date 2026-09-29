import * as fs from "node:fs";
import * as path from "node:path";
import { stripFrontmatter } from "@frameworks/agent/prompt-loader";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";

/**
 * 仓根定位：本文件编译产物在 <repoRoot>/dist/src/frameworks/agent/（生产 main.js 从 dist/src 起），
 * 向上四级即仓根。alpha 实例 cwd 是数据根（非仓根），不能用 process.cwd()——import.meta.dirname
 * 锚定编译产物位置，跨启动方式（主仓/alpha/worktree）稳定。
 * 兜底：dist 路径不存在时退回 process.cwd()。
 */
function resolveRepoRoot(): string {
  const anchor = path.resolve(import.meta.dirname, "..", "..", "..", "..");
  return fs.existsSync(path.join(anchor, ".pi", "SYSTEM.md")) ? anchor : process.cwd();
}

/**
 * F20260929scfx：能力库全书数据源辅助——skill 正文与 SYSTEM.md 分节的文件读取。
 * 从 app.ts 拆出（lint max-lines）：失败均降级空值，不抛错（页面该节只少内容，不整页消失）。
 */

/** 按约定路径读 skill 正文（frontmatter 之后全文）。读失败降级 ''。 */
export function readSkillBody(name: string): string {
  try {
    const filePath = path.resolve(resolveRepoRoot(), ".pi/skills", name, "SKILL.md");
    if (!fs.existsSync(filePath)) return "";
    return stripFrontmatter(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return "";
  }
}

/**
 * 读 .pi/SYSTEM.md 并按二级标题（## ）切分为 sections。
 * 文件缺失/读失败降级空数组；frontmatter 剥离后首个 ## 之前的引言归第一编。
 */
export function readSystemSections(): Array<{ title: string; content: string }> {
  try {
    const filePath = path.resolve(resolveRepoRoot(), ".pi/SYSTEM.md");
    if (!fs.existsSync(filePath)) return [];
    const raw = stripFrontmatter(fs.readFileSync(filePath, "utf-8"));
    return splitByH2(raw);
  } catch {
    return [];
  }
}

/** 按 ## 二级标题切分 markdown；行内锚点（## 标题 {#id}）剥为纯标题 */
function splitByH2(markdown: string): Array<{ title: string; content: string }> {
  const lines = markdown.split("\n");
  const sections: Array<{ title: string; content: string }> = [];
  let current: { title: string; content: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].replace(/\s*\{[^}]*\}\s*$/, "").trim(), content: "" };
    } else if (current) {
      current.content += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ title: s.title, content: s.content.trim() }));
}

/** 工具清单聚合：createTools 真实全集的 name+description 摘要（不取 inputSchema）。 */
export function listAllToolSummaries(): Array<{ name: string; description: string }> {
  return createTools({ client: undefined as never, otterId: "", conversationId: "" } as never).map(
    (t) => ({ name: t.name, description: t.description }),
  );
}
