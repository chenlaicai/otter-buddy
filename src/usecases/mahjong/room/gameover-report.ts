/**
 * 局终战报（方案模块五·对话侧收尾）——GameoverReport → html-card speak entry + linked_resource 登记。
 * 装配点在 bootstrap（buildMahjongController 注入 SendEntry / ConversationRepository / linkResource），
 * 本文件只做渲染与编排，不依赖 bootstrap。
 *
 * 口径（大獭 10/16 裁决 + 方案文档）：
 *  - conversationId = 首个 otter 座位的挂靠对话（resolveFirstConversationId 同源：getIdsByOtterId[0]；
 *    该查询无 ORDER BY、返回序未定义——既有语义沿用，选对话策略是独立议题）
 *  - html-card 合规：单卡、title 必填、<64KB、schema v2（entry.metadata.cardSchemaVersion）
 *  - 无 otter 座位 / 无挂靠对话 → 跳过并告警——战报失败不阻塞牌局（RoomService.fireGameover 已兜底）
 *  - linked_resource：fact 类、content ≤500（FACT_CONTENT_MAX_LENGTH），发卡成功后登记，
 *    登记失败仅告警（卡已可见，不回滚）
 */

import { CARD_SCHEMA_VERSION } from "@contract/api/html-card";
import type { GameoverReport } from "./room-types";
import type { SanmaEngine } from "../engine/engine";
import type { Seat, Settlement } from "../engine/types";
import type { SendEntry } from "../../conversation/send-entry";
import type { ConversationRepository } from "../../conversation/conversation-repository";
import type { LinkedResourceInput } from "../../conversation/manage-key-info";
import type { Logger } from "../../ports/logger";

export interface GameoverReportDeps {
  sendEntry: Pick<SendEntry, "createSpeakEntry">;
  conversationRepo: Pick<ConversationRepository, "getIdsByOtterId">;
  linkResource: (input: LinkedResourceInput) => Promise<unknown>;
  logger?: Pick<Logger, "warn">;
}

type NameOf = (seat: number) => string;

/** F20261022mjls：战报组装（自 RoomService.fireGameover 拆出——控 max-lines）。
 *  名次：gameOver 事件优先（nextRound 产生，已在 publishGame 采集）；缺失回退末局点数 */
export function buildGameoverReport(room: {
  roomId: string;
  gameId: string;
  engine: SanmaEngine;
  report: {
    ranking: GameoverReport["ranking"] | null;
    highlights: Array<GameoverReport["highlights"][number]>;
    speeches: Array<GameoverReport["speeches"][number]>;
    proxyFallbacks: number;
  };
  startedAt: number;
}): GameoverReport {
  const cfg = room.engine.state.config;
  const finalPlayers = room.engine.state.round?.players;
  const ranking = room.report.ranking
    ?? (finalPlayers
      ? [...finalPlayers]
          .map((p) => ({ seat: p.seat, name: p.name, points: p.points }))
          .sort((a, b) => b.points - a.points)
      : []);
  return {
    roomId: room.roomId,
    gameId: room.gameId,
    seed: cfg.seed,
    players: cfg.players.map((p, i) => ({
      seat: i as Seat,
      name: p.name,
      kind: p.kind,
      ...(p.otterId ? { otterId: p.otterId } : {}),
    })),
    ranking,
    highlights: room.report.highlights,
    speeches: room.report.speeches,
    proxyFallbacks: room.report.proxyFallbacks,
    startedAt: room.startedAt,
    endedAt: Date.now(),
  };
}

/** 中止流局条款中文标签（AbortiveDrawKind 三值） */
const ABORTIVE_LABEL: Record<string, string> = {
  threeWinds: "三风连打",
  fourKans: "四杠散了",
  nineTerminals: "九种九牌",
};

/** HTML 转义（牌桌名/发言是自由文本——防注入卡体） */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 和了明细（yakuSummary 缺失时降级空串，调用方回退只展示胜负方） */
function yakuDetail(s: Settlement, nameOf: NameOf): string {
  return (s.yakuSummary ?? [])
    .map((y) => {
      const yaku = y.yakus.length > 0 ? y.yakus.join("·") : "（役种未记）";
      const fu = y.fu !== undefined ? `${y.fu}符` : "";
      return `${nameOf(y.seat)}：${yaku}（${y.han}番${fu}）${y.points}点`;
    })
    .join("；");
}

/** 和了行（自摸/放铳——包牌标注） */
function winLine(roundNo: number, s: Settlement, nameOf: NameOf): string {
  const detail = yakuDetail(s, nameOf);
  const winners = (s.winners ?? []).map(nameOf).join("、");
  const label = s.kind === "tsumo"
    ? `东${roundNo}局 自摸`
    : `东${roundNo}局 ${nameOf(s.payer ?? 0)} 放铳${s.baoSeat !== undefined ? "（包牌）" : ""}`;
  return detail ? `${label} → ${detail}` : `${label} → ${winners}`;
}

/** 流局行（荒牌听牌名单 / 中止条款） */
function drawLine(roundNo: number, s: Settlement, nameOf: NameOf): string {
  if (s.kind === "abortive") {
    return `东${roundNo}局 中止流局（${ABORTIVE_LABEL[s.abortive ?? ""] ?? s.abortive ?? "未知条款"}）`;
  }
  const tenpai = (s.tenpai ?? [])
    .map((t, i) => (t ? nameOf(i) : null))
    .filter((x): x is string => x !== null);
  return `东${roundNo}局 荒牌流局（听牌：${tenpai.length > 0 ? tenpai.join("、") : "无人"}）`;
}

/** 单局结算亮点一行 */
function highlightLine(roundNo: number, s: Settlement, nameOf: NameOf): string {
  if (s.kind === "noten" || s.kind === "abortive") return drawLine(roundNo, s, nameOf);
  return winLine(roundNo, s, nameOf);
}

function rankingRows(report: GameoverReport, kindOf: (seat: number) => string): string[] {
  const rows: string[] = ['<div class="section"><div class="sec">名次</div>'];
  report.ranking.forEach((r, i) => {
    rows.push(`<div class="kv"><span class="key">第 ${i + 1} 名</span>`
      + `<span class="val">${esc(r.name)}（${esc(kindOf(r.seat))}） · <b>${r.points}</b> 点</span></div>`);
  });
  rows.push("</div>");
  return rows;
}

function highlightRows(report: GameoverReport, nameOf: NameOf): string[] {
  const rows: string[] = ['<div class="section"><div class="sec">役种亮点</div>'];
  for (const h of report.highlights) {
    rows.push(`<div class="alt">${esc(highlightLine(h.roundNo, h.settlement, nameOf))}</div>`);
  }
  rows.push("</div>");
  return rows;
}

function speechRows(report: GameoverReport): string[] {
  const shown = report.speeches.slice(-8);
  const rest = report.speeches.length - shown.length;
  const rows: string[] = ['<div class="section"><div class="sec">桌上锐评</div>'];
  for (const sp of shown) {
    rows.push(`<div class="meta">[${sp.seat}号位 ${esc(sp.name)}] ${esc(sp.text)}</div>`);
  }
  if (rest > 0) rows.push(`<div class="meta">…另 ${rest} 条未列出</div>`);
  rows.push("</div>");
  return rows;
}

/**
 * 战报 html-card（渲染为 speak entry body）。
 * 结构：一行可见前言 + 单卡（名次/役种亮点/桌上锐评/脚注）。preset 类直用
 * （.head/.sec/.kv/.alt/.meta/.foot——contract 预设库），体积远低于 64KB 上限。
 */
export function renderGameoverCard(report: GameoverReport): string {
  const nameOf: NameOf = (seat) => report.ranking.find((r) => r.seat === seat)?.name
    ?? report.players.find((p) => p.seat === seat)?.name
    ?? `${seat}号位`;
  const kindOf = (seat: number): string => report.players.find((p) => p.seat === seat)?.kind ?? "";
  const minutes = Math.max(1, Math.round((report.endedAt - report.startedAt) / 60_000));

  const rows: string[] = ['<div class="head"><span class="title">东风战终局</span>'
    + `<span class="badge badge-info">${esc(report.roomId)}</span>`
    + `<span class="meta">seed ${esc(report.seed)} · 约 ${minutes} 分钟</span></div>`];
  rows.push(...rankingRows(report, kindOf));
  if (report.highlights.length > 0) rows.push(...highlightRows(report, nameOf));
  if (report.speeches.length > 0) rows.push(...speechRows(report));

  const footBits: string[] = [`${report.highlights.length} 局结算`];
  if (report.proxyFallbacks > 0) footBits.push(`代理代打 ${report.proxyFallbacks} 次`);
  rows.push(`<div class="foot">${esc(footBits.join(" · "))}</div>`);

  const lead = `🀄 三麻东风战战报 · ${report.roomId}`;
  const card = ["```html-card title=\"🀄 三麻战报\"", "<div class=\"wrap\">", ...rows, "</div>", "```"].join("\n");
  return `${lead}\n\n${card}`;
}

/** linked_resource 摘要（fact ≤500：名次点数 + 局数——检索够用，不塞卡体） */
function reportSummary(report: GameoverReport): string {
  const ranking = report.ranking.map((r, i) => `${i + 1}.${r.name}${r.points}`).join(" ");
  return `三麻东风战战报（${report.roomId}）：${ranking}（${report.highlights.length} 局结算，seed ${report.seed}）`;
}

/**
 * 战报发送编排：解析挂靠对话 → 发 html-card speak entry → 登记 fact linked_resource。
 * 全程失败向上抛（RoomService.fireGameover 已 catch 并告警）；仅 linkResource 独立兜底
 * （卡已发出，登记失败不值得重发卡）。
 */
export async function sendGameoverReport(deps: GameoverReportDeps, report: GameoverReport): Promise<void> {
  const otter = report.players.find((p) => p.otterId !== undefined);
  if (!otter?.otterId) {
    deps.logger?.warn("mahjong gameover report skipped: no otter seat", { roomId: report.roomId });
    return;
  }
  const ids = await deps.conversationRepo.getIdsByOtterId(otter.otterId);
  const conversationId = ids[0];
  if (!conversationId) {
    deps.logger?.warn("mahjong gameover report skipped: otter has no conversation", {
      roomId: report.roomId,
      otterId: otter.otterId,
    });
    return;
  }
  const { entry } = await deps.sendEntry.createSpeakEntry({
    conversationId,
    otterId: otter.otterId,
    body: renderGameoverCard(report),
    metadata: { cardSchemaVersion: CARD_SCHEMA_VERSION },
  });
  try {
    await deps.linkResource({
      conversationId,
      resourceType: "fact",
      title: `🀄 三麻战报 ${report.roomId}`,
      content: reportSummary(report),
      category: "mahjong-report",
      linkedBy: otter.otterId,
      otterId: otter.otterId,
      autoLinked: true,
    });
  } catch (e) {
    deps.logger?.warn("mahjong gameover linked_resource failed (card already sent)", {
      roomId: report.roomId,
      entryId: entry.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
