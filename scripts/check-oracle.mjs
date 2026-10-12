#!/usr/bin/env node
/**
 * 验收 Oracle 机器闸——不变量 registry 在位性 PASS/FAIL checker（F20261012orcl）。
 *
 * 语义：
 * - oracle/invariants.json 登记「必须在位」的纪律语义（pattern 为子串，`re:` 前缀为正则）；
 *   逐条校验目标文件仍含该语义，缺失 → FAIL（exit 1）。
 * - 防静默篡改：oracle/lock.json 记录 registry / checker 自身 / waivers 三件的 sha256；
 *   不符或缺失 → exit 2「registry/checker 被改动，需 --update-lock 并走 waiver 评审」。
 *   强度边界：lock 防的是静默篡改；--update-lock 一把梭机器拦不住（流程锁：变更进 diff + 评审兕住）。
 * - waiver：oracle/waivers.json 条目 {invariant_id, reason, approved_by, expires}；
 *   有效期内（今天 ≤ expires，expires 是最后有效日）且条目 waiver_eligible=true 的缺失
 *   降为 WARN（exit 0）；过期 waiver 无效（缺失即 FAIL）。
 *
 * 退出码：0 通过（可含 WARN）/ 1 不变量缺失、waiver 配置非法 / 2 lock 不符或 registry 非法。
 * 用法：node scripts/check-oracle.mjs [--json] [--update-lock] [--root <dir>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";

/** lock 覆盖面：registry + checker 自身 + waivers——只锁 registry 则改 checker 让它永远 PASS 即绕闸 */
export const LOCK_TARGETS = [
  "oracle/invariants.json",
  "scripts/check-oracle.mjs",
  "oracle/waivers.json",
];
/** waiver 数量 ratchet 上限——超限即红，防 waiver 堆积变成静默豁免清单（只减不增语义） */
export const WAIVER_MAX = 10;
const LOCK_PATH = "oracle/lock.json";
const REGISTRY_PATH = "oracle/invariants.json";
const WAIVERS_PATH = "oracle/waivers.json";
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 本地日期 YYYY-MM-DD（waiver 过期判定用本地日界，与人写的 expires 同口径） */
export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readJson(rel, root) {
  const abs = path.join(root, rel);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

/** 逐文件 sha256 + 组合 hash（组合 = 三件 hash 按 LOCK_TARGETS 顺序拼接后再 sha256） */
export function computeLock(root) {
  const files = {};
  for (const rel of LOCK_TARGETS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`lock 目标缺失：${rel}`);
    files[rel] = sha256(fs.readFileSync(abs));
  }
  const combined = sha256(LOCK_TARGETS.map((rel) => files[rel]).join(""));
  return { version: 1, algorithm: "sha256", files, combined };
}

export function writeLock(root) {
  const lock = computeLock(root);
  const abs = path.join(root, LOCK_PATH);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

/** lock 自校验：缺失 / 解析失败 / 逐件 hash 不符 / combined 不符 → ok:false（exit 2 语义） */
export function verifyLock(root) {
  const abs = path.join(root, LOCK_PATH);
  if (!fs.existsSync(abs)) {
    return { ok: false, reason: `${LOCK_PATH} 缺失——registry/checker/waivers 无防静默篡改基线` };
  }
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    return { ok: false, reason: `${LOCK_PATH} 解析失败：${e.message}` };
  }
  let actual;
  try {
    actual = computeLock(root);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const diffs = [];
  for (const rel of LOCK_TARGETS) {
    const want = recorded.files?.[rel];
    const got = actual.files[rel];
    if (want !== got) diffs.push(`${rel}（记录 ${String(want).slice(0, 12)}… ≠ 实际 ${got.slice(0, 12)}…）`);
  }
  if (recorded.combined !== actual.combined) diffs.push("combined hash");
  if (diffs.length > 0) {
    return {
      ok: false,
      reason: `registry/checker 被改动，需 --update-lock 并走 waiver 评审：${diffs.join("；")}`,
    };
  }
  return { ok: true };
}

/** registry schema 校验——非法即 tamper 类（exit 2 语义） */
export function validateRegistry(reg) {
  const errors = [];
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) {
    return ["registry 顶层必须是对象 {version, invariants}"];
  }
  if (reg.version !== 1) errors.push(`registry.version 必须为 1（实际 ${JSON.stringify(reg.version)}）`);
  const list = reg.invariants;
  if (!Array.isArray(list) || list.length === 0) {
    errors.push("registry.invariants 必须是非空数组");
    return errors;
  }
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const inv = list[i];
    const at = `invariants[${i}]`;
    if (!inv || typeof inv !== "object") {
      errors.push(`${at} 必须是对象`);
      continue;
    }
    if (typeof inv.id !== "string" || !ID_RE.test(inv.id)) {
      errors.push(`${at}.id 非法（需 ${ID_RE}）：${JSON.stringify(inv.id)}`);
    } else if (seen.has(inv.id)) {
      errors.push(`${at}.id 重复：${inv.id}`);
    } else {
      seen.add(inv.id);
    }
    if (typeof inv.file !== "string" || inv.file.length === 0) {
      errors.push(`${at}.file 必须是非空相对路径`);
    } else if (path.isAbsolute(inv.file) || inv.file.split(/[\\/]/).includes("..")) {
      errors.push(`${at}.file 必须是仓库内相对路径（禁绝对路径/..）：${inv.file}`);
    }
    if (typeof inv.pattern !== "string" || inv.pattern.length === 0) {
      errors.push(`${at}.pattern 必须是非空字符串`);
    } else if (inv.pattern.startsWith("re:")) {
      try {
        new RegExp(inv.pattern.slice(3));
      } catch (e) {
        errors.push(`${at}.pattern 正则非法：${e.message}`);
      }
    }
    if (typeof inv.rationale !== "string" || inv.rationale.trim().length === 0) {
      errors.push(`${at}.rationale 必须非空（每条必须写清出处）`);
    }
    if (typeof inv.waiver_eligible !== "boolean") {
      errors.push(`${at}.waiver_eligible 必须是布尔值`);
    }
  }
  return errors;
}

function patternMatched(pattern, content) {
  return pattern.startsWith("re:")
    ? new RegExp(pattern.slice(3)).test(content)
    : content.includes(pattern);
}

/**
 * waiver 校验。fail-closed：条目畸形 / 指向未知条目 / 指向不可豁免条目 / 超上限 → errors。
 * 返回 {entries, errors, warnings}。
 */
export function validateWaivers(waiverDoc, registry) {
  const errors = [];
  const warnings = [];
  const byId = new Map(registry.invariants.map((inv) => [inv.id, inv]));
  const entries = Array.isArray(waiverDoc?.waivers) ? waiverDoc.waivers : null;
  if (entries === null) {
    return { entries: [], errors: ["waivers 顶层必须是对象 {version, waivers}"], warnings };
  }
  if (waiverDoc.version !== 1) errors.push(`waivers.version 必须为 1（实际 ${JSON.stringify(waiverDoc.version)}）`);
  if (entries.length > WAIVER_MAX) {
    errors.push(`waiver 条目 ${entries.length} 条超过上限 ${WAIVER_MAX}（ratchet 只减不增）——长期放宽请改 registry 并走评审`);
  }
  for (let i = 0; i < entries.length; i++) {
    const w = entries[i];
    const at = `waivers[${i}]`;
    if (!w || typeof w !== "object") {
      errors.push(`${at} 必须是对象`);
      continue;
    }
    const inv = byId.get(w.invariant_id);
    if (!inv) {
      errors.push(`${at} 指向未知条目：${JSON.stringify(w.invariant_id)}`);
      continue;
    }
    if (inv.waiver_eligible === false) {
      errors.push(`${at} 指向不可豁免条目 ${inv.id}（waiver_eligible=false，安全底线不接受放宽）`);
    }
    if (typeof w.reason !== "string" || w.reason.trim().length === 0) {
      errors.push(`${at}.reason 必须非空`);
    }
    if (typeof w.approved_by !== "string" || w.approved_by.trim().length === 0) {
      errors.push(`${at}.approved_by 必须非空（谁批的必须留痕）`);
    }
    if (typeof w.expires !== "string" || !DATE_RE.test(w.expires) || Number.isNaN(Date.parse(w.expires))) {
      errors.push(`${at}.expires 必须是合法日期 YYYY-MM-DD（实际 ${JSON.stringify(w.expires)}）`);
    }
  }
  return { entries, errors, warnings };
}

/** 逐条校验在位性；缺失且有有效 waiver → waived（WARN），否则 failure */
export function checkInvariants({ root, today = todayISO() }) {
  const registry = readJson(REGISTRY_PATH, root);
  const regErrors = validateRegistry(registry);
  if (regErrors.length > 0) return { failures: [], waived: [], errors: regErrors, registry };

  const waiverDoc = fs.existsSync(path.join(root, WAIVERS_PATH))
    ? readJson(WAIVERS_PATH, root)
    : { version: 1, waivers: [] };
  const { entries, errors: waiverErrors } = validateWaivers(waiverDoc, registry);

  const failures = [];
  const waived = [];
  for (const inv of registry.invariants) {
    const abs = path.join(root, inv.file);
    if (!fs.existsSync(abs)) {
      failures.push({ ...inv, detail: "目标文件不存在" });
      continue;
    }
    const content = fs.readFileSync(abs, "utf8");
    if (patternMatched(inv.pattern, content)) continue;

    // waiver_eligible=false 的缺失不可降级（validateWaivers 已把这类 waiver 判非法）
    const waiver =
      inv.waiver_eligible !== false
        ? entries.find(
            (w) =>
              w.invariant_id === inv.id &&
              typeof w.expires === "string" &&
              DATE_RE.test(w.expires) &&
              today <= w.expires,
          )
        : undefined;
    if (waiver) {
      waived.push({ ...inv, detail: "语义缺失（有效 waiver 降级 WARN）", waiver });
    } else {
      const expired = entries.find((w) => w.invariant_id === inv.id && !waived.some((x) => x.waiver === w));
      failures.push({
        ...inv,
        detail: expired
          ? `语义缺失（waiver 已过期 ${expired.expires}，无效）`
          : "语义缺失",
      });
    }
  }
  return { failures, waived, errors: waiverErrors, registry };
}

export { todayISO as _todayISO };

function parseArgs(argv) {
  const args = { json: false, updateLock: false, root: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--update-lock") args.updateLock = true;
    else if (a === "--root") args.root = path.resolve(argv[++i] ?? ".");
    else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  // registry / waivers 非法 = tamper 类（exit 2）；--update-lock 也拒绝写锁
  let registry;
  try {
    registry = readJson(REGISTRY_PATH, args.root);
  } catch (e) {
    const msg = `[lint:oracle] ${REGISTRY_PATH} 读取/解析失败：${e.message}`;
    if (args.json) console.log(JSON.stringify({ ok: false, exitCode: 2, errors: [msg] }));
    else console.error(msg);
    process.exit(2);
  }
  const regErrors = validateRegistry(registry);
  if (regErrors.length > 0) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, exitCode: 2, errors: regErrors, lock: { ok: false } }, null, 2));
    } else {
      console.error("[lint:oracle] registry 非法（按 tamper 处置，需 --update-lock 并走 waiver 评审）：");
      for (const e of regErrors) console.error(`  ✗ ${e}`);
    }
    process.exit(2);
  }

  if (args.updateLock) {
    const lock = writeLock(args.root);
    console.log(`[lint:oracle] lock 已更新（${LOCK_TARGETS.join(" / ")}）：combined ${lock.combined.slice(0, 16)}…`);
    process.exit(0);
  }

  const lockResult = verifyLock(args.root);
  if (!lockResult.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, exitCode: 2, errors: [lockResult.reason], lock: lockResult }, null, 2));
    } else {
      console.error(`[lint:oracle] ✗ ${lockResult.reason}`);
    }
    process.exit(2);
  }

  const { failures, waived, errors } = checkInvariants({ root: args.root });
  const exitCode = failures.length > 0 || errors.length > 0 ? 1 : 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: exitCode === 0,
          exitCode,
          lock: { ok: true },
          failures,
          waived,
          errors,
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }

  const total = registry.invariants.length;
  const boundary =
    "｜边界：lock 防静默篡改；--update-lock 为流程锁（变更须走 waiver 评审，diff 显形）";
  if (failures.length === 0 && errors.length === 0 && waived.length === 0) {
    console.log(`[lint:oracle] PASS（${total}/${total} 条在位，lock OK）${boundary}`);
    process.exit(0);
  }
  for (const f of failures) {
    console.error(`✗ ${f.id}  ${f.file}\n    ${f.detail}——期望 pattern：${f.pattern}\n    rationale：${f.rationale}`);
  }
  for (const w of waived) {
    console.warn(`⚠ ${w.id}  ${w.file}\n    ${w.detail}——waiver 至 ${w.waiver.expires}（${w.waiver.approved_by}）：${w.waiver.reason}`);
  }
  for (const e of errors) console.error(`✗ waiver 配置：${e}`);
  if (exitCode === 0) {
    console.log(`[lint:oracle] PASS(WARN)（${total - waived.length}/${total} 在位，${waived.length} 条 waiver 降级；lock OK）${boundary}`);
  } else {
    console.error(`\n[lint:oracle] FAIL（缺失 ${failures.length} / 配置错误 ${errors.length}，lock OK）——修复语义或走 waiver（oracle/waivers.json）后重跑`);
  }
  process.exit(exitCode);
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main();
}
