import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { BackgroundStore } from "@usecases/settings/background-store";
import { handleError } from "../http-error";

export class BackgroundController {
  constructor(private readonly store: BackgroundStore, private readonly logger: Logger) {}

  async get(c: Context): Promise<Response> {
    try {
      const image = this.store.read();
      if (!image) return c.json({ error: "Background not configured" }, 404);
      return new Response(new Uint8Array(image.buffer), {
        headers: {
          "Content-Type": image.mimeType,
          "Content-Length": String(image.buffer.length),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
          "ETag": `"${image.version}"`,
        },
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async put(c: Context): Promise<Response> {
    try {
      const { version } = await this.store.save(await c.req.text());
      return c.json({ url: `/api/settings/background?v=${encodeURIComponent(version)}` });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async delete(c: Context): Promise<Response> {
    try {
      this.store.remove();
      return c.body(null, 204);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
