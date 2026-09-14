/**
 * 自有项目 dev server 端口白名单（#844，F20260914dsrv）。
 *
 * 背景：bash 守卫按进程特征拦截 pkill/killall，但外部项目 dev server 命令行
 * 天然含 main.js / node 词元（如 dongbeicun 的 `node dist/api/src/main.js`），
 * 按名匹配从原理上无法区分——6 次变体重试全被拦（#844 实证）。
 *
 * 方案 A（静态白名单）：搭档在 <projectRoot>/.otter/allowed-service-ports.json
 * 声明「端口 + 项目目录」后，守卫把「可静态解析为白名单端口上监听者」的 kill
 * 目标视为合法（放行实际终止动作由 scripts/restart-service.mjs 受控执行，
 * 守卫只对同端口的辅助 kill 组合放行）。
 *
 * Why 静态：守卫在 tool_execution_start 同步拦截，不能跑 lsof（不可阻塞/不可
 * 注入副作用）；lsof 校验全部下沉到受控脚本内部。
 *
 * 文件格式（UTF-8 JSON，体积上限防巨文件打挂同步路径）：
 *   { "services": [{ "port": 3100, "projectDir": "/Users/x/dongbeicun" }] }
 *
 * 热加载：每次拦截判定都重读文件（与 .otter-buddy.pid 同策略），改配置无需
 * 重启主进程。解析失败 = 无白名单（守卫行为退回 #844 之前，保守）。
 */
import fs from "fs";
import path from "path";

/** 单个白名单服务声明 */
export interface AllowedService {
  port: number;
  projectDir: string;
}

export interface AllowedServicePorts {
  services: AllowedService[];
}

/** 白名单文件最大体积（字节）——防误投巨文件阻塞同步拦截路径 */
const MAX_FILE_BYTES = 64 * 1024;

/** 文件级缓存：同 path + mtimeMs + size 只解析一次（每次 stat，文件变了自动失效） */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: AllowedService[];
}
const parseCache = new Map<string, CacheEntry>();

function whitelistPath(projectRoot: string): string {
  return path.join(projectRoot, ".otter", "allowed-service-ports.json");
}

/**
 * 读取并解析白名单。任何异常（缺文件/坏 JSON/超限/字段非法）都返回 []，
 * 绝不抛出——白名单是放行增强，加载失败必须退化为主逻辑原状。
 */
export function loadAllowedServicePorts(projectRoot: string): AllowedService[] {
  try {
    const file = whitelistPath(projectRoot);
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return [];
    const cached = parseCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.result;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as AllowedServicePorts;
    const services = Array.isArray(raw?.services) ? raw.services : [];
    const valid = services.filter(
      (s): s is AllowedService =>
        Number.isInteger(s?.port) && s.port > 0 && s.port <= 65535 && typeof s?.projectDir === "string" && s.projectDir.trim() !== "",
    );
    parseCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result: valid });
    return valid;
  } catch {
    return [];
  }
}

/**
 * 从命令文本静态提取「监听白名单端口」引用：lsof -t -i :3100 / lsof -ti:3100 /
 * lsof -i :3100 -t 等变体（#844 现场变体 4/5 同构）。返回命中的端口列表。
 */
export function extractWhitelistedPortRefs(command: string, allowed: AllowedService[]): number[] {
  const hits: number[] = [];
  for (const s of allowed) {
    // lsof 参数中的端口引用：`-i:PORT` / `-i :PORT` / `-ti:PORT`（-t 与 -i 组合短参）。
    // 数字前必须有 `:`（lsof -i 语法），冒号前必须挂着字母（参数名）——
    // 避免把无关数字（日期/PID）当端口。
    const re = new RegExp(`(?:^|\\s)-t?[a-z]*\\s*:${s.port}\\b`);
    if (re.test(command)) hits.push(s.port);
  }
  return hits;
}

/** 白名单文件路径导出（测试与文档引用） */
export { whitelistPath };
