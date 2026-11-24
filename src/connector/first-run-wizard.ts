/**
 * （执行通道）：connector 首启向导
 *
 * 双击启动器（OtterConnector.command）的目标用户路径：无 device.json 时交互式引导
 * 输入/自动带入配对码与 hub URL → 复用 main.pairWithHub 核销换 token → 写既有
 * device.json（附 hubUrl）→ 常驻。不引入第二套配对机制——码的生成/核销仍在 hub 侧
 * 既有 pairing_codes 链路。
 *
 * 自动带入来源（bootstrap 引导文件）：Web 添加设备面板下载的
 * otter-connector-bootstrap.json，含 hub / pairingCode / expiresAt。发现顺序：
 * ① 启动器同目录（用户手动放置）；② 下载目录（浏览器默认落点）里
 * `otter-connector-bootstrap*.json` 最新一份。只按精确前缀列目录、只读匹配文件，
 * 不扫描其他内容。过期文件只降级丢弃 code（hub 仍可用），坏文件整体忽略并提示。
 *
 * 码即秘密纪律：向导不把码写进结构化日志（log() 仅在 main 侧输出设备/会话事件）。
 */

import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as nodeFs from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** 设备身份（~/.otter/connector/device.json）。hubUrl 为新增可选字段——
 *  首启/显式 --hub 连接成功路径回写，后续无参启动自动重连用；旧文件无此字段照常加载。 */
export interface DeviceIdentity {
  deviceId: string;
  pairToken: string;
  hubUrl?: string;
}

/** bootstrap 引导文件的可用预填内容（全部可选——坏文件/过期码只降级对应字段） */
export interface BootstrapPrefill {
  hub?: string;
  pairingCode?: string;
  /** 预填来源路径（提示用；不进结构化日志） */
  source?: string;
}

/** 配对码字母表（与 hub 侧签发完全一致：8 位、无易混淆字符 0/1/I/O） */
const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/** 规范化 hub URL：trim → 解析 → 仅 http(s) → 去尾斜杠；非法返回 null */
export function normalizeHubUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** 规范化配对码：trim → 大写 → 8 位字母表校验；非法返回 null */
export function normalizePairingCode(input: string): string | null {
  const normalized = input.trim().toUpperCase();
  return PAIRING_CODE_PATTERN.test(normalized) ? normalized : null;
}

/** 解析 bootstrap JSON 文本 → 预填内容（纯函数，可测）。
 *  过期（expiresAt 早于 now）只丢 pairingCode 保 hub；结构坏/字段非法返回空对象。 */
export function parseBootstrapJson(text: string, now: number): Omit<BootstrapPrefill, "source"> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const prefill: Omit<BootstrapPrefill, "source"> = {};
  if (typeof obj.hub === "string") {
    const hub = normalizeHubUrl(obj.hub);
    if (hub) prefill.hub = hub;
  }
  if (typeof obj.pairingCode === "string") {
    const code = normalizePairingCode(obj.pairingCode);
    const expires = typeof obj.expiresAt === "string" ? Date.parse(obj.expiresAt) : Number.NaN;
    // 无 expiresAt 视为不可信预填（引导文件必带时效）；过期只丢码
    if (code && !Number.isNaN(expires) && expires > now) prefill.pairingCode = code;
  }
  return prefill;
}

/** 读取并校验一份 bootstrap 文件；不存在/不可读返回 null（调用方换下一个来源） */
async function readBootstrapFile(filePath: string, now: number): Promise<BootstrapPrefill | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const prefill = parseBootstrapJson(text, now);
  return prefill.hub || prefill.pairingCode ? { ...prefill, source: filePath } : null;
}

/** 引导文件名（前缀匹配，浏览器对重复下载会追加 " (1)" 等后缀） */
const BOOTSTRAP_FILENAME_PATTERN = /^otter-connector-bootstrap[^/]*\.json$/i;

/** 发现 bootstrap 预填：启动器同目录优先，其次下载目录（新→旧逐个尝试）；无则空。 */
export async function findBootstrapPrefill(exeDir: string, now: number = Date.now(), downloadsDir: string = path.join(os.homedir(), "Downloads")): Promise<BootstrapPrefill> {
  const local = await readBootstrapFile(path.join(exeDir, "otter-connector-bootstrap.json"), now);
  if (local) return local;
  let names: string[];
  try {
    names = await readdir(downloadsDir);
  } catch {
    return {};
  }
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!BOOTSTRAP_FILENAME_PATTERN.test(name)) continue;
    try {
      candidates.push({ name, mtimeMs: nodeFs.statSync(path.join(downloadsDir, name)).mtimeMs });
    } catch {
      // 竞态删除/权限——跳过该候选
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // 新→旧逐个尝试：最新的坏了（下载损坏/人为篡改）不阻断更早的好文件
  for (const candidate of candidates) {
    const prefill = await readBootstrapFile(path.join(downloadsDir, candidate.name), now);
    if (prefill) return prefill;
  }
  return {};
}

/** 终端交互可用性：双击 .command 打开的 Terminal 满足；脚本/管道场景（CI、冒烟）为 false，
 *  此时保持既有 usage 退出路径，不破坏脚本化使用。 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** 单条提问（默认值直接回车采纳）。返回原始输入（不裁剪语义——由调用方规范化）。 */
export async function promptLine(question: string, fallback?: string): Promise<string> {
  const suffix = fallback !== undefined && fallback !== "" ? ` [${fallback}]` : "";
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** 每项最多重试次数——防坏预填/坏输入下的无限循环 */
const MAX_ATTEMPTS = 3;

/** 追问一个合法 hub URL（空输入且有 fallback 时采纳 fallback）。失败抛错（向导终止）。 */
export async function askHubUrl(fallback?: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const input = await promptLine("中枢地址（Web 添加设备页显示的地址）", fallback);
    const candidate = input === "" && fallback !== undefined ? fallback : input;
    const normalized = candidate === "" ? null : normalizeHubUrl(candidate);
    if (normalized) return normalized;
    stdout.write("  ✗ 需要形如 https://hub.example.com 或 http://192.168.1.10:3000 的地址\n");
  }
  throw new Error("多次输入无效的中枢地址——向导终止。可重新下载引导文件，或用命令行参数 --hub <url> 启动");
}

/** 追问一个合法配对码。失败抛错（向导终止）。 */
export async function askPairingCode(fallback?: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const input = await promptLine("一次性配对码（Web 添加设备页生成）", fallback);
    const candidate = input === "" && fallback !== undefined ? fallback : input;
    const normalized = candidate === "" ? null : normalizePairingCode(candidate);
    if (normalized) return normalized;
    stdout.write("  ✗ 配对码是 8 位大写字母/数字（不含 0/1/I/O），见 Web 添加设备页\n");
  }
  throw new Error("多次输入无效的配对码——向导终止。可在 Web 生成新码后重试");
}

/** 向导依赖注入（pair 复用 main.pairWithHub——核销/落盘语义单一事实源） */
export interface WizardDeps {
  pair: (hub: string, code: string, name: string) => Promise<DeviceIdentity>;
  exeDir: string;
  now?: () => number;
  hostname?: string;
}

/** 首启向导主体：预填发现 → 三问 → 核销。成功返回带 hubUrl 的身份。 */
export async function runFirstRunWizard(deps: WizardDeps): Promise<DeviceIdentity> {
  stdout.write("\n=== OtterBuddy 设备首启向导 ===\n");
  stdout.write("本机将注册为当前中枢的可执行设备；配对完成后自动上线并保持连接。\n\n");
  const prefill = await findBootstrapPrefill(deps.exeDir, (deps.now ?? Date.now)());
  if (prefill.source) {
    stdout.write(`已发现引导文件：${prefill.source}\n`);
  } else {
    stdout.write("未发现引导文件（可在 Web 添加设备页下载，或手动输入）。\n");
  }
  const hub = await askHubUrl(prefill.hub);
  const code = await askPairingCode(prefill.pairingCode);
  const defaultName = deps.hostname ?? os.hostname();
  const nameInput = await promptLine("设备名（在执行机列表中显示）", defaultName);
  const name = nameInput === "" ? defaultName : nameInput;
  stdout.write("\n正在向中枢核销配对码…\n");
  const identity = await deps.pair(hub, code, name);
  stdout.write(`✓ 设备已注册（deviceId=${identity.deviceId}），身份已保存。\n`);
  stdout.write(`  后续直接双击启动器即可自动重连；如需换中枢，用命令行 --hub <url> 覆盖。\n\n`);
  return identity;
}

/** 已有身份但缺 hubUrl（旧 CLI 时代文件）的补问。 */
export async function askMissingHubUrl(): Promise<string> {
  stdout.write("\n（本机已配对，但还没有记住中枢地址）\n");
  return askHubUrl(undefined);
}
