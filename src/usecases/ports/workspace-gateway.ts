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
  /** 读取文件原始字节（二进制安全，用于图片类内容，F20261014pvmd） */
  readFileBuffer(conversationId: string, relativePath: string): Promise<Buffer>;
  /** 写入文件内容（自动创建中间目录） */
  writeFile(conversationId: string, relativePath: string, content: string): Promise<void>;
  /** 列出目录条目 */
  listDir(conversationId: string, relativePath?: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  /** 获取工作区绝对路径 */
  getWorkspacePath(conversationId: string): string;
  /** 获取文件/目录元数据（大小、修改时间等） */
  statFile(conversationId: string, relativePath: string): Promise<{ size: number; mtime: Date; isFile: boolean; isDirectory: boolean }>;
  /**
   * 删除工作区内的文件或目录（#1484 临时件回收机械路径）。
   * 安全边界与读写同构（resolveSafe：路径穿越/symlink 逃逸拒绝），另拒绝删除工作区根。
   * 目录语义：空目录可直接删；非空目录须 options.recursive=true 整树删除。
   * @returns 实际删除的条目类型（lstat 口径——symlink 按链接本身删除，不跟随目标）
   */
  deletePath(
    conversationId: string,
    relativePath: string,
    options?: { recursive?: boolean },
  ): Promise<{ deleted: "file" | "directory" }>;
}
