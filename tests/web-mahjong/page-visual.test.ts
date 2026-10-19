/**
 * 牌局页真机自查（F20261015mjsg 模块四）——真实 Chrome + 真实 HTTP 端口 + 真实牌局。
 *
 * 为什么不用 app.request 断言渲染：本页是视觉产物，view.js 单测只证逻辑，
 * 「牌桌摆得下、字形出得来、按钮点得动」必须在真浏览器里看一眼。
 * 测试同时是回归门：控制台报错/入口脚本挂载/牌河 6 列/手牌张数与服务端视图一致。
 *
 * 截图输出：MAHJONG_SHOT_DIR 环境变量指定目录（默认 os.tmpdir()/mahjong-shots），
 * 供人工/AI 目视复核，不入库。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHttpApp } from "../../src/bootstrap/server";
import { MahjongController } from "../../src/interface-adapters/http/controllers/mahjong-controller";
import { SqliteFrameStore } from "../../src/usecases/mahjong/room/frames";
import { RoomBus, RoomService } from "../../src/usecases/mahjong/room/room-service";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import type { OtterGateway } from "../../src/usecases/mahjong/room/otter-adapter";
import type { PlayerConfig } from "../../src/usecases/mahjong/engine/types";

const ROOM = "visual-room";
const SHOT_DIR = process.env.MAHJONG_SHOT_DIR ?? path.join(tmpdir(), "mahjong-shots");
const PLAYERS: PlayerConfig[] = [
  { kind: "proxy", name: "獭 A" },
  { kind: "human", name: "你" },
  { kind: "proxy", name: "獭 B" },
];

describe("牌局页浏览器真机渲染", () => {
  let db: ReturnType<typeof createTestDb>;
  let store: SqliteFrameStore;
  let rooms: RoomService;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let base = "";
  let pageRoot: string;

  beforeAll(async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    db = createTestDb();
    store = new SqliteFrameStore(db);
    const bus = new RoomBus();
    const gateway: OtterGateway = { invoke: async () => { throw new Error("视觉测试无 otter 座位"); } };
    rooms = new RoomService({ store, gateway, bus, humanTimeoutMs: 30_000, humanGraceMs: 30_000 });
    const logger = createTestLogger();
    const controller = new MahjongController(rooms, store, logger);
    pageRoot = path.resolve(process.cwd(), "web-mahjong");
    // buildHttpApp 要的是 bootstrap 的完整 Controllers 形状；运行时只读 ctrl.mahjong，其余字段缺省即不挂路由
    const app = buildHttpApp({ mahjong: controller } as unknown as Parameters<typeof buildHttpApp>[0], logger, false, pageRoot);

    // 真端口（port 0 = 内核分配，避免与常驻实例撞端口）
    let port = 0;
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      port = info.port;
    });
    for (let i = 0; i < 200 && !port; i++) await new Promise((r) => setTimeout(r, 10));
    expect(port, "HTTP 端口未就绪").toBeGreaterThan(0);
    base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/mahjong/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: ROOM, seed: "visual-seed", players: PLAYERS }),
    });
    expect(res.status).toBe(201);

    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rooms?.close(ROOM);
    db?.close();
    if (!process.env.MAHJONG_SHOT_DIR) rmSync(SHOT_DIR, { recursive: true, force: true });
  }, 60_000);

  it("入座遮罩 → 牌桌渲染 → 轮到自己可点牌（无控制台报错）", async () => {
    const errors: string[] = [];
    const page: Page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`console: ${m.text()}`);
    });

    await page.goto(`${base}/mahjong/${ROOM}`, { waitUntil: "domcontentloaded" });

    // ① 入座遮罩：三个座位卡 + 观战 + 分享链接按钮
    await page.waitForSelector('#overlayBox [data-do="join"]', { timeout: 15_000 });
    expect(await page.locator('#overlayBox [data-do="join"]').count()).toBe(3);
    expect(await page.locator('[data-do="spectate"]').count()).toBe(1);
    await page.screenshot({ path: path.join(SHOT_DIR, "01-join.png"), fullPage: true });

    // ② 坐到真人座（seat 1）→ 遮罩关闭、手牌出现
    await page.click('[data-do="join"][data-seat="1"]');
    await page.waitForSelector("#hand .tile", { timeout: 15_000 });

    const view: any = await (await fetch(`${base}/api/mahjong/rooms/${ROOM}/view?seat=1`)).json();
    const handCount = await page.locator("#hand .tile").count();
    expect(handCount, "手牌张数应与服务端私有视图一致").toBe(view.players[1].hand.length);

    // ③ 牌面是 Unicode 麻将字符（不是空、不是图片）
    // tsconfig lib 无 DOM（types: ["node"]）——页面侧表达式一律从 globalThis 拿
    const face: any = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const t = doc.querySelector("#hand .tile");
      const r = t ? t.getBoundingClientRect() : { width: 0, height: 0 };
      return { text: t ? String(t.textContent) : "", w: r.width, h: r.height };
    });
    expect(face.text.trim().length, `牌面字形为空：${JSON.stringify(face)}`).toBeGreaterThan(0);
    expect(face.text.codePointAt(0), `牌面不是麻将字符块：${face.text}`).toBeGreaterThanOrEqual(0x1f000);
    expect(face.w).toBeGreaterThan(20);
    expect(face.h).toBeGreaterThan(30);

    // ④ 对手暗牌、牌河 6 列（CSS grid 列数 = 结构需求的硬指标）
    expect(await page.locator("#left .tile--back").count()).toBeGreaterThan(0);
    const grid: number = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const el = doc.querySelector("#left .discards");
      if (!el) return 0;
      const cs = (globalThis as any).getComputedStyle(el);
      return String(cs.gridTemplateColumns).split(" ").length;
    });
    expect(grid, "对手牌河应为 6 列网格").toBe(6);

    // ⑤ 三家点数/场况栏/宝牌指示牌在位
    const fieldText = (await page.locator("#field").innerText()).replace(/\s+/g, " ");
    expect(fieldText).toContain("東風戦");
    expect(fieldText).toContain("東一局");
    expect(fieldText).toMatch(/余牌 \d+/);
    expect(await page.locator("#field .f-dora .tile").count()).toBeGreaterThan(0);
    expect(await page.locator("#left .p-points").count()).toBe(1);
    expect(await page.locator("#right .p-points").count()).toBe(1);

    // ⑥ 等到停驻自己：动作栏出现「点手牌打出」且手牌可点
    await page.waitForFunction(() => {
      const el = (globalThis as any).document.querySelector("#actionbar .hint");
      return el ? String(el.textContent).includes("点手牌打出") : false;
    }, undefined, { timeout: 20_000 });
    const clickable = await page.locator("#hand .tile.is-clickable").count();
    expect(clickable, "停驻自己时应有可点手牌").toBeGreaterThan(0);
    expect(await page.locator("#turnStatus").innerText()).toContain("轮到你了");

    await page.screenshot({ path: path.join(SHOT_DIR, "02-table.png"), fullPage: true });

    // ⑦ 点一张牌真的打出去（以服务端牌河变长为准——手牌可能有同码张，拿牌面列表比对会假阴性）
    const beforeDiscards = view.players[1].discards.length;
    await page.locator("#hand .tile.is-clickable").first().click();
    let advanced = false;
    for (let i = 0; i < 400 && !advanced; i++) {
      const now: any = await (await fetch(`${base}/api/mahjong/rooms/${ROOM}/view?seat=1`)).json();
      advanced = now.players[1].discards.length > beforeDiscards;
      if (!advanced) await new Promise((r) => setTimeout(r, 25));
    }
    expect(advanced, "点牌后服务端牌河应变长（动作注入成功）").toBe(true);
    expect(errors, errors.join("\n")).toEqual([]);
    await page.screenshot({ path: path.join(SHOT_DIR, "03-after-discard.png"), fullPage: true });
    await page.close();
  }, 120_000);

  it("#1532 聊天回显：入座后发言 → SSE chat 帧进日志（无控制台报错）", async () => {
    const errors: string[] = [];
    const page: Page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`console: ${m.text()}`);
    });

    await page.goto(`${base}/mahjong/${ROOM}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#overlayBox [data-do="join"]', { timeout: 15_000 });
    await page.click('[data-do="join"][data-seat="1"]');
    await page.waitForSelector("#hand .tile", { timeout: 15_000 });

    // 聊天条入座后可见（观战隐藏由 app.js 门控；本条验「在座」方向）
    await page.waitForSelector("#chatBar:not([hidden])", { timeout: 5_000 });
    await page.fill("#chatInput", "第一句测试发言");
    await page.press("#chatInput", "Enter");

    // 自己的话经 SSE chat 帧回显进对局日志（修复前无 #chatBar/无消费分支 → 本选择器必挂）
    await page.waitForSelector("#log li.is-chat", { timeout: 5_000 });
    const line = await page.locator("#log li.is-chat").first().textContent();
    expect(String(line)).toContain("第一句测试发言");
    expect(errors, `控制台报错：${errors.join(" | ")}`).toEqual([]);
    await page.close();
  });

  it("观战入口：无座进场三家手牌可见", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
    await page.goto(`${base}/mahjong/${ROOM}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-do="spectate"]', { timeout: 15_000 });
    await page.click('[data-do="spectate"]');
    await page.waitForSelector("#hand .tile", { timeout: 15_000 });
    // 观战：动作栏亮出观战提示，自己位置的手牌一律不可点
    await page.waitForFunction(() => {
      const el = (globalThis as any).document.querySelector("#actionbar .hint");
      return el ? String(el.textContent).includes("观战") : false;
    }, undefined, { timeout: 15_000 });
    expect(await page.locator("#hand .tile.is-clickable").count()).toBe(0);
    // 三家手牌都可见（引擎视图口径：seat=null 观战全览）
    const visibleHands = await page.locator("#left .p-hand .tile, #right .p-hand .tile").count();
    expect(visibleHands).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(SHOT_DIR, "04-spectate.png"), fullPage: true });
    await page.close();
  }, 60_000);

  it("大厅页 /mahjong：建房表单在位", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
    await page.goto(`${base}/mahjong`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#overlayBox h2", { timeout: 15_000 });
    expect(await page.locator("[data-do='create']").count()).toBe(1);
    expect(await page.locator("[data-seat-kind]").count()).toBe(3);
    await page.screenshot({ path: path.join(SHOT_DIR, "05-lobby.png"), fullPage: true });
    await page.close();
  }, 60_000);
});
