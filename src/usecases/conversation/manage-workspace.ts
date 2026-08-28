import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

/** 工作区文件条目 */
export interface WorkspaceEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string; // 相对于工作区根目录的路径
}

/** 工作区文件内容 */
export interface WorkspaceFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

/** 单文件读取大小上限（字节）——超过此值截断并提示 */
const MAX_DISPLAY_FILE_SIZE_BYTES = 100 * 1024; // 100KB

/**
 * 工作区只读管理用例。
 * 提供目录列表和文件读取功能，用于前端工作区文件浏览。
 * 写操作仍由海獭 agent 工具（workspace_write）处理，不在本用例范围内。
 */
export class ManageWorkspace {
  constructor(private readonly workspaceGateway: WorkspaceGateway) {}

  /**
   * 列出工作区指定目录的条目
   * @param conversationId 对话 ID
   * @param relativePath 相对于工作区根目录的路径，默认为根目录
   * @returns 目录条目列表
   */
  async listDir(conversationId: string, relativePath?: string): Promise<WorkspaceEntry[]> {
    // 检查工作区是否存在
    const exists = await this.workspaceGateway.exists(conversationId);
    if (!exists) {
      return [];
    }

    const entries = await this.workspaceGateway.listDir(conversationId, relativePath);
    const basePath = relativePath || '';

    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      isFile: entry.isFile,
      path: basePath ? `${basePath}/${entry.name}` : entry.name,
    }));
  }

  /**
   * 读取工作区文件内容
   * @param conversationId 对话 ID
   * @param relativePath 相对于工作区根目录的文件路径
   * @returns 文件内容（可能截断）
   */
  async readFile(conversationId: string, relativePath: string): Promise<WorkspaceFileContent> {
    // 检查工作区是否存在
    const exists = await this.workspaceGateway.exists(conversationId);
    if (!exists) {
      throw new Error('工作区不存在');
    }

    // 读取文件内容（WorkspaceGateway 已有 1MB 大小限制）
    const content = await this.workspaceGateway.readFile(conversationId, relativePath);

    // 检查是否需要截断（显示层限制）
    const truncated = Buffer.byteLength(content, 'utf-8') > MAX_DISPLAY_FILE_SIZE_BYTES;
    const displayContent = truncated
      ? content.slice(0, MAX_DISPLAY_FILE_SIZE_BYTES) + '\n\n... [文件过大，已截断显示]'
      : content;

    return {
      path: relativePath,
      content: displayContent,
      truncated,
    };
  }

  /**
   * 获取工作区根目录路径
   * @param conversationId 对话 ID
   * @returns 工作区绝对路径
   */
  getWorkspacePath(conversationId: string): string {
    return this.workspaceGateway.getWorkspacePath(conversationId);
  }
}
