/**
 * 对话工作区的文件系统操作网关。
 * 每个 Conversation 拥有一个沙箱目录，生命周期随对话走。
 * 所有 relativePath 参数为相对于工作区根目录的路径（不允许 .. 遍历）。
 */
export interface WorkspaceGateway {
  /** 创建工作区目录（幂等），返回绝对路径 */
  ensureWorkspace(conversationId: string): Promise<string>;
  /** 删除工作区目录及其全部内容 */
  removeWorkspace(conversationId: string): Promise<void>;
  /** 检查工作区是否存在 */
  exists(conversationId: string): Promise<boolean>;
  /** 读取文件内容（utf-8） */
  readFile(conversationId: string, relativePath: string): Promise<string>;
  /** 写入文件内容（自动创建中间目录） */
  writeFile(conversationId: string, relativePath: string, content: string): Promise<void>;
  /** 列出目录条目 */
  listDir(conversationId: string, relativePath?: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  /** 获取工作区绝对路径 */
  getWorkspacePath(conversationId: string): string;
  /** 获取文件/目录元数据（大小、修改时间等） */
  statFile(conversationId: string, relativePath: string): Promise<{ size: number; mtime: Date; isFile: boolean; isDirectory: boolean }>;
}
