/**
 * F20260804dcnv: disk-id-scanner 共享 scanner 测试
 *
 * 覆盖：frontmatter 优先、文件名兜底、缺 frontmatter 文档不双重消失、
 * 非字符串 id 跳过、Map 冲突警告。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { scanDiskIds } from "@usecases/document/disk-id-scanner";
import type { FileSystemGateway, DirEntry } from "@usecases/ports/file-system-gateway";
import { createCapturingLogger } from "../../helpers/logger";

function mkFile(name: string): DirEntry {
  return { name, isDirectory: () => false, isFile: () => true };
}
function mkDir(name: string): DirEntry {
  return { name, isDirectory: () => true, isFile: () => false };
}


function makeFs(files: Record<string, string>): FileSystemGateway {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    readDir: vi.fn(async (dir: string) => {
      // 把 dir 当 prefix，返回直接位于该目录下的 .md 文件
      const entries: DirEntry[] = [];
      const seen = new Set<string>();
      for (const fullPath of Object.keys(files)) {
        if (!fullPath.startsWith(dir + "/")) continue;
        const rest = fullPath.slice(dir.length + 1);
        if (rest.includes("/")) continue; // 跳过子目录里的
        if (seen.has(rest)) continue;
        seen.add(rest);
        entries.push(mkFile(rest));
      }
      return entries;
    }),
    exists: vi.fn(async () => true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("disk-id-scanner - F20260804dcnv", () => {
  it("frontmatter 有 id 时优先用 frontmatter（单一真相源）", async () => {
    const fs = makeFs({
      "docs/features/F20260804abcd-title.md":
        "---\nid: F20260804abcd\ntitle: t\nsummary: s\n---\nbody",
    });
    const map = await scanDiskIds(fs, "docs/features");
    expect(map.size).toBe(1);
    expect(map.has("F20260804abcd")).toBe(true);
    expect(map.get("F20260804abcd")).toBe("docs/features/F20260804abcd-title.md");
  });

  it("frontmatter 缺失时走文件名兜底，文档不再双重消失", async () => {
    const fs = makeFs({
      "docs/features/F20260804vmsg-foo.md": "# F20260804vmsg: 标题\nbody\n",
    });
    const map = await scanDiskIds(fs, "docs/features");
    // 修复前：parseFrontmatterFromContent 抛错被吞，map 为空
    // 修复后：文件名正则提 ID，map 有这条
    expect(map.size).toBe(1);
    expect(map.has("F20260804vmsg")).toBe(true);
  });

  it("frontmatter id 为非字符串时跳过，走文件名兜底", async () => {
    const fs = makeFs({
      "docs/features/F20260804num-x.md":
        "---\nid: 12345\ntitle: t\n---\nbody",
    });
    const map = await scanDiskIds(fs, "docs/features");
    expect(map.size).toBe(1);
    // 文件名兜底提 F20260804num，frontmatter 的数字 id 不用
    expect(map.has("F20260804num")).toBe(true);
  });

  it("文件名不含合法 ID 模式时返回 null，不进 map", async () => {
    const fs = makeFs({
      "docs/features/README.md": "# README\n",
    });
    const map = await scanDiskIds(fs, "docs/features");
    expect(map.size).toBe(0);
  });

  it("R 前缀文件名同样兜底", async () => {
    const fs = makeFs({
      "docs/research/R20260716x2k9-foo.md": "# R20260716x2k9\nbody",
    });
    const map = await scanDiskIds(fs, "docs/research");
    expect(map.size).toBe(1);
    expect(map.has("R20260716x2k9")).toBe(true);
  });

  it("目录不存在时返回空 map，不抛错", async () => {
    const fs: FileSystemGateway = {
      readFile: vi.fn(), readDir: vi.fn(async () => { throw new Error("ENOENT"); }),
      exists: vi.fn(async () => false),
    };
    const map = await scanDiskIds(fs, "docs/nonexistent");
    expect(map.size).toBe(0);
  });

  it("递归进入子目录找 .md 文件（scanRec 核心路径）", async () => {
    // 用真实目录层级结构模拟：docs/features/2026/08/04/F...md
    const fs: FileSystemGateway = {
      readFile: vi.fn(async () => "---\nid: F20260804abcd\ntitle: t\nsummary: s\n---\n"),
      readDir: vi.fn(async (dir: string) => {
        if (dir === "docs/features") return [mkDir("2026")];
        if (dir === "docs/features/2026") return [mkDir("08")];
        if (dir === "docs/features/2026/08") return [mkDir("04")];
        if (dir === "docs/features/2026/08/04") return [mkFile("F20260804abcd-x.md")];
        return [];
      }),
      exists: vi.fn(async () => true),
    };
    const map = await scanDiskIds(fs, "docs/features");
    expect(map.size).toBe(1);
    expect(map.get("F20260804abcd")).toBe("docs/features/2026/08/04/F20260804abcd-x.md");
  });

  it("同 ID 冲突（两份文件 frontmatter 都损坏、文件名 ID 相同）走 logger.warn，后者覆盖", async () => {
    const logger = createCapturingLogger();
    const fs: FileSystemGateway = {
      readFile: vi.fn(async () => "no frontmatter"),
      readDir: vi.fn(async (dir: string) => {
        if (dir === "docs/features") {
          return [
            mkFile("F20260804dup-foo.md"),
            mkFile("F20260804dup-bar.md"),
          ];
        }
        return [];
      }),
      exists: vi.fn(async () => true),
    };
    const map = await scanDiskIds(fs, "docs/features", logger);
    expect(map.size).toBe(1);
    // 断言 warn 的内容（不绑定调用次数--避免绑定实现细节）
    expect(logger.captured.warns.some(w => /ID 冲突/.test(w))).toBe(true);
  });

  it("不传 logger 时静默处理冲突，不抛错", async () => {
    const fs: FileSystemGateway = {
      readFile: vi.fn(async () => "no frontmatter"),
      readDir: vi.fn(async (dir: string) => {
        if (dir === "docs/features") {
          return [
            mkFile("F20260804dup-foo.md"),
            mkFile("F20260804dup-bar.md"),
          ];
        }
        return [];
      }),
      exists: vi.fn(async () => true),
    };
    // 不传 logger，不应抛错
    const map = await scanDiskIds(fs, "docs/features");
    expect(map.size).toBe(1);
  });
});
