import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG_PATH = resolve(process.cwd(), "deploy/ecs/nginx-otter.conf");
const source = readFileSync(CONFIG_PATH, "utf8");

/** 专属 SSE location 当前没有嵌套块，直接取正则与块正文做静态契约检查。 */
function sseLocation(): { pattern: RegExp; block: string } {
  const match = source.match(/location\s+~\s+(\^\/api\/\S+)\s+\{([\s\S]*?)^\s*\}/m);
  if (!match) throw new Error("未找到 API SSE 专属 location");
  return { pattern: new RegExp(match[1]), block: match[2] };
}

describe("中枢公网反代 SSE 覆盖", () => {
  it("同一 location 覆盖会话订阅、发消息、两类重试与牌局事件流", () => {
    const { pattern } = sseLocation();
    const paths = [
      "/api/conversations/conversation-1/subscribe",
      "/api/conversations/conversation-1/messages",
      "/api/invokes/invoke-1/retry",
      "/api/otters/otter-1/retry",
      "/api/mahjong/rooms/room-1/events",
    ];
    for (const path of paths) expect(pattern.test(path), path).toBe(true);
    expect(pattern.test("/api/conversations/conversation-1/entries")).toBe(false);
  });

  it("SSE location 关缓冲/缓存并延长读超时，且清掉可伪造身份头", () => {
    const { block } = sseLocation();
    expect(block).toContain("proxy_buffering off;");
    expect(block).toContain("proxy_cache off;");
    expect(block).toContain("proxy_read_timeout 3600s;");
    expect(block).toContain('proxy_set_header X-Otter-User-Id "";');
    expect(block).toContain('proxy_set_header X-Otter-User-Role "";');
  });
});
