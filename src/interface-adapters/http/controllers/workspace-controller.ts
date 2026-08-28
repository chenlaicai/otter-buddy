import type { Context } from "hono";
import type { ManageWorkspace } from "@usecases/conversation/manage-workspace";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";

/**
 * 工作区文件浏览控制器。
 * 提供只读 API：目录列表和文件内容读取。
 * 写操作仍由海獭 agent 工具处理，不在本控制器范围内。
 */
export class WorkspaceController {
  constructor(
    private readonly manageWorkspace: ManageWorkspace,
    private readonly logger: Logger,
  ) {}

  /**
   * GET /api/conversations/:id/workspace
   * 列出工作区目录内容
   * Query params:
   *   - path?: string - 相对于工作区根目录的路径，默认为根目录
   */
  async listDir(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const relativePath = c.req.query("path") || undefined;

      const entries = await this.manageWorkspace.listDir(conversationId, relativePath);
      return c.json({
        entries,
        basePath: relativePath || "",
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /**
   * GET /api/conversations/:id/workspace/file
   * 读取工作区文件内容
   * Query params:
   *   - path: string - 相对于工作区根目录的文件路径（必填）
   */
  async readFile(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const relativePath = c.req.query("path");

      if (!relativePath) {
        return c.json({ error: "path 参数必填" }, 400);
      }

      const fileContent = await this.manageWorkspace.readFile(conversationId, relativePath);
      return c.json(fileContent);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
