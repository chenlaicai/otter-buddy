/**
 * PrCollector: open PR 采集器（F20260902sigm 链路信号模型）
 *
 * 为 pr-stalled 信号提供数据源：gh CLI 现拉 open PR + 每条 PR 的推进时间
 * （lastActivity = max(最新 commit, 最新 review, 最新 comment)）。
 *
 * 设计取舍（方案 R3）：不建 PR 持久化表——本仓 GitHub 单远程，gh 已是既定
 * 基础设施（docs-advance.mjs 同款用法）；查询时实时派生，零滞后零维护。
 *
 * 降级语义（与 #658 检测器清洗原则一致）：无 gh / 无凭据 / 限流 / 无网络 →
 * 返回空数组，pr-stalled 信号缺席，不误报、不崩——检测器缺失 ≠ 系统健康。
 *
 * PR↔链关联规则（方案 S1 处置定稿，三级优先）：
 * 1. PR commits 的 message FID（最高优先）：commit-msg hook 强制 [FID][module][type]
 *    前缀，规范确立后 100% 覆盖，零误配
 * 2. PR body 的 FID（次优先）：覆盖 commit 不带但 body 带的场景（如汇总 PR）
 * 3. branch name 不提取：分支命名无 hook 强制（feature/rhi-pr2-ui 无 FID），
 *    正则提取误配率高（日期字符串/历史 FID 残留），收益不抵误挂风险
 *
 * 多 FID：PR 关联到所有命中链（一对多）；无 FID（dependabot Bump 等）：不关联。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FID_DATE_SEGMENT, FID_SUFFIX_SEGMENT } from "@entities/document/fid-format";

const execFileAsync = promisify(execFile);

/** F/R ID 全局匹配正则（fid-format.ts 契约单一真相源；g 全局匹配，用时需先 reset） */
const FID_GLOBAL_REGEX = new RegExp(`[FR]${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}`, "g");

/** 从任意文本提取全部 FID（去重，保持出现序） */
export function extractFeatureIds(text: string | null | undefined): string[] {
  if (!text) return [];
  FID_GLOBAL_REGEX.lastIndex = 0;
  const out: string[] = [];
  for (const m of text.matchAll(FID_GLOBAL_REGEX)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** 单条 open PR 的链路信号视图 */
export interface OpenPrInfo {
  number: number;
  title: string;
  /** 分支名（仅展示用，不提取 FID） */
  headRefName: string;
  body: string | null;
  url: string | null;
  /** PR 创建时间（ISO） */
  createdAt: string | null;
  /** 推进时间（ISO）：max(最新 commit, 最新 review, 最新 comment)——null=无任何活动数据 */
  lastActivityAt: string | null;
  /** 关联的 FID 清单（commits FID ∪ body FID；空数组=无关联） */
  featureIds: string[];
}

export interface PrCollectOptions {
  /** gh CLI 可执行文件名（默认 gh；测试可注入 mock runner） */
  runner?: (cmd: string, args: string[], opts: { cwd: string; maxBuffer: number; timeout: number; killSignal: NodeJS.Signals }) => Promise<{ stdout: string }>;
}

/** gh 子进程超时（ms）：CI runner 预装 gh 但无凭据时会挂起等认证——超时快速失败进降级路径
 *  （pr-stalled 信号缺席），绝不阻塞扫描主路。15s 覆盖正常网络抖动。 */
const GH_TIMEOUT_MS = 15_000;

/** 默认采集入口（rhi-scan-worker 的 prSource 端口签名）：repoPath → open PR 列表 */
export function collectOpenPrsForRepo(repoPath: string): Promise<OpenPrInfo[]> {
  return collectOpenPrs(repoPath);
}

/** gh pr list 的行形态（只取需要的字段控 payload） */
interface GhPrListRow {
  number: number;
  title: string;
  headRefName: string;
  body: string | null;
  url: string | null;
  createdAt: string | null;
}

/** gh pr view 的活动数据形态 */
interface GhPrView {
  commits?: Array<{ committedDate?: string | null; messageHeadline?: string }>;
  reviews?: Array<{ submittedAt?: string | null }>;
  comments?: Array<{ createdAt?: string | null }>;
}

/**
 * 采集全部 open PR 及其推进时间。任何失败（无 gh/无凭据/限流/解析异常）→ 空数组降级。
 */
export async function collectOpenPrs(repoPath: string, options?: PrCollectOptions): Promise<OpenPrInfo[]> {
  const run = options?.runner ?? defaultRun;
  try {
    const { stdout } = await run("gh", [
      "pr", "list",
      "--state", "open",
      "--json", "number,title,headRefName,body,url,createdAt",
      "--limit", "100",
    ], { cwd: repoPath, maxBuffer: 5 * 1024 * 1024, timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL" });

    const rows = JSON.parse(stdout) as GhPrListRow[];
    if (!Array.isArray(rows)) return [];

    return Promise.all(rows.map(async (row) => {
      const view = await collectPrView(run, repoPath, row.number);
      return buildPrInfo(row, view);
    }));
  } catch {
    // 检测器缺失 ≠ 系统健康：gh 不可用/凭据缺失/限流一律降级为信号缺席
    return [];
  }
}

/** 单条 PR 的活动明细（失败降级 null——list 成功但 view 失败时仍保留 PR，只是无 lastActivity） */
async function collectPrView(
  run: NonNullable<PrCollectOptions["runner"]>,
  repoPath: string,
  number: number,
): Promise<GhPrView | null> {
  try {
    const { stdout } = await run("gh", [
      "pr", "view", String(number),
      "--json", "commits,reviews,comments",
    ], { cwd: repoPath, maxBuffer: 5 * 1024 * 1024, timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL" });
    return JSON.parse(stdout) as GhPrView;
  } catch {
    return null;
  }
}

/** list 行 + view 明细 → OpenPrInfo（关联规则在此实现） */
function buildPrInfo(row: GhPrListRow, view: GhPrView | null): OpenPrInfo {
  // 关联规则三级优先：commits message FID 优先，body FID 补充（并集去重）
  const commitFids = (view?.commits ?? [])
    .flatMap(c => extractFeatureIds(c.messageHeadline ?? ""));
  const bodyFids = extractFeatureIds(row.body);
  const featureIds = [...new Set([...commitFids, ...bodyFids])];

  const lastActivityAt = latestActivityStamp(view);

  return {
    number: row.number,
    title: row.title,
    headRefName: row.headRefName,
    body: row.body,
    url: row.url,
    createdAt: row.createdAt,
    lastActivityAt,
    featureIds,
  };
}

/** lastActivity = max(最新 commit, 最新 review, 最新 comment)；无任何活动数据 → null（不猜） */
function latestActivityStamp(view: GhPrView | null): string | null {
  const stamps = [
    ...(view?.commits ?? []).map(c => c.committedDate),
    ...(view?.reviews ?? []).map(r => r.submittedAt),
    ...(view?.comments ?? []).map(cm => cm.createdAt),
  ].filter((s): s is string => Boolean(s));
  return stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
}

async function defaultRun(cmd: string, args: string[], opts: { cwd: string; maxBuffer: number; timeout: number; killSignal: NodeJS.Signals }): Promise<{ stdout: string }> {
  return execFileAsync(cmd, args, opts);
}
