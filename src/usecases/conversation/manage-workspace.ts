import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { Logger } from "@usecases/ports/logger";
import { DomainError } from "@entities/errors";
// Why: Workspace DTO 单一真相源在 api-contract（issue #558）——本文件曾是定义处，
// 迁移后此处仅消费契约，与 controller / web 三侧靠双端 tsc 锁死漂移
import type { WorkspaceEntry, WorkspaceFileContent } from "@contract/api/workspace";
import { WORKSPACE_IMAGE_EXTENSIONS } from "@contract/api/workspace";

export type { WorkspaceEntry, WorkspaceFileContent };

/** 单文件读取大小上限（字节）——超过此值截断并提示 */
const MAX_DISPLAY_FILE_SIZE_BYTES = 100 * 1024; // 100KB

/**
 * 工作区只读管理用例。
 * 提供目录列表和文件读取功能，用于前端工作区文件浏览。
 * 写操作仍由海獭 agent 工具（workspace_write）处理，不在本用例范围内。
 */
export class ManageWorkspace {
  constructor(
    private readonly workspaceGateway: WorkspaceGateway,
    private readonly logger?: Logger,
  ) {}

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
   * @returns 文件内容（可能截断）。图片类扩展名返回 base64 编码（encoding: 'base64'），
   *          其余返回 utf-8 文本；truncated 逻辑只适用文本路径（F20261014pvmd）
   */
  async readFile(conversationId: string, relativePath: string): Promise<WorkspaceFileContent> {
    // 检查工作区是否存在
    const exists = await this.workspaceGateway.exists(conversationId);
    if (!exists) {
      throw new DomainError('工作区不存在', 'not_found');
    }

    // 扩展名提取要求存在点且不在首位（避免「名为 png 的无扩展名文本文件」误路由，F20261014pvmd）
    const base = relativePath.split('/').pop() ?? '';
    const dotIdx = base.lastIndexOf('.');
    const ext = dotIdx > 0 ? base.slice(dotIdx + 1).toLowerCase() : '';

    // 图片类扩展名：走二进制路径，返回 base64（truncated 逻辑不适用——图片按原始字节完整传输）
    if ((WORKSPACE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      const buf = await this.workspaceGateway.readFileBuffer(conversationId, relativePath);
      return {
        path: relativePath,
        content: buf.toString('base64'),
        truncated: false,
        encoding: 'base64',
      };
    }

    // 读取文件内容（WorkspaceGateway 已有 1MB 大小限制）
    const content = await this.workspaceGateway.readFile(conversationId, relativePath);

    // 检查是否需要截断（显示层限制，基于字节）
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    if (contentBytes > MAX_DISPLAY_FILE_SIZE_BYTES) {
      // 按字节截断，确保不在多字节 UTF-8 字符中间切开：
      // 1. 先取前 N 字节
      const buf = Buffer.from(content, 'utf-8');
      const truncatedBuf = buf.subarray(0, MAX_DISPLAY_FILE_SIZE_BYTES);
      // 2. 往回退到最近的 UTF-8 字符边界（continuation byte 0x80..0xBF 不是字符起始）
      let end = truncatedBuf.length;
      while (end > 0 && (truncatedBuf[end - 1] & 0xC0) === 0x80) {
        end--;
      }
      // 3. 如果截断点落在多字节序列起始字节上但序列不完整，也退掉该字节
      if (end > 0 && (truncatedBuf[end - 1] & 0xC0) === 0xC0) {
        end--;
      }
      return {
        path: relativePath,
        content: truncatedBuf.subarray(0, end).toString('utf-8') + '\n\n... [文件过大，已截断显示]',
        truncated: true,
      };
    }

    return {
      path: relativePath,
      content,
      truncated: false,
    };
  }

  /**
   * 获取工作区统计信息（文件数、总大小、top N 大文件）。
   * 用于收尾清理时评估工作区堆积状况。
   */
  async getWorkspaceStats(
    conversationId: string,
    topN: number = 10,
  ): Promise<{
    fileCount: number;
    totalSize: number;
    topFiles: Array<{ path: string; size: number }>;
  }> {
    const exists = await this.workspaceGateway.exists(conversationId);
    if (!exists) {
      return { fileCount: 0, totalSize: 0, topFiles: [] };
    }

    const allFiles: Array<{ path: string; size: number }> = [];

    // 递归遍历工作区
    const walk = async (dir: string) => {
      const entries = await this.workspaceGateway.listDir(conversationId, dir);
      for (const entry of entries) {
        const relPath = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await walk(relPath);
        } else if (entry.isFile) {
          try {
            const stat = await this.workspaceGateway.statFile(conversationId, relPath);
            allFiles.push({ path: relPath, size: stat.size });
          } catch {
            // 文件在遍历过程中被删除等异常，跳过
          }
        }
      }
    };

    await walk('');

    allFiles.sort((a, b) => b.size - a.size);

    return {
      fileCount: allFiles.length,
      totalSize: allFiles.reduce((sum, f) => sum + f.size, 0),
      topFiles: allFiles.slice(0, topN),
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

  /** F20261111clota：由 Otter 自己落 External 每会话 MCP 配置，App 无需任何数据目录写权限。
   * 只接受专属回环 HTTP server；不接受 command/args、外部 URL 或其他 server，避免管理端点变成任意执行入口。 */
  async writeExternalMcpConfig(conversationId: string, raw: unknown): Promise<void> {
    const config = validateExternalMcpConfig(raw);
    const workspace = this.getWorkspacePath(conversationId);
    const dataDir = path.dirname(path.dirname(workspace));
    assertNoGlobalExternalConflict(path.join(dataDir, 'sessions', 'mcp.json'), Object.keys(config.mcpServers)[0]!);
    assertRealWorkspaceDirectory(workspace);
    const file = path.join(workspace, 'mcp.json');
    if (isSameOwnedConfig(file, config)) {
      // Why: 幂等返回也必须收敛权限，旧 0644 文件不能继续暴露当前 bearer。
      fs.chmodSync(file, 0o600);
      return;
    }
    await writeExternalConfigAtomic(workspace, file, config);
  }

  /**
   * 在本机文件管理器中显示指定文件/目录。
   * macOS: `open -R <path>`（Reveal in Finder）
   * Windows: `explorer /select,<path>`
   * Linux: `xdg-open <parentDir>`（无原生 reveal，退化为打开所在目录）
   */
  async revealInFileManager(conversationId: string, relativePath: string): Promise<void> {
    this.validateRelativePath(relativePath);

    const exists = await this.workspaceGateway.exists(conversationId);
    if (!exists) {
      throw new DomainError('工作区不存在', 'not_found');
    }

    // Why: statFile 内部走 gateway 的 resolveSafe（含 symlink 逃逸检测），
    // 不存在则抛异常——用例层不重复做 path.resolve + realpath 校验
    try {
      await this.workspaceGateway.statFile(conversationId, relativePath);
    } catch {
      throw new DomainError('文件或目录不存在', 'not_found');
    }

    const root = this.workspaceGateway.getWorkspacePath(conversationId);
    const resolved = path.resolve(root, relativePath);
    this.spawnReveal(resolved, conversationId);
  }

  private validateRelativePath(relativePath: string): void {
    if (path.isAbsolute(relativePath)) {
      throw new DomainError('路径不允许为绝对路径', 'validation');
    }
    if (relativePath.split('/').some(p => p === '..' || p === '.')) {
      throw new DomainError('路径不允许包含 .. 或 . 段', 'validation');
    }
  }

  /** Why: 平台分发 + spawn 逻辑抽出，控 revealInFileManager 语句数 */
  private spawnReveal(resolved: string, conversationId: string): void {
    const platform = process.platform;
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';
    const cmd = isMac ? 'open' : isWin ? 'explorer' : 'xdg-open';
    const args = isMac ? ['-R', resolved]
      : isWin ? ['/select,', resolved]
      : [path.dirname(resolved)];

    // Why: Linux 无 xdg-open 时 fail-fast —— headless server 常态，503 诚实失败优于静默吞错
    if (!isMac && !isWin) {
      try {
        execSync('which xdg-open', { stdio: 'ignore' });
      } catch {
        throw new DomainError('当前环境不支持打开文件管理器（缺少 xdg-open）', 'validation');
      }
    }

    // Why: detached + unref —— 不阻塞 Node 进程，子进程生命周期独立
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      child.on('error', (err) => {
        this.logger?.error('revealInFileManager: 子进程启动失败', err, { cmd, args, conversationId });
      });
    } catch (err) {
      this.logger?.error('revealInFileManager: spawn 失败', err instanceof Error ? err : undefined, { cmd, args, conversationId });
    }
  }
}

type McpConfigFile = { mcpServers?: Record<string, { headers?: { authorization?: unknown } }> };
type ExternalMcpServer = {
  url: string;
  headers: { authorization: string };
  exposure: 'direct';
  timeout: number;
};
type ExternalMcpConfig = { mcpServers: Record<string, ExternalMcpServer> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalJson(file: string): McpConfigFile | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DomainError('OTTER_MCP_CONFIG_INVALID', 'conflict');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(descriptor, 'utf8')); } finally { fs.closeSync(descriptor); }
    if (!isObject(value)) throw new DomainError('OTTER_MCP_CONFIG_INVALID', 'conflict');
    return value as McpConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof DomainError) throw error;
    throw new DomainError('OTTER_MCP_CONFIG_INVALID', 'conflict');
  }
}

function invalidExternalConfig(): never {
  throw new DomainError('OTTER_EXTERNAL_MCP_CONFIG_INVALID', 'validation');
}

function validateExternalUrl(raw: unknown): string {
  if (typeof raw !== 'string') invalidExternalConfig();
  let url: URL;
  try { url = new URL(raw); } catch { invalidExternalConfig(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) invalidExternalConfig();
  return raw;
}

function validateTimeout(raw: unknown): number {
  if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > 300) invalidExternalConfig();
  return raw as number;
}

function validateAuthorization(raw: unknown): string {
  if (!isObject(raw) || Object.keys(raw).length !== 1 || typeof raw.authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(raw.authorization)) invalidExternalConfig();
  return raw.authorization;
}

function validateExternalMcpConfig(raw: unknown): ExternalMcpConfig {
  if (!isObject(raw) || Object.keys(raw).length !== 1 || !isObject(raw.mcpServers)) invalidExternalConfig();
  const servers = raw.mcpServers;
  const entry = Object.entries(servers)[0];
  if (Object.keys(servers).length !== 1 || !entry) invalidExternalConfig();
  const [name, server] = entry;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || !isObject(server)) invalidExternalConfig();
  if (Object.keys(server).sort().join(',') !== 'exposure,headers,timeout,url' || server.exposure !== 'direct') invalidExternalConfig();
  return {
    mcpServers: {
      [name]: {
        url: validateExternalUrl(server.url),
        headers: { authorization: validateAuthorization(server.headers) },
        exposure: 'direct',
        timeout: validateTimeout(server.timeout),
      },
    },
  };
}

function assertNoGlobalExternalConflict(file: string, serverName: string): void {
  const global = readOptionalJson(file);
  if (global?.mcpServers && typeof global.mcpServers === 'object' && serverName in global.mcpServers) {
    throw new DomainError('OTTER_GLOBAL_MCP_CONFIG_CONFLICT', 'conflict');
  }
}

function assertRealWorkspaceDirectory(workspace: string): void {
  if (!fs.existsSync(workspace)) return;
  const stat = fs.lstatSync(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DomainError('OTTER_MCP_WORKSPACE_INVALID', 'conflict');
}

function isSameOwnedConfig(file: string, config: ExternalMcpConfig): boolean {
  const existing = readOptionalJson(file);
  if (!existing) return false;
  const servers = existing.mcpServers;
  const [serverName, server] = Object.entries(config.mcpServers)[0]!;
  const token = server.headers.authorization;
  if (!servers || Object.keys(servers).length !== 1 || servers[serverName]?.headers?.authorization !== token) {
    throw new DomainError('OTTER_MCP_CONFIG_CONFLICT', 'conflict');
  }
  return JSON.stringify(existing) === JSON.stringify(config);
}

async function writeExternalConfigAtomic(workspace: string, file: string, config: ExternalMcpConfig): Promise<void> {
  await fs.promises.mkdir(workspace, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Why: 随机名 + wx 独占创建，工作区内预置 symlink/文件不能劫持 Otter 写权限。
    await fs.promises.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, file);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
