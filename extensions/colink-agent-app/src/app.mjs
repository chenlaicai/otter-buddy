import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createCoLinkApp, openEncryptedStore, validateIssuer } from '@colink/app-sdk';
import { ConversationStore, OtterBridge } from './otter-bridge.mjs';
import { createManifest } from './manifest.mjs';
import { createMentionHandler } from './mention-handler.mjs';
import { CoLinkToolBridge } from './colink-tools.mjs';

const required = ['COLINK_APP_ID', 'COLINK_APP_INSTANCE_ID', 'COLINK_CLIENT_ID', 'COLINK_CLIENT_SECRET',
  'COLINK_SIGNING_SECRET', 'COLINK_ISSUER', 'COLINK_API_BASE', 'COLINK_CREDENTIAL_KEY', 'COLINK_ALLOWED_USER_IDS'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
const allowedUserIds = new Set(process.env.COLINK_ALLOWED_USER_IDS.split(',').map(value => value.trim()).filter(Boolean));
if (allowedUserIds.size === 0) throw new Error('COLINK_ALLOWED_USER_IDS must contain at least one user ID');
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
  onMention: createMentionHandler({ bridge, allowedUserIds, deploymentId: config.appInstanceId }),
  log: entry => console.log(JSON.stringify({ code: entry.code, stage: entry.stage, eventId: entry.eventId,
    installationId: entry.installationId, status: entry.status, error: entry.error })),
});
const server = createServer(app.publicHandler);
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 31130);
server.listen(port, host, () => console.log(`Otter CoLink App listening on ${host}:${port}`));
let closing;
const close = () => {
  if (closing) return closing;
  closing = (async () => {
    await app.close();
    await toolBridge.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  })();
  return closing;
};
process.on('SIGTERM', () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
process.on('SIGINT', () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
