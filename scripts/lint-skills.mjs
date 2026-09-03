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
 *   9. references 引用形态可见性（#726）：
 *      E1 绝对路径引用（agent 换 cwd/worktree 后必然读不到）
 *      E2 引用仅出现在参考索引、未在工作流步骤中内联出现
 *      （实证：步骤内联引用被 agent 主动 read，纯索引引用读取概率低——
 *       writing-skills/references/skill-types.md 零读取 vs lint-rules.md 步骤 7 内联被读）
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

// 校验 7/9（#726）共享的引用宇宙：反引号代码与 markdown 链接两种形态；
// 相对路径四种形态：references/x（本 skill）、../x 与 ../_shared/x（本 skill 目录解析）、
// <skill-name>/references|x（跨 skill，相对 skills 根解析）。
// 注意：_shared/x 裸写法（无 ../ 前缀）不属于合法宇宙——见 ABSOLUTE_SHARED_REF_RE（校验 9 E1b）。
// 结构假设：校验 9 E2 以「## 工作流」节为可见性判定域（workflowLineRange 只认 ^##\s+工作流）；
// 无该节的 skill 若引用 references 文件会被判索引-only error——写 skill 时必须保留该节名。
const REF_LINE_RE = /`((?:\.\.\/|_shared\/|(?:[a-z][a-z0-9-]*\/)?references\/)[^`]+\.md)`|\]\(((?:\.\.\/|_shared\/|(?:[a-z][a-z0-9-]*\/)?references\/)[^)]+\.md)\)/g;
// E1：反引号内的绝对路径 .md 引用（含 .pi/skills 前缀）——cwd 依赖，跨环境必然失效
const ABSOLUTE_REF_RE = /`(\/[^`\n]*\.pi\/skills\/[^`\n]*\.md)`/;
// E1b：_shared/ 裸写法（无 ../ 前缀）。SDK 系统提示指引 agent「resolve against the
// skill directory」，会把 `_shared/x` 解析到 `<skill>/_shared/x`（从未存在）→ ENOENT。
// 实证：941 session 扫描 28 次失败全为此形态（8/10→9/02 持续，3 个 session 试错后放弃）。
// 正确写法 `../_shared/x`：相对 skill 目录解析恰好命中 skills 根。
const BARE_SHARED_REF_RE = /`_shared\/[^`\n]+\.md`|\]\(_shared\/[^)]+\.md\)/;

/** 解析引用形态 → 文件绝对路径（与 REF_LINE_RE 的宇宙一一对应） */
function resolveRefToAbs(s, refPath) {
  if (refPath.startsWith("_shared/") || /^[a-z][a-z0-9-]*\/(?:references|_shared)\//.test(refPath)) {
    return path.resolve(SKILLS_DIR, refPath);
  }
  return path.resolve(s.dir, refPath);
}

/** 提取 body 中全部引用 → [{ raw, abs }]（校验 7 存在性 + 校验 9 可见性共用） */
function extractRefs(s, body) {
  return [...body.matchAll(REF_LINE_RE)].map(m => {
    const raw = m[1] ?? m[2];
    return { raw, abs: resolveRefToAbs(s, raw) };
  });
}

/** 定位 "## 工作流" section 的行范围 [start, end)。无工作流 section 返回 null */
function workflowLineRange(bodyLines) {
  let start = -1;
  let end = bodyLines.length;
  for (let i = 0; i < bodyLines.length; i++) {
    if (!/^##\s/.test(bodyLines[i])) continue;
    if (start >= 0) { end = i; break; }
    if (/^##\s+工作流/.test(bodyLines[i])) start = i;
  }
  return start >= 0 ? [start, end] : null;
}

let errors = 0;
let warnings = 0;
/** 校验 9 E2：skill 名 → { wfRefs: 本 skill 工作流内的引用集, allRefs: 全部引用集 } */
const skillWorkflowRefs = new Map();

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

  // 校验 7: references 路径存在（含跨 skill 形态，解析规则见 extractRefs）
  for (const { raw, abs } of extractRefs(s, s.body)) {
    if (!fs.existsSync(abs)) error(`${rel}: references 路径不存在: ${raw}`);
  }

  // 校验 9: references 引用形态可见性（#726）——收集引用，判定在全局 pass。
  // 引用键用解析后的绝对路径：不同 skill 对同一文件的引用字符串可能不同
  //（如 `references/xxx.md` vs `adversarial-review/references/xxx.md`），归一化后才能认出跨 skill 绑定。
  // E1: 绝对路径引用——agent 在其他 cwd（worktree、子 agent 沙箱）必然读不到
  if (ABSOLUTE_REF_RE.test(s.body)) {
    error(`${rel}: references 绝对路径引用（含 /…/.pi/skills/…）——agent 换 cwd 后不可解析，改用相对 skill 目录的路径`);
  }
  // E1b: _shared/ 裸写法——agent 按 SDK 指引解析到 <skill>/_shared/x（从未存在）→ ENOENT
  const bareShared = s.body.match(/`(_shared\/[^`\n]+\.md)`|\](_shared\/[^)]+\.md)\)/);
  if (BARE_SHARED_REF_RE.test(s.body)) {
    const shown = bareShared ? bareShared[1] ?? bareShared[2] : "_shared/xxx.md";
    error(`${rel}: _shared/ 裸写法引用 \`${shown}\`——agent 会解析到 <skill>/_shared/（不存在，实证 28 次 ENOENT），改写为 \`../${shown}\``);
  }
  const bodyLines9 = s.body.split("\n");
  const wf9 = workflowLineRange(bodyLines9);
  const wfText9 = wf9 ? bodyLines9.slice(wf9[0], wf9[1]).join("\n") : "";
  const wfRefs9 = new Set(extractRefs(s, wfText9).map(r => r.abs));
  const allRefs9 = new Set(extractRefs(s, s.body).map(r => r.abs));
  skillWorkflowRefs.set(s.name, { wfRefs: wfRefs9, allRefs: allRefs9, rel, dir: s.dir });

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

// 校验 9 E2 全局 pass：引用可见性 = 出现在任一 skill 的工作流 section（含跨 skill 绑定）。
// 分级：哪都没绑定 → error；仅其他 skill 的工作流绑定、本 skill 未内联 → warning。
// （实证 #726：工作流内联引用被高频读取（20-190 次）；索引-only 引用低频/零读取；
//   跨 skill 工作流绑定有效（author-response-protocol.md 由 code-implementation 步骤 10 绑定，被读 48 次））
// 并集提到循环外一次构建（检视发现 3：原实现在循环内重建，O(skills²)）
const anyWorkflowRefs = new Set();
for (const { wfRefs } of skillWorkflowRefs.values()) {
  for (const r of wfRefs) anyWorkflowRefs.add(r);
}
for (const refs of skillWorkflowRefs.values()) {
  const rel = refs.rel;
  for (const refAbs of refs.allRefs) {
    if (refs.wfRefs.has(refAbs)) continue; // 本 skill 工作流已内联
    const refRel = path.relative(refs.dir, refAbs).startsWith("..")
      ? path.relative(SKILLS_DIR, refAbs)
      : path.relative(refs.dir, refAbs);
    if (anyWorkflowRefs.has(refAbs)) {
      warn(`${rel}: 引用 ${refRel} 本 skill 工作流未内联，仅由其他 skill 的工作流绑定——建议在本 skill 对应步骤也内联`);
    } else {
      error(`${rel}: 引用 ${refRel} 未被任何 skill 工作流步骤内联，只出现在参考索引——agent 不会主动 read（#726 零读取实证）。请在工作流对应步骤中引用（如：详见 \`${refRel}\`）`);
    }
  }
}

if (warnings > 0) console.log(`[lint:skills] ${warnings} 个警告`);
if (errors > 0) {
  console.error(`[lint:skills] ${errors} 个错误`);
  process.exit(1);
}
console.log(`[lint:skills] OK（${skills.length} skills，${warnings} warnings）`);
