#!/usr/bin/env node
/**
 * 注释编号禁绝闸：非特性文档的代码注释里不允许出现任何编号。
 *
 * 规则（搭档拍板）：特性编号（字母+8位日期+后缀形态）、检视轮次编号（中文动作词短语 /
 * round/轮形态 / 单字母序号）、issue 编号（井号+字母数字，色值不豁免）一律禁止。
 * 判据一句话——注释 why 用文字直接写清楚，编号是「跳去别处」的指针，没必要。
 *
 * 检测口径：PR 新增行 only（防复发）；存量分批整改由本特性链逐批清理。
 * 排除：特性文档目录（编号的家）、dist 产物、生成文件、纯 JSON、markdown。
 *
 * 注释识别（语言专用扫描器，全文持续状态）：
 *   - TS/JS 系：TypeScript createScanner——模板字符串/表达式、跨行块注释、正则、字符串全部
 *     由编译器级词法保证，不重复实现语法
 *   - YAML：# 仅在行首或空白后作注释（裸 URL 内的井号不误伤）
 *   - Shell：# 仅在词首或控制运算符后作注释
 *   - Python/TOML：# 行内即注释（引号外），三引号字符串跨行跳过（仅正常代码位置触发）
 *   - HTML：<!-- --> 跨行；CSS：斜杠星块注释跨行；SCSS/SASS/LESS：另加 // 行注释；均跳过字符串
 *
 * 行号定位：diff 新增行按新文件行号回查「全文词法标注」。
 * 读取失败 fail-closed：受支持的代码文件读不到即拒判，绝不静默放行。
 * 退出码：0 无违规（含纯删除变更）/ 1 违规 / 2 拒判（diff 完全为空或读取失败）。
 * 用法：node scripts/check-pr-anchor-discipline.mjs --base <ref> [--diff-file <path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** 排除路径。 */
export function isExcludedPath(p) {
  if (/^docs\/features\//.test(p)) return true;
  if (/(^|\/)dist\//.test(p) || /(^|\/)node_modules\//.test(p)) return true;
  if (/\.d\.ts$/.test(p)) return true;
  if (/\.json$/.test(p)) return true;
  if (/\.md$/.test(p)) return true;
  return false;
}

/** 井号注释语言（# 是注释导引符）。 */
export function isHashCommentLang(p) {
  return /\.(ya?ml|sh|py|toml)$/.test(p);
}

/** HTML 语言（<!-- -->）。 */
export function isHtmlLang(p) {
  return /\.html?$/.test(p);
}

/** CSS 系语言（块注释；scss/sass/less 另有 // 行注释）。 */
export function isCssLikeLang(p) {
  return /\.(css|scss|sass|less)$/.test(p);
}

/** 支持的代码注释语言（用于判定是否可建立注释状态）。 */
export function isSupportedCodePath(p) {
  if (isHashCommentLang(p) || isHtmlLang(p) || isCssLikeLang(p)) return true;
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p);
}

/** 工具脚本自身：注释里的编号 token 是规则说明（元语言），不参与存量子清理与新增行拦截。 */
export function isToolScriptPath(p) {
  return (
    p === "scripts/clean-comment-anchors.mjs" ||
    p === "scripts/check-pr-anchor-discipline.mjs" ||
    p === "scripts/check-pr-claim.mjs" ||
    p === "scripts/commit-msg-claim-gate.mjs"
  );
}

/** 特性编号：[FR] + 8 位日期 +（可选连字符）+ 4-10 位字母数字后缀。 */
export const FID_RE = /[FR]\d{8}-?[a-z0-9]{4,10}/g;

/** issue 编号：井号+字母数字。色值不豁免——注释里写色值改用文字表述。 */
const ISSUE_CAND_RE = /\B#([0-9a-zA-Z]+)\b/g;
const REGION_DIRECTIVE_RE = /^(?:end)?region$/i;

/** 技术词豁免表：单字母+数字中的高置信技术词（芯片代际 / 存储桶 / 纸张规格）。 */
const TECH_TOKEN_RE = /\b(?:M[0-9]{1,2}|S3|A[1-4])\b/;

/** 文档结构编号：方案/特性文档的小节、分节、检查项、阶段、章节、实现记录引用。 */
export const DOC_STRUCTURE_RES = [
  /\bT[0-9]+\b/g, // T 小节号（ISO 时间在豁免逻辑排除）
  /\bPart\s*[0-9]+(?:\.[0-9]+)?/gi, // Part 分节号（含小数点变体）
  /\b[BC][0-9]+(?:-[BC][0-9]+)*/g, // 检查项号（含区间变体）
  /方案\s*[A-Z]\s*节/g, // 方案字母+节 引用
  /方案\s*§\s*[0-9]+(?:\.[0-9]+)?/g, // 方案+章节号（整体删，不留「方案」残渣）
  /方案\s*Part\s*[0-9]+(?:\.[0-9]+)?/gi, // 方案+分节号
  /\bPR-[A-Z][0-9]?\b/g, // PR 代号（拉请求分片号）
  /\bD[0-9]+(?:-[A-Z]?[0-9]+)*/g, // D 实现记录号（含区间与数字子项 D1-1）
  /阶段\s*[0-9]+[a-z]?/g, // 阶段号（含字母后缀）
  /\bPhase\s*[0-9]+/g, // Phase 号（仅大写，不误伤 phase1 文件名）
  /§\s*[0-9]+(?:\.[0-9]+)?/g, // 章节号（含小数点变体）
  /方案\s*v[0-9]+(?:\.[0-9]+)?/gi, // 方案版本号
  /\bR[0-9]+[a-z]?\b/g, // R 规则号（单位数也禁：R1-R9 + R099/R100）
  /\bS[0-9]+[a-z]?(?:\.[0-9]+)?\b/g, // S 审视项号（含字母/小数点后缀）
  /\bM[0-9]+[a-z]?\b/g, // M 审视项号（含字母后缀）
  /\bA[0-9]+[a-z]?\b/g, // A 审视项号（含字母后缀）
  /\bm[0-9]+[a-z]?\b/g, // m 审视项号（含字母后缀）
  /\bP[0-9]+(?:[a-z][0-9]?)?\b/g, // P 阶段缩写号（含字母后缀）
];

/** 检视轮次编号形态（过程编号）。 */
export const DISPOSITION_RES = [
  /** 中文动作词 × 处置词 × 序号 */
  /(?:审视|检视|复审|快审|终核|评审)\s*(?:修复|处置|发现|建议)\s*[0-9]+/g,
  /** round 形态 */
  /round[- ]?[0-9]+/gi,
  /** 第 N 轮 */
  /第\s*[0-9]+\s*轮/g,
  /** 检视/审视/复审/评审轮次 N */
  /(?:检视|审视|复审|评审)轮次\s*[0-9]+/g,
  /** 单字母序号紧跟处置语境（字符类与处置词共现；S/M/A/R 已归文档编号形态） */
  /\b[Nr][0-9]{1,2}\s*(?:修复|处置|发现|建议|复核|确认|配套)/g,
  /** 发现/建议/严重 N 紧跟处置词 */
  /(?:发现|建议|严重)\s*[0-9]+\s*(?:处置|修复|配套|建议)/g,
  /** delta 轮：delta 发现/建议/修复/处置 N */
  /\bdelta\s*(?:发现|修复|建议|处置|复核|审视|确认|配套)\s*[0-9]+/gi,
  /** delta 轮简写：delta-r3 / delta D1 / delta2 / delta-3（字母可选，大小写不敏感——Delta2 / DeltaR3 / DELTA-r3 同判） */
  /\bdelta[- ]?[A-Za-z]?[0-9]+/gi,
  /** 检视/审视/复审语境 + 小写 sN（不全局禁 sN——变量名/麻将区间不误伤） */
  /(?:检视|审视|复审|评审|快审|终核)\s*\bs[0-9]+[a-z]?\b/g,
  /** sN / minorN 后紧跟（检视/审视/复审…）形态 */
  /\b(?:s|minor)[0-9]+[a-z]?(?=\s*[（(](?:检视|审视|复审|评审))/g,
  /** 日期型检视轮指针：F+8 位日期 + 检视轮 */
  /F\d{8}\s*检视轮/g,
];

/** 文档结构编号的语义豁免：日常词/时间/复合名不走「文档编号」删除。 */
function isExemptDocNumber(commentText, m, kind) {
  const before = commentText.slice(0, m.index);
  const after = commentText.slice(m.index + m[0].length);
  const token = m[0];
  if (kind === "T编号") {
    // ISO 时间（T10:00）——后紧跟英文冒号+数字；中文冒号是分隔符照删
    return /^:\d/.test(after);
  }
  if (kind === "BC检查项") {
    // B/C 系列纸张/信封规格（如「B4 纸」「C5 信封」）不误删；
    // C3 高警队列（healing 高危路由登记表）是队列名，不是检查项号：
    // 后跟高警/告警/入队/队列，或前有入/不入（「不再入 C3」「不入 C3 告警」）均豁免
    if (token === "C3" && (/^\s*(?:高警|告警|入队|队列)/.test(after) || /(?:入|不入)\s*$/.test(before))) return true;
    return /^\s*(?:纸|信封|系列|幅面)/.test(after);
  }
  if (kind === "m编号") {
    // bge-m3 模型名（前是连字符）、麻将牌索引 m0-8（后是连字符+数字）、m5.large 实例（后是点）
    if (/-$/.test(before) || /^-\d/.test(after) || /^\./.test(after)) return true;
    // 测试数据/窗口边界：m1/m2/m3 斜杠列表 或「m1 之前/之后」时间窗口语（非审视项号）
    if (/[^/]\s*\/\s*$/.test(before) || /^\s*\//.test(after)) return true;
    if (/^\s*(?:之前|之后|前|后)(?=$|[^0-9])/.test(after)) return true;
  }
  if (kind === "R编号") {
    // git rename 相似度分数（R100/R096/R50% 等）——diff --name-status 的 R 分，不是规则号
    // （规则号在本仓实际只到 R12；R50+ 的三位数 R 均出现在 lint-historical-docs 的 git 语境）
    const n = Number(token.slice(1));
    return Number.isInteger(n) && n >= 50;
  }
  if (kind === "Phase") {
    // 英文步骤标签（Phase 1: Stream ...）是代码步骤描述，不是文档分节指针；
    // 中文描述（多模态 Phase 1：附件 repo）仍是文档阶段号照删
    return /^:\s*[A-Za-z]/.test(after);
  }
  if (kind === "S编号" || kind === "M编号" || kind === "A编号" || kind === "m编号") {
    // 明确审视语境（前后紧跟审视/检视/轮/锚点/(检视)）→ 编号，不豁免（删）
    const afterCtx = after.trimStart();
    if (/^(?:审视|检视|复审|评审|快审|终核|锚点|轮)/.test(afterCtx)) return false;
    if (/^[(（](?:审视|检视|复审|评审)/.test(afterCtx)) return false;
    if (/(?:审视|检视|复审|评审|快审|终核|锚点|轮)\s*$/.test(before.trimEnd())) return false;
    // 段落级技术词（芯片/存储/纸/信封/设备/实例/尺寸/桶）→ 该段字母编号视作日常词豁免
    if (/芯片|存储|纸|信封|设备|实例|尺寸|桶/.test(commentText)) return true;
    // 默认：审视项编号（无技术语境）→ 删
    return false;
  }
  if (kind === "P编号") {
    // 优先级取值/分位/Job 代号：P1→P2、P0/P1/P2 斜杠列表（空格或不空格）、priority 语境、P99 分位、P0-b 类后缀
    return (
      /^→/.test(after) ||
      /→$/.test(before) ||
      /^\s*\//.test(after) || // 斜杠列表（P0/P1 或 P0 / P1）
      /[^/]\s*\/\s*$/.test(before) || // 列表后项（前是「/」或「 /」，排除注释引导符 // 自身）
      /^-[a-z0-9]/i.test(after) ||
      /priority/i.test(before) ||
      token === "P99"
    );
  }
  return false;
}

/** 对一段注释文本收集违规编号（含 token 在文本内的精确位置）。 */
export function collectAnchorViolationsWithIndex(commentText) {
  const out = [];
  const push = (token, kind, start, end) => out.push({ token, kind, start, end });

  for (const m of commentText.matchAll(FID_RE)) push(m[0], "特性编号", m.index, m.index + m[0].length);

  // issue 编号：井号+字母数字，排除 region/endregion 折叠指令
  ISSUE_CAND_RE.lastIndex = 0;
  for (const m of commentText.matchAll(ISSUE_CAND_RE)) {
    if (REGION_DIRECTIVE_RE.test(m[1])) continue;
    push(m[0], "issue 编号", m.index, m.index + m[0].length);
  }

  for (const re of DISPOSITION_RES) {
    re.lastIndex = 0;
    for (const m of commentText.matchAll(re)) push(m[0], "轮次编号", m.index, m.index + m[0].length);
  }

  // 文档结构编号（T/Part/B/C/方案/D/阶段/Phase/§/方案 vN/R/S/M/A/m/P）
  const docKinds = [
    "T编号", "Part分节", "BC检查项", "方案节", "方案章节", "方案分节", "PR代号", "D编号", "阶段", "Phase", "§章节",
    "方案版本", "R编号", "S编号", "M编号", "A编号", "m编号", "P编号",
  ];
  DOC_STRUCTURE_RES.forEach((re, i) => {
    re.lastIndex = 0;
    for (const m of commentText.matchAll(re)) {
      if (isExemptDocNumber(commentText, m, docKinds[i])) continue;
      push(m[0], "文档编号", m.index, m.index + m[0].length);
    }
  });

  // 孤立单字母序号仍禁，但高置信技术词（芯片代际 / 存储桶 / 纸张规格）豁免
  TECH_TOKEN_RE.lastIndex = 0;
  const singleRe = /\b[Nr][0-9]{1,2}[a-z]?\b/g;
  for (const m of commentText.matchAll(singleRe)) {
    if (TECH_TOKEN_RE.test(m[0])) continue;
    if (out.some((v) => v.kind === "轮次编号" && v.token === m[0])) continue;
    push(m[0], "轮次编号", m.index, m.index + m[0].length);
  }

  return out;
}

/** 对一段注释文本收集违规编号。 */
export function collectAnchorViolations(commentText) {
  return collectAnchorViolationsWithIndex(commentText).map(({ token, kind }) => ({ token, kind }));
}

function countLines(content, pos) {
  return content.slice(0, pos).split("\n").length;
}

/** TS/JS 系：TS 编译器级 AST + 注释范围收集。返回每行注释文本（1 基）。segs 可选：记录行内注释段精确 offset。 */
function annotateTs(content, path, segs = null) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  // 仅 .tsx/.jsx 用 JSX/AST 词法；模板字符串/嵌套模板/JSX 文本均由 createSourceFile 保证，不再手写状态机
  const scriptKind = /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(path)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind);
  const seen = new Set();
  // JSX 文本（<div>这里的内容</div>）不是注释：其中出现的 // 或 /* 不能被文本级
  // getLeadingCommentRanges/getTrailingCommentRanges 误判为注释。先收集全部 JsxText
  // 区间，record 时落在区间内的范围直接跳过。
  const jsxTextSpans = [];
  const collectJsxText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTextSpans.push({ pos: node.getStart(sourceFile), end: node.getEnd() });
    }
    ts.forEachChild(node, collectJsxText);
  };
  collectJsxText(sourceFile);
  const inJsxText = (pos, end) => {
    for (const s of jsxTextSpans) {
      if (pos < s.end && end > s.pos) return true;
    }
    return false;
  };
  const record = (pos, end) => {
    if (pos < 0 || end > content.length || pos >= end) return;
    if (inJsxText(pos, end)) return;
    const key = `${pos}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = content.slice(pos, end);
    const startLine = countLines(content, pos);
    const lineStartOffset = content.lastIndexOf("\n", pos - 1) + 1;
    const startCol = pos - lineStartOffset;
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const idx = startLine - 1 + i;
      if (idx >= lines.length) continue;
      const start = i === 0 ? startCol : 0;
      const endCol = i === parts.length - 1 ? start + parts[i].length : lines[idx].length;
      out[idx] = out[idx] == null ? parts[i] : `${out[idx]} ${parts[i]}`;
      if (segs) segs.push({ line: idx, start, end: endCol, text: parts[i] });
    }
  };
  const visit = (node) => {
    // leading 注释（节点首 token 上方各行）+ trailing 注释（节点末 token 同行尾部）
    ts.forEachLeadingCommentRange(content, node.pos, (lpos, lend) => record(lpos, lend));
    const trailing = ts.getTrailingCommentRanges(content, node.end);
    if (trailing) for (const r of trailing) record(r.pos, r.end);
    // 用 getChildren（而非 forEachChild）递归：把标点 token 也纳入，
    // 否则 `{ // 注释`、`foo(a, // 注释` 这类开括号/逗号后的 trailing 注释会漏扫。
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return out;
}

/** YAML：# 仅在行首或空白后作注释；块标量（| 或 >，含列表项与显式缩进指示符）正文是字符串非注释。 */
function annotateYaml(content, segs = null) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let blockIndent = null; // 块标量正文的最小缩进（父键缩进）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blockIndent != null) {
      if (line.trim() === "") {
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent > blockIndent) continue; // 正文，非注释
      blockIndent = null; // 缩进回到父级，块标量结束
    }
    let state = "normal";
    let commentStart = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (state === "normal") {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "#") {
          const prev = j === 0 ? " " : line[j - 1];
          if (prev === " " || prev === "\t") {
            commentStart = j;
            out[i] = line.slice(j);
            if (segs) segs.push({ line: i, start: j, end: line.length, text: line.slice(j) });
            break;
          }
        }
      } else if (state === "single") {
        if (ch === "'") {
          if (line[j + 1] === "'") j += 1;
          else state = "normal";
        }
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      }
    }
    // 块标量 opener 在注释前的代码区间检测（覆盖 key: |、- |、|2 等合法形式）
    const codePart = commentStart == null ? line : line.slice(0, commentStart);
    if (/(?:^|:\s*|\?\s*|-\s*)[|>][+-]?[0-9]*\s*$/.test(codePart)) {
      blockIndent = (line.match(/^\s*/) || [""])[0].length;
    }
  }
  return out;
}

/** Shell：# 仅在词首或控制运算符后作注释；heredoc 正文是数据非注释（opener 在行尾注释前检测）。 */
function annotateSh(content, segs = null) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let heredocDelim = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (heredocDelim != null) {
      out[i] = null; // heredoc 正文
      if (line.trim() === heredocDelim) heredocDelim = null;
      continue;
    }
    let state = "normal";
    let commentStart = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (state === "normal") {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "#") {
          const prev = j === 0 ? "" : line[j - 1];
          if (j === 0 || /\s|;|&|\||\(|\)/.test(prev)) {
            commentStart = j;
            out[i] = line.slice(j);
            if (segs) segs.push({ line: i, start: j, end: line.length, text: line.slice(j) });
            break;
          }
        }
      } else if (state === "single") {
        if (ch === "'") state = "normal";
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      }
    }
    // heredoc opener 在注释前的代码区间检测
    const codePart = commentStart == null ? line : line.slice(0, commentStart);
    const heredocM = codePart.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/);
    if (heredocM) heredocDelim = heredocM[1] || heredocM[2] || heredocM[3];
  }
  return out;
}

/** Python：# 行内即注释（引号外）；三引号字符串跨行跳过（仅正常代码位置触发）。 */
function annotatePython(content, segs = null) {
  return annotatePyOrToml(content, /* tomlLiteral */ false, segs);
}

/** TOML：# 行内即注释（引号外）；单引号 literal string 不转义反斜杠，三引号跨行跳过。 */
function annotateToml(content, segs = null) {
  return annotatePyOrToml(content, /* tomlLiteral */ true, segs);
}

/**
 * Python/TOML 共用：# 行内即注释（引号外）；三引号字符串跨行跳过（仅正常代码位置触发）。
 * tomlLiteral=true 时单引号字符串不把反斜杠当转义（TOML literal string 规则）。
 */
function annotatePyOrToml(content, tomlLiteral, segs = null) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let inTriple = null; // 三引号定界符（""" 或 '''）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let j = 0;
    if (inTriple) {
      const close = line.indexOf(inTriple);
      if (close < 0) continue; // 整行在三引号字符串内
      j = close + 3;
      inTriple = null;
    }
    let state = "normal";
    for (; j < line.length; j++) {
      const ch = line[j];
      if (state === "normal") {
        if ((ch === '"' || ch === "'") && line.startsWith(ch + ch + ch, j)) {
          const triple = ch + ch + ch;
          const rest = line.slice(j + 3);
          const closeInLine = rest.indexOf(triple);
          if (closeInLine >= 0) {
            j = j + 3 + closeInLine + 2; // 跳到闭合后
          } else {
            inTriple = triple;
            break; // 三引号 opener 之前无注释
          }
        } else if (ch === '"') state = "double";
        else if (ch === "'") state = "single";
        else if (ch === "#") {
          out[i] = line.slice(j);
          if (segs) segs.push({ line: i, start: j, end: line.length, text: line.slice(j) });
          break;
        }
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      } else if (state === "single") {
        if (!tomlLiteral && ch === "\\") j += 1;
        else if (ch === "'") state = "normal";
      }
    }
  }
  return out;
}

/** HTML：<!-- --> 跨行；闭合行从闭合标记后恢复扫描。 */
function annotateHtml(content, segs = null) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const comments = [];
    const cmSegs = [];
    let j = 0;
    if (inComment) {
      const close = line.indexOf("-->");
      if (close < 0) {
        out[i] = line;
        if (segs) segs.push({ line: i, start: 0, end: line.length, text: line });
        continue;
      }
      comments.push(line.slice(0, close + 3));
      cmSegs.push({ start: 0, end: close + 3 });
      j = close + 3; // 闭合后继续扫描
      inComment = false;
    }
    for (; j < line.length; j++) {
      if (line.startsWith("<!--", j)) {
        const close = line.indexOf("-->", j + 4);
        if (close < 0) {
          comments.push(line.slice(j));
          cmSegs.push({ start: j, end: line.length });
          inComment = true;
          break;
        }
        comments.push(line.slice(j, close + 3));
        cmSegs.push({ start: j, end: close + 3 });
        j = close + 2;
      }
    }
    if (comments.length) {
      out[i] = comments.join(" ");
      if (segs) for (const s of cmSegs) segs.push({ line: i, ...s, text: line.slice(s.start, s.end) });
    }
  }
  return out;
}

/** CSS 系：斜杠星块注释跨行 + 引号字符串跳过；scss/sass/less 另加 // 行注释（URL scheme 的 // 不误判）。 */
function annotateCss(content, allowLineComment, segs = null) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const comments = [];
    const cmSegs = [];
    let state = "normal";
    let j = 0;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close < 0) {
        out[i] = line;
        if (segs) segs.push({ line: i, start: 0, end: line.length, text: line });
        continue;
      }
      comments.push(line.slice(0, close + 2));
      cmSegs.push({ start: 0, end: close + 2 });
      j = close + 2; // 闭合后继续扫描代码
      inBlock = false;
    }
    for (; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (state === "normal") {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "/" && next === "*") {
          const end = line.indexOf("*/", j + 2);
          if (end < 0) {
            comments.push(line.slice(j));
            cmSegs.push({ start: j, end: line.length });
            inBlock = true;
            break;
          }
          comments.push(line.slice(j, end + 2));
          cmSegs.push({ start: j, end: end + 2 });
          j = end + 1;
        } else if (allowLineComment && ch === "/" && next === "/") {
          // 行注释：URL scheme 的 //（前一个字符是冒号）不是注释
          const prev = j === 0 ? "" : line[j - 1];
          if (prev !== ":") {
            comments.push(line.slice(j));
            cmSegs.push({ start: j, end: line.length });
            break;
          }
        } else if (allowLineComment && (ch === "u" || ch === "U") && /^url\(/i.test(line.slice(j, j + 4))) {
          // url( 无引号参数：跳过到匹配 )。其中的 // 不是行注释
          let depth = 0;
          let k = j + 3; // 指向 (
          let q = null;
          k += 1;
          while (k < line.length) {
            const c = line[k];
            if (q) {
              if (c === "\\") k += 1;
              else if (c === q) q = null;
            } else if (c === "'" || c === '"') q = c;
            else if (c === "(") depth += 1;
            else if (c === ")") {
              if (depth === 0) break;
              depth -= 1;
            }
            k += 1;
          }
          j = k;
        }
      } else if (state === "single") {
        if (ch === "\\") j += 1;
        else if (ch === "'") state = "normal";
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      }
    }
    if (comments.length) {
      out[i] = comments.join(" ");
      if (segs) for (const s of cmSegs) segs.push({ line: i, ...s, text: line.slice(s.start, s.end) });
    }
  }
  return out;
}

/** 全文词法标注：返回行号(1 基) → 该行注释文本（跨行块注释体内行也标为注释）。 */
export function annotateFile(content, path, segs = null) {
  if (isHtmlLang(path)) return annotateHtml(content, segs);
  if (isCssLikeLang(path)) return annotateCss(content, /\.(scss|sass|less)$/.test(path), segs);
  if (isHashCommentLang(path)) {
    if (/\.ya?ml$/.test(path)) return annotateYaml(content, segs);
    if (/\.sh$/.test(path)) return annotateSh(content, segs);
    if (/\.toml$/.test(path)) return annotateToml(content, segs);
    return annotatePython(content, segs);
  }
  return annotateTs(content, path, segs);
}

/** 行内注释段（精确 offset）：[{line: 0基, start, end, text}]。清理工具与判定器共用同一词法。 */
export function annotateFileSegments(content, path) {
  const segs = [];
  annotateFile(content, path, segs);
  return segs;
}

/** 解码 Git C 风格引号路径（\ooo 八进制字节序列按 UTF-8 还原）。失败抛错。 */
export function decodeCQuotedPath(s) {
  let latin1 = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (/[0-7]/.test(s[i + 1])) {
        const m = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (!m) throw new Error("bad octal escape");
        latin1 += String.fromCharCode(parseInt(m[0], 8));
        i += m[0].length;
      } else if (s[i + 1] !== undefined) {
        latin1 += s[i + 1];
        i += 1;
      } else {
        throw new Error("trailing backslash");
      }
    } else {
      if (ch.charCodeAt(0) > 0x7f) throw new Error("unexpected non-ascii in quoted path");
      latin1 += ch;
    }
  }
  return Buffer.from(latin1, "latin1").toString("utf8");
}

/** 解析 unified diff（--unified=0）新增行。带引号路径（中文等）解码；无法识别的文件头抛错。 */
export function parseDiffAddedLines(diffText) {
  const out = [];
  const files = new Set();
  let path = null;
  let newLine = 0;
  let seenHunk = false;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const rest = raw.slice(4);
      if (rest.startsWith('"')) {
        const end = rest.lastIndexOf('"');
        if (end <= 0) throw new Error(`无法解析带引号文件头：${raw}`);
        path = decodeCQuotedPath(rest.slice(1, end));
      } else {
        path = rest;
      }
      if (path.startsWith("b/")) path = path.slice(2);
      else if (path.startsWith("a/")) path = path.slice(2);
      files.add(path);
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) {
      seenHunk = true;
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (path == null) continue;
    if (raw.startsWith("+")) {
      out.push({ path, line: newLine, content: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      // 删除行不推进新文件行号
    } else {
      newLine += 1;
    }
  }
  return { added: out, files: [...files], diffNonEmpty: seenHunk || files.length > 0 };
}

/** 默认读 HEAD 版本文件内容（与 git diff origin/main...HEAD 的行号同源；工作区脏时不错位）。 */
function readHeadFile(p) {
  return execFileSync("git", ["show", `HEAD:${p}`], { encoding: "utf8", timeout: 30_000 });
}

/**
 * 对 diff 全量判定。readFileFn 用于按新文件行号读全文；测试注入。
 * 受支持的代码文件读取失败时抛错（fail-closed，由调用方转 exit 2）。
 */
export function checkDiff(diffText, readFileFn = readHeadFile) {
  const { added, diffNonEmpty } = parseDiffAddedLines(diffText);
  if (!diffNonEmpty) return { addedTotal: 0, diffNonEmpty: false, violations: [] };

  const cache = new Map();
  const annotate = (p) => {
    if (cache.has(p)) return cache.get(p);
    let ann;
    try {
      ann = annotateFile(readFileFn(p), p);
    } catch (err) {
      throw new Error(`读取文件失败（fail-closed）：${p} —— ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    cache.set(p, ann);
    return ann;
  };

  const violations = [];
  for (const { path, line, content } of added) {
    if (isExcludedPath(path) || isToolScriptPath(path) || !isSupportedCodePath(path)) continue;
    const ann = annotate(path);
    const commentText = ann[line - 1] ?? null;
    if (!commentText) continue;
    for (const v of collectAnchorViolations(commentText)) {
      violations.push({ path, line, content: content.trim(), ...v });
    }
  }
  return { addedTotal: added.length, diffNonEmpty: true, violations };
}

function main() {
  const args = process.argv.slice(2);
  let base = "origin/main";
  let diffFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") base = args[++i];
    else if (args[i] === "--diff-file") diffFile = args[++i];
  }

  let diffText;
  try {
    diffText = diffFile
      ? readFileSync(diffFile, "utf8")
      : execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024 * 64,
        });
  } catch (err) {
    console.error(`[check-pr-anchor-discipline] 获取 diff 失败（拒判，fail-closed）：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = checkDiff(diffText);
  } catch (err) {
    console.error(`[check-pr-anchor-discipline] 判定失败（拒判，fail-closed）：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  if (!result.diffNonEmpty) {
    console.error("[check-pr-anchor-discipline] 空判定面（diff 无变更）——拒判不作「无违规」放行");
    process.exitCode = 2;
    return;
  }
  if (result.violations.length === 0) {
    if (result.addedTotal === 0) {
      console.log("✅ 注释编号禁绝：纯删除变更（无新增行），无可检测对象，放行");
    } else {
      console.log("✅ 注释编号禁绝：新增注释行无特性/轮次/issue 编号");
    }
    process.exitCode = 0;
    return;
  }
  console.log(`❌ 注释编号禁绝：新增注释行夹带编号 ${result.violations.length} 处（非特性文档注释不允许出现任何编号）：`);
  for (const v of result.violations) {
    console.log(`   - ${v.path}:${v.line}  [${v.kind}] ${v.token}  ← ${v.content}`);
  }
  process.exitCode = 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}