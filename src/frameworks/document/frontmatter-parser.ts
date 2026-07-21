import * as yaml from "yaml";
import * as fs from "fs/promises";

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  content: string;
}

export async function parseFrontmatter(filePath: string): Promise<ParsedFrontmatter> {
  const raw = await fs.readFile(filePath, "utf-8");

  // 允许 --- 后有可选空格
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Missing frontmatter in ${filePath}`);
  }

  const frontmatter = yaml.parse(match[1]);
  const content = match[2];

  return { frontmatter, content };
}
