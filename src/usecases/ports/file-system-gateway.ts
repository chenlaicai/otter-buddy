export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FileSystemGateway {
  /** 读取文件内容 */
  readFile(path: string): Promise<string>;
  /** 读取目录条目（不递归） */
  readDir(dir: string): Promise<DirEntry[]>;
  /** 检查文件是否存在 */
  exists(path: string): Promise<boolean>;
}
