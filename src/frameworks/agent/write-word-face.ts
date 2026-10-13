/**
 * write-word-face：词面证（F20261013gev2 能力 1-4，证明演算 §3.2.1 三条规则）。
 *
 * 规则 1（路径调用三分类）：写证据（写 mode/写 API/重定向）→ 落点判；读证据 → 只读不参与写证明；
 *   未知 mode/不可求值 → 不可证（fail-closed）。
 * 规则 2（exec 类）：运行时获得/构造的可调用执行一律不可证——exec/eval/system/popen/execSync/
 *   spawn/fork/import_module/__import__/getattr/Function/constructor/反引号/$(...) 递归、管道入
 *   shell；import/require 拆分：字面量模块名 → 规则 3 非路径调用（副作用残余记档），变量/拼接/路径
 *   形态 → exec 不可证。
 * 规则 3（非路径调用）：纯计算/网络等无文件路径字面量实参的调用不参与证明。
 * 证明无写 = 无写词面 ∧ 无隐式写词面 ∧ 无重定向落点 ∧ 无 exec 类 ∧ 载荷写调用=0。
 *
 * 词面证（能力 4 无落点正向证明）的适用面：结构不可信（parseOk=false/窄提取失败）时的正向证明
 *   兜底——扫的是**原文**，引号/参数分裂无法把写词面藏出扫描面（正是残余面「引号/参数分裂逃逸」的
 *   对偶防线）；反向不放宽：任何写面存在即不可证。载荷内引号失衡（递归 payload 解析失败）不走本
 *   通道——TS-c020 残余面钉死 fail-closed（payload-parse-failed），防「放宽误当修复面」。
 */
/** 能力 2：写词面命令族（裸词面——落点可字面量求值者由结构化通道收，其余不可证） */
const WRITE_FACE_WORDS = /(?:^|[\s;&|()`$])(?:touch|mkdir|rmdir|rm|mv|cp|tee|install|dd|truncate|ln|chmod|chown|chgrp|mknod|mkfifo|shred)(?:\s|$)/;
/** 能力 2：原地编辑词面（sed -i / perl -pi / ruby -pi 族——写面=原文件） */
const INPLACE_FACE = /(?:^|[\s;&|()`$])(?:sed\s+-[^\s]*i|perl\s+(?:-\w*p\w*|-[ip]\b)|ruby\s+(?:-\w*p\w*|-[ip]\b))/;
/** 能力 2：参数即落点（curl -o / wget -O / dd of=） */
const ARG_TARGET_FACE = /(?:^|[\s;&|()`$])(?:curl|wget)\s+[^\n]*\s-[oO]\s|(?:^|[\s;&|()`$])dd\s+[^\n]*\bof=/;
/** 能力 3：隐式写词面（元操作——写面在 cwd/仓，落点=cwd） */
const IMPLICIT_WRITE_FACE =
  /\bgit\s+(?:commit|amend|merge|rebase|cherry-pick|reset|revert|checkout|switch|restore|stash|clean|worktree\s+(?:add|remove|move|prune|repair)|branch\s+-[DdMm]|tag\b)|\b(?:npm|pnpm|yarn)\s+(?:install|i\b|ci\b|update|add|publish|pack|unpublish|link|dedupe)|\bpip3?\s+install|\bgem\s+install|\bcargo\s+(?:install|build|test|publish)|\bgo\s+(?:install|build|get)|\b(?:apt|apt-get|dnf|yum|brew|apk)\s+install|\bmake(?:\s|$)/;
/** 能力 1 规则 2：exec 类词面（可调用执行/递归构造） */
const EXEC_FACE =
  /\b(?:exec|execSync|execFile|spawn|spawnSync|fork|system|popen|eval|Function|__import__|import_module|getattr)\s*\(|\b(?:child_process|subprocess)\b|\bos\.(?:system|popen)\b|(?<!\\)[`$]\(|(?<=[\s;(=])<\(|(?<=[\s;)=])>\(|\beval\s+["'$]|(?<=[\s;&)])[|]{1,2}\s*(?:sudo\s+)?(?:ba|z|k)?sh\b|(?<=[\s;&)])[|]{1,2}\s*(?:python3?|node|perl|ruby)\b/;
/** 能力 1 规则 2：import/require 拆分——变量/拼接/路径形态 → exec 不可证（首参紧随字面量字符串=读披露放行） */
export const DYNAMIC_IMPORT_FACE = /\b(?:require|import)\s*\(\s*(?!['"][^'"]*['"])/;

/** 规则 2「exec 类一律不可证」的载荷闸（能力 5 附带，拍板 2026-10-13）：运行时获得/构造的
 *  可调用执行（裸调用形态）→ 不可证回落。点号方法调用（db.exec 型数据库调用）不拦——
 *  实证面 TS-e00efca3；点号方法残余面（os.system 等）与 exec 词面同口径记档特性文档。 */
export const SCRIPT_EXEC_FACE = /(?<![\w.])(?:exec|execSync|execFile|spawn|spawnSync|fork|system|popen|eval|Function|__import__|import_module|getattr|constructor)\s*\(/;
/** 能力 1 规则 1：脚本载荷写调用（写证据——出现即有写面，落点另行求值） */
const PAYLOAD_WRITE_FACE =
  /\b(?:writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|rmdirSync|truncateSync)\s*\(|\bfs\.(?:write|writev)\s*\(|\bos\.(?:remove|rename|mkdir|makedirs|rmdir|mknod|replace)\s*\(|\bshutil\.(?:copy|copy2|copytree|move|rmtree)\s*\(|\.\s*(?:writelines|truncate|unlink)\s*\(|(?<!stdout)(?<!stderr)\.\s*write\s*\(/;
/** 重定向落点词面（排除 fd 复制 2>&1/>&2、比较/箭头 =>/->/<=/>=）；&>/<>/>> 单列 */
const REDIRECT_FACE = /(?:&>{1,2}|<>|(?<![=\-<>&])>{1,2}(?!&|\(|=|\s*\/dev\/(?:null|std(?:out|err))))/;

/** 能力 5 病型 C 负门（拍板 2026-10-13）：重组 span 写词面探测——写词面族全量。
 *  不含 exec/重定向面：$()/重定向由递归载荷求值与段级判定各自入账，且引号塔载荷内
 *  JS 比较符/测试字符串会误伤；写词面（含隐式写元操作/原地编辑/参数即落点/载荷写调用/
 *  open 写 mode/未知 mode）命中即有写面，跨段藏写不许遮蔽。 */
export function payloadWriteFaceHit(script: string): boolean {
  return WRITE_FACE_WORDS.test(script) || INPLACE_FACE.test(script) || ARG_TARGET_FACE.test(script)
    || IMPLICIT_WRITE_FACE.test(script) || PAYLOAD_WRITE_FACE.test(script) || openCallWriteHits(script) || openCallUnknownMode(script);
}

export function openCallUnknownMode(script: string): boolean {
  for (const { args } of openCallSites(script)) {
    if (openModeOf(args) === "unknown") return true; // mode 不可证 → fail-closed（默认读模式不触发）
  }
  return false;
}

/** open() mode 三分类（§3.2.1 规则 1）：read=缺省（python 默认读模式=非写嫌疑）/纯读字面量；
 *  write=写 mode 字面量（w/a/x/+ 族）；unknown=mode 非字面量（变量/调用/空字面量）→ 不可证。
 *  mode= kwarg（open(p, mode='w')）取其值；非 mode kwarg（encoding=/buffering=…）不算 mode。 */
function openModeOf(args: string[]): "read" | "write" | "unknown" {
  for (const a of args) {
    const kw = /^mode\s*=\s*(.+)$/.exec(a.trim());
    if (kw !== null) return classifyModeLiteral(kw[1]);
  }
  const positional = args.map(a => a.trim()).filter(a => a !== "" && !/^\w+\s*=/.test(a));
  if (positional.length < 2) return "read"; // 默认读模式=非写嫌疑
  return classifyModeLiteral(positional[1]);
}

/** open() 第二实参三分类（提取通道共用）：read=缺省（python 默认读=非写嫌疑）/纯读字面量（含
 *  perl "<"）；write=写 mode 字面量（w/a/x/+ 族、r+、perl ">"/">>"/"+<"）；unknown=非字面量
 *  （变量/调用/空）/语义不明 → 不可证。mode= kwarg 取值；非 mode kwarg 不算 mode。 */
export function classifyOpenModeArg(rawMode: string | undefined, hasSecond: boolean): "read" | "write" | "unknown" {
  if (!hasSecond) return "read"; // 默认读模式=非写嫌疑
  const t = (rawMode ?? "").trim();
  const kw = /^mode\s*=\s*(.+)$/.exec(t);
  const val = kw !== null ? kw[1].trim() : t;
  if (kw === null && /^\w+\s*=/.test(t)) return "read"; // 非 mode kwarg（encoding=/buffering=…）
  return classifyModeLiteral(val);
}

function classifyModeLiteral(val: string): "read" | "write" | "unknown" {
  const lit = /^["'`]([^"'`]*)["'`]$/.exec(val.trim());
  if (lit === null) return "unknown"; // mode 非字面量 → 不可证
  const mode = lit[1];
  // python：r 只读 / w a x 写 / r+ 读写；perl："<" 只读 / ">" ">>" "+<" "+>" "+>>" 写
  if (/^[wa][+bt]*$|^r\+$|^x/.test(mode)) return "write";
  if (/^[rR][bBtT]?$/.test(mode)) return "read";
  if (/^<+$/.test(mode)) return "read"; // perl 只读模式
  if (/^\+?[<>]/.test(mode)) return "write"; // perl 写模式（含读写 +<）
  return "unknown"; // 字面量但语义不明（''/'U'/'|-' 等）→ 不可证
}

/** open() 调用点三分类（规则 1）：写 mode 字面量=写证据；未知 mode 由 openCallUnknownMode
 *  收（不可证回落），不再当写证据（语义模型：不可证≠已证写）；默认/纯读=非写嫌疑。 */
function openCallWriteHits(script: string): boolean {
  for (const { args } of openCallSites(script)) {
    if (openModeOf(args) === "write") return true;
  }
  return false;
}

/** open() 调用点扫描（括号配平取实参表）。 */
function openCallSites(script: string): Array<{ args: string[] }> {
  const out: Array<{ args: string[] }> = [];
  const re = /\bopen\s*\(/g;
  let m = re.exec(script);
  while (m !== null) {
    let depth = 1;
    let j = re.lastIndex;
    const args: string[] = [];
    let cur = "";
    while (j < script.length && depth > 0) {
      const c = script[j];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { args.push(cur); break; } }
      else if (c === "," && depth === 1) { args.push(cur); cur = ""; j++; continue; }
      cur += c;
      j++;
    }
    out.push({ args });
    m = re.exec(script);
  }
  return out;
}

/** 词面证（能力 4）：原文级证明无写——所有写面/隐式写/exec 类/载荷写调用均为 0。 */
export function proveNoWrite(command: string): boolean {
  return !(
    WRITE_FACE_WORDS.test(command)
    || INPLACE_FACE.test(command)
    || ARG_TARGET_FACE.test(command)
    || IMPLICIT_WRITE_FACE.test(command)
    || EXEC_FACE.test(command)
    || DYNAMIC_IMPORT_FACE.test(command)
    || PAYLOAD_WRITE_FACE.test(command)
    || REDIRECT_FACE.test(command)
    || openCallWriteHits(command)
    || openCallUnknownMode(command)
  );
}
