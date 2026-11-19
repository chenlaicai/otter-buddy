import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

type FsPromises = typeof fs;

/** 单文件大小上限 1MB */
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

/** R-1：链式断链逐级 readlink 解析到最终缺失目标；深度上限对齐 OS ELOOP 常见配额 40，
 *  耗尽仍指向链接 = 循环/超深链，显式报错对齐 SDK 基线的 ELOOP（不静默替换链接）。 */
async function resolveBrokenLinkTarget(fs: FsPromises, linkPath: string): Promise<string> {
  let current = linkPath;
  for (let depth = 0; depth < 40; depth += 1) {
    const raw = await fs.readlink(current);
    current = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(current), raw);
    const next = await fs.lstat(current).catch(() => undefined);
    if (!next || !next.isSymbolicLink()) return current;
  }
  throw new Error(`symlink chain too deep or cyclic: ${linkPath}`);
}

/**
 * WorkspaceGateway 的 Node.js 文件系统实现。
 * 工作区根目录：dataDir/workspaces/{conversationId}/
 */
export class NodeWorkspaceGateway implements WorkspaceGateway {
  constructor(private readonly dataDir: string) {}

  private workspaceRoot(conversationId: string): string {
    // dataDir 可能是相对路径（app.ts 默认 "./data"），必须归一化为绝对路径：
    // resolveSafe 中 path.resolve() 的结果恒为绝对路径，与相对 root 做 startsWith
    // 比较恒为 false，会导致所有正常读写被误判为 path traversal（2026-08-26 故障）
    return path.resolve(this.dataDir, "workspaces", conversationId);
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

  /** Why: readFile 强制 utf-8，二进制（图片）读出乱码——图片预览需要原始字节 */
  async readFileBuffer(conversationId: string, relativePath: string): Promise<Buffer> {
    const fullPath = await this.resolveSafe(conversationId, relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large (${stat.size} bytes, max ${MAX_FILE_SIZE_BYTES})`);
    }
    return fs.readFile(fullPath);
  }

  async writeFile(conversationId: string, relativePath: string, content: string): Promise<void> {
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_FILE_SIZE_BYTES) {
      throw new Error(`Content too large (${byteLength} bytes, max ${MAX_FILE_SIZE_BYTES})`);
    }
    const fullPath = await this.resolveSafe(conversationId, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    // 原子写——同目录临时文件 → rename 原子落位，
    // 崩溃不留半截文件；已存在目标保留 mode；symlink 跟随写真实文件不替换链接；
    // broken symlink 回退 SDK 语义（穿透创建 referent），对齐 env 基线。
    let target = fullPath;
    let mode: number | undefined;
    try {
      const linkStat = await fs.lstat(target);
      if (linkStat.isSymbolicLink()) {
        try {
          target = await fs.realpath(target);
        } catch {
          // 链式断链：逐级 readlink 到最终缺失目标（深度上限防循环链），穿透创建 referent
          target = await resolveBrokenLinkTarget(fs, fullPath);
          await fs.mkdir(path.dirname(target), { recursive: true });
        }
      }
      const existingStat = await fs.stat(target).catch(() => undefined);
      mode = existingStat ? existingStat.mode & 0o777 : undefined;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("symlink chain")) throw error; // 链解析显式失败不吞
      /* 全新文件 */
    }
    const tmp = path.join(path.dirname(target), `.otter-tmp-${crypto.randomUUID()}`);
    try {
      await fs.writeFile(tmp, content, { encoding: "utf-8", mode: mode ?? 0o666 });
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
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

  async statFile(
    conversationId: string,
    relativePath: string,
  ): Promise<{ size: number; mtime: Date; isFile: boolean; isDirectory: boolean }> {
    const fullPath = await this.resolveSafe(conversationId, relativePath);
    const stat = await fs.stat(fullPath);
    return {
      size: stat.size,
      mtime: stat.mtime,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
    };
  }

  /**
   * 删除文件或目录。安全口径与读写同构 + 根保护：
   * - resolveSafe 拒绝路径穿越与 symlink 逃逸（与 readFile/writeFile 同一入口）
   * - 拒绝删除工作区根（relativePath 为空/. 时 resolved === root；整区回收是 removeWorkspace 的事，不走这里）
   * - lstat 口径判类型：symlink 按链接本身删除，不跟随目标
   * - 目录：空目录可直接删（rmdir）；非空目录必须 options.recursive=true（防止误删整树）
   */
  async deletePath(
    conversationId: string,
    relativePath: string,
    options?: { recursive?: boolean },
  ): Promise<{ deleted: "file" | "directory" }> {
    const root = this.workspaceRoot(conversationId);
    const fullPath = await this.resolveSafe(conversationId, relativePath);
    if (fullPath === root) {
      throw new Error("Refusing to delete workspace root");
    }
    const stat = await fs.lstat(fullPath);
    if (stat.isDirectory()) {
      if (options?.recursive) {
        await fs.rm(fullPath, { recursive: true, force: false });
      } else {
        try {
          await fs.rmdir(fullPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
            throw new Error("Directory not empty: pass recursive=true to delete the whole tree", { cause: err });
          }
          throw err;
        }
      }
      return { deleted: "directory" };
    }
    await fs.unlink(fullPath);
    return { deleted: "file" };
  }
}
