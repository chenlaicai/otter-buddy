/**
 * F20261015mjsg 局终战报（模块五·对话侧）测试：
 *  - renderGameoverCard：html-card 合规（title 围栏/体积上限/HTML 转义）+ 名次/亮点/锐评/脚注渲染
 *  - sendGameoverReport：挂靠对话解析 → speak entry（cardSchemaVersion=2）→ fact 登记；
 *    无 otter 座位/无挂靠对话跳过；linkResource 失败不回滚发卡
 */
import { describe, it, expect } from "vitest";
import { CARD_SCHEMA_VERSION } from "@contract/api/html-card";
import {
  renderGameoverCard,
  sendGameoverReport,
  type GameoverReportDeps,
} from "../../../../src/usecases/mahjong/room/gameover-report";
import type { GameoverReport } from "../../../../src/usecases/mahjong/room/room-types";

function report(overrides: Partial<GameoverReport> = {}): GameoverReport {
  return {
    roomId: "r1",
    gameId: "r1-abc",
    seed: "s1",
    players: [
      { seat: 0, name: "A", kind: "otter", otterId: "otter-a" },
      { seat: 1, name: "B", kind: "human" },
      { seat: 2, name: "C", kind: "otter", otterId: "otter-c" },
    ],
    ranking: [
      { seat: 0, name: "A", points: 41200 },
      { seat: 2, name: "C", points: 34800 },
      { seat: 1, name: "B", points: 29000 },
    ],
    highlights: [
      {
        roundNo: 1,
        settlement: {
          kind: "ron",
          deltas: [8000, -8000, 0],
          winners: [0],
          payer: 1,
          yakuSummary: [{ seat: 0, han: 4, fu: 30, yakus: ["立直", "断幺九"], points: 8000 }],
        },
      },
      { roundNo: 2, settlement: { kind: "noten", deltas: [-1000, 1000, 0], tenpai: [false, true, false] } },
      {
        roundNo: 3,
        settlement: {
          kind: "tsumo",
          deltas: [6000, 3000, -9000],
          winners: [2],
          yakuSummary: [{ seat: 2, han: 3, yakus: ["役牌 白"], points: 6000 }],
        },
      },
      { roundNo: 4, settlement: { kind: "abortive", abortive: "threeWinds", deltas: [0, 0, 0] } },
    ],
    speeches: Array.from({ length: 10 }, (_, i) => ({ seat: i % 2 === 0 ? 0 : 2, name: i % 2 === 0 ? "A" : "C", text: `锐评${i}` })),
    proxyFallbacks: 2,
    startedAt: 1_000,
    endedAt: 1_000 + 5 * 60_000,
    ...overrides,
  };
}

describe("renderGameoverCard 战报卡渲染", () => {
  it("html-card 合规：title 围栏单卡、体积 <64KB、名次/四局亮点/锐评截断/代打脚注", () => {
    const body = renderGameoverCard(report());
    expect(body).toContain('```html-card title="🀄 三麻战报"');
    expect(body.match(/```html-card/g)).toHaveLength(1); // 单卡
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(65536);

    // 名次三行
    expect(body).toContain("第 1 名");
    expect(body).toContain("第 3 名");
    expect(body).toContain("<b>41200</b> 点");

    // 四局结算各一行（ron/noten/tsumo/abortive）
    expect(body).toContain("东1局 B 放铳 → A：立直·断幺九（4番30符）8000点");
    expect(body).toContain("东2局 荒牌流局（听牌：B）");
    expect(body).toContain("东3局 自摸 → C：役牌 白（3番）6000点");
    expect(body).toContain("东4局 中止流局（三风连打）");

    // 锐评只展示末 8 条 + 截断计数
    expect(body).toContain("锐评9");
    expect(body).toContain("锐评2");
    expect(body).not.toContain("锐评1");
    expect(body).toContain("…另 2 条未列出");

    // 脚注：代打计数（proxyFallbacks>0）
    expect(body).toContain("代理代打 2 次");
    expect(body).toContain("4 局结算");
  });

  it("自由文本 HTML 转义（牌桌名/发言防注入卡体）", () => {
    const body = renderGameoverCard(report({
      players: [
        { seat: 0, name: "<script>x</script>", kind: "otter", otterId: "otter-a" },
        { seat: 1, name: "B", kind: "human" },
        { seat: 2, name: "C", kind: "otter", otterId: "otter-c" },
      ],
      ranking: [
        { seat: 0, name: "<script>x</script>", points: 41200 },
        { seat: 2, name: "C", points: 34800 },
        { seat: 1, name: "B", points: 29000 },
      ],
      speeches: [{ seat: 0, name: "A", text: "<img onerror=alert(1)>" }],
      highlights: [],
    }));
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img ");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("sendGameoverReport 战报发送编排", () => {
  function mockDeps(overrides?: {
    ids?: string[];
    throwLink?: boolean;
  }): { deps: GameoverReportDeps; spoke: Array<Record<string, unknown>>; linked: Array<Record<string, unknown>>; warns: string[] } {
    const spoke: Array<Record<string, unknown>> = [];
    const linked: Array<Record<string, unknown>> = [];
    const warns: string[] = [];
    const deps = {
      sendEntry: {
        createSpeakEntry: async (input: Record<string, unknown>) => {
          spoke.push(input);
          return { entry: { id: "entry-1" } };
        },
      },
      conversationRepo: {
        getIdsByOtterId: async () => overrides?.ids ?? ["conv-9"],
      },
      linkResource: async (input: Record<string, unknown>) => {
        if (overrides?.throwLink) throw new Error("link down");
        linked.push(input);
        return {};
      },
      logger: {
        warn: (m: string) => {
          warns.push(m);
        },
      },
    } as unknown as GameoverReportDeps;
    return { deps, spoke, linked, warns };
  }

  it("happy path：发卡（cardSchemaVersion=2）+ fact 登记（≤500 摘要）", async () => {
    const { deps, spoke, linked, warns } = mockDeps();
    await sendGameoverReport(deps, report());

    expect(warns).toHaveLength(0);
    expect(spoke).toHaveLength(1);
    const sent = spoke[0]!;
    expect(sent.conversationId).toBe("conv-9");
    expect(sent.otterId).toBe("otter-a");
    expect(sent.metadata).toEqual({ cardSchemaVersion: CARD_SCHEMA_VERSION });
    expect(String(sent.body)).toContain("```html-card");

    expect(linked).toHaveLength(1);
    const res = linked[0]!;
    expect(res.resourceType).toBe("fact");
    expect(res.category).toBe("mahjong-report");
    expect(res.linkedBy).toBe("otter-a");
    expect(res.conversationId).toBe("conv-9");
    expect(String(res.content).length).toBeLessThanOrEqual(500);
    expect(String(res.content)).toContain("41200");
  });

  it("无挂靠对话 → 跳过（不发卡不登记，仅告警）", async () => {
    const { deps, spoke, linked, warns } = mockDeps({ ids: [] });
    await sendGameoverReport(deps, report());
    expect(spoke).toHaveLength(0);
    expect(linked).toHaveLength(0);
    expect(warns.some((w) => w.includes("no conversation"))).toBe(true);
  });

  it("无 otter 座位（全 proxy/human）→ 跳过并告警", async () => {
    const { deps, spoke, warns } = mockDeps();
    const noOtter = report({
      players: [
        { seat: 0, name: "P0", kind: "proxy" },
        { seat: 1, name: "B", kind: "human" },
        { seat: 2, name: "P2", kind: "proxy" },
      ],
    });
    await sendGameoverReport(deps, noOtter);
    expect(spoke).toHaveLength(0);
    expect(warns.some((w) => w.includes("no otter seat"))).toBe(true);
  });

  it("linkResource 失败 → 发卡不回滚（仅告警）", async () => {
    const { deps, spoke, linked, warns } = mockDeps({ throwLink: true });
    await sendGameoverReport(deps, report());
    expect(spoke).toHaveLength(1);
    expect(linked).toHaveLength(0);
    expect(warns.some((w) => w.includes("linked_resource failed"))).toBe(true);
  });
});
