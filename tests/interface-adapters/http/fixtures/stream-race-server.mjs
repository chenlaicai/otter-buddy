/* global process, setTimeout, Buffer, Response */
/**
 * #2010 竞态复现 fixture（子进程服务器）。
 *
 * 用受控 Node Readable 构造确定性时序：chunk1 → 挂起（pull pending）→
 * 客户端 abort（writable close → reader.cancel()）→ EOF 迟到到达。
 * - /legacy：new Response(nodeStream)（Node async iterable 直接喂 Response）
 *   → undici ReadableStreamFrom 包装 → queueMicrotask(controller.close()) 落在
 *   已 cancel 的 controller 上 → ERR_INVALID_STATE → exit(42)
 * - /fixed：new Response(Readable.toWeb(nodeStream)) → undici 直接透传 → 存活 exit(0)
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Readable } from "node:stream";

process.on("uncaughtException", (e) => {
  process.stderr.write(`UNCAUGHT|${e.code}|${e.message}\n`);
  process.exit(42);
});

class ControlledFile extends Readable {
  constructor() { super(); this.emitted = false; }
  _read() {
    if (!this.emitted) {
      this.emitted = true;
      this.push(Buffer.alloc(64 * 1024, 7));
      // 挂起：不 push，pull 的 iterator.next() pending
      setTimeout(() => this.push(null), 400); // EOF 迟到：客户端 abort 之后
    }
  }
}

const app = new Hono();
app.get("/legacy", () => {
  const s = new ControlledFile();
  return new Response(s, { headers: { "Content-Type": "application/octet-stream" } });
});
app.get("/fixed", () => {
  const s = new ControlledFile();
  return new Response(Readable.toWeb(s), { headers: { "Content-Type": "application/octet-stream" } });
});

serve({ fetch: app.fetch, port: Number(process.env.RACE_PORT || 3987) }, () => {
  process.stdout.write("READY\n");
});
