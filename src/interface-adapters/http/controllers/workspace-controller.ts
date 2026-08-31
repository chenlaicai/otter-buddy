import type { Context } from "hono";
import type { ManageWorkspace } from "@usecases/conversation/manage-workspace";
import type { Logger } from "@usecases/ports/logger";
import { HttpError, handleError, param } from "../http-error";

/** 合法 conversationId 的正则：UUID 格式，杜绝路径分隔符和 .. 逃逸 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /** 校验 conversationId 为合法 UUID，拒绝含路径分隔符/.. 的值 */
  private validateConversationId(id: string): string {
    if (!UUID_RE.test(id)) {
      throw new HttpError("非法的 conversationId 格式", 400);
    }
    return id;
  }

  /**
   * GET /api/conversations/:id/workspace
   * 列出工作区目录内容
   * Query params:
   *   - path?: string - 相对于工作区根目录的路径，默认为根目录
   */
  async listDir(c: Context): Promise<Response> {
    try {
      const conversationId = this.validateConversationId(param(c, "id"));
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
   * GET /api/conversations/:id/workspace/stats
   * 获取工作区统计信息（文件数、总大小、top N 大文件）
   * Query params:
   *   - top?: number - top N 大文件数量，默认 10
   */
  async getStats(c: Context): Promise<Response> {
    try {
      const conversationId = this.validateConversationId(param(c, "id"));
      const topN = parseInt(c.req.query("top") || "10", 10);

      const stats = await this.manageWorkspace.getWorkspaceStats(
        conversationId,
        isNaN(topN) ? 10 : Math.max(0, Math.min(topN, 50)),
      );
      return c.json(stats);
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
      const conversationId = this.validateConversationId(param(c, "id"));
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
