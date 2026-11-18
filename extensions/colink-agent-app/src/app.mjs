import { resolve } from 'node:path';
import { createCoLinkRuntime, serveCoLinkRuntime, EventType } from '../vendor/app-sdk/index.mjs';
import { ConversationStore, OtterBridge } from './otter-bridge.mjs';
import { createManifest } from './manifest.mjs';
import { createMentionHandler } from './mention-handler.mjs';
import { CoLinkToolBridge } from './colink-tools.mjs';

// Why: 0.28 起身份、连接、签名密钥由 SDK 从 COLINK_* 环境变量读取并在创建时报错，
// 这里只校验本扩展自己的运行时配置，不复制 SDK 的凭据校验。
// Why: MCP bearer 由 COLINK_MCP_SECRET 派生且必须按 Conversation 稳定——Otter 的
// mcp-external 守卫拒绝同一 server 换 bearer（见 colink-tools.mjs 类注释）。
for (const name of ['DATA_DIR', 'OTTER_BASE_URL', 'COLINK_MCP_SECRET']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
const dataDir = resolve(process.env.DATA_DIR);

const toolBridge = new CoLinkToolBridge({
  secret: process.env.COLINK_MCP_SECRET,
  port: Number(process.env.COLINK_MCP_PORT ?? 31_131),
});
await toolBridge.start();
const bridge = new OtterBridge({
  baseUrl: process.env.OTTER_BASE_URL,
  store: new ConversationStore(resolve(dataDir, 'otter-conversations.json')),
  timeoutMs: 180_000,
  toolBridge,
});

const runtime = createCoLinkRuntime({
  manifest: createManifest(),
  onEvent: { [EventType.UserMessageReceived]: createMentionHandler({ bridge }) },
  log: entry => console.log(JSON.stringify({ code: entry.code, stage: entry.stage, eventId: entry.eventId,
    installationId: entry.installationId, status: entry.status, error: entry.error })),
});

// 嵌入页由 SDK 按 manifest 的 viewId 托管在 entryPath（/embed.html）；
// /page-config.json 与 SDK 浏览器包同样由 serveCoLinkRuntime 内建提供，需要 COLINK_APP_ORIGIN。
// 监听地址与端口由 SDK 的环境配置决定（COLINK_BIND_HOST / COLINK_PORT，缺省 127.0.0.1:8080）。
const server = await serveCoLinkRuntime(runtime, {
  views: { 'otter.embed': new URL('./embed-page.html', import.meta.url) },
});
console.log(`Otter CoLink App listening on ${server.host}:${server.port}`);

let closing;
const close = () => {
  if (closing) return closing;
  closing = (async () => {
    await server.close();
    await toolBridge.close();
  })();
  return closing;
};
process.on('SIGTERM', () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
process.on('SIGINT', () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
