import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

/**
 * WorkspaceGateway 的 Node.js 文件系统实现。
 * 工作区根目录：dataDir/workspaces/{conversationId}/
 */
export class NodeWorkspaceGateway implements WorkspaceGateway {
  constructor(private readonly dataDir: string) {}

  private workspaceRoot(conversationId: string): string {
    return path.join(this.dataDir, "workspaces", conversationId);
  }

  /** 解析相对路径并校验不穿越工作区边界 */
  private resolveSafe(conversationId: string, relativePath: string): string {
    const root = this.workspaceRoot(conversationId);
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error("Path traversal not allowed");
    }
    return resolved;
  }

  async ensureWorkspace(conversationId: string): Promise<string> {
    const dir = this.workspaceRoot(conversationId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async removeWorkspace(conversationId: string): Promise<void> {
    const dir = this.workspaceRoot(conversationId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async exists(conversationId: string): Promise<boolean> {
    try {
      await fs.access(this.workspaceRoot(conversationId));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(conversationId: string, relativePath: string): Promise<string> {
    return fs.readFile(this.resolveSafe(conversationId, relativePath), "utf-8");
  }

  async writeFile(conversationId: string, relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafe(conversationId, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }

  async listDir(
    conversationId: string,
    relativePath?: string,
  ): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> {
    const dir = relativePath
      ? this.resolveSafe(conversationId, relativePath)
      : this.workspaceRoot(conversationId);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  }

  getWorkspacePath(conversationId: string): string {
    return this.workspaceRoot(conversationId);
  }
}
