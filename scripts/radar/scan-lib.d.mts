/** radar scan-lib 类型声明（零依赖 .mjs 供 TS 测试 import；先例 check-pr-evidence.d.mts） */
export interface HackerNewsItem {
  title: string;
  url: string;
  score: number;
  comments: number;
}

export interface GitHubItem {
  repo: string;
  desc: string;
  stars: number;
  created: string;
  topic: string;
}

export interface AnthropicItem {
  slug: string;
  url: string;
}

export interface RadarSource<T> {
  items: T[];
  error?: string;
}

export interface RadarResult {
  date: string;
  generatedAt: string;
  sources: {
    hackernews: RadarSource<HackerNewsItem>;
    github: RadarSource<GitHubItem>;
    anthropic: RadarSource<AnthropicItem>;
  };
}

export declare const HN_KEYWORDS: RegExp;
export declare function selectHackerNewsItem(
  item: {
    title?: string;
    url?: string;
    score?: number;
    descendants?: number;
  } | null,
  id: number,
): HackerNewsItem | null;
export declare function sortHackerNewsItems(items: HackerNewsItem[]): HackerNewsItem[];
export declare function sortGitHubItems(items: GitHubItem[]): GitHubItem[];
export declare function extractAnthropicSlugs(html: string): string[];
export declare function selectAnthropicItems(html: string): AnthropicItem[];
export declare function assembleRawResult(input: {
  date: string;
  generatedAt: string;
  hackernews: RadarSource<HackerNewsItem>;
  github: RadarSource<GitHubItem>;
  anthropic: RadarSource<AnthropicItem>;
}): RadarResult;
export declare function formatRadarSummary(input: {
  result: RadarResult;
  outputPath: string;
}): string;
