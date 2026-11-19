#!/usr/bin/env node
/**
 * issue 认领 commit 闸（F20261119claim）：commit message 引用 #N 时，检查 issue #N
 * 的 otter-claim 认领——本 worktree 已认领才放行；未认领拒绝并提示认领命令。
 *
 * 设计取舍：
 *  - 只在每 issue × 每分支首次触发时联网检查（worktree 私有 git-dir 内
 *    otter-claim-ok-<N>-<分支> 标记缓存），后续 commit 零开销——协议顺序本就是
 *    「认领 → worktree → commit」，首 commit 即第一个强制点。marker 绑分支：同
 *    worktree 切到另一 F-ID 分支后不命中旧缓存（重新核验即拒）；release/他线接管
 *    后同分支仍命中——已接受残余，CI 闸（check-pr-claim）每次真查兜底
 *    （kimi检视獭-1954 MINOR-1）。
 *  - marker 必须落在 git rev-parse --absolute-git-dir（worktree 私有 git-dir），
 *    不可取其父目录——.git/worktrees/ 是全部 linked worktree 共享目录，父目录级
 *    marker 会让他线静默继承核验结果（kimi检视獭-1954 BLOCK-2 实盘复现）。
 *  - issue 提取用 commit 侧语义（首行尾注 + closes 族，body 裸 #N 叙述不计）——
 *    与 CI 闸同正则源（check-pr-claim.mjs 单一真相源）。
 *  - 网络/查询失败 fail-open（本地开发不被 GitHub 故障卡死），CI 闸兜底拦截。
 *  - 无 issue 引用的 commit 不查（非 issue 驱动改动不适用认领协议）
 * 用法：.githooks/commit-msg <message-file>
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { extractCommitIssueNumbers } from "./check-pr-claim.mjs";

const msgFile = process.argv[2];
if (!msgFile) process.exit(0);
const message = readFileSync(msgFile, "utf8");
const nums = extractCommitIssueNumbers(message);
if (nums.length === 0) process.exit(0);

// marker 目录：worktree 私有 git-dir（--absolute-git-dir 主仓=.git、linked worktree=.git/worktrees/<名>）
const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
const markerStem = branch.replace(/[^A-Za-z0-9._-]/g, "_");
let worktreeName = null;
try {
  const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  worktreeName = topLevel.split("/").pop();
} catch { /* 主仓提交无 worktree 名，按分支 F-ID 匹配 */ }

for (const n of nums) {
  const okMarker = `${gitDir}/otter-claim-ok-${n}-${markerStem}`;
  if (existsSync(okMarker)) continue;
  let comments;
  try {
    comments = execFileSync("gh", ["issue", "view", String(n), "--json", "comments", "-q", ".comments"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    console.warn(`⚠️  认领闸：issue #${n} 查询失败（网络？），fail-open 放行——CI 闸会兜底`);
    continue;
  }
  let claims;
  const state = new Map();
  try {
    const list = JSON.parse(comments).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const claimRe = /<!--\s*otter-claim:\s*conversation=([^;\s>]+);\s*otter=([^;\s>]+);\s*worktree=([^;\s>]+);/g;
    const releaseRe = /<!--\s*otter-claim-release:\s*conversation=([^;\s>]+)\s*-->/g;
    for (const c of list) {
      for (const m of (c.body ?? "").matchAll(claimRe)) state.set(m[1], { conversation: m[1], worktree: m[3] });
      for (const m of (c.body ?? "").matchAll(releaseRe)) state.set(m[1], null);
    }
    claims = [...state.values()].filter(Boolean);
  } catch {
    console.warn(`⚠️  认领闸：issue #${n} 评论解析异常，fail-open 放行`);
    continue;
  }
  if (claims.length === 0) {
    console.error(`❌ 认领闸：issue #${n} 无有效认领——按认领协议（worktree-isolation 步骤 2）先发认领评论再 commit：`);
    console.error(`   gh issue comment ${n} --body "🦦 认领 #${n}\n<!-- otter-claim: conversation=<对话短ID>; otter=<名号>; worktree=${worktreeName ?? "<F-ID>"}; at=<ISO时间> -->\n开工：<一句话任务>"`);
    process.exit(1);
  }
  const fidRe = /F\d{8}[a-z][a-z0-9]{4}/;
  const branchFid = fidRe.exec(branch)?.[0] ?? null;
  const wtFid = worktreeName ? fidRe.exec(worktreeName)?.[0] ?? null : branchFid;
  const target = wtFid ?? branchFid;
  const mine = claims.some(c => target && fidRe.exec(c.worktree)?.[0] === target);
  if (!mine) {
    console.error(`❌ 认领闸：issue #${n} 已被认领（${claims.map(c => c.worktree).join(", ")}），与当前 ${target ?? "worktree"} 不符——换目标或协调（认领协议 worktree-isolation 步骤 2）`);
    process.exit(1);
  }
  writeFileSync(okMarker, String(Date.now()));
  console.log(`✅ 认领闸：issue #${n} 认领核验通过`);
}
process.exit(0);
