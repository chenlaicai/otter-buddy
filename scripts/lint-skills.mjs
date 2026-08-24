#!/usr/bin/env node
/**
 * F20260811sktp Part A: Skill 系统契约校验（commit-time gate）。
 *
 * error（阻断）：
 *   1. SKILL.md frontmatter 必有 name / description / co_loads / category
 *   2. frontmatter.name 必须等于目录名
 *   3. manifest skill 集合 = .pi/skills 目录集合（双向，防孤立）
 *   4. manifest next 指针有效
 *   5. manifest not_for 指针有效
 *   6. manifest category 与 SKILL.md frontmatter category 一致（防漂移）
 *   7. SKILL.md 中提到的 references/ 路径必须存在
 *
 * warning（不阻断）：
 *   W1. SKILL.md 行数 ≤ 200
 *   W2. description 字符长度 ≤ 500
 *   W3. 两个 skill 的 not_for 互指对方（检查 Use when 区分度）
 *   W4. description 不含三段式 marker（Use when / Not for / Output）—— companion 豁免
 *
 * 退出码：0 通过（含警告）/ 1 有错误。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const SKILLS_DIR = path.join(root, ".pi/skills");
const MANIFEST_PATH = path.join(root, "prompts/skills/manifest.yaml");
const VALID_CATEGORIES = new Set(["technique", "pattern", "reference"]);
// F20260821kgts: 数量下限 ratchet（防"删光 skills + 同步清空 manifest"静默绿）。
// 有意移除 skill 时须同步下调此值，让移除成为显式决策。
const MIN_SKILLS = 9;
const THREE_PART_MARKERS = ["Use when", "Not for", "Output"];
const THREE_PART_EXEMPT = new Set(["companion"]); // fallback skill 豁免

let errors = 0;
let warnings = 0;

function error(msg) { errors++; console.error(`✗ ${msg}`); }
function warn(msg) { warnings++; console.warn(`⚠ ${msg}`); }

/** 扫描 .pi/skills/ 下所有含 SKILL.md 的目录（_shared 排除） */
function scanSkillDirs() {
  const out = [];
  for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === "_shared") continue;
    const skillMd = path.join(SKILLS_DIR, e.name, "SKILL.md");
    if (fs.existsSync(skillMd)) out.push({ name: e.name, dir: path.join(SKILLS_DIR, e.name), skillMd });
  }
  return out;
}

/** 提取 markdown frontmatter + body */
function parseMarkdown(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: raw };
  return { fm: parse(m[1]), body: m[2] };
}

function readSkill({ name, dir, skillMd }) {
  const raw = fs.readFileSync(skillMd, "utf8");
  const { fm, body } = parseMarkdown(raw);
  const lines = raw.split("\n").length;
  return { name, dir, skillMd, fm: fm ?? {}, body, lines, raw };
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

// ── 校验主流程 ──

const skillDirs = scanSkillDirs();
const skills = skillDirs.map(readSkill);
const skillByName = new Map(skills.map(s => [s.name, s]));
const manifest = readManifest();

if (!manifest) {
  error("prompts/skills/manifest.yaml 不存在");
} else {
  const manifestSkills = new Map((manifest.skills ?? []).map(s => [s.name, s]));

  // 校验 3: 集合双向一致
  for (const s of skills) {
    if (!manifestSkills.has(s.name)) error(`manifest 缺 skill: ${s.name}（存在于 .pi/skills/ 但 manifest 未声明）`);
  }
  for (const name of manifestSkills.keys()) {
    if (!skillByName.has(name)) error(`manifest 多余 skill: ${name}（manifest 声明但 .pi/skills/ 不存在）`);
  }

  // 校验 4/5: next / not_for 指针有效
  for (const m of manifestSkills.values()) {
    for (const n of m.next ?? []) {
      if (!manifestSkills.has(n)) error(`manifest next 指针断裂: ${m.name}.next -> ${n}`);
    }
    for (const n of m.not_for ?? []) {
      if (!manifestSkills.has(n)) error(`manifest not_for 指针断裂: ${m.name}.not_for -> ${n}`);
    }
  }

  // 校验 6: manifest category 与 frontmatter category 一致
  for (const m of manifestSkills.values()) {
    const s = skillByName.get(m.name);
    if (!s) continue;
    if (m.category !== s.fm.category) {
      error(`category 漂移: ${m.name} manifest=${m.category} 但 SKILL.md frontmatter=${s.fm.category}`);
    }
  }

  // W3: not_for 互指
  for (const m of manifestSkills.values()) {
    for (const n of m.not_for ?? []) {
      const other = manifestSkills.get(n);
      if (other && (other.not_for ?? []).includes(m.name)) {
        warn(`${m.name} 与 ${n} 的 not_for 互指——检查 Use when 是否有足够区分度`);
      }
    }
  }
}

for (const s of skills) {
  const rel = path.relative(root, s.skillMd);

  // 校验 1: frontmatter 必填字段（0/false 等非空值也算缺失——name: 0 曾双重绕过）
  for (const f of ["name", "description", "co_loads", "category"]) {
    if (s.fm[f] === undefined || s.fm[f] === null || s.fm[f] === "") error(`${rel}: frontmatter 缺字段 ${f}`);
  }

  // 校验 2: name = 目录名（必须是字符串，非字符串类型直接报错）
  if (s.fm.name !== undefined && (typeof s.fm.name !== "string" || s.fm.name !== s.name)) {
    error(`${rel}: frontmatter.name="${String(s.fm.name)}" 但目录名="${s.name}"`);
  }

  // 校验 7: references 路径存在
  // _shared/xxx 相对 .pi/skills/ 解析；references/xxx 与 ../xxx 相对当前 skill 目录解析
  // 反引号代码与 markdown 链接 ](path) 两种形态都校验
  const refMatches = s.body.matchAll(/`((?:\.\.\/|_shared\/|references\/)[^`]+\.md)`|\]\(((?:\.\.\/|_shared\/|references\/)[^)]+\.md)\)/g);
  for (const m of refMatches) {
    const refPath = m[1] ?? m[2];
    const base = refPath.startsWith("_shared/") ? SKILLS_DIR : s.dir;
    const full = path.resolve(base, refPath);
    if (!fs.existsSync(full)) error(`${rel}: references 路径不存在: ${refPath}`);
  }

  // category 合法性
  if (s.fm.category && !VALID_CATEGORIES.has(s.fm.category)) {
    error(`${rel}: category="${s.fm.category}" 不合法（应为 technique / pattern / reference）`);
  }

  // W1: 行数
  if (s.lines > 200) warn(`${rel}: ${s.lines} 行 > 200，建议移到 references/`);

  // W2/W4: description 长度与三段式 marker
  const desc = s.fm.description ?? "";
  const descChars = [...desc].length;
  if (descChars > 500) warn(`${rel}: description ${descChars} 字符 > 500（职责可能过宽）`);
  if (!THREE_PART_EXEMPT.has(s.name)) {
    const missing = THREE_PART_MARKERS.filter(m => !desc.includes(m));
    if (missing.length > 0) warn(`${rel}: description 缺三段式 marker: ${missing.join(", ")}`);
  }
}

// 校验 8: 数量下限 ratchet（F20260821kgts）
if (skills.length < MIN_SKILLS) {
  error(`skills 数量 ${skills.length} < 下限 ${MIN_SKILLS}——skill 目录被清空或大量缺失？有意移除请同步下调 MIN_SKILLS`);
}

if (warnings > 0) console.log(`[lint:skills] ${warnings} 个警告`);
if (errors > 0) {
  console.error(`[lint:skills] ${errors} 个错误`);
  process.exit(1);
}
console.log(`[lint:skills] OK（${skills.length} skills，${warnings} warnings）`);
