import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import { handleError } from "../http-error";
import type { SkillListDTO } from "@contract/api/skill";

/**
 * #576（F20260901emps）：skill 目录的最小端口——返回 ResourceLoader 发现的 skill 集合。
 * F20260929scfx：扩展 body 字段（SKILL.md frontmatter 之后的正文全文）。
 */
export interface SkillDirectory {
  list(): Promise<{ name: string; description: string; body?: string }[]>;
}

/**
 * #576：能力库页面数据端点。
 * F20260929scfx：skill 项带正文全文（卷中·招式秘籍正文区数据源）。
 *
 * 数据源：pi-agent ResourceLoader（与 otter 实际加载一致），替代页面内静态快照。
 * 路由：GET /api/skills
 */
export class SkillController {
  constructor(
    private readonly skillDirectory: SkillDirectory,
    private readonly logger: Logger,
  ) {}

  async list(c: Context): Promise<Response> {
    try {
      const skills = await this.skillDirectory.list();
      const dto: SkillListDTO = {
        skills: skills.map((s) => ({ name: s.name, description: s.description, body: s.body ?? "" })),
      };
      return c.json(dto);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
