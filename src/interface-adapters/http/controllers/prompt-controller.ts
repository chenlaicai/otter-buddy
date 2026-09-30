import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import { handleError } from "../http-error";
import type { PromptBundleDTO } from "@contract/api/prompt";

/**
 * F20260929scfx：能力库全书——系统提示词与工具清单端口。
 *
 * system: .pi/SYSTEM.md 按二级标题（## ）切分为 sections。
 * tools: 无条件注册的基础工具集（name + description，不含 inputSchema）。
 * 注意：本端点无鉴权，供本地面板展示用；若 web 端口暴露非本机访问需加鉴权层。
 */
export interface PromptDirectory {
  getSystemSections(): Promise<Array<{ title: string; content: string }>>;
  listTools(): Promise<Array<{ name: string; description: string }>>;
}

/**
 * F20260929scfx：卷首·心法总纲 + 卷末·兵器谱数据源。
 *
 * 路由：GET /api/prompts
 */
export class PromptController {
  constructor(
    private readonly promptDirectory: PromptDirectory,
    private readonly logger: Logger,
  ) {}

  async list(c: Context): Promise<Response> {
    try {
      const [system, tools] = await Promise.all([
        this.promptDirectory.getSystemSections(),
        this.promptDirectory.listTools(),
      ]);
      const dto: PromptBundleDTO = { system, tools };
      return c.json(dto);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
