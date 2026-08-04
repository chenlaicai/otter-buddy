/**
 * F20260804dcnv: 磁盘 ID 扫描共享逻辑。
 *
 * 设计动机：之前 `SyncDocuments.collectDiskIds` 和 `HealthController.collectDiskIds`
 * 各自实现一份，且都用 `parseFrontmatterFromContent` 提 ID。缺 frontmatter 的文档
 * 会抛错被 catch 吞掉，导致 ID 既不在 diskIds 也不在 DB -- 双重消失，reconcile
 * 检测不到。F20260803vmsg 就是这种隐藏 bug 的实例。
 *
 * 修复：frontmatter 解析失败时，用文件名正则兜底提 ID。返回 `Map<id, filepath>`
 * 让下游能反查文件做二次校验（如 health 端点的 gapReasons）。
 *
 * 单一真相源：两处调用方共用此扫描器，避免盲区再次分裂。
 */
import * as path from "node:path";
import type { FileSystemGateway, DirEntry } from "@usecases/ports/file-system-gateway";
import { parseFrontmatterFromContent } from "@usecases/document/frontmatter-parse";

/** 文件名提 ID：F20260803vmsg-xxx.md / R20260716x2k9-xxx.md / F20260803vmsg.md */
const ID_FROM_FILENAME = /^([FR]\d{8}[a-z0-9]{3,8})(?:[-.]|$)/;

/**
 * 递归扫描 dir，返回 id -> 绝对文件路径 的映射。
 * frontmatter 缺失或损坏的文件走文件名兜底。
 */
export async function scanDiskIds(
  fs: FileSystemGateway,
  dir: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  await scanRec(fs, dir, ids);
  return ids;
}

async function scanRec(
  fs: FileSystemGateway,
  dir: string,
  ids: Map<string, string>,
): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await fs.readDir(dir);
  } catch {
    return; // 目录不存在
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanRec(fs, full, ids);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const id = await extractId(fs, full, entry.name);
    if (id) ids.set(id, full);
  }
}

async function extractId(
  fs: FileSystemGateway,
  fullPath: string,
  filename: string,
): Promise<string | null> {
  // 优先用 frontmatter（单一真相源；文件名只是兜底）
  try {
    const content = await fs.readFile(fullPath);
    const { frontmatter } = parseFrontmatterFromContent(content);
    if (typeof frontmatter.id === "string" && frontmatter.id) {
      return frontmatter.id;
    }
  } catch {
    // fall through to filename
  }
  // 兜底：从文件名提 ID（缺 frontmatter / frontmatter 损坏）
  const m = filename.match(ID_FROM_FILENAME);
  return m ? m[1] : null;
}
