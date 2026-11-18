import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateState, readStateFile, writeStateFile, TARGET_AAD } from '../scripts/migrate-state.mjs';
import { runtimeState } from '../vendor/app-sdk/src/shared/state.mjs';
import { openEncryptedStore } from '../vendor/app-sdk/src/shared/store.mjs';

/** 按 0.15 的落盘格式造一份旧状态（format 1 + AAD=appInstanceId）；行形状取自真实 0.15 部署。 */
function legacyStateFile({ keyHex, appInstanceId, state }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(appInstanceId));
  return Buffer.concat([iv, cipher.update(JSON.stringify(state), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

const legacy = {
  format: 1,
  // 旧 events 行带 status/startedAt/sessionKey 等 0.28 schema 已不接受的字段。
  events: {
    'evt-1': {
      event: { schemaVersion: '1.0.0', eventId: 'evt-1', type: 'app.mentioned', appId: 'app_1', deploymentId: 'dep_1', installationId: 'inst-1', timestamp: '2026-11-16T09:00:00Z', actor: {}, data: {} },
      fingerprint: 'fp-1', executionId: 'exec-1', scopes: [], version: 1,
      status: 'done', createdAt: 1, updatedAt: 2, startedAt: 1, sessionKey: 'k', sessionId: 's',
      interactionStatus: { state: 'done' }, finishedAt: 2, nextAttempt: 0, error: null,
    },
  },
  sessions: {},
  oauthInstallations: {
    'inst-1': { authorizationVersion: 1, eventId: 'evt-0', status: 'ready', startedAt: 1, accessToken: 'a', refreshToken: 'r', expiresAt: 9, scope: 'messages:read-public' },
  },
  oauthUserExecutions: {
    'exec-1': { access: 'a', refresh: 'r', expiresAt: 9, mode: 'session', deadline: 9, scopes: ['messages:read-private'], installationId: 'inst-1', userId: 'user-1', eventId: 'evt-1' },
  },
  eventStops: {},
  controls: {
    'evt-1': { event: { type: 'installation.authorized', eventId: 'evt-1', installationId: 'inst-1', authorizationVersion: 1 }, done: true, createdAt: 1, updatedAt: 1 },
  },
  oauthControlReceipts: [{ eventId: 'evt-1', installationId: 'inst-1', authorizationVersion: 1 }],
};

test('migrateState keeps authorization maps, drops the legacy event journal', () => {
  const migrated = migrateState(legacy, { validate: runtimeState });
  assert.equal(migrated.format, 2);
  assert.deepEqual(migrated.events, {});
  assert.deepEqual(migrated.oauthInstallations, legacy.oauthInstallations);
  assert.deepEqual(migrated.oauthUserExecutions, legacy.oauthUserExecutions);
  assert.equal(migrated.oauthControlReceipts.length, 1);
  // 新 SDK 的 decode 是验收口径：必须直接过。
  assert.doesNotThrow(() => runtimeState(migrated));
});

test('legacy event rows really are rejected by the 0.28 schema (why we drop them)', () => {
  const withEvents = migrateState(legacy, { keepEvents: true });
  assert.throws(() => runtimeState(withEvents), /Unsupported runtime state shape/);
});

test('migrateState refuses a non-format-1 source', () => {
  assert.throws(() => migrateState({ format: 2, events: {}, sessions: {} }), /is not 1/);
});

test('round trip: 0.15 file → 0.28 file opens through the SDK store', () => {
  const keyHex = randomBytes(32).toString('hex');
  const appInstanceId = 'inst-abcdef';
  const dir = mkdtempSync(join(tmpdir(), 'clink-migrate-'));
  try {
    const source = join(dir, 'colink-state.enc');
    const target = join(dir, 'colink-state-v2.enc');
    writeFileSync(source, legacyStateFile({ keyHex, appInstanceId, state: legacy }));

    const old = readStateFile(source, { keyHex, aad: appInstanceId });
    assert.equal(old.format, 1);
    writeStateFile(target, migrateState(old, { validate: runtimeState }), { keyHex });

    // TARGET_AAD 必须与 SDK 默认值一致，否则 SDK 打不开——这是最容易写错的一处。
    const store = openEncryptedStore(target, keyHex, { decode: runtimeState });
    assert.equal(store.data.format, 2);
    assert.deepEqual(Object.keys(store.data.oauthInstallations), ['inst-1']);
    assert.deepEqual(store.data.events, {});
    store.close();
    assert.equal(TARGET_AAD, 'colink-agent-state-v1');
    // 旧文件保持原样，可回滚。
    assert.equal(readStateFile(source, { keyHex, aad: appInstanceId }).format, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrating with the wrong AAD fails instead of writing a broken file', () => {
  const keyHex = randomBytes(32).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'clink-migrate-aad-'));
  try {
    const source = join(dir, 'colink-state.enc');
    writeFileSync(source, legacyStateFile({ keyHex, appInstanceId: 'right-aad', state: legacy }));
    assert.throws(() => readStateFile(source, { keyHex, aad: 'wrong-aad' }), /unable to authenticate|Unsupported state/);
    // 正确的 AAD 下同一份文件可读。
    assert.equal(readStateFile(source, { keyHex, aad: 'right-aad' }).format, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration script ships with the SDK-relative import path it needs', () => {
  assert.ok(readFileSync(new URL('../scripts/migrate-state.mjs', import.meta.url), 'utf8').includes('TARGET_AAD'));
});
