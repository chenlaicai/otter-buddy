import { readFileSync, existsSync } from "node:fs";

/**
 * 加载 prompt 文件（身份文案、平台 prompt 等）。
 * 支持 YAML frontmatter（--- 分隔），返回 frontmatter 之后的正文内容。
 * 文件不存在时返回 null。
 */
export function loadPromptFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  return stripFrontmatter(raw);
}

/** 剥离 YAML frontmatter，返回正文 */
function stripFrontmatter(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return content;

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return content;

  return trimmed.slice(endIndex + 4).trimStart();
}
