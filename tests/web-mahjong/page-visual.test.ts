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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// F20261021ttos：Playwright 真浏览器结构性重活，文件级宽窗（判据见 testing-rules「重成本用例超时策略」）
vi.setConfig({ testTimeout: 20_000 });
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

// eslint-disable-next-line max-lines-per-function -- 6 用例共享 beforeAll 夹具（真端口 HTTP + 真 Chrome + 房间，~45 行）；拆 describe 须整块重复造夹具，用例内已按主链路/入口/骨架契约分段
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

  it("入座遮罩 → 牌桌渲染 → 轮到自己可点牌（无控制台报错）", { timeout: 120_000 }, async () => {
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

    // ②b 手牌张数与服务端私有视图一致——**收敛后再断言**（不是放松成「∈{13,14}」）：
    //     两侧是两个真相源（页面 state.view vs 直连 API），同步采样会撞上时序缝：
    //     页面还停在发牌前的 13 张、服务端已是发牌后的 14 张 → 假阴性（2026-10-20 CI 实挂一例）。
    //     轮询到两侧相等（≤6s，靠 SSE game 事件驱动页面重渲染）；真不一致就是真断言失败。
    let view: any = null;
    let handCount = -1;
    for (let i = 0; i < 60; i++) {
      view = await (await fetch(`${base}/api/mahjong/rooms/${ROOM}/view?seat=1`)).json();
      const viewLen: number = view.players[1].hand.length;
      handCount = await page.locator("#hand .tile").count();
      if (handCount === viewLen) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      handCount,
      `手牌张数应与服务端私有视图一致（收敛 6s 仍不等：页面=${handCount} 服务端=${view?.players[1]?.hand?.length}）`,
    ).toBe(view.players[1].hand.length);

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

    // ④ 对手暗牌、牌河 6 列（CSS grid 列数 = 结构需求的硬指标）——v3：牌河在座位块内（上家顶/下家右）
    expect(await page.locator("#kamicha .tile--back").count()).toBeGreaterThan(0);
    const grid: number = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const el = doc.querySelector("#kamicha .discards");
      if (!el) return 0;
      const cs = (globalThis as any).getComputedStyle(el);
      return String(cs.gridTemplateColumns).split(" ").length;
    });
    expect(grid, "对手牌河应为 6 列网格").toBe(6);

    // ⑤ v3 场况分工：角标只留宝牌/连接/停局，局数·本场·供托·余牌归中央信息盘（D3 不同屏双显）
    const fieldText = (await page.locator("#field").innerText()).replace(/\s+/g, " ");
    expect(await page.locator("#field .f-dora .tile").count()).toBeGreaterThan(0);
    expect(fieldText, "角标不该再重复局数（双显 = 同一状态两个渲染点）").not.toContain("東一局");
    expect(await page.locator("#field .fc-hint").count(), "牌型提醒预留槽位应在位").toBe(1);
    const hubText = (await page.locator("#hub").innerText()).replace(/\s+/g, " ");
    expect(hubText).toContain("東風戦");
    expect(hubText).toContain("東一局");
    expect(hubText).toMatch(/余牌 \d+/);
    expect(hubText).toMatch(/\d+ 本場/);
    // 三家信息条：上家顶 / 下家右 / 自己左下（各自只有一份）
    expect(await page.locator("#kamicha .p-points").count()).toBe(1);
    expect(await page.locator("#shimocha .p-points").count()).toBe(1);
    expect(await page.locator("#selfInfo .p-points").count()).toBe(1);
    expect(await page.locator(".chatbar #log").count(), "日志应在底部通栏里（与玩家条分家）").toBe(1);

    // ⑥ 等到停驻自己：动作栏出现「点手牌打出」且手牌可点
    await page.waitForFunction(() => {
      const el = (globalThis as any).document.querySelector("#actionbar .hint");
      return el ? String(el.textContent).includes("点手牌打出") : false;
    }, undefined, { timeout: 20_000 });
    const clickable = await page.locator("#hand .tile.is-clickable").count();
    expect(clickable, "停驻自己时应有可点手牌").toBeGreaterThan(0);
    expect(await page.locator("#turnStatus").innerText()).toContain("轮到你了");

    // ⑥-b v3 骨架几何：上家河在信息盘上方、自己河在下方且水平居中、下家河在信息盘右侧
    const geom: any = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const box = (sel: string) => {
        const el = doc.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cx: r.left + r.width / 2 };
      };
      return {
        felt: box("#felt"),
        hub: box("#hub"),
        topRiver: box("#kamicha .discards"),
        selfRiver: box("#riverSelf"),
        rightRiver: box("#shimocha .discards"),
        chatbar: box(".chatbar"),
      };
    });
    for (const k of ["felt", "hub", "topRiver", "selfRiver", "rightRiver", "chatbar"]) {
      expect(geom[k], `几何锚点缺失：#${k}`).not.toBeNull();
    }
    expect(geom.topRiver.bottom, "上家河应在信息盘上方").toBeLessThanOrEqual(geom.hub.top);
    expect(geom.hub.bottom, "自己河应在信息盘下方").toBeLessThanOrEqual(geom.selfRiver.top);
    expect(geom.rightRiver.left, "下家河应在信息盘右侧").toBeGreaterThanOrEqual(geom.hub.right);
    expect(Math.abs(geom.selfRiver.cx - geom.felt.cx), `自己河应水平居中（偏 ${geom.selfRiver.cx - geom.felt.cx}px）`).toBeLessThan(8);
    expect(Math.abs(geom.topRiver.cx - geom.felt.cx), `上家河应水平居中（偏 ${geom.topRiver.cx - geom.felt.cx}px）`).toBeLessThan(8);
    expect(geom.chatbar.top, "聊天通栏应在台面之外（不与玩家条挤）").toBeGreaterThanOrEqual(geom.felt.bottom);

    // ⑥-c 计时器渲染位随迁（回归风险项）：awaitingHuman.deadline → #actionbar[data-deadline]，
    //      文本由 tickTimer 回填（首次渲染为空串，能读到「倒计时 Ns」即证明 300ms tick 未断）
    const timerCount = await page.locator("#actionbar .timer[data-deadline]").count();
    expect(timerCount, "动作栏应保留 timer 渲染位（awaitingHuman 停驻自己）").toBe(1);
    // tickTimer 每 300ms 回填一次（首渲染为空串）——等一拍再读，读到即证明 tick 循环活着
    await page.waitForFunction(
      () => {
        const el = (globalThis as any).document.querySelector("#actionbar .timer");
        return el ? /^倒计时 \d+s$/.test(String(el.textContent)) : false;
      },
      undefined,
      { timeout: 5_000 },
    );
    const timerText = (await page.locator("#actionbar .timer").innerText()).trim();
    expect(timerText, `计时器未由 tick 回填：${JSON.stringify(timerText)}`).toMatch(/^倒计时 \d+s$/);

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
  });

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

    // 消息栏惯例（playtest 反馈 2026-10-20 19:25：原来一行往右滚不对劲）：
    // ① 日志必须是**纵列上下滚**——computed flexDirection 回归锁，改回 row 就是横排老毛病复现
    const logCss = await page.evaluate(() => {
      const cs = (globalThis as any).getComputedStyle((globalThis as any).document.querySelector("#log"));
      return { dir: String(cs.flexDirection), overflow: String(cs.overflowY), height: Number.parseFloat(cs.height) };
    });
    expect(logCss.dir, "日志应为纵列 column-reverse（DOM 新在前 × 反向 = 视觉新在底）").toBe("column-reverse");
    expect(logCss.overflow, "日志列应可纵向滚动").toBe("auto");
    expect(logCss.height, "日志列应有固定可见高度（非随消息无限长）").toBeGreaterThan(0);

    // ② 新发言必须插在 DOM 首位（unshift）——改 push 会让新消息沉顶，
    //    在 column-reverse 视觉里就是「旧消息盖住新消息」，本断言会红
    const lines = await page.locator("#log li").allInnerTexts();
    const chatIdx = lines.findIndex((t) => t.includes("第一句测试发言"));
    const joinIdx = lines.findIndex((t) => t.includes("你坐上南家"));
    expect(chatIdx, "本条发言应已进日志").toBeGreaterThanOrEqual(0);
    expect(joinIdx, "入座日志行应在（更早推入，用作顺序对照）").toBeGreaterThanOrEqual(0);
    expect(chatIdx, "新发言应比入座行更靠 DOM 前排（unshift×column-reverse 才有「新在底」）").toBeLessThan(joinIdx);

    expect(errors, `控制台报错：${errors.join(" | ")}`).toEqual([]);
    await page.close();
  });

  it("观战入口：无座进场三家手牌可见", { timeout: 60_000 }, async () => {
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
    // 三家手牌都可见（引擎视图口径：seat=null 观战全览；v3 玩家条扩展为牌面横幅）
    const visibleHands = await page.locator("#kamicha .p-hand .tile, #shimocha .p-hand .tile").count();
    expect(visibleHands).toBeGreaterThan(0);
    expect(await page.locator("#selfInfo .badge--kind", { hasText: "观战" }).count()).toBe(1);
    await page.screenshot({ path: path.join(SHOT_DIR, "04-spectate.png"), fullPage: true });
    await page.close();
  });

  it("窄屏（<940px）断点重排：台面单列纵队 + 场况角标入流", { timeout: 60_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
    await page.goto(`${base}/mahjong/${ROOM}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-do="spectate"]', { timeout: 15_000 });
    await page.click('[data-do="spectate"]');
    await page.waitForSelector("#hand .tile", { timeout: 15_000 });
    const narrow: any = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const cs = (sel: string) => (globalThis as any).getComputedStyle(doc.querySelector(sel));
      const felt = cs("#felt");
      const corner = cs("#field");
      return {
        cols: String(felt.gridTemplateColumns).split(" ").length,
        cornerPos: String(corner.position),
        riverCols: String(cs("#riverSelf").gridTemplateColumns).split(" ").length,
      };
    });
    expect(narrow.cols, "窄屏台面应压成单列").toBe(1);
    expect(narrow.cornerPos, "窄屏场况角标应入流（不再绝对定位压牌桌）").not.toBe("absolute");
    expect(narrow.riverCols, "窄屏牌河仍 6 列（紧凑而非拆列）").toBe(6);
    await page.screenshot({ path: path.join(SHOT_DIR, "06-narrow.png"), fullPage: true });
    await page.close();
  });

  it("桌心互斥（信息盘 ↔ 结算停驻）与 claim 浮层不拦动作栏（v3 CSS 契约）", { timeout: 120_000 }, async () => {
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
    // 停驻自己后房间 park 在本真人的决策上，无 game 推送 → 手工摆的 DOM 状态不会被重渲染冲掉
    await page.waitForFunction(() => {
      const el = (globalThis as any).document.querySelector("#actionbar .hint");
      return el ? String(el.textContent).includes("点手牌打出") : false;
    }, undefined, { timeout: 20_000 });

    // ① 结算停驻：占信息盘位，信息盘必须退位（互斥），且面板居中
    const settle: any = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const felt = doc.querySelector("#felt");
      const panel = doc.querySelector("#settlePanel");
      panel.innerHTML = '<h3>和 了</h3><div class="settle-row"><span>你 ★</span><span class="up">+8000</span></div>';
      panel.hidden = false;
      felt.dataset.state = "settle";
      const cs = (sel: string) => (globalThis as any).getComputedStyle(doc.querySelector(sel));
      const fr = felt.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      return {
        hubDisplay: cs("#hub").display,
        panelDisplay: String((globalThis as any).getComputedStyle(panel).display),
        centered: Math.abs(pr.left + pr.width / 2 - (fr.left + fr.width / 2)),
        text: String(panel.innerText).replace(/\s+/g, " "),
      };
    });
    expect(settle.hubDisplay, "结算停驻时信息盘应退位（互斥）").toBe("none");
    expect(settle.panelDisplay, "结算面板应在位").not.toBe("none");
    expect(settle.centered, `结算面板应居中（偏 ${settle.centered}px）`).toBeLessThan(8);
    expect(settle.text).toContain("和 了");
    await page.screenshot({ path: path.join(SHOT_DIR, "07-settle.png"), fullPage: true });

    // ② claim 浮层：盖桌心但不拦动作栏/手牌（pointer-events 收在卡片 + hand-zone 抬一层）
    const claim: any = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const felt = doc.querySelector("#felt");
      const panel = doc.querySelector("#settlePanel");
      panel.hidden = true;
      panel.innerHTML = "";
      felt.dataset.state = "play";
      const el = doc.querySelector("#claim");
      el.innerHTML = '<div class="claim-card"><div class="claim-from">下家打出</div><div class="claim-tile">🀄</div></div>';
      el.hidden = false;
      const cs = (sel: string) => (globalThis as any).getComputedStyle(doc.querySelector(sel));
      const probe = (sel: string) => {
        const target = doc.querySelector(sel);
        const r = target.getBoundingClientRect();
        const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit && (hit === target || (hit.closest && hit.closest(sel))));
      };
      return {
        overlayPe: cs("#claim").pointerEvents,
        cardPe: (globalThis as any).getComputedStyle(el.firstElementChild).pointerEvents,
        hubDisplay: cs("#hub").display,
        hintReachable: probe("#actionbar .hint"),
        tileReachable: probe("#hand .tile"),
        text: String(el.innerText).replace(/\s+/g, " "),
      };
    });
    expect(claim.overlayPe, "浮层本体不应拦截点击").toBe("none");
    expect(claim.cardPe, "浮层卡片自身可点").toBe("auto");
    expect(claim.hubDisplay, "claim 期间信息盘仍在位（只有结算才退位）").not.toBe("none");
    expect(claim.hintReachable, "claim 盖桌心时动作栏提示仍应命中").toBe(true);
    expect(claim.tileReachable, "claim 盖桌心时手牌仍应命中").toBe(true);
    expect(claim.text).toContain("打出");
    await page.screenshot({ path: path.join(SHOT_DIR, "08-claim.png"), fullPage: true });

    // ③ 复原，不留残留状态
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const claimEl = doc.querySelector("#claim");
      claimEl.hidden = true;
      claimEl.innerHTML = "";
      const panel = doc.querySelector("#settlePanel");
      panel.hidden = true;
      panel.innerHTML = "";
      doc.querySelector("#felt").dataset.state = "play";
    });
    expect(errors, errors.join("\n")).toEqual([]);
    await page.close();
  });

  it("大厅页 /mahjong：建房表单在位", { timeout: 60_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
    await page.goto(`${base}/mahjong`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#overlayBox h2", { timeout: 15_000 });
    expect(await page.locator("[data-do='create']").count()).toBe(1);
    expect(await page.locator("[data-seat-kind]").count()).toBe(3);
    await page.screenshot({ path: path.join(SHOT_DIR, "05-lobby.png"), fullPage: true });
    await page.close();
  });
});
