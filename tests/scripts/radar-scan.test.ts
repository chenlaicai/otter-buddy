/**
 * radar 确定性抓取层回归（F20261103repro）。
 * 所有期望均由 fixture 输入和 README 的过滤/排序/截取规则独立推导，
 * 不从 scan 实现导出期望值。
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectHackerNewsItem,
  sortHackerNewsItems,
  sortGitHubItems,
  selectAnthropicItems,
  assembleRawResult,
  formatRadarSummary,
} from "../../scripts/radar/scan-lib.mjs";

vi.setConfig({ testTimeout: 20_000 });

const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/radar/${name}`, import.meta.url));
const hnFixture = JSON.parse(readFileSync(fixturePath("hn-response.json"), "utf8"));
const ghFixture = JSON.parse(readFileSync(fixturePath("github-response.json"), "utf8"));
const anthropicHtml = readFileSync(fixturePath("anthropic-news.html"), "utf8");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("HN 粗筛与排序", () => {
  it("命中 AI 独立词与 agent 词，漏杀 PostgreSQL 和食谱，缺 URL 回退 HN 条目页", () => {
    // topStories 中 102/106 不含任何关键词；107 有 AI 但无 URL，comments 缺省为 0。
    const selected = hnFixture.topStories.map((id: number) => selectHackerNewsItem(hnFixture.items[String(id)], id));

    expect(selected).toEqual([
      {
        title: "Launch HN: Momentic (YC W24) – Agents that catch bugs by using your app",
        url: "https://momentic.ai/",
        score: 116,
        comments: 75,
      },
      null,
      {
        title: "Agentic backdoors via pretraining poisoning",
        url: "https://arxiv.org/abs/2610.37741",
        score: 86,
        comments: 28,
      },
      {
        title: "Claude Opus 5.5 Can Draw Permit-Level Architectural Drawings",
        url: "https://stephenjgallagher.substack.com/p/ai-can-draw-blueprints-now",
        score: 78,
        comments: 27,
      },
      {
        title: "LLMs are not superhuman at reading and writing neural network weights",
        url: "https://www.seangoedecke.com/llms-are-not-superhuman-at-reading-and-writing-neural-network-weights/",
        score: 16,
        comments: 0,
      },
      null,
      {
        title: "Why I built an AI weather balloon",
        url: "https://news.ycombinator.com/item?id=107",
        score: 48,
        comments: 9,
      },
    ]);
  });

  it("按 HN score 降序，不沿用来榜顺序", () => {
    const selected = hnFixture.topStories
      .map((id: number) => selectHackerNewsItem(hnFixture.items[String(id)], id))
      .filter((item: unknown) => item !== null);

    expect(sortHackerNewsItems(selected).map((item) => item.score)).toEqual([116, 86, 78, 48, 16]);
  });

  it("词边界防止 available 中的 ai 子串误命中，空响应不产生条目", () => {
    expect(selectHackerNewsItem({ title: "The available options", score: 99 }, 200)).toBeNull();
    expect(selectHackerNewsItem(null, 201)).toBeNull();
  });
});

describe("GitHub 与 Anthropic 确定性转换", () => {
  it("GitHub 汇总后按 stars 跨 topic 降序", () => {
    const items = Object.entries(ghFixture.topics).flatMap(([topic, response]) =>
      (response as { items: Array<Record<string, unknown>> }).items.map((item) => ({
        repo: item.full_name as string,
        desc: (item.description as string | null) || "",
        stars: item.stargazers_count as number,
        created: item.created_at as string,
        topic,
      })),
    );

    expect(sortGitHubItems(items).map((item) => [item.repo, item.stars])).toEqual([
      ["example/large-agent", 900],
      ["example/mcp-tools", 120],
      ["example/llm-kit", 80],
      ["example/small-agent", 17],
    ]);
  });

  it("Anthropic slug 保序去重并截取前 10，绝对链接和第 11 个 slug 不入选", () => {
    expect(selectAnthropicItems(anthropicHtml)).toEqual([
      { slug: "announcements", url: "https://www.anthropic.com/news/announcements" },
      { slug: "claude-opus-5-5", url: "https://www.anthropic.com/news/claude-opus-5-5" },
      { slug: "agentic-ai-foundation", url: "https://www.anthropic.com/news/agentic-ai-foundation" },
      { slug: "public-benefit-fund", url: "https://www.anthropic.com/news/public-benefit-fund" },
      { slug: "features", url: "https://www.anthropic.com/news/features" },
      { slug: "partnerships", url: "https://www.anthropic.com/news/partnerships" },
      {
        slug: "ai-for-science-expands-foundations-research-institutions",
        url: "https://www.anthropic.com/news/ai-for-science-expands-foundations-research-institutions",
      },
      { slug: "expanding-partnership-gsa", url: "https://www.anthropic.com/news/expanding-partnership-gsa" },
      { slug: "s1-sec", url: "https://www.anthropic.com/news/s1-sec" },
      { slug: "product", url: "https://www.anthropic.com/news/product" },
    ]);
    expect(selectAnthropicItems("<html>no matching links</html>")).toEqual([]);
  });
});

describe("raw JSON 与 stdout 契约", () => {
  const rawInput = {
    date: "2026-11-03",
    generatedAt: "2026-11-03T04:00:00.000Z",
    hackernews: { items: [{ title: "AI story", url: "https://example.com/ai", score: 3, comments: 1 }] },
    github: { items: [{ repo: "example/repo", desc: "", stars: 2, created: "2026-11-01T00:00:00Z", topic: "llm" }] },
    anthropic: { items: [{ slug: "announcements", url: "https://www.anthropic.com/news/announcements" }] },
  };

  it("raw JSON 保留日期、生成时间和三源结构，字段不丢失", () => {
    expect(assembleRawResult(rawInput)).toEqual({
      date: "2026-11-03",
      generatedAt: "2026-11-03T04:00:00.000Z",
      sources: {
        hackernews: { items: [{ title: "AI story", url: "https://example.com/ai", score: 3, comments: 1 }] },
        github: { items: [{ repo: "example/repo", desc: "", stars: 2, created: "2026-11-01T00:00:00Z", topic: "llm" }] },
        anthropic: { items: [{ slug: "announcements", url: "https://www.anthropic.com/news/announcements" }] },
      },
    });
  });

  it("stdout 关键行格式可被 LLM 分拣层消费，落盘路径单独收尾", () => {
    const summary = formatRadarSummary({ result: assembleRawResult(rawInput), outputPath: "/tmp/radar/raw/2026-11-03.json" });
    const lines = summary.split("\n");

    expect(lines[0]).toBe("=== AI 雷达原始数据 2026-11-03 ===");
    expect(lines).toEqual(expect.arrayContaining([
      "[HN] 1 条 AI 相关（错误: 无）",
      "  [3分/1评论] AI story | https://example.com/ai",
      "[GitHub] 1 个近7天新项目（错误: 无）",
      "  [2★ llm] example/repo — ",
      "[Anthropic] 1 篇（错误: 无）",
      "  announcements",
    ]));
    expect(summary.endsWith("\n原始数据已落盘: /tmp/radar/raw/2026-11-03.json\n")).toBe(true);
  });
});

describe("main 离线接线", () => {
  const rawInput = {
    date: "2026-11-03",
    generatedAt: "2026-11-03T04:00:00.000Z",
    hackernews: { items: [{ title: "AI story", url: "https://example.com/ai", score: 3, comments: 1 }] },
    github: { items: [{ repo: "example/repo", desc: "", stars: 2, created: "2026-11-01T00:00:00Z", topic: "llm" }] },
    anthropic: { items: [{ slug: "announcements", url: "https://www.anthropic.com/news/announcements" }] },
  };

  it("formatRadarSummary 全量逐行断言含尾部换行", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "radar-scan-byte-test-"));
    temporaryDirectories.push(outputDirectory);
    const rawResult = assembleRawResult(rawInput);
    const outputPath = join(outputDirectory, "raw", "2026-11-03.json");
    const expectedSummary = formatRadarSummary({ result: rawResult, outputPath });

    expect(expectedSummary.split("\n")).toEqual([
      "=== AI 雷达原始数据 2026-11-03 ===",
      "[HN] 1 条 AI 相关（错误: 无）",
      "  [3分/1评论] AI story | https://example.com/ai",
      "[GitHub] 1 个近7天新项目（错误: 无）",
      "  [2★ llm] example/repo — ",
      "[Anthropic] 1 篇（错误: 无）",
      "  announcements",
      "",
      "原始数据已落盘: " + outputPath,
      "",
    ]);
  });

  it("scan.mjs 经 mocked fetch 调用纯函数，symlink 调用同样执行 main", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "radar-scan-test-"));
    temporaryDirectories.push(outputDirectory);
    const scanPath = fileURLToPath(new URL("../../scripts/radar/scan.mjs", import.meta.url));
    const linkedScanPath = join(outputDirectory, "scan-link.mjs");
    symlinkSync(scanPath, linkedScanPath);
    const fixtures = {
      hn: hnFixture,
      gh: ghFixture,
      anthropicHtml,
    };
    // 子进程内只替换网络边界和时钟；生产 scan.mjs 不经测试专用分支。
    const bootstrap = `
      const fixtures = ${JSON.stringify(fixtures)};
      const fixedNow = Date.parse('2026-11-03T04:00:00.000Z');
      globalThis.Date = class extends Date {
        constructor(...args) { super(...(args.length ? args : [fixedNow])); }
        static now() { return fixedNow; }
      };
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target === 'https://hacker-news.firebaseio.com/v0/topstories.json') return { json: async () => fixtures.hn.topStories };
        const hn = target.match(/^https:\\/\\/hacker-news\\.firebaseio\\.com\\/v0\\/item\\/(\\d+)\\.json$/);
        if (hn) return { json: async () => fixtures.hn.items[hn[1]] };
        const gh = target.match(/^https:\\/\\/api\\.github\\.com\\/search\\/repositories\\?q=topic:([a-z-]+)\\+/);
        if (gh) return { json: async () => fixtures.gh.topics[gh[1]] };
        if (target === 'https://www.anthropic.com/news') return { text: async () => fixtures.anthropicHtml };
        throw new Error('Unexpected URL: ' + target);
      };
      const [scanPath, outputDirectory] = process.argv.slice(1);
      process.argv = [process.argv[0], scanPath, outputDirectory];
      await import(scanPath);
    `;
    const execution = spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap, linkedScanPath, outputDirectory], {
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(execution.status, execution.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(outputDirectory, "raw", "2026-11-03.json"), "utf8"));
    expect(result.date).toBe("2026-11-03");
    expect(result.generatedAt).toBe("2026-11-03T04:00:00.000Z");
    expect(result.sources.hackernews.items.map((item: { score: number }) => item.score)).toEqual([116, 86, 78, 48, 16]);
    expect(result.sources.github.items.map((item: { stars: number }) => item.stars)).toEqual([900, 120, 80, 17]);
    expect(result.sources.anthropic.items).toHaveLength(10);
    expect(execution.stdout).toContain("[HN] 5 条 AI 相关（错误: 无）");
    expect(execution.stdout).toContain("[GitHub] 4 个近7天新项目（错误: 无）");
    expect(execution.stdout).toContain("[Anthropic] 10 篇（错误: 无）");
    expect(execution.stdout.endsWith(`\n原始数据已落盘: ${join(outputDirectory, "raw", "2026-11-03.json")}\n`)).toBe(true);
    expect(execution.stdout).toBe(formatRadarSummary({
      result,
      outputPath: join(outputDirectory, "raw", "2026-11-03.json"),
    }));
  });
});
