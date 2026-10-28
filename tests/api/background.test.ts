import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { BackgroundStore } from "../../src/usecases/settings/background-store";
import { BackgroundController } from "../../src/interface-adapters/http/controllers/background-controller";
import { createTestLogger } from "../helpers/logger";

// 合法 1x1 PNG；其余用例只依赖 magic bytes 的格式拒绝路径。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const dataUrl = (buffer: Buffer, mime = "image/png") => `data:${mime};base64,${buffer.toString("base64")}`;

let directory: string;
let store: BackgroundStore;
let app: Hono;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "otter-background-"));
  store = new BackgroundStore(directory);
  app = new Hono();
  const controller = new BackgroundController(store, createTestLogger());
  app.get("/api/settings/background", c => controller.get(c));
  app.put("/api/settings/background", c => controller.put(c));
  app.delete("/api/settings/background", c => controller.delete(c));
});

afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe("应用启动目录背景", () => {
  it("PUT 原子保存到启动目录，新 store 实例 GET 读回真实图片", async () => {
    const put = await app.request("/api/settings/background", { method: "PUT", body: dataUrl(PNG) });
    expect(put.status).toBe(200);
    const body = await put.json() as { url: string };
    expect(body.url).toMatch(/^\/api\/settings\/background\?v=/);
    expect(fs.existsSync(path.join(directory, "current"))).toBe(true);
    expect(fs.readdirSync(directory)).toEqual(["current"]);

    const freshStore = new BackgroundStore(directory);
    const freshApp = new Hono();
    const controller = new BackgroundController(freshStore, createTestLogger());
    freshApp.get("/api/settings/background", c => controller.get(c));
    const res = await freshApp.request("/api/settings/background");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("重复保存不会遗留临时文件，旧图被替换", async () => {
    await store.save(dataUrl(PNG));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    const { version } = await store.save(dataUrl(jpeg, "image/jpeg"));
    expect(version).toBeTruthy();
    expect(store.read()?.mimeType).toBe("image/jpeg");
    expect(store.read()?.buffer.equals(jpeg)).toBe(true);
    expect(fs.readdirSync(directory)).toEqual(["current"]);
  });

  it.each([
    ["伪造 MIME", dataUrl(Buffer.from("not an image"), "image/png")],
    ["声明与内容不符", dataUrl(PNG, "image/jpeg")],
    ["SVG", dataUrl(Buffer.from("<svg onload=alert(1)></svg>"), "image/svg+xml")],
    ["坏 base64", "data:image/png;base64,%%%"],
    ["非 data URL", "https://example.com/a.png"],
  ])("拒绝%s且不创建资产", async (_name, input) => {
    await expect(store.save(input)).rejects.toThrow();
    expect(fs.existsSync(path.join(directory, "current"))).toBe(false);
  });

  it("超过 8 MiB 拒绝，不覆盖旧资产", async () => {
    await store.save(dataUrl(PNG));
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
    PNG.copy(oversized);
    await expect(store.save(dataUrl(oversized))).rejects.toThrow("不能超过 8 MB");
    expect(store.read()?.buffer.equals(PNG)).toBe(true);
  });

  it("磁盘坏资产不作为图片返回，回默认背景", async () => {
    fs.writeFileSync(path.join(directory, "current"), "broken");
    expect(store.read()).toBeNull();
    expect((await app.request("/api/settings/background")).status).toBe(404);
  });

  it("DELETE 删除资产且幂等", async () => {
    await store.save(dataUrl(PNG));
    expect((await app.request("/api/settings/background", { method: "DELETE" })).status).toBe(204);
    expect(store.read()).toBeNull();
    expect((await app.request("/api/settings/background", { method: "DELETE" })).status).toBe(204);
  });
});
