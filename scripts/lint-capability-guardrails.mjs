#!/usr/bin/env node
/**
 * 能力保证格点与 faux 排除的单一真相源校验。
 * - 每个 capability 测试文件必须登记 trigger/effect/consumer/guarantee；
 * - 文件新增、删除、改名都必须同步登记，杜绝「有文件=有能力保证」的静默漂移；
 * - faux 文件级排除必须绑 issue，排除从无声 skip 变为公开债务。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const GUARANTEE_LAYERS = new Set([
  "structure",
  "runtime-guard",
  "equivalence",
  "faux",
  "live",
  "mechanism",
  "none",
]);

export function loadCapabilityRegistry(root = process.cwd()) {
  const file = path.join(root, "tests/capability/guardrails.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walkCapabilityTests(dir, root, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walkCapabilityTests(full, root, out);
    else if (item.name.endsWith(".capability.test.ts")) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return out;
}

export function globToRegExp(glob) {
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${source}$`);
}

export function matchingCapabilityChanges(changedPaths, registry) {
  const patterns = registry.changeTrigger?.paths ?? [];
  const regexes = patterns.map(globToRegExp);
  return [...new Set(changedPaths.filter(file => regexes.some(re => re.test(file))))];
}

export function validateCapabilityGuardrails(root = process.cwd(), registry = loadCapabilityRegistry(root)) {
  const errors = [];
  if (registry.version !== 1) errors.push("guardrails.version 必须为 1");
  if (!Array.isArray(registry.capabilities)) {
    return ["guardrails.capabilities 必须为数组"];
  }
  if (!Array.isArray(registry.changeTrigger?.paths) || registry.changeTrigger.paths.length === 0) {
    errors.push("changeTrigger.paths 必须非空：贵的验证按变更路径触发，不按日历触发");
  }
  const parityTest = registry.changeTrigger?.parityTest;
  if (typeof parityTest !== "string" || !fs.existsSync(path.join(root, parityTest))) {
    errors.push(`changeTrigger.parityTest 不存在: ${parityTest}`);
  }
  if (typeof registry.changeTrigger?.liveCommand !== "string" || !registry.changeTrigger.liveCommand.trim()) {
    errors.push("changeTrigger.liveCommand 必须声明真 LLM 全量档命令");
  }

  const seen = new Set();
  for (const [index, entry] of registry.capabilities.entries()) {
    const at = `capabilities[${index}]`;
    if (!entry || typeof entry.file !== "string" || !entry.file.endsWith(".capability.test.ts")) {
      errors.push(`${at}.file 非法`);
      continue;
    }
    if (seen.has(entry.file)) errors.push(`${entry.file} 重复登记`);
    seen.add(entry.file);
    if (!fs.existsSync(path.join(root, entry.file))) errors.push(`${entry.file} 已登记但文件不存在`);
    for (const field of ["trigger", "effect", "consumer"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) errors.push(`${entry.file} 缺 ${field}`);
    }
    if (!GUARANTEE_LAYERS.has(entry.guarantee)) {
      errors.push(`${entry.file} guarantee=${entry.guarantee} 非法（none 也必须显式登记）`);
    }
    if (!["run", "exclude"].includes(entry.faux)) {
      errors.push(`${entry.file} faux 必须为 run/exclude`);
    } else if (entry.faux === "exclude" && !/^#[1-9]\d*$/.test(entry.issue ?? "")) {
      errors.push(`${entry.file} faux=exclude 必须登记 issue（如 #1234）`);
    }
  }

  const actual = walkCapabilityTests(path.join(root, "tests/capability"), root).sort();
  for (const file of actual) {
    if (!seen.has(file)) errors.push(`${file} 未登记保证格点`);
  }

  const allowFile = path.join(root, "tests/capability/parity-allowlist.json");
  if (fs.existsSync(allowFile)) {
    try {
      const allowances = JSON.parse(fs.readFileSync(allowFile, "utf8"));
      if (allowances.version !== 1 || !Array.isArray(allowances.allowances)) {
        errors.push("parity-allowlist 必须为 {version:1, allowances:[]}");
      } else {
        for (const allowance of allowances.allowances) {
          if (!/^[0-9a-f]{40}$/.test(allowance.base)) errors.push("parity 许可必须绑定完整基线 commit");
          if (!Array.isArray(allowance.diffs) || allowance.diffs.length === 0 ||
              allowance.diffs.some(diff => typeof diff !== "string" || !diff) ||
              new Set(allowance.diffs).size !== allowance.diffs.length) {
            errors.push(`parity 许可 ${allowance.base} 的 diffs 必须为非空、不重复字符串数组`);
          }
        }
      }
    } catch (error) {
      errors.push(`parity-allowlist JSON 不可读: ${error.message}`);
    }
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const registry = loadCapabilityRegistry(root);
  const errors = validateCapabilityGuardrails(root, registry);
  if (errors.length) {
    for (const error of errors) console.error(`❌ [capability-guardrails] ${error}`);
    process.exit(1);
  }
  const excluded = registry.capabilities.filter(entry => entry.faux === "exclude");
  const unguarded = registry.capabilities.filter(entry => entry.guarantee === "none");
  console.log(
    `✅ [capability-guardrails] ${registry.capabilities.length} 个能力格点；` +
    `faux 排除 ${excluded.length}（均带公开 issue）；显式无保证 ${unguarded.length}；` +
    `变更触发路径 ${registry.changeTrigger.paths.length} 条`,
  );
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
