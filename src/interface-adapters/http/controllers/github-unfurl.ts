import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * F20261013csv3 T1：GitHub URL 结构化取数（gh CLI 路径）。
 *
 * Why gh CLI 而非 og 抓取/undici 代理（方案「设计取舍」表）：
 * ① gh 自带认证 + 用户本机已配网络（进程级代理问题一并绕过——本机直连 github.com
 *   需代理而服务进程无代理变量，og 抓取 41% 超时失败的实证根因）；
 * ② 拿到的是结构化数据（PR 状态/diff stat/labels 远比 og 丰富）；
 * ③ 服务进程内调 gh CLI 已有先例（tool-factory.ts gh pr view），架构上无阻碍。
 *
 * 全类型覆盖（S2 修正——不止 PR）：PR / issue / 文件 / 仓库主页统一走 gh，
 * 消灭「非 PR 链接走 og 仍可能超时」的缺口。
 *
 * 执行面设防（mimo S2——URL 来源完全用户可控，攻击面属本方案新增）：
 * - execFile 参数数组，禁 shell（无管道/展开/注入面）——owner/repo/number 经
 *   encodeURIComponent / ^\d+$ 归一后作为独立 argv 元素，gh 不会把位置参数当 flag
 * - owner/repo 白名单字符集 [a-zA-Z0-9._-]，超集即拒（不落 failed 也不执行）
 * - 输出上限 1MB（maxBuffer），防畸形输出撑爆内存
 */

const execFileAsync = promisify(execFile);

/** gh 进程执行预算 */
const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 1024 * 1024;

/** owner/repo 白名单字符集（GitHub 实际允许 [a-zA-Z0-9-] 与 ._ 历史遗留；超集拒） */
const OWNER_REPO_RE = /^[a-zA-Z0-9._-]+$/;

export interface GithubTarget {
  kind: "pr" | "issue" | "repo";
  owner: string;
  repo: string;
  /** pr/issue 的号码；repo 主页为 null */
  number: number | null;
}

export interface GithubFetchResult {
  title: string | null;
  state: string | null;
  description: string | null;
  additions: number | null;
  deletions: number | null;
  stateReason?: string | null;
  isDraft?: boolean;
  labels?: string[];
}

/** 解析 GitHub URL → 结构化目标。非 GitHub 或非 http/https 返回 null。 */
export function parseGithubUrl(raw: string): GithubTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const segs = u.pathname.split("/").filter(s => s.length > 0).map(decodeURIComponent);
  if (segs.length < 2) return null;
  const [owner, repo, seg3, seg4] = segs;
  if (!OWNER_REPO_RE.test(owner!) || !OWNER_REPO_RE.test(repo!)) return null;
  // 去 .git 后缀（clone 地址形态）
  const repoName = repo!.endsWith(".git") ? repo!.slice(0, -4) : repo!;
  return classifyPath(owner!, repoName, seg3, seg4);
}

/** 路径段分类：pull/N → pr；issues/N → issue；其余（主页/文件/子页）→ repo */
function classifyPath(owner: string, repo: string, seg3?: string, seg4?: string): GithubTarget {
  if (seg3 === "pull" && seg4 && /^\d+$/.test(seg4)) {
    return { kind: "pr", owner, repo, number: Number(seg4) };
  }
  if (seg3 === "issues" && seg4 && /^\d+$/.test(seg4)) {
    return { kind: "issue", owner, repo, number: Number(seg4) };
  }
  return { kind: "repo", owner, repo, number: null };
}

/** gh CLI 结构化取数。失败抛错（调用方落 failed 记录）。 */
export async function fetchGithubMeta(target: GithubTarget): Promise<GithubFetchResult> {
  const base = [target.owner, target.repo].map(s => encodeURIComponent(s));
  const repoSlug = `${base[0]}/${base[1]}`;
  switch (target.kind) {
    case "pr":
      return fetchPr(repoSlug, target.number!);
    case "issue":
      return fetchIssue(repoSlug, target.number!);
    case "repo":
      return fetchRepo(repoSlug);
  }
}

/** gh pr view：标题/状态/diff stat/labels */
async function fetchPr(repoSlug: string, number: number): Promise<GithubFetchResult> {
  const out = await runGh([
    "pr", "view", String(number), "--repo", repoSlug,
    "--json", "title,state,body,additions,deletions,isDraft,labels",
  ]);
  const j = JSON.parse(out) as Record<string, unknown>;
  return {
    title: typeof j.title === "string" ? j.title : null,
    state: typeof j.state === "string" ? j.state : null,
    description: typeof j.body === "string" ? firstLines(j.body, 3) : null,
    additions: typeof j.additions === "number" ? j.additions : null,
    deletions: typeof j.deletions === "number" ? j.deletions : null,
    isDraft: j.isDraft === true,
    labels: extractLabels(j.labels),
  };
}

/** gh issue view：标题/状态/stateReason/labels（无 diff stat） */
async function fetchIssue(repoSlug: string, number: number): Promise<GithubFetchResult> {
  const out = await runGh([
    "issue", "view", String(number), "--repo", repoSlug,
    "--json", "title,state,body,stateReason,labels",
  ]);
  const j = JSON.parse(out) as Record<string, unknown>;
  return {
    title: typeof j.title === "string" ? j.title : null,
    state: typeof j.state === "string" ? j.state : null,
    description: typeof j.body === "string" ? firstLines(j.body, 3) : null,
    additions: null,
    deletions: null,
    stateReason: typeof j.stateReason === "string" ? j.stateReason : null,
    labels: extractLabels(j.labels),
  };
}

/** gh repo view：仓库名/描述（PR/issue 号外的其余 GitHub 链接统一形态） */
async function fetchRepo(repoSlug: string): Promise<GithubFetchResult> {
  const out = await runGh([
    "repo", "view", repoSlug, "--json", "name,description,stargazerCount",
  ]);
  const j = JSON.parse(out) as Record<string, unknown>;
  return {
    title: typeof j.name === "string" ? j.name : null,
    state: null,
    description: typeof j.description === "string" ? j.description : null,
    additions: null,
    deletions: null,
  };
}

/** labels JSON 数组 → name 字符串数组（防御非数组形态） */
function extractLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ name?: string }>).map(l => l.name ?? "").filter(Boolean);
}

/** execFile 参数数组禁 shell + 1MB 输出上限。失败抛带 stderr 的 Error。 */
async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
    env: { ...process.env },
  });
  return stdout;
}

/** 描述取首 N 行（gh body 常带模板尾巴，整段塞进卡片描述过长） */
function firstLines(body: string, n: number): string {
  const lines = body.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return lines.slice(0, n).join(" ").slice(0, 300);
}
