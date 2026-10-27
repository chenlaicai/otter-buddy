import * as fs from "node:fs";
import * as path from "node:path";
import { DomainError } from "@entities/errors";
import { sniffType } from "@usecases/conversation/upload-validation";

export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
const CURRENT_FILE = "current";
const TEMP_FILE = ".current.tmp";

export interface StoredBackground {
  buffer: Buffer;
  mimeType: string;
  version: string;
}

/** 应用启动目录下的单一背景资产；文件存在与否即持久化状态，不另建 DB/浏览器副本。 */
export class BackgroundStore {
  constructor(private readonly directory: string) {}

  private currentPath(): string {
    return path.join(this.directory, CURRENT_FILE);
  }

  async save(dataUrl: string): Promise<{ version: string }> {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
    if (!match) throw new DomainError("仅支持 JPG、PNG 或 WebP 图片", "validation");
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > MAX_BACKGROUND_BYTES) throw new DomainError("图片不能超过 8 MB", "validation");
    if (buffer.length === 0 || !this.isCanonicalBase64(match[2], buffer)) {
      throw new DomainError("图片 base64 数据无效", "validation");
    }
    const detected = sniffType(buffer.subarray(0, 65536), "background");
    if (!detected || detected.kind !== "image" || detected.mimeType !== match[1]) {
      throw new DomainError("图片内容与声明格式不一致或已损坏", "validation");
    }

    fs.mkdirSync(this.directory, { recursive: true });
    const tempPath = path.join(this.directory, TEMP_FILE);
    // Why: temp + rename，进程中断不会留下半张 current；文件名不含用户输入。
    fs.writeFileSync(tempPath, buffer, { mode: 0o600 });
    fs.renameSync(tempPath, this.currentPath());
    return { version: `${Date.now()}-${buffer.length}` };
  }

  read(): StoredBackground | null {
    const filePath = this.currentPath();
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const detected = sniffType(buffer.subarray(0, 65536), "background");
    // Why: 磁盘值也可能是手工改坏的；坏资产不当图片返回，由默认画布回退。
    if (!detected || detected.kind !== "image" || buffer.length > MAX_BACKGROUND_BYTES) return null;
    const stat = fs.statSync(filePath);
    return { buffer, mimeType: detected.mimeType, version: `${stat.mtimeMs}-${stat.size}` };
  }

  remove(): void {
    try { fs.unlinkSync(this.currentPath()); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private isCanonicalBase64(encoded: string, buffer: Buffer): boolean {
    return buffer.toString("base64") === encoded;
  }
}
