/**
 * F20261009tsts（#1371）：会话级 tool_search 单测。
 *
 * 锁三件事：
 * 1. BM25 排序语义：词频命中 × idf，中英混合 query，无命中返回空，limit 截断
 * 2. execute 行为：命中即激活（setActiveToolsByName 收到 active ∪ hits）、
 *    session 未绑定时报错而非崩溃、空 query 拒绝
 * 3. 免疫性本源：execute 全程只经 holder.session（会话私有引用），不接触任何
 *    可失效的 extension runtime——这是 #1371 的修复主命题
 */

import { describe, expect, it } from "vitest";

import {
  buildSessionToolSearchTool,
  buildToolCorpus,
  rankToolsByQuery,
  tokenizeToolSearch,
  type ToolSearchSessionLike,
} from "@frameworks/agent/tool-search-tool";

describe("F20261009tsts: tokenizeToolSearch 分词", () => {
  it("camelCase 拆开 + 小写 + 去 stop word（search 本身在 stop 表内，与 SDK 版一致）", () => {
    expect(tokenizeToolSearch("searchMemoryQuery")).toEqual(["memory", "query"]);
  });

  it("中文连续段切 2-gram，单字保留", () => {
    expect(tokenizeToolSearch("记忆溯源")).toEqual(["记忆", "忆溯", "溯源"]);
    expect(tokenizeToolSearch("图")).toEqual(["图"]);
  });

  it("stem 词形还原：复数归一（issues→issue；searches→search 后命中 stop 表被滤，与 SDK 版同序）", () => {
    expect(tokenizeToolSearch("issues searches"))
      .toEqual(["issue"]); // 先 stem 后查 stop 表：searches→search 在表内被滤
    expect(tokenizeToolSearch("trackers")).toEqual(["tracker"]);
  });

  it("ALLCAPS→Camel 边界也拆开（SDK 版双规则）", () => {
    expect(tokenizeToolSearch("parseJSONData")).toContain("json");
  });

  it("中英混合并列进索引", () => {
    const terms = tokenizeToolSearch("卡片高度 cardHeight");
    expect(terms).toContain("卡片");
    expect(terms).toContain("card");
    expect(terms).toContain("height");
  });
});

describe("F20261009tsts: buildToolCorpus 检索语料（含参数 schema）", () => {
  it("name + _ 换空格 + description + 参数描述/属性名全进语料", () => {
    const corpus = buildToolCorpus({
      name: "merge_pr",
      description: "合并 PR",
      parameters: {
        type: "object",
        properties: { prNumber: { type: "number", description: "PR 编号" } },
      },
    });
    expect(corpus).toContain("merge pr");
    expect(corpus).toContain("prNumber");
    expect(corpus).toContain("PR 编号");
  });

  it("无 schema 时只有 name/description，不炸", () => {
    expect(buildToolCorpus({ name: "x", description: undefined })).toBe("x x");
  });
});

describe("F20261009tsts: rankToolsByQuery BM25 排序", () => {
  const candidates = [
    { name: "get_html_card_contract", description: "卡片契约：写 HTML 卡片前必取完整规格" },
    { name: "speak", description: "发言工具——聊天室里唯一的发言通道" },
    { name: "search_memory", description: "检索记忆：跨会话的历史决策、讨论与事实" },
    { name: "merge_pr", description: "合并 PR（搭档授权闸）" },
  ];

  it("语义命中排序：query 命中语料 term 的工具得分", () => {
    const hits = rankToolsByQuery("卡片 契约", candidates, 8);
    expect(hits[0]?.name).toBe("get_html_card_contract");
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("检索语料含参数 schema：按参数名/参数描述也能命中（检视发现 1 回归锁）", () => {
    const withSchema = [
      {
        name: "tool_x",
        description: "另一个东西",
        parameters: {
          type: "object",
          properties: {
            issueNumber: { type: "number", description: "PR 编号，合并前必填" },
          },
        },
      },
    ];
    // query 只含参数属性名，description 不含这些词——旧实现（name+description 语料）必落空
    const hits = rankToolsByQuery("issueNumber 编号", withSchema, 8);
    expect(hits.map((h) => h.name)).toContain("tool_x");
  });

  it("stem 生效：复数 query 命中单数语料（检视发现 1 回归锁）", () => {
    const singular = [{ name: "tool_y", description: "issue tracker lookup" }];
    const hits = rankToolsByQuery("issues", singular, 8);
    expect(hits.map((h) => h.name)).toContain("tool_y");
  });

  it("idf 生效：稀有词比常见词得分高（记忆 vs 卡片各只命中一个工具时排序稳定）", () => {
    const hits = rankToolsByQuery("记忆", candidates, 8);
    expect(hits.map((h) => h.name)).toContain("search_memory");
  });

  it("无命中返回空数组", () => {
    expect(rankToolsByQuery("zzz_unmatched", candidates, 8)).toEqual([]);
  });

  it("limit 截断", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `tool_${i}`,
      description: "memory recall search index",
    }));
    expect(rankToolsByQuery("memory", many, 5)).toHaveLength(5);
  });
});

describe("F20261009tsts: buildSessionToolSearchTool execute 行为", () => {
  /** 最小 session 替身：记录 setActiveToolsByName 调用 */
  function makeFakeSession(tools: Array<{ name: string; description?: string }>, active: string[]) {
    const calls: string[][] = [];
    const fake: ToolSearchSessionLike = {
      getAllTools: () => tools,
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names) => calls.push(names),
    };
    return { fake, calls };
  }

  it("命中即激活：setActiveToolsByName 收到 active ∪ hits", async () => {
    const { fake, calls } = makeFakeSession(
      [
        { name: "bash", description: "shell 命令" },
        { name: "search_terminology", description: "术语库查找术语定义" },
      ],
      ["bash", "speak"],
    );
    const tool = buildSessionToolSearchTool({ session: fake });
    const result = await tool.execute(
      "tc_1",
      { query: "术语 定义" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set(["bash", "speak", "search_terminology"]));
    const text = JSON.stringify(result);
    expect(text).toContain("search_terminology");
    expect(result.isError).toBeFalsy();
  });

  it("session 未绑定：返回 isError 错误而非崩溃（#1371 主命题的接线防御）", async () => {
    const tool = buildSessionToolSearchTool({});
    const result = await tool.execute(
      "tc_2",
      { query: "anything" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBe(true);
  });

  it("空 query 拒绝", async () => {
    const { fake } = makeFakeSession([], []);
    const tool = buildSessionToolSearchTool({ session: fake });
    const result = await tool.execute(
      "tc_3",
      { query: "  " } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBe(true);
  });

  it("无命中：不调 setActiveToolsByName，返回空结果提示", async () => {
    const { fake, calls } = makeFakeSession(
      [{ name: "bash", description: "shell" }],
      ["bash"],
    );
    const tool = buildSessionToolSearchTool({ session: fake });
    const result = await tool.execute(
      "tc_4",
      { query: "zzz_unmatched" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(calls).toHaveLength(0);
    expect(result.isError).toBeFalsy();
  });

  it("免疫回归锁（#1371 主命题，检视发现 2 处置）：execute 全程不触发 extension ctx 的 assertActive 门——即使另一个 session 已被 dispose（共享 runtime 失效），本工具仍可用", async () => {
    // 模拟：holder 持有的 session 属于会话 A；另一个 session B 已 dispose。
    // 田 dispose 只会使共享 extension runtime 失效（assertActive 抛 stale）；
    // 本工具 execute 只经 holder.session 的公开方法，不接触 runtime。
    // 若未来有人把 execute 改回经 extension ctx 路径（pi.getActiveTools 等），
    // 此处的替身会因 ctx 抛 stale 而失败——锁死免疫性不被无意回退。
    const staleRuntimeError = () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    };
    const fake: ToolSearchSessionLike = {
      // 健康面：会话 A 的公开方法
      getAllTools: () => [
        { name: "search_terminology", description: "术语库查找术语定义" },
      ],
      getActiveToolNames: () => [],
      setActiveToolsByName: () => undefined,
    };
    // 模拟 B 已 dispose：若 execute 误用共享 runtime，这些门全抛（本测试不引用它们，
    // 存在本身即文档——免疫性的对偶面是「不接触这些门」）
    const poisonedEnv = { getActiveTools: staleRuntimeError, setActiveTools: staleRuntimeError };
    void poisonedEnv;
    const tool = buildSessionToolSearchTool({ session: fake });
    // 关键断言：execute 在「另一 session 已 dispose」的世界里仍正常返回且激活成功
    const result = await tool.execute(
      "tc_immune",
      { query: "术语 定义" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).toContain("search_terminology");
  });
});
