import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20261013csv3 T1：unfurl 预览缓存读写（P1「数据先行」原则的持久化载体）。
 *
 * 写口仅 unfurl-controller 抓取流程；读口有二：UnfurlCard 经 GET /api/unfurl、
 * LinkedResource 列表接口读侧 join 投影（T2 产物卡 diff stat 数据源）。
 *
 * TTL 三分支（单点判定，方案 A3）：
 * - source='og'       → 永久缓存（标题/截图静态元数据，陈旧可接受）
 * - source='failed'   → 7 天窗口内直接返回（防永久黑化，过期重抓）
 * - source='github-api' → 24h SWR（PR 状态/diff stat 随时间衰减，「显示 open 实已 merged」
 *   是信息负增量——stale-while-revalidate：返回旧值同时后台刷新，刷新结果下次渲染生效）
 *
 * fetched_at 统一应用层 ISO 8601 写入（与 send-entry.ts 惯例一致），7 天/24h 窗口
 * 用 Date.parse 解析比较——不设 SQL DEFAULT，防空格格式混排字典序偏移（R2）。
 */

/** 缓存行（repository 层实体——控制器/读侧投影共用） */
export interface UnfurlCacheRow {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  host: string;
  source: "og" | "github-api" | "failed";
  /** github-api 记录：PR/issue 状态（open/merged/closed/draft）——T2 状态徽章数据源 */
  state: string | null;
  /** github-api PR 记录：diff stat（T2 产物卡数据源）；其余来源为 null */
  additions: number | null;
  deletions: number | null;
  error: string | null;
  fetchedAt: string;
}

export const UNFURL_FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const UNFURL_GITHUB_TTL_MS = 24 * 60 * 60 * 1000;

/** github-api SWR 判定结果：fresh=窗口内直接可用；stale=先返回旧值后台刷新；miss=需抓取 */
export type GithubFreshness = "fresh" | "stale" | "miss";

export class SqliteUnfurlCacheRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {}

  /**
   * TTL 判定 + 读。返回：
   * - og 记录（任意时间）→ { kind: 'hit', row }
   * - failed 记录且 7 天内 → { kind: 'hit', row }（显式失败也是显式状态，不重复抓取）
   * - failed 记录且过期 → miss（重新抓取）
   * - github-api 且 24h 内 → { kind: 'hit', row }
   * - github-api 且过期 → { kind: 'stale', row }（SWR：调用方返回旧值并触发后台刷新）
   * - 无记录 → { kind: 'miss' }
   */
  get(url: string): { kind: "hit" | "stale" | "miss"; row?: UnfurlCacheRow } {
    const row = this.db
      .prepare("SELECT * FROM unfurl_cache WHERE url = ?")
      .get(url) as Record<string, unknown> | undefined;
    if (!row) return { kind: "miss" };

    const parsed = rowToCacheRow(row);
    const age = Date.now() - Date.parse(parsed.fetchedAt);
    switch (parsed.source) {
      case "og":
        return { kind: "hit", row: parsed };
      case "failed":
        return age <= UNFURL_FAILED_TTL_MS ? { kind: "hit", row: parsed } : { kind: "miss" };
      case "github-api":
        if (age <= UNFURL_GITHUB_TTL_MS) return { kind: "hit", row: parsed };
        return { kind: "stale", row: parsed };
    }
  }

  /**
   * 读侧 join 投影：一次查询取回一组 URL 的缓存记录（keyed by url）。
   * 调用方按 join 键（resource.url ↔ unfurl_cache.url）自取；落空的 URL 不在结果中。
   * TTL 口径与 get 一致（og/failed-7d 命中；github-api 过期记录仍返回——
   * 陈旧 diff stat 胜过「未抓取」，渲染侧可标陈旧徽记）。
   */
  getByUrls(urls: string[]): Map<string, UnfurlCacheRow> {
    if (urls.length === 0) return new Map();
    const placeholders = urls.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM unfurl_cache WHERE url IN (${placeholders})`)
      .all(...urls) as Array<Record<string, unknown>>;
    const out = new Map<string, UnfurlCacheRow>();
    for (const row of rows) {
      const parsed = rowToCacheRow(row);
      if (parsed.source === "failed" && Date.now() - Date.parse(parsed.fetchedAt) > UNFURL_FAILED_TTL_MS) {
        continue; // 过期 failed 记录不投影（等同未抓取，触发懒抓取补位）
      }
      out.set(parsed.url, parsed);
    }
    return out;
  }

  /** 抓取结果（含失败）落库。upsert 语义——同 URL 重复抓取覆盖旧值。 */
  put(row: UnfurlCacheRow): void {
    this.db
      .prepare(`
        INSERT INTO unfurl_cache (url, title, description, image, site_name, host, source, state, additions, deletions, error, fetched_at)
        VALUES (@url, @title, @description, @image, @siteName, @host, @source, @state, @additions, @deletions, @error, @fetchedAt)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          image = excluded.image,
          site_name = excluded.site_name,
          host = excluded.host,
          source = excluded.source,
          state = excluded.state,
          additions = excluded.additions,
          deletions = excluded.deletions,
          error = excluded.error,
          fetched_at = excluded.fetched_at
      `)
      .run({
        url: row.url,
        title: row.title,
        description: row.description,
        image: row.image,
        siteName: row.siteName,
        host: row.host,
        source: row.source,
        state: row.state,
        additions: row.additions,
        deletions: row.deletions,
        error: row.error,
        fetchedAt: row.fetchedAt,
      });
  }

  /** 是否存在该 URL 的记录（预抓取去重哨兵：pending 期间重复请求不再发起抓取） */
  has(url: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM unfurl_cache WHERE url = ?").get(url);
  }

  /** 测试辅助：清空表 */
  clear(): void {
    this.db.prepare("DELETE FROM unfurl_cache").run();
  }
}

function rowToCacheRow(row: Record<string, unknown>): UnfurlCacheRow {
  const source = String(row.source ?? "og");
  return {
    url: String(row.url),
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    image: (row.image as string | null) ?? null,
    siteName: (row.site_name as string | null) ?? null,
    host: String(row.host),
    source: source === "github-api" || source === "failed" ? source : "og",
    state: (row.state as string | null) ?? null,
    additions: (row.additions as number | null) ?? null,
    deletions: (row.deletions as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    fetchedAt: String(row.fetched_at),
  };
}

/** 供测试/调用方构造标准时间戳（应用层 ISO 8601，单点口径） */
export function unfurlNowIso(): string {
  return new Date().toISOString();
}

/** github-api SWR 判定纯函数（暴露给测试；repository.get 内部同源） */
export function githubFreshness(fetchedAtIso: string, now = Date.now()): GithubFreshness {
  const age = now - Date.parse(fetchedAtIso);
  if (Number.isNaN(age)) return "miss";
  if (age <= UNFURL_GITHUB_TTL_MS) return "fresh";
  return "stale";
}
