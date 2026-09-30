#!/usr/bin/env node
/**
 * 自有项目 dev server 受控重启脚本（#844，F20260914dsrv，方案 B；#1069 补 bootstrap）。
 *
 * 用途：bash 守卫生态内唯一合法的「终止自有项目 dev server」入口。
 *   restart-service.mjs <port> [--project /abs/path]              # 重启白名单内端口
 *   restart-service.mjs <port> --project /abs/path --add          # 声明并写回白名单，随后重启（#1069）
 *
 * 守卫设计契约（为什么这样写）：
 * - 本脚本的命令行形态（restart-service.mjs 3100）不含任何 kill/pkill 词元，
 *   天然不触发 bash-safety-guard——「放行」不是守卫开了口子，而是形态本身干净；
 * - 因此本脚本是全生态唯一做真杀校验的地方，必须自证目标不是 otter-buddy 主进程：
 *   ① 目标端口必须在 <otterRoot>/.otter/allowed-service-ports.json 白名单内
 *      （#1069：白名单缺失/端口未声明时可用 --project + --add 现场声明写回，
 *        不再硬依赖搭档手动创建——「正道死路」修复；写回后仍走 ②③ 校验）
 *   ② 解析出的每个 PID 经 lsof 校验 cwd 在声明项目目录下（或 --project 指定目录）
 *   ③ PID === 主进程 PID（.otter-buddy.pid）→ 拒绝（纵深防御，白名单本身不该含主进程端口）
 *   - --add 不稀释安全面：白名单不是安全边界，② cwd 归属校验 + ③ 主进程拒绝才是——
 *     即使海獭把任意端口 --add 进白名单，能终止的仍只有「cwd 在声明目录下」的进程，
 *     主进程被 ③ 恒拒。
 * - 校验全过才终止；任一失败 → 退出码 1 + stderr 说明，绝不猜。
 *
 * 退出码：0 = 成功（或无进程在监听，视为已达成）；1 = 校验失败/无权限/执行错误。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const otterRoot = path.resolve(__dirname, "..");

function die(msg) {
  console.error(`[restart-service] 拒绝：${msg}`);
  process.exit(1);
}

/**
 * #1069：端口声明解析（导出供单测；主流程经 main-guard 保护不会被 import 触发）。
 *
 * 输入/输出均为普通对象，文件 IO 限定在 whitelistPath 一个文件内，测试用 tmp 目录驱动。
 * 语义：
 * - 端口已在白名单 → 直接返回 entry（projectDir 不一致仍拒绝，原语义保留）
 * - 端口不在白名单：
 *   - 无 --add → 拒绝，错误信息含两条正道指引（搭档编辑 / --add 现场声明）
 *   - 有 --add → projectDir 必填；写回白名单（保留既有 entries）后返回
 * - 白名单文件缺失 → 仅 --add 可从空 services 起步创建；否则拒绝并指引
 * - 白名单 JSON 损坏 → 一律拒绝（--add 也不得覆盖搭档待修的配置）
 */
export function resolvePortEntry({ port, projectDir, add, whitelistPath }) {
  const readWhitelist = () => {
    try {
      return { found: true, data: JSON.parse(fs.readFileSync(whitelistPath, "utf-8")) };
    } catch (err) {
      if (err && err.code === "ENOENT") return { found: false };
      throw err; // JSON 损坏等 → 上层统一拒绝（不覆盖）
    }
  };

  let wl;
  try {
    wl = readWhitelist();
  } catch {
    return { ok: false, error: `白名单 JSON 解析失败（${whitelistPath}）——拒绝，请搭档修复后再用（--add 也不覆盖损坏配置）` };
  }

  if (!wl.found) {
    if (!add) {
      return {
        ok: false,
        error: `端口白名单不存在（${whitelistPath}）。两条正道：①请搭档创建（格式 {"services":[{"port":N,"projectDir":"/abs/path"}]}）；②本命令带 --project /abs/path --add 现场声明并写回，随后自动执行重启`,
      };
    }
  }

  const services = wl.found && Array.isArray(wl.data.services) ? wl.data.services : [];
  const entry = services.find(s => s && s.port === port);

  if (entry) {
    const declaredDir = path.resolve(entry.projectDir);
    if (projectDir && projectDir !== declaredDir) {
      return { ok: false, error: `--project (${projectDir}) 与白名单声明 (${declaredDir}) 不一致` };
    }
    return { ok: true, entry, declaredDir: projectDir ?? declaredDir };
  }

  // 端口未声明
  if (!add) {
    const current = services.length ? JSON.stringify(services) : "（空）";
    return {
      ok: false,
      error: `端口 ${port} 不在白名单内。白名单当前：${current}。两条正道：①请搭档编辑 ${whitelistPath} 声明；②重试本命令并加 --project /abs/path --add 现场声明写回（cwd 校验仍执行）`,
    };
  }
  if (!projectDir) {
    return { ok: false, error: "--add 必须同时给 --project /abs/path（声明该端口归属的项目目录）" };
  }

  // --add 写回：保留既有 entries，追加新声明
  const nextServices = [...services, { port, projectDir }];
  const payload = JSON.stringify({ services: nextServices }, null, 2) + "\n";
  fs.mkdirSync(path.dirname(whitelistPath), { recursive: true });
  fs.writeFileSync(whitelistPath, payload, "utf-8");
  return { ok: true, entry: { port, projectDir }, declaredDir: projectDir, declared: true };
}

// ── 主流程（main-guard：被测试 import 时不执行）──
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  // ── 参数解析 ──
  const args = process.argv.slice(2);
  const port = parseInt(args[0] ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("用法: restart-service.mjs <port> [--project /abs/path] [--add]");
    console.error("  port    : 要重启的 dev server 端口");
    console.error("  --project: 项目目录（端口已在白名单时可省略，取声明值）");
    console.error("  --add   : 端口未声明时，把 --project 目录声明写回白名单再重启（#1069 兜底正道）");
    process.exit(1);
  }
  let projectDir = null;
  let add = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === "--add") { add = true; }
  }

  // ── 校验 ①：端口白名单（含 --add 声明写回，#1069）──
  const resolved = resolvePortEntry({
    port,
    projectDir,
    add,
    whitelistPath: path.join(otterRoot, ".otter", "allowed-service-ports.json"),
  });
  if (!resolved.ok) die(resolved.error);
  const { declaredDir, declared } = resolved;
  if (declared) {
    console.log(`[restart-service] 端口 ${port} 已声明写回白名单（projectDir=${declaredDir}）——后续重启无需 --add。`);
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
}
