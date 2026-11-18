#!/usr/bin/env node
/**
 * 0.15（state format 1）→ 0.28（state format 2）状态迁移。
 *
 * 为什么需要：0.28 的 SDK 只认 format 2，且 AAD 固定为 'colink-agent-state-v1'；
 * 0.15 落盘的是 format 1、AAD 取 appInstanceId。直接把 COLINK_STATE_FILE 指过去会在
 * 启动时报 `Unsupported state format`。重新安装 App 也能解决，但那会让已有安装授权失效。
 *
 * 迁什么、扔什么：
 * - 保留 `oauthInstallations` / `oauthUserExecutions` / `controls` / `oauthControlReceipts` /
 *   `sessions` / `eventStops`（这些是授权与幂等凭据，迁移后无需重新安装）；
 * - 丢弃 `events`：它是投递日志，旧行字段（status/startedAt/interactionStatus 等）不符合
 *   0.28 schema，且内容都是已终态事件；丢了不影响后续投递。
 *
 * 用法（先停服务，跑在与服务同一份代码目录下）：
 *   node scripts/migrate-state.mjs --source <旧 state.enc> --target <新 state.enc> \
 *     --key <32 字节 hex> --aad <旧 AAD，通常是 COLINK_APP_INSTANCE_ID> [--keep-events]
 * 输出为单行 JSON 摘要，不打印任何密钥或令牌内容。迁移后请把 COLINK_STATE_FILE 指向新文件，
 * 旧文件保留即可回滚。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// 与 0.28 SDK 一致的固定 AAD（vendor/app-sdk/src/shared/store.mjs 的默认值）。
export const TARGET_AAD = 'colink-agent-state-v1';

const PRESERVED_MAPS = ['sessions', 'oauthInstallations', 'oauthUserExecutions', 'eventStops', 'controls'];

function unseal(file, keyHex, aad) {
  const bytes = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (bytes.length < 28) throw new Error('state file too short');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
}

function seal(value, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(TARGET_AAD));
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

/** 纯函数：旧状态对象 → 新状态对象（不做 IO，便于测试）。 */
export function migrateState(old, { keepEvents = false, validate } = {}) {
  if (old?.format !== 1) throw new Error(`source state format ${String(old?.format)} is not 1`);
  const next = { format: 2, events: {}, oauthControlReceipts: old.oauthControlReceipts ?? [] };
  for (const name of PRESERVED_MAPS) next[name] = old[name] ?? {};
  if (keepEvents) next.events = old.events ?? {};
  // 新 SDK 的 decode 是唯一的验收口径：形状不合就抛，宁可不迁移也不写坏文件。
  return typeof validate === 'function' ? validate(next) : next;
}

export function readStateFile(file, { keyHex, aad }) {
  return unseal(file, keyHex, aad);
}

export function writeStateFile(file, state, { keyHex }) {
  writeFileSync(file, seal(state, keyHex), { mode: 0o600 });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    if (name === 'keep-events') { args.keepEvents = true; continue; }
    args[name] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const keyHex = args.key ?? process.env.COLINK_CREDENTIAL_KEY;
  const aad = args.aad ?? process.env.COLINK_APP_INSTANCE_ID;
  if (!args.source || !args.target) throw new Error('--source and --target are required');
  if (!/^[a-f0-9]{64}$/i.test(String(keyHex ?? ''))) throw new Error('--key (or COLINK_CREDENTIAL_KEY) must be 32 bytes hex');
  if (!aad) throw new Error('--aad (or COLINK_APP_INSTANCE_ID) is required');
  if (args.source === args.target) throw new Error('--target must differ from --source (keep the old file for rollback)');

  const { runtimeState } = await import('../vendor/app-sdk/src/shared/state.mjs');
  const old = unseal(args.source, keyHex, aad);
  const next = migrateState(old, { keepEvents: args.keepEvents === true, validate: runtimeState });
  writeStateFile(args.target, next, { keyHex });

  // 写盘后立刻用 SDK 自己的解码路径回读一遍，避免「写成功但打不开」。
  const { openEncryptedStore } = await import('../vendor/app-sdk/src/shared/store.mjs');
  const store = openEncryptedStore(args.target, keyHex, { decode: runtimeState });
  const summary = {
    source: { format: old.format, events: Object.keys(old.events ?? {}).length },
    target: {
      format: store.data.format,
      events: Object.keys(store.data.events).length,
      sessions: Object.keys(store.data.sessions).length,
      oauthInstallations: Object.keys(store.data.oauthInstallations).length,
      oauthUserExecutions: Object.keys(store.data.oauthUserExecutions).length,
      controls: Object.keys(store.data.controls).length,
      oauthControlReceipts: store.data.oauthControlReceipts.length,
    },
  };
  store.close();
  console.log(JSON.stringify(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(`[migrate-state] ${error.message}`);
    process.exit(1);
  });
}
