import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 技能定义 */
export interface Skill {
  name: string;
  description: string;
  content: string;
}

/** Otter 类型到技能名称的映射 */
export interface SkillConfig {
  otterType: string;
  skillNames: string[];
}

/**
 * 技能加载器：扫描指定目录下的 SKILL.md 文件，按 Otter 类型过滤。
 * 薄封装，为 agent-runtime 的 system prompt 构建提供服务。
 */
export class SkillLoader {
  constructor(
    private readonly skillsDir: string,
    private readonly configs: SkillConfig[] = [],
  ) {}

  /** 加载指定 Otter 类型的技能 */
  loadSkillsForOtterType(otterType: string): Skill[] {
    const config = this.configs.find((c) => c.otterType === otterType);
    if (!config) return [];

    const allSkills = this.loadAllSkills();
    /** skillNames 为空时返回全部技能（通配符语义） */
    if (config.skillNames.length === 0) return allSkills;
    return allSkills.filter((s) => config.skillNames.includes(s.name));
  }

  /** 扫描目录，加载所有 SKILL.md 文件 */
  private loadAllSkills(): Skill[] {
    if (!existsSync(this.skillsDir)) {
      return [];
    }

    const skills: Skill[] = [];
    const entries = readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(this.skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, "utf-8");
      skills.push({
        name: entry.name,
        description: this.extractDescription(content),
        content,
      });
    }

    return skills;
  }

  /** 从 SKILL.md 内容中提取描述（第一段非标题文本） */
  private extractDescription(content: string): string {
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return trimmed;
      }
    }
    return "";
  }
}
