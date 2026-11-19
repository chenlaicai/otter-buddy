/**
 * check-dependency-sections 机械闸测试（依赖分区唯一性）。
 *
 * 覆盖：分区互斥（同一包多处出现必须报）、生产可安装（dependencies 的包在 lock 中
 * 带 dev 标记必须报）、通过路径、fail-closed（文件读不到 → exit 2）。
 *
 * 背景：线上部署实证（2026-11-19）——hono / @hono/node-server 同时列在 dependencies
 * 与 devDependencies，npm ci --omit=dev 跳过它们，ECS 部署后服务启动即
 * ERR_MODULE_NOT_FOUND。本地与 CI 都装 dev 依赖，所以全绿掩盖了故障。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEPENDENCY_SECTIONS,
  findSectionDuplicates,
  findDevFlaggedRuntimeDeps,
  checkDependencySections,
  type PackageJsonLike,
  type PackageLockLike,
} from "../../scripts/check-dependency-sections.mjs";

const SCRIPT = new URL("../../scripts/check-dependency-sections.mjs", import.meta.url).pathname;

/** 建临时目录写 package.json / package-lock.json，返回路径。 */
function fixture(pkg: PackageJsonLike, lock: PackageLockLike) {
  const dir = mkdtempSync(join(tmpdir(), "dep-sections-"));
  const pkgPath = join(dir, "package.json");
  const lockPath = join(dir, "package-lock.json");
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return { pkgPath, lockPath };
}

/** 跑脚本，返回 {code, stdout, stderr}。 */
function run(pkgPath: string, lockPath: string) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--package", pkgPath, "--lock", lockPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("分区互斥", () => {
  it("同一包写在 dependencies 与 devDependencies → 违规并列出两区", () => {
    const pkg = {
      dependencies: { hono: "^4.13.18", yaml: "^2.0.0" },
      devDependencies: { hono: "^4.13.18", vitest: "^3.0.0" },
    };
    expect(findSectionDuplicates(pkg)).toEqual([{ name: "hono", sections: ["dependencies", "devDependencies"] }]);
  });

  it("分区各写各的 → 零违规", () => {
    const pkg = {
      dependencies: { hono: "^4.13.18" },
      devDependencies: { vitest: "^3.0.0" },
      optionalDependencies: { "better-sqlite3": "^12.0.0" },
    };
    expect(findSectionDuplicates(pkg)).toEqual([]);
  });

  it("三区同列只报一条、区序稳定", () => {
    const pkg = {
      dependencies: { dup: "1.0.0" },
      devDependencies: { dup: "1.0.0" },
      peerDependencies: { dup: "1.0.0" },
    };
    expect(findSectionDuplicates(pkg)).toEqual([
      { name: "dup", sections: ["dependencies", "devDependencies", "peerDependencies"] },
    ]);
  });

  it("分区表缺失或非对象不抛异常（存量仓结构差异容错）", () => {
    expect(findSectionDuplicates({})).toEqual([]);
    expect(findSectionDuplicates({ dependencies: null as unknown as Record<string, string> })).toEqual([]);
  });

  it("参与判定的分区集合固定为四个", () => {
    expect(DEPENDENCY_SECTIONS).toEqual([
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]);
  });
});

describe("生产可安装（lock dev 标记）", () => {
  it("运行时包在 lock 中 dev=true → 违规", () => {
    const pkg = { dependencies: { hono: "^4.13.18" } };
    const lock = { packages: { "node_modules/hono": { version: "4.13.18", dev: true } } };
    expect(findDevFlaggedRuntimeDeps(pkg, lock)).toEqual([
      { name: "hono", entry: "node_modules/hono", version: "4.13.18" },
    ]);
  });

  it("运行时包无 dev 标记 → 通过", () => {
    const pkg = { dependencies: { hono: "^4.13.18" } };
    const lock = { packages: { "node_modules/hono": { version: "4.13.18" } } };
    expect(findDevFlaggedRuntimeDeps(pkg, lock)).toEqual([]);
  });

  it("lock 缺该条目 → 不在此断言范围（交给 npm ci 自己报）", () => {
    const pkg = { dependencies: { "inner-pkg": "^1.0.0" } };
    expect(findDevFlaggedRuntimeDeps(pkg, { packages: {} })).toEqual([]);
  });

  it("devDependencies 里的包带 dev 标记是正常的，不报", () => {
    const pkg = { devDependencies: { vitest: "^3.0.0" } };
    const lock = { packages: { "node_modules/vitest": { version: "3.0.0", dev: true } } };
    expect(findDevFlaggedRuntimeDeps(pkg, lock)).toEqual([]);
  });
});

describe("checkDependencySections 汇总", () => {
  it("两条断言都过 → ok", () => {
    const pkg = { dependencies: { hono: "^4.13.18" }, devDependencies: { vitest: "^3.0.0" } };
    const lock = { packages: { "node_modules/hono": { version: "4.13.18" } } };
    expect(checkDependencySections(pkg, lock)).toEqual({ ok: true, duplicates: [], devFlagged: [] });
  });

  it("任一条失败 → 不 ok（并同时返回两类违规，便于一次修完）", () => {
    const pkg = {
      dependencies: { hono: "^4.13.18", yaml: "^2.0.0" },
      devDependencies: { hono: "^4.13.18" },
    };
    const lock = { packages: { "node_modules/yaml": { version: "2.0.0", dev: true } } };
    const result = checkDependencySections(pkg, lock);
    expect(result.ok).toBe(false);
    expect(result.duplicates.map((d) => d.name)).toEqual(["hono"]);
    expect(result.devFlagged.map((d) => d.name)).toEqual(["yaml"]);
  });
});

describe("CLI 行为", () => {
  it("干净仓 → exit 0 且输出通过文案", () => {
    const pkg = { dependencies: { hono: "^4.13.18" }, devDependencies: { vitest: "^3.0.0" } };
    const lock = { packages: { "node_modules/hono": { version: "4.13.18" } } };
    const { pkgPath, lockPath } = fixture(pkg, lock);
    const result = run(pkgPath, lockPath);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("依赖分区唯一");
  });

  it("复现 #1956 形态 → exit 1 且报出包名与两个分区", () => {
    const pkg = {
      dependencies: { hono: "^4.13.18" },
      devDependencies: { hono: "^4.13.18" },
    };
    const lock = { packages: {} };
    const { pkgPath, lockPath } = fixture(pkg, lock);
    const result = run(pkgPath, lockPath);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("hono → dependencies + devDependencies");
  });

  it("package.json 不存在 → exit 2（fail-closed，不静默放行）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-sections-miss-"));
    const result = run(join(dir, "nope.json"), join(dir, "package-lock.json"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("读 package.json 失败");
  });
});
