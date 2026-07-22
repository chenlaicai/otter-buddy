import * as yaml from "yaml";

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  content: string;
}

/**
 * 从 markdown 内容中解析 frontmatter（纯函数，无 IO）
 * 依赖 yaml 第三方库，但 yaml.parse 是纯函数，usecases 层可以使用
 */
export function parseFrontmatterFromContent(content: string): ParsedFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Missing frontmatter");
  }
  const frontmatter = yaml.parse(match[1]);
  const body = match[2];
  return { frontmatter, content: body };
}
