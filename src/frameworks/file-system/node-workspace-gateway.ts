import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

/** 单文件大小上限 1MB */
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * WorkspaceGateway 的 Node.js 文件系统实现。
 * 工作区根目录：dataDir/workspaces/{conversationId}/
 */
export class NodeWorkspaceGateway implements WorkspaceGateway {
  constructor(private readonly dataDir: string) {}

  private workspaceRoot(conversationId: string): string {
    return path.join(this.dataDir, "workspaces", conversationId);
  }

  /** 解析相对路径并校验不穿越工作区边界（含 symlink 真实路径校验） */
  private async resolveSafe(conversationId: string, relativePath: string): Promise<string> {
    const root = this.workspaceRoot(conversationId);
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error("Path traversal not allowed");
    }
    // 解析 root 本身的 symlink（macOS /var -> /private/var）
    const realRoot = await fs.realpath(root).catch(() => root);
    // 逐级解析已存在的祖先目录，防止 symlink 逃逸
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..")) return resolved; // 已被上面拦截，防御性返回
    const parts = rel.split(path.sep);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const real = await fs.realpath(current);
        if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
          throw new Error("Symlink escape not allowed");
        }
        // 如果解析后路径与当前不同，后续路径基于真实路径继续
        if (real !== current) current = real;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break; // 后续不存在，无 symlink 风险
        throw err;
      }
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
    const fullPath = await this.resolveSafe(conversationId, relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large (${stat.size} bytes, max ${MAX_FILE_SIZE_BYTES})`);
    }
    return fs.readFile(fullPath, "utf-8");
  }

  async writeFile(conversationId: string, relativePath: string, content: string): Promise<void> {
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_FILE_SIZE_BYTES) {
      throw new Error(`Content too large (${byteLength} bytes, max ${MAX_FILE_SIZE_BYTES})`);
    }
    const fullPath = await this.resolveSafe(conversationId, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }

  async listDir(
    conversationId: string,
    relativePath?: string,
  ): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> {
    const dir = relativePath
      ? await this.resolveSafe(conversationId, relativePath)
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
