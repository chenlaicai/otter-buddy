import { resolve } from 'node:path';
import { createCoLinkApp, openEncryptedStore, serveCoLinkApp, validateIssuer } from '@colink/app-sdk';
import { ConversationStore, OtterBridge } from './otter-bridge.mjs';
import { createManifest } from './manifest.mjs';
import { createMentionHandler } from './mention-handler.mjs';
import { CoLinkToolBridge } from './colink-tools.mjs';

const required = ['COLINK_APP_ID', 'COLINK_APP_INSTANCE_ID', 'COLINK_CLIENT_ID', 'COLINK_CLIENT_SECRET',
  'COLINK_SIGNING_SECRET', 'COLINK_ISSUER', 'COLINK_API_BASE', 'COLINK_CREDENTIAL_KEY'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const config = {
  appId: process.env.COLINK_APP_ID,
  appInstanceId: process.env.COLINK_APP_INSTANCE_ID,
  clientId: process.env.COLINK_CLIENT_ID,
  clientSecret: process.env.COLINK_CLIENT_SECRET,
  signingSecret: process.env.COLINK_SIGNING_SECRET,
  issuer: process.env.COLINK_ISSUER,
  apiBase: process.env.COLINK_API_BASE,
  allowInsecureIssuer: process.env.COLINK_ALLOW_INSECURE_ISSUER === 'true',
  turnTimeoutMs: 240_000,
};
validateIssuer(config.issuer, process.env.COLINK_ALLOW_INSECURE_ISSUER === 'true');
const manifest = createManifest();
const store = openEncryptedStore(resolve(dataDir, 'colink-state.enc'), process.env.COLINK_CREDENTIAL_KEY,
  { aad: process.env.COLINK_STORE_AAD ?? config.appInstanceId });
const toolBridge = new CoLinkToolBridge({
  secret: process.env.COLINK_CREDENTIAL_KEY,
  port: Number(process.env.COLINK_MCP_PORT ?? 31_131),
});
await toolBridge.start();
const bridge = new OtterBridge({
  baseUrl: process.env.OTTER_BASE_URL ?? 'http://127.0.0.1:3000',
  store: new ConversationStore(resolve(dataDir, 'otter-conversations.json')),
  timeoutMs: 180_000,
  toolBridge,
});
const app = createCoLinkApp({
  config, store, manifest,
  onMention: createMentionHandler({ bridge, deploymentId: config.appInstanceId }),
  log: entry => console.log(JSON.stringify({ code: entry.code, stage: entry.stage, eventId: entry.eventId,
    installationId: entry.installationId, status: entry.status, error: entry.error })),
});

// 宿主页面 web origin：嵌入 iframe 时用于 postMessage 握手。
// 当前部署 App 与宿主同域（issuer 即宿主 origin）；若宿主前端与 API 分域，显式设置 COLINK_HOST_ORIGIN 覆盖。
const hostOrigin = process.env.COLINK_HOST_ORIGIN ?? config.issuer;
console.log(JSON.stringify({ code: 'app_host_origin', hostOrigin }));

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 31130);
const appServer = await serveCoLinkApp(app, {
  host,
  port,
  // 显式公开资源：只暴露嵌入页单文件；page-config 与 SDK 浏览器包由 serveCoLinkApp 内建提供，
  // 并带 validateIssuer 启动校验、publicHandler 503 兜底与 reserved 路径保护。
  assets: {
    '/embed.html': { file: new URL('./embed-page.html', import.meta.url), contentType: 'text/html; charset=utf-8' },
  },
  pageConfig: {
    hostOrigin,
    issuer: config.issuer,
    ...(config.allowInsecureIssuer ? { allowInsecureLocal: true } : {}),
  },
  handleSignals: false,
});
console.log(`Otter CoLink App listening on ${appServer.host}:${appServer.port}`);

let closing;
const close = () => {
  if (closing) return closing;
  closing = (async () => {
    await appServer.close();
    await toolBridge.close();
  })();
  return closing;
};
process.on('SIGTERM', () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
process.on('SIGINT', () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
