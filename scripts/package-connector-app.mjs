#!/usr/bin/env node
/**
 * connector 可执行安装包打包器——免 CLI 首启分发。
 *
 * 产出：packages/connector/release/otter-connector-<os>-<version>.zip
 *   OtterConnector.command   双击启动器（Finder 双击 → Terminal 打开，向导式首启）
 *   runtime/node             内嵌 Node 运行时（构建机 process.execPath 副本；
 *                            darwin 上通常是 x64+arm64 通用二进制——一个包服务两种 Mac）
 *   app/dist/…               connector 构建产物（与 npm tarball 同源）
 *   app/node_modules/…       运行时依赖闭包（ws / better-sqlite3(含全平台 prebuilds)
 *                            / @earendil-works/* —— 按各包 dependencies BFS 收集）
 *
 * 同步产出 <zip>.sha256 清单（hash:… 一行）供分发核对。
 *
 * 诚实边界（不冒充桌面应用）：
 * - 未签名/未公证——下载解压后首次双击可能被 Gatekeeper 拦，右键打开或系统设置放行；
 * - Terminal 向导式交互，不是 .app/.dmg GUI；
 * - 包平台 = 构建机平台（hub 部署机为谁构建，设备侧就拿到谁的运行时）。
 *
 * 打包期自证（fail-closed）：
 * 1. 版本一致性（packages/connector vs 主仓，防漂移——与 package-connector.mjs 同规）；
 * 2. 冒烟：用**内嵌** node 在隔离 HOME 下跑 staged main.js（无参、非 TTY），
 *    必须 exit 2 + usage——证明运行时/产物/依赖闭包三者自洽（ESM import 全链 eager 解析），
 *    且隔离 HOME 防止误连真实中枢。
 *
 * 前置：npm run build:connector 已跑（产物过闭包断言）。
 * 用法：node scripts/package-connector-app.mjs
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const pkgDir = path.resolve("packages/connector");
const mainJs = path.join(pkgDir, "dist", "connector", "main.js");

const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const root = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.version !== root.version) {
  console.error(`[package-connector-app] 版本漂移：packages/connector ${pkg.version} ≠ 主仓 ${root.version}——同步后再打包`);
  process.exit(1);
}
if (!existsSync(mainJs)) {
  console.error(`[package-connector-app] 产物缺失：${mainJs} 不存在——先 npm run build:connector`);
  process.exit(1);
}

const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
const archLabel = process.platform === "darwin" ? "universal" : process.arch;
const zipName = `otter-connector-${platform}-${archLabel}-${pkg.version}.zip`;

/** exports map 解析（简化版：string/条件 dict/无 exports 三形态）——返回包内文件绝对路径 */
function resolveSubpath(pkgDir, subpath) {
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const exports = manifest.exports;
  if (exports === undefined) {
    return path.join(pkgDir, subpath);
  }
  const key = subpath.startsWith(".") ? subpath : `./${subpath}`;
  const entry = typeof exports === "object" && exports !== null ? exports[key] : undefined;
  if (typeof entry === "string") return path.join(pkgDir, entry);
  if (entry && typeof entry === "object") {
    for (const cond of ["import", "default", "require", "node"]) {
      if (typeof entry[cond] === "string") return path.join(pkgDir, entry[cond]);
    }
  }
  if (subpath === "." ) {
    const main = typeof exports === "object" ? exports["."] : undefined;
    if (typeof main === "string") return path.join(pkgDir, main);
    if (main && typeof main === "object") {
      for (const cond of ["import", "default", "require"]) {
        if (typeof main[cond] === "string") return path.join(pkgDir, main[cond]);
      }
    }
  }
  return null;
}

function importSpecsOf(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  const patterns = [/from\s+["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']\s*\)/g, /require\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

/** 运行时依赖闭包：从 dist 产物实际 import 图出发做**文件级**追踪，收集触达的外部包。
 *  （包级 BFS 会把 pi-durable→pi-ai→AWS/Anthropic/OpenAI SDK 全家拖进来——实测
 *  98MB zip；而文件级追踪只触达 ws/better-sqlite3/pi-durable/chord 四包。）
 *  触达的包**整个**拷入（防 lazy require 内部相对路径断链），未触达的传递依赖不拷。
 *  触达包自身的 declared dependencies 若未被文件级触达，也不拷——运行面没用到。 */
function collectRuntimePackages(distRoot, nodeModulesDir) {
  const seenFiles = new Set();
  const touchedPackages = new Set();
  const missing = [];
  const queue = [path.join(distRoot, "connector", "main.js")];
  const tryFile = (f) => {
    if (existsSync(f) && statSync(f).isFile()) return f;
    return null;
  };
  const resolveRelative = (fromFile, spec) => {
    const base = path.resolve(path.dirname(fromFile), spec);
    return tryFile(base) ?? tryFile(`${base}.js`) ?? tryFile(`${base}.mjs`) ?? tryFile(`${base}.cjs`) ?? tryFile(path.join(base, "index.js")) ?? tryFile(path.join(base, "index.mjs"));
  };
  while (queue.length > 0) {
    const file = queue.pop();
    if (seenFiles.has(file)) continue;
    if (!existsSync(file)) {
      missing.push(file);
      continue;
    }
    seenFiles.add(file);
    for (const spec of importSpecsOf(file)) {
      if (spec.startsWith("node:") || isBuiltin(spec)) continue;
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (resolved) queue.push(resolved);
        else missing.push(`${spec} (from ${file})`);
        continue;
      }
      const parts = spec.split("/");
      const root = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      const sub = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
      const pkgDir = path.join(nodeModulesDir, root);
      if (!existsSync(path.join(pkgDir, "package.json"))) {
        // ws 的可选加速件 bufferutil/utf-8-validate（peer/optionalDependencies 形态）未装属预期
        // ——ws 有 try/catch 纯 JS 回退。判据：触达包声明且本地未装 → 跳过；否则致命（闭包不完整）。
        const optionalDep = [...touchedPackages].some(name => {
          try {
            const manifest = JSON.parse(readFileSync(path.join(nodeModulesDir, name, "package.json"), "utf8"));
            return manifest.optionalDependencies?.[root] !== undefined || manifest.peerDependencies?.[root] !== undefined;
          } catch {
            return false;
          }
        });
        if (optionalDep) continue;
        missing.push(`${root} (from ${file})`);
        continue;
      }
      touchedPackages.add(root);
      const resolved = sub === "" ? resolveSubpath(pkgDir, ".") : resolveSubpath(pkgDir, sub);
      if (resolved && existsSync(resolved)) queue.push(resolved);
      else missing.push(`${spec} (from ${file})`);
    }
  }
  if (missing.length > 0) {
    console.error(`[package-connector-app] 闭包追踪未解析 ${String(missing.length)} 项：\n  ${missing.slice(0, 10).join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[package-connector-app] 文件级追踪 ${String(seenFiles.size)} 文件 → 触达包 ${[...touchedPackages].sort().join(", ")}`);
  return [...touchedPackages].sort();
}

/** 拷贝包时剔除纯构建期/文档产物（不参与运行时解析）。保守清单：只删公认目录与
 *  非运行文件类型；宁大勿坏。 */
const PRUNE_DIRS = new Set(["docs", "doc", "test", "tests", "testing", "examples", "example", "benchmark", "benchmarks", ".github", ".bin", "coverage", ".npmignore"]);
const PRUNE_FILE_RE = /\.(md|markdown|ts|map|flow|coffee|tsbuildinfo)$/i;
function pruneCopyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      if (PRUNE_DIRS.has(name)) continue;
      pruneCopyDir(srcPath, destPath);
    } else if (st.isFile()) {
      if (PRUNE_FILE_RE.test(name)) continue;
      cpSync(srcPath, destPath);
    }
  }
}

/** 双击启动器（macOS/类 Unix 通用）。设计要点：
 *  - cd 自身目录（Finder 双击 cwd=home）；runtime 与 app 用相对路径引用；
 *  - 非零退出时暂停（双击场景 Terminal 一闪而过=用户什么都看不到）；
 *  - 完整性预检缺失时给人话提示而不是 node 的 stack trace。 */
const LAUNCHER = `#!/bin/bash
# OtterBuddy 设备端启动器（开发态，未签名）——首次运行如被 macOS 拦截，请右键选「打开」，
# 或到「系统设置 → 隐私与安全性」点「仍要打开」。向导式交互在终端窗口内进行。
set -u
cd "$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="runtime/node"
APP_JS="app/dist/connector/main.js"
if [ ! -x "$NODE_BIN" ] || [ ! -f "$APP_JS" ]; then
  echo "[OtterConnector] 安装包不完整：缺少 runtime/node 或 app/dist。请重新下载完整 zip 并完整解压后再双击。"
  read -r -p "按回车退出…" _
  exit 1
fi
"$NODE_BIN" "$APP_JS"
code=$?
if [ "$code" -ne 0 ]; then
  read -r -p "按回车退出（退出码 \${code}）…" _
fi
exit "$code"
`;

// ── 组装 staging ──
const staging = path.join(pkgDir, "release", "app-staging");
rmSync(staging, { recursive: true, force: true });
mkdirSync(path.join(staging, "runtime"), { recursive: true });
mkdirSync(path.join(staging, "app"), { recursive: true });

// 启动器
writeFileSync(path.join(staging, "OtterConnector.command"), LAUNCHER, { mode: 0o755 });
chmodSync(path.join(staging, "OtterConnector.command"), 0o755);

// 内嵌 node（realpath：process.execPath 可能是 symlink）
const nodeSrc = realpathSync(process.execPath);
cpSync(nodeSrc, path.join(staging, "runtime", "node"));
chmodSync(path.join(staging, "runtime", "node"), 0o755);

// connector 产物 + README
cpSync(path.join(pkgDir, "dist"), path.join(staging, "app", "dist"), { recursive: true });
cpSync(path.join(pkgDir, "README.md"), path.join(staging, "app", "README.md"));

// 依赖闭包（文件级追踪——见 collectRuntimePackages 注释）
const packages = collectRuntimePackages(path.join(pkgDir, "dist"), path.resolve("node_modules"));
for (const name of packages) {
  pruneCopyDir(path.join("node_modules", name), path.join(staging, "app", "node_modules", name));
}
console.log(`[package-connector-app] 拷入 ${String(packages.length)} 包（prune 后）`);

// ── 冒烟：内嵌 node + staged 产物 + 隔离 HOME（防误连真实中枢；无参非 TTY → usage exit 2）──
const smokeHome = mkdtempSync(path.join(os.tmpdir(), "otter-connector-smoke-"));
let smokeOk = false;
try {
  const result = execFileSync(path.join(staging, "runtime", "node"), [path.join(staging, "app", "dist", "connector", "main.js")], {
    encoding: "utf8",
    cwd: staging,
    env: { ...process.env, HOME: smokeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.error(`[package-connector-app] 冒烟异常：期望 exit 2，实际 0，输出：${result}`);
} catch (err) {
  const e = err;
  const stderr = String(e.stderr ?? "");
  if (e.status === 2 && /usage: main\.js/.test(stderr)) smokeOk = true;
  else console.error(`[package-connector-app] 冒烟失败：status=${String(e.status)} stderr=${stderr.slice(0, 800)}`);
}
rmSync(smokeHome, { recursive: true, force: true });
if (!smokeOk) {
  console.error("[package-connector-app] staged 冒烟未过（内嵌 node/产物/依赖闭包不自洽）——拒绝出包");
  process.exit(1);
}

// ── zip（系统 zip；构建期依赖，非请求期）──
const releaseDir = path.join(pkgDir, "release");
const zipPath = path.join(releaseDir, zipName);
rmSync(zipPath, { force: true });
const zipBin = process.platform === "win32" ? "zip.exe" : "zip";
try {
  execFileSync(zipBin, ["-qr", zipPath, "."], { cwd: staging, stdio: ["ignore", "ignore", "pipe"] });
} catch {
  console.error(`[package-connector-app] zip 打包失败：${zipBin} 不可用或执行出错——安装 zip 后重试`);
  process.exit(1);
}
const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
writeFileSync(`${zipPath}.sha256`, `hash: ${hash}\n`);
console.log(`[package-connector-app] ${zipPath}`);
console.log(`[package-connector-app] sha256 ${hash}`);
console.log(`[package-connector-app] 设备侧：解压 zip → 双击 OtterConnector.command（首启向导；引导文件 otter-connector-bootstrap.json 放同目录或下载目录可自动带入）`);
console.log("[package-connector-app] 诚实标注：未签名/未公证（Gatekeeper 首次右键打开）；终端向导式交互，非 .app GUI");
