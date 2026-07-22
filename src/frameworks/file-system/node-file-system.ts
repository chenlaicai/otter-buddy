import * as fs from "fs/promises";
import type { FileSystemGateway, DirEntry } from "@usecases/ports/file-system-gateway";

export class NodeFileSystem implements FileSystemGateway {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  async readDir(dir: string): Promise<DirEntry[]> {
    return fs.readdir(dir, { withFileTypes: true });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
