#!/usr/bin/env node
/**
 * Part A: Skill 系统契约校验（commit-time gate）。
 * F20260903（拆解）: _shared/ 目录退役——skills/ 下只有 skill；引用校验改为
 * 跨 skill 引用规范（校验 7/9），设计继承 诊断资产（940 session 扫描、
 *   28 次 ENOENT 根因、索引-only 零读取实证、golden 判据）。
 *
 * error（阻断）：
 *   1. SKILL.md frontmatter 必有 name / description / co_loads / category
 *   2. frontmatter.name 必须等于目录名
 *   3. manifest skill 集合 = .pi/skills 目录集合（双向，防孤立）
 *   4. manifest next 指针有效
 *   5. manifest not_for 指针有效
 *   6. manifest category 与 SKILL.md frontmatter category 一致（防漂移）
 *   7. SKILL.md 中提到的 references 路径必须存在（合法引用形态统一解析）
 *   8. 数量下限 ratchet（防"删光 skills + 同步清空 manifest"静默绿）
 * 9. 引用形态与可见性（/实证）：
 *      E1 绝对路径引用（agent 换 cwd/worktree 后必然读不到）
 *      E1b _shared/ 目录残留引用（目录已删除，任何形态的 _shared 引用都必然 ENOENT）
 *      E2 引用仅出现在参考索引、未在任何 skill 工作流步骤中内联出现
 *      （实证：步骤内联引用被 agent 主动 read（20-190 次），纯索引引用低频/零读取）
 *
 * warning（不阻断）：
 *   W1. SKILL.md 行数 ≤ 200
 *   W2. description 字符长度 ≤ 500
 *   W3. 两个 skill 的 not_for 互指对方（检查 Use when 区分度）
 *   W4. description 不含三段式 marker（Use when / Not for / Output）—— companion 豁免
 *
 * 引用形态宇宙（校验 7/9 共用）：
 *   - 本 skill 相对：`references/x.md`——相对当前 skill 目录解析（SDK 系统提示指引如此，
 *     agent 的 read 从 SKILL.md 所在目录出发）
 *   - 跨 skill 引用：**必须 `../` 前缀**（`../other-skill/references/x.md`）——与 SDK
 *     解析规则对齐（SDK 相对路径一律从当前 skill 目录解析）。
 * 非法形态（E1c，）：跨 skill **裸写**（`other-skill/references/x.md`、
 *   `other-skill/SKILL.md`）——lint 曾按 skills 根解析放行，但 SDK 从当前 skill 目录
 * 解析必然 ENOENT（28 次 ENOENT 同族病灶：lint 认存在、SDK 读不到 = 错误安全感）。
 *   其他非法：`_shared/x`、`../_shared/x`（目录已删，E1b）、绝对路径（E1）。
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
// 数量下限 ratchet（防"删光 skills + 同步清空 manifest"静默绿）。
// 有意移除 skill 时须同步下调此值，让移除成为显式决策。F20260903 拆解后 14 个 skill。
const MIN_SKILLS = 9;
const THREE_PART_MARKERS = ["Use when", "Not for", "Output"];
const THREE_PART_EXEMPT = new Set(["companion"]); // fallback skill 豁免

// 引用宇宙（合法形态）：本 skill 相对（references/）+ 跨 skill（../ 前缀，写死）。
// 跨 skill 裸写不再属于合法宇宙——由 E1c 显式拦截并给迁移指引。
const REF_LINE_RE = /`((?:\.\.\/|references\/)[^`]*\.md)`|\]\(((?:\.\.\/|references\/)[^)]+\.md)\)/g;

// E1c：跨 skill 裸写引用（<name>/references/… 或 <name>/SKILL.md）——lint 按 skills
// 根解析会放行，SDK 从当前 skill 目录解析必然 ENOENT。必须 ../ 前缀。
const BARE_CROSS_SKILL_RE = /`([a-z][a-z0-9-]*\/(?:references\/[^`]*\.md|SKILL\.md))`|\]\(([a-z][a-z0-9-]*\/(?:references\/[^)]+\.md|SKILL\.md))\)/g;
// E1：反引号内的绝对路径 .md 引用（含 .pi/skills 前缀）——cwd 依赖，跨环境必然失效
const ABSOLUTE_REF_RE = /`(\/[^`\n]*\.pi\/skills\/[^`\n]*\.md)`/;
// E1b：任何 _shared/ 引用（裸写或 ../ 前缀）。目录已随 F20260903 拆解删除，
// 任何形态都必然 ENOENT。实证：_shared/x 裸写 28 次读取失败（8/10→9/02）。
const SHARED_REF_RE = /(\.\.\/)?_shared\/[^`\n)\s]+\.md/;

let errors = 0;
let warnings = 0;
/** 校验 9 E2：skill 名 → { wfRefs: 本 skill 工作流内的引用集, allRefs: 全部引用集 } */
const skillWorkflowRefs = new Map();

function error(msg) { errors++; console.error(`✗ ${msg}`); }
function warn(msg) { warnings++; console.warn(`⚠ ${msg}`); }

/** 扫描 .pi/skills/ 下所有含 SKILL.md 的目录（skills/ 下只有 skill，F20260903） */
function scanSkillDirs() {
  const out = [];
  for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
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

/**
 * 解析引用形态 → 文件绝对路径（与 REF_LINE_RE 的合法宇宙一一对应）。
 * 解析规则（与 SDK 系统提示给 agent 的指引一致：相对 skill 目录解析）：
 *   references/x.md | ../x.md        → 相对当前 skill 目录
 * （跨 skill 裸写已非法化，E1c 拦截——不再参与存在性解析）
 */
function resolveRefToAbs(s, refPath) {
  return path.resolve(s.dir, refPath);
}

/** 提取 body 中全部合法引用 → [{ raw, abs }]（校验 7 存在性 + 校验 9 可见性共用） */
function extractRefs(s, body) {
  return [...body.matchAll(REF_LINE_RE)].map(m => {
    const raw = m[1] ?? m[2];
    return { raw, abs: resolveRefToAbs(s, raw) };
  });
}

/** 定位 "## 工作流" section 的行范围 [start, end)。无工作流 section 返回 null。
 *  结构假设：校验 9 E2 以「## 工作流」节为可见性判定域——写 skill 时必须保留该节名。 */
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

/** 提取「### 禁用语」节全文（ratchet 专用）：标题必须精确为「### 禁用语」（行尾无其他内容），
 *  到下一个 `## ` 节标题前结束。标题带后缀/改名均返回 null（触发 error，防节被改名绕过）。
 *  三级标题（###）属节内子级，只以二级（##）作为节边界。 */
function extractBannedSection(body) {
  const lines = body.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+禁用语\s*$/.test(lines[i]) && start < 0) { start = i; continue; }
    if (start >= 0 && /^##\s/.test(lines[i])) { end = i; break; }
  }
  return start >= 0 ? lines.slice(start, end).join("\n") : null;
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

  // 校验 9 E1: 绝对路径引用——agent 在其他 cwd（worktree、子 agent 沙箱）必然读不到
  if (ABSOLUTE_REF_RE.test(s.body)) {
    error(`${rel}: references 绝对路径引用（含 /…/.pi/skills/…）——agent 换 cwd 后不可解析，改用相对 skill 目录的路径`);
  }
  // 校验 9 E1b: _shared/ 残留引用——目录已删除（F20260903 拆解），任何形态必然 ENOENT
  if (SHARED_REF_RE.test(s.body)) {
    const shown = s.body.match(SHARED_REF_RE)?.[0] ?? "_shared/x.md";
    error(`${rel}: _shared/ 残留引用 \`${shown}\`——目录已随 F20260903 拆解删除。约定类内容已升格为 skill（signature-convention / review-protocol / conflict-resolution-protocol），模板在 writing-skills/references/`);
  }
  // 校验 9 E1c：跨 skill 裸写引用——lint 按 skills 根解析会放行，SDK 从当前
  // skill 目录解析必然 ENOENT（同族病灶：lint 认存在、SDK 读不到）。必须 ../ 前缀。
  {
    const bare = [...s.body.matchAll(BARE_CROSS_SKILL_RE)];
    for (const m of bare) {
      const raw = m[1] ?? m[2];
      error(`${rel}: 跨 skill 裸写引用 \`${raw}\`——SDK 从当前 skill 目录解析必然 ENOENT（#773）。改写为 \`../${raw}\`。若为反例说明（提及而非使用），请将裸写拆写为 \`foo/\` + \`references/\` 分段，避免整体落入反引号`);
    }
  }

  // 校验 7: references 路径存在（合法形态统一解析，规则见 resolveRefToAbs）
  for (const { raw, abs } of extractRefs(s, s.body)) {
    if (!fs.existsSync(abs)) error(`${rel}: references 路径不存在: ${raw}`);
  }

  // 校验 9 E2: 引用收集（可见性在全局 pass 判定——跨 skill 绑定需要全集）
  // 引用键用解析后的绝对路径归一：不同 skill 对同一文件的引用字符串可能不同
  //（如 `references/xxx.md` vs `adversarial-review/references/xxx.md`）。
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

  // 校验 10：adversarial-review 禁用语节完整性 ratchet——
  // 兜底原则句与关键中文变体词族不得删减（防回退到「仅枚举匹配」的缺口态）。
  // 语义：禁语判定必须按原则泛化，不是字面命中清单。
  // 只校验「### 禁用语」节（标题精确匹配 + 到下一 `## ` 前），避免 body 别处合法用例
  // （如 说明里的「不可降级为『可接受』或『完整』」）把 ratchet 榨空成永远真。
  if (s.name === "adversarial-review") {
    const bannedSection = extractBannedSection(s.body);
    if (!bannedSection) {
      error(`${rel}: 未找到「### 禁用语」节（标题须精确为「### 禁用语」）——#1896 ratchet 无法核验，禁语节不得改名/删除/加后缀`);
    } else {
      // 词项按带引号完整形态匹配：裸子串 includes 会被「均不阻塞」/「不阻塞合入」兑住
      // （发现 1 复现：删独立词项「不阻塞」后子串仍命中 → 假绿）。
      const requiredBanned = [
        '"不阻塞"',
        '"均不阻塞"',
        '"非阻塞"',
        '"可接受"',
        '"零成本"',
        '"不构成合入建议"',
      ];
      for (const phrase of requiredBanned) {
        if (!bannedSection.includes(phrase)) {
          error(`${rel}: 禁用语节缺词项 ${phrase}——#1896 复发根因是中文变体未被枚举、禁语靠字面匹配。清单不得删减`);
        }
      }
      // 兜底原则完整语义（发现 1 复现：删语义只留「枚举仅为示例」字样 → 假绿）。
      const requiredPrinciple = ["枚举仅为示例", "不是完整清单", "凡暗示"];
      for (const phrase of requiredPrinciple) {
        if (!bannedSection.includes(phrase)) {
          error(`${rel}: 禁用语节兜底原则语义不完整，缺「${phrase}」——#1896 兜底句不得删减为标记性字样`);
        }
      }
    }
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

// 校验 8: 数量下限 ratchet
if (skills.length < MIN_SKILLS) {
  error(`skills 数量 ${skills.length} < 下限 ${MIN_SKILLS}——skill 目录被清空或大量缺失？有意移除请同步下调 MIN_SKILLS`);
}

// 校验 9 E2 全局 pass：引用可见性 = 出现在任一 skill 的工作流 section（含跨 skill 绑定）。
// 分级：哪都没绑定 → error；仅其他 skill 的工作流绑定、本 skill 未内联 → warning。
// （实证 /工作流内联引用被高频读取（20-190 次）；索引-only 引用低频/零读取；
//   跨 skill 工作流绑定有效（author-response-protocol.md 由 code-implementation 步骤 10 绑定，被读 48 次））
// 豁免：SKILL.md 是 skill 入口文件——skill 加载即读，E2 的「索引-only 低可见性」
// 实证（针对 references 类材料文件）对入口文件不适用。
// 并集在循环外一次构建（O(skills)——原实现在循环内重建 O(skills²)）
const anyWorkflowRefs = new Set();
for (const { wfRefs } of skillWorkflowRefs.values()) {
  for (const r of wfRefs) anyWorkflowRefs.add(r);
}
for (const refs of skillWorkflowRefs.values()) {
  const rel = refs.rel;
  for (const refAbs of refs.allRefs) {
    if (refs.wfRefs.has(refAbs)) continue; // 本 skill 工作流已内联
    if (path.basename(refAbs) === "SKILL.md") continue; // skill 入口文件豁免
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
