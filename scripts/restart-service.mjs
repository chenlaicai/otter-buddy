#!/usr/bin/env node
/**
 * 自有项目 dev server 受控重启脚本（#844，F20260914dsrv，方案 B）。
 *
 * 用途：bash 守卫生态内唯一合法的「终止自有项目 dev server」入口。
 *   restart-service.mjs <port> [--project /abs/path]
 *
 * 守卫设计契约（为什么这样写）：
 * - 本脚本的命令行形态（restart-service.mjs 3100）不含任何 kill/pkill 词元，
 *   天然不触发 bash-safety-guard——「放行」不是守卫开了口子，而是形态本身干净；
 * - 因此本脚本是全生态唯一做真杀校验的地方，必须自证目标不是 otter-buddy 主进程：
 *   ① 目标端口必须在 <otterRoot>/.otter/allowed-service-ports.json 白名单内
 *   ② 解析出的每个 PID 经 lsof 校验 cwd 在声明项目目录下（或 --project 指定目录）
 *   ③ PID === 主进程 PID（.otter-buddy.pid）→ 拒绝（纵深防御，白名单本身不该含主进程端口）
 * - 校验全过才终止；任一失败 → 退出码 1 + stderr 说明，绝不猜。
 *
 * 退出码：0 = 成功（或无进程在监听，视为已达成）；1 = 校验失败/无权限/执行错误。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const otterRoot = path.resolve(__dirname, "..");

function die(msg) {
  console.error(`[restart-service] 拒绝：${msg}`);
  process.exit(1);
}

// ── 参数解析 ──
const args = process.argv.slice(2);
const port = parseInt(args[0] ?? "", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("用法: restart-service.mjs <port> [--project /abs/path]");
  console.error("  port    : 要重启的 dev server 端口（必须已声明在白名单）");
  console.error("  --project: 项目目录（默认取白名单中该端口声明的 projectDir）");
  process.exit(1);
}
let projectDir = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--project" && args[i + 1]) { projectDir = path.resolve(args[i + 1]); i++; }
}

// ── 校验 ①：端口白名单 ──
let whitelist;
try {
  whitelist = JSON.parse(fs.readFileSync(path.join(otterRoot, ".otter", "allowed-service-ports.json"), "utf-8"));
} catch {
  die(`无法读取端口白名单 ${path.join(otterRoot, ".otter", "allowed-service-ports.json")}——请搭档创建后再用本脚本`);
}
const entry = (whitelist.services ?? []).find(s => s.port === port);
if (!entry) die(`端口 ${port} 不在白名单内。白名单当前：${JSON.stringify(whitelist.services ?? [])}`);
const declaredDir = path.resolve(entry.projectDir);
if (!projectDir) projectDir = declaredDir;
if (projectDir !== declaredDir) {
  die(`--project (${projectDir}) 与白名单声明 (${declaredDir}) 不一致`);
}

// ── 校验 ②：主进程 PID 纵深防御 ──
let mainPid = null;
try {
  mainPid = parseInt(fs.readFileSync(path.join(otterRoot, ".otter-buddy.pid"), "utf-8").trim(), 10) || null;
} catch { /* PID 文件缺失 = 主进程未运行，无需防御 */ }

// ── 解析监听者 ──
let pids;
try {
  const out = execFileSync("lsof", ["-t", `-i:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
  pids = out ? out.split("\n").map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0) : [];
} catch {
  pids = []; // lsof 非零退出通常 = 无监听者
}
if (pids.length === 0) {
  console.log(`[restart-service] 端口 ${port} 无监听进程，无需终止。`);
  process.exit(0);
}

// ── 校验 ③：每个 PID 的 cwd 必须在声明项目目录下 ──
for (const pid of pids) {
  if (pid === mainPid) die(`PID ${pid} 是 otter-buddy 主进程——拒绝终止（白名单配置有误，请检查端口声明）`);
  let cwd = null;
  try {
    cwd = execFileSync("lsof", ["-a", `-p`, String(pid), "-d", "cwd", "-Fn"], { encoding: "utf-8" });
  } catch { /* 进程可能已退出 */ }
  const m = cwd && cwd.match(/^n(.+)$/m);
  const procCwd = m ? m[1] : null;
  if (!procCwd) die(`无法解析 PID ${pid} 的工作目录（进程可能刚退出）——拒绝，请重试`);
  const rel = path.relative(declaredDir, procCwd);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    die(`PID ${pid} 的 cwd (${procCwd}) 不在声明项目目录 (${declaredDir}) 下——拒绝终止`);
  }
}

// ── 全部校验通过，执行终止 ──
for (const pid of pids) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[restart-service] SIGTERM → PID ${pid}（端口 ${port}，cwd 校验通过）`);
  } catch (err) {
    die(`kill(${pid}) 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`[restart-service] 端口 ${port} 旧进程已发 SIGTERM（${pids.length} 个）。请用项目自己的启动命令重启 dev server。`);
process.exit(0);
