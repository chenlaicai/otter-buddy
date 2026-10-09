#!/usr/bin/env node
/**
 * F20261009gwte：shadow 语料库构建（三源合成，方案 v2 模块 2）。
 *
 * 用法：
 *   node scripts/build-write-eval-corpus.mjs --db <dbPath> [--out <path>]
 *
 * 三源：
 *   S1 replay 存量（guard-v2-real-replay.test.ts + #1368 固化候选——命令+期望内嵌在本脚本，单一真相源为 fixtures JSON）
 *   S2 healing 台账回捞（复用 generate-guard-replay.mjs 的查询口径——guard_intercept 结构化事件 commandHead 反查）
 *   S3 形态补齐（覆盖面表逐行 × 三态人工构造——内嵌本脚本）
 *
 * 输出：tests/fixtures/guard-write-eval-corpus.json
 *   { generatedAt, sources, samples: [{id, command, expect: "ALLOW"|"BLOCK"|"UNEVAL_UNKNOWN", source, note}] }
 *   expect=ALLOW/BLOCK 是人工裁决的行为期望（对"现行判定链+求值器终态"而言）；
 *   UNEVAL_UNKNOWN 表示预期求值器回落旧链、旧行为即期望（Phase 1 载荷族/动态族）。
 *
 * 注意：台账回捞部分需要 db 存在；无 db 时 --skip-ledger 跳过该源（语料量不足 100 时构建脚本退出码 3 提示）。
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = argOf("--db", `${repoRoot}/data/otter-buddy.db`);
const outPath = resolve(argOf("--out", `${repoRoot}/tests/fixtures/guard-write-eval-corpus.json`));

const samples = [];
let n = 0;
function add(command, expect, source, note) {
  n += 1;
  // synthetic/replay 源的期望内联（构建期已定）；ledger 源 verdict 留 null 待人工裁决
  const verdict = source === "ledger" ? null : expect;
  samples.push({ id: `c${String(n).padStart(3, "0")}`, command, expect, verdict, source, note: note ?? "" });
}

// ── S3：形态补齐（覆盖面表 × 三态；每规则至少放行/拦截/回落各一）──
const WT = "/repo/.otter/worktrees/wt";
const M = "/repo";

// 重定向通道
add(`cd ${WT} && echo x > out.txt`, "ALLOW", "synthetic", "redirect→wt 放行");
add(`cd ${WT} && echo x >> log.txt`, "ALLOW", "synthetic", "append→wt");
add(`echo x > ${M}/hacked.txt`, "BLOCK", "synthetic", "redirect→主仓 拦");
add(`cat a > /tmp/f`, "ALLOW", "synthetic", "redirect→tmp");
add(`echo x > $TARGET`, "UNEVAL_UNKNOWN", "synthetic", "动态目标回落");
add(`grep -r pattern src/ > ${M}/report.txt`, "BLOCK", "synthetic", "读命令重定向主仓（S4 亲历族）");

// 词表命令
add(`cd ${WT} && touch a.txt b.txt`, "ALLOW", "synthetic", "touch→wt");
add(`cp x ${M}/data/secret`, "BLOCK", "synthetic", "cp→主仓");
add(`cd ${WT} && cp a b`, "ALLOW", "synthetic", "cp wt 内");
add(`tee ${M}/x < input`, "BLOCK", "synthetic", "tee→主仓");
add(`cd ${WT} && tee out.log < in.log`, "ALLOW", "synthetic", "tee→wt");
add(`cd ${WT} && mv old new`, "ALLOW", "synthetic", "mv wt 内");
add(`mv f ${M}/data/f`, "BLOCK", "synthetic", "mv→主仓");
add(`cd ${WT} && mkdir -p sub/deep`, "ALLOW", "synthetic", "mkdir→wt");
add(`mkdir -p ${M}/data/newdir`, "BLOCK", "synthetic", "mkdir→主仓");

// git 写族
add(`cd ${WT} && git commit -m x`, "ALLOW", "synthetic", "git→wt");
add(`cd ${WT} && git add -A && git commit -F /tmp/msg.txt`, "ALLOW", "synthetic", "git 链 wt");
add(`git -C ${M} commit -m x`, "BLOCK", "synthetic", "#1363 灰区正例");
add(`cd ${WT} && git push origin HEAD`, "ALLOW", "synthetic", "push from wt");
add(`cd ${M} && git commit -m x`, "BLOCK", "synthetic", "BC-1 主仓 cwd commit");
add(`cd ${WT} && git status && git log --oneline -3`, "ALLOW", "synthetic", "git 读族无落点");
add(`cd ${WT} && git rebase -i HEAD~2`, "ALLOW", "synthetic", "rebase wt");

// cwd 跟踪
add(`W=${WT}; cd $W && git commit -m x`, "ALLOW", "synthetic", "同命令赋值溯源→wt");
add(`W=${M}; cd $W && git commit -m x`, "BLOCK", "synthetic", "同命令赋值溯源→主仓");
add(`cd $WT && git commit -m x`, "UNEVAL_UNKNOWN", "synthetic", "BC-5 父 shell 环境变量回落");
add(`cd ${WT} & touch ${M}/x`, "BLOCK", "synthetic", "& 后段继承主仓 cwd");
add(`pushd ${M} && touch x`, "UNEVAL_UNKNOWN", "synthetic", "pushd 回落");
add(`cd ${M}/../elsewhere && touch x`, "UNEVAL_UNKNOWN", "synthetic", ".. 爬升保守回落");
add(`cd ${WT} && cd sub && touch f`, "ALLOW", "synthetic", "链式 cd");

// 载荷族（Phase 1 显式回落——旧行为即期望）
add(`python3 -c "open('${M}/data/x','w').write('hi')"`, "UNEVAL_UNKNOWN", "synthetic", "审视 S1 锚点回落");
add(`node -e "require('fs').writeFileSync('${M}/x','1')"`, "UNEVAL_UNKNOWN", "synthetic", "载荷族回落");
add(`python3 -c "print(open('a.txt').read())"`, "UNEVAL_UNKNOWN", "synthetic", "只读载荷也回落（行为不变）");
add(`cd ${WT} && node -e "console.log(1)"`, "UNEVAL_UNKNOWN", "synthetic", "wt 内载荷仍回落（行为不变）");

// bash -c / cmdsub 递归
add(`bash -c 'touch ${M}/x'`, "BLOCK", "synthetic", "bash-c 递归命中主仓");
add(`bash -c 'cd ${WT} && touch a'`, "ALLOW", "synthetic", "bash-c 递归 wt");
add(`echo $(date) > /tmp/f`, "ALLOW", "synthetic", "cmdsub 在读侧，落点 tmp");
add(`cd $(dirname x)/../main && touch y`, "UNEVAL_UNKNOWN", "synthetic", "BC-6 cmdsub 变形回落");
// 审视 §3.1 负门（PR #1381 严重：$VAR 拼接后缀爬升曾假放行真主仓写）——永久钉住回落
add(`W=${WT}; cd $W/../.. && touch foo`, "UNEVAL_UNKNOWN", "synthetic", "负门：$W/.. 爬升回落（§3.1）");
add(`W=${WT}; cd $W/../../../main && touch foo`, "UNEVAL_UNKNOWN", "synthetic", "负门：$W/../../../main 深爬升回落（§3.1 逃逸形态原样）");
add(`W=${WT}; cd $W/sub && touch foo`, "UNEVAL_UNKNOWN", "synthetic", "负门：$W/字面后缀拼接回落（非纯 $VAR 词）");
add(`cd ${WT}/.. && touch foo`, "UNEVAL_UNKNOWN", "synthetic", "负门：evaluated 含 .. 回落");
// 审视 §3.3 负门：嵌套 decoy 不得被 worktree 排除误豁免
add(`touch ${M}/data/.otter/worktrees/decoy/f`, "BLOCK", "synthetic", "负门：嵌套 decoy 非主仓 worktree 区（§3.3）");
add(`echo x > ${M}/data/.otter/worktrees/decoy/f`, "BLOCK", "synthetic", "负门：decoy 重定向拦（§3.3）");

// 解析失败
add(`echo "unclosed`, "UNEVAL_UNKNOWN", "synthetic", "parse-failed 回落");
add(`git commit -m "msg with $(cat f)"`, "BLOCK", "synthetic", "cmdsub 在引文数据侧不影响 git 落点=cwd；shadow 首跑旧链也拦，期望修正为 BLOCK");

// heredoc
add(`cd ${WT} && bash - <<'EOF'\ntouch a.txt\nEOF`, "ALLOW", "synthetic", "bash heredoc 递归 wt");
add(`bash - <<'EOF'
touch ${M}/x
EOF`, "ALLOW", "synthetic", "裸定界体=数据（模型层不递归，#1171 口径）旧链放行，求值器同口径放行=行为不变；写主仓裸体现状放行属守卫已知洞非本层变更");

// 读族对照（应 evaluated 空集）
add(`ls -la && git status`, "ALLOW", "synthetic", "纯读空集");
add(`cd ${WT} && cat f.txt | grep x | wc -l`, "ALLOW", "synthetic", "管道读族");

// ── S1：replay 存量（guard-v2-real-replay 9 例语义搬入；路径用真实主仓形态）──
const RT = "/Users/orca/ai/otter-buddy/.otter/worktrees";
add(`cd ${RT}/invoke-periodic-audit && F=web/src/pages/conversation/index.tsx && cp $F /tmp/bak.tsx`, "UNEVAL_UNKNOWN", "replay-928", "E1 现场：cp $F 动态源——源动态不影响落点判定，cp 落点 /tmp 放行（但 $F 在 words evaluated 为 null → dynamic-path 回落，行为不变）");
add(`cd ${RT}/capability-entries-bridge && git stash push -- tests/capability/helpers/audit-fixtures.ts`, "ALLOW", "replay-928", "E3 现场");
add(`cd ${RT}/guard-v2-redesign && git add -A && git commit -F /tmp/commit-p3.txt 2>&1 | tail -5`, "ALLOW", "replay-928", "E4 #1170 主形态");
add(`cd ${RT}/guard-v2-redesign && git checkout main -- src/x.ts`, "ALLOW", "replay-928", "checkout 非写族词表：求值器无落点放行=旧行为；shadow 首跑归因后修正");
add(`cd ${RT}/wx-bridge && rm -rf node_modules/.cache && npm run build`, "ALLOW", "replay-928", "rm/npm 非本层判定（data_destructive 层）；求值器无落点放行=旧行为；shadow 首跑归因后修正");

// ── S2：healing 台账回捞（db 存在时）──
let ledgerCount = 0;
if (!args.includes("--skip-ledger") && existsSync(dbPath)) {
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT id, description, context, created_at FROM healing_events
      WHERE error_type = 'guard_intercept' AND created_at >= ?
        AND (json_valid(context) AND json_extract(context, '$.commandHead') IS NOT NULL)
      ORDER BY created_at DESC LIMIT 80
    `).all(since);
    const seen = new Set();
    for (const row of rows) {
      let ctx = {};
      try { ctx = JSON.parse(row.context) || {}; } catch { continue; }
      const head = (ctx.commandHead ?? "").trim();
      if (!head || seen.has(head)) continue;
      seen.add(head);
      // 台账样本只有被拦事实，无期望裁决——期望留人工（verdict 字段），构建期标 UNEVAL_UNKNOWN（回落=旧行为）
      // 人工裁决流程：跑本脚本后对 verdict=null 样本逐条填 ALLOW/BLOCK（同 #1368 固化纪律）
      add(head, "UNEVAL_UNKNOWN", "ledger", `台账 ${row.created_at.slice(0, 10)} ruleId=${ctx.ruleId ?? "?"}（期望待人工裁决）`);
      ledgerCount += 1;
    }
    db.close();
  } catch (e) {
    console.error(`[corpus] 台账回捞失败（跳过）：${e.message}`);
  }
}

const counts = {
  synthetic: samples.filter(s => s.source === "synthetic").length,
  replay: samples.filter(s => s.source === "replay-928").length,
  ledger: ledgerCount,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), dbPath, counts, samples }, null, 2)}\n`);

const total = samples.length;
console.log(`[corpus] 共 ${total} 例（synthetic=${counts.synthetic} replay=${counts.replay} ledger=${counts.ledger}）→ ${outPath}`);
if (total < 100) {
  console.error(`[corpus] 语料 ${total} < 100（方案 v2 判据）——需补台账回捞（检查 dbPath）或追加形态补齐样本`);
  process.exit(3);
}
console.log(`[corpus] 达标（≥100）。verdict 待人工裁决的 ledger 样本：${counts.ledger} 条（跑 shadow 前需裁决，同 #1368 纪律）。`);
