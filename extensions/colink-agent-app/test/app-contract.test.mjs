import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionPoint, ViewContainer } from '../vendor/app-sdk/index.mjs';
import { createManifest } from '../src/manifest.mjs';
import { createMentionHandler } from '../src/mention-handler.mjs';

test('manifest includes a passive otter avatar and both personal/project scopes', () => {
  const manifest = createManifest();
  assert.equal(manifest.iconId, 'otter');
  assert.deepEqual(manifest.supportedInstallationScopes, ['personal', 'project']);
  const prefix = 'data:image/svg+xml;base64,';
  assert.ok(manifest.icons.otter.startsWith(prefix));
  const svg = Buffer.from(manifest.icons.otter.slice(prefix.length), 'base64').toString('utf8');
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /<script|onload=|javascript:|<image|<foreignObject/i);
  assert.doesNotMatch(svg, /<rect[^>]*width="64"[^>]*height="64"/i);
  // 图标契约（CoLink）：单色线条，禁止渐变/opacity/引用颜料，颜色只允许 currentColor 与 none
  assert.doesNotMatch(svg, /<(?:linear|radial)Gradient/i);
  assert.doesNotMatch(svg, /\bopacity\s*=/i);
  assert.doesNotMatch(svg, /url\(#/i);
  assert.doesNotMatch(svg, /(?:fill|stroke)\s*=\s*["'](?!currentColor|none)[^"']+["']/i);
  assert.equal(manifest.version, '0.6.1');
  assert.deepEqual(manifest.permissions, ['messages:receive', 'messages:write', 'messages:read-public', 'messages:read-private', 'files:read', 'files:upload']);
  // Why: 0.28 协议把用户消息统一为 app.user_message_received；app.mentioned 已退役。
  assert.deepEqual(manifest.events, { path: '/events', schemaVersion: '2.0.0', types: ['app.user_message_received'] });
  assert.equal(manifest.ui.contractVersion, '1.0.0');
  assert.deepEqual(manifest.ui.views, [{ viewId: 'otter.embed', renderer: 'app', entryPath: '/embed.html', bridgeVersion: '1.0.0' }]);
  assert.ok(manifest.ui.entries.some(entry => entry.extensionPoint.id === 'colink.app.home' && entry.openView.container === 'side_panel'));
  assert.ok(manifest.ui.entries.some(entry => entry.extensionPoint.id === 'colink.navigation.modules' && entry.openView.container === 'page_content'));
  assert.ok(manifest.ui.entries.some(entry => entry.extensionPoint.id === 'colink.dm.actions' && entry.openView.container === 'side_panel'));
  // 不再声明 colink.topic.actions：该点会把入口带进频道话题标题栏与消息操作栏（个人空间兜底还会泄漏进项目频道）。
  assert.ok(!manifest.ui.entries.some(entry => entry.extensionPoint.id === ExtensionPoint.TopicActions));
  // Why: 扩展点与容器必须落在当前 SDK 的契约常量里，SDK 升级后被删除/改名的点在这里就会失败。
  const containers = {
    [ExtensionPoint.AppHome]: [ViewContainer.SidePanel],
    [ExtensionPoint.NavigationModules]: [ViewContainer.PageContent],
    // 权威清单契约：dm.actions 只接受 side_panel（for-ai-manifest.md 扩展点表）。
    [ExtensionPoint.DmActions]: [ViewContainer.SidePanel],
  };
  for (const entry of manifest.ui.entries) {
    assert.ok(Object.hasOwn(containers, entry.extensionPoint.id), `未知扩展点 ${entry.extensionPoint.id}`);
    assert.ok(containers[entry.extensionPoint.id].includes(entry.openView.container), `容器不合法 ${entry.openView.container}`);
  }
});

/** 0.28 的事件回调上下文：数据全在 event.data，回复走 ctx.reply。 */
function ctxFixture(input, replies, userId = 'owner') {
  return {
    event: { deploymentId: 'deployment', eventId: 'event', actor: { id: userId }, data: { text: '你好', ...input } },
    context: { userId, installationId: 'installation' },
    signal: new AbortController().signal,
    reply: async value => replies.push(value),
  };
}

test('mention handler routes DM and channel to their respective Otter mappings', async () => {
  const calls = [];
  const replies = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge });
  await handler(ctxFixture({ reason: 'dm_message', conversationId: 'same-id' }, replies, 'teammate-dm'));
  await handler(ctxFixture({ reason: 'mention', channelId: 'same-id' }, replies, 'teammate'));
  assert.equal(calls[0].kind, 'dm');
  assert.equal(calls[1].kind, 'channel');
  assert.equal(calls[0].conversationId, 'same-id');
  assert.equal(calls[1].conversationId, 'same-id');
  assert.equal(calls[1].actorId, 'teammate');
  assert.equal(calls[0].ctx.event.data.reason, 'dm_message');
  assert.equal(calls[1].ctx.event.data.reason, 'mention');
  assert.deepEqual(replies, [{ text: '回答' }, { text: '回答' }]);
});

test('mention handler allows personal DM without a user allowlist and rejects unsupported events', async () => {
  let executions = 0;
  const replies = [];
  const bridge = { reply: async () => { executions++; return '同事回答'; } };
  const handler = createMentionHandler({ bridge });
  await handler(ctxFixture({ reason: 'dm_message', conversationId: 'dm' }, replies, 'colleague-not-in-old-allowlist'));
  await assert.rejects(handler(ctxFixture({ reason: 'mention', channelId: null }, [])), /ONLY_DM_AND_CHANNEL_TEXT_SUPPORTED/);
  assert.equal(executions, 1);
  assert.deepEqual(replies, [{ text: '同事回答' }]);
});

const RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 带 colink 客户端 mock 的事件上下文：channel 用 readImage、DM 用 downloadAttachment。 */
function imageCtxFixture({ kind = 'channel', text = '看图', fileIds = [], imageData = RED_PNG_BASE64, imageMimeType = 'image/png', uploadFails = false } = {}) {
  const reads = [];
  const uploads = [];
  const sends = [];
  const replies = [];
  const colink = {
    user: {
      topics: { readImage: async ({ topicId, artifactId }) => { reads.push({ topicId, artifactId }); return { artifactId, mimeType: imageMimeType, data: imageData }; } },
      directMessages: { downloadAttachment: async ({ conversationId, artifactId }) => { reads.push({ conversationId, artifactId }); return { bytes: Uint8Array.from(Buffer.from(imageData, 'base64')), contentType: imageMimeType }; } },
    },
    app: {
      files: {
        upload: async input => {
          uploads.push(input);
          if (uploadFails) throw new Error('upload failed');
          return { fileId: `file-upload-${uploads.length}` };
        },
      },
      messages: { send: async input => { sends.push(input); return { messageId: 'out-1' }; } },
    },
  };
  const data = kind === 'dm'
    ? { reason: 'dm_message', conversationId: 'conv-1', topicId: null, channelId: null, text, fileIds }
    : { reason: 'mention', channelId: 'ch-1', topicId: 'topic-1', conversationId: null, text, fileIds };
  const ctx = {
    event: { deploymentId: 'deployment', eventId: 'event', actor: { id: 'owner' }, data },
    context: { userId: 'owner', installationId: 'installation' },
    signal: new AbortController().signal,
    colink,
    reply: async value => replies.push(value),
  };
  return { ctx, reads, uploads, sends, replies };
}

test('mention handler downloads event images through readImage and forwards them to the bridge', async () => {
  const calls = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge });
  const { ctx, reads } = imageCtxFixture({ fileIds: ['file-1', 'file-2'] });
  await handler(ctx);
  assert.deepEqual(reads.map(r => r.artifactId), ['file-1', 'file-2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 2);
  assert.deepEqual(calls[0].images.map(i => i.fileId), ['file-1', 'file-2']);
  assert.equal(calls[0].images[0].mimeType, 'image/png');
  assert.deepEqual([...calls[0].images[0].bytes], [...Uint8Array.from(Buffer.from(RED_PNG_BASE64, 'base64'))]);
  assert.deepEqual(calls[0].failedImageIds, []);
});

test('mention handler accepts an image-only message (empty text with a fileId)', async () => {
  const calls = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge });
  const { ctx } = imageCtxFixture({ text: '', fileIds: ['file-1'] });
  await handler(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '');
  assert.equal(calls[0].images.length, 1);
});

test('mention handler still rejects a message with neither text nor readable images', async () => {
  const calls = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge });
  const { ctx } = imageCtxFixture({ text: '', fileIds: [] });
  await assert.rejects(handler(ctx), /EMPTY_MESSAGE_TEXT/);
  assert.equal(calls.length, 0);
});

test('mention handler degrades a failed image read to a failedImageIds note without blocking the text', async () => {
  const calls = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge });
  const { ctx } = imageCtxFixture({ fileIds: ['bad-1'] });
  ctx.colink.user.topics.readImage = async () => { throw new Error('SCOPE_MISSING'); };
  await handler(ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images, []);
  assert.deepEqual(calls[0].failedImageIds, ['bad-1']);
});

test('mention handler downloads DM images through downloadAttachment', async () => {
  const calls = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge });
  const { ctx, reads } = imageCtxFixture({ kind: 'dm', fileIds: ['file-9'], imageMimeType: 'image/jpeg' });
  await handler(ctx);
  assert.deepEqual(reads.map(r => r.artifactId), ['file-9']);
  assert.equal(calls[0].images.length, 1);
  assert.equal(calls[0].images[0].mimeType, 'image/jpeg');
  assert.equal(calls[0].images[0].fileName, 'colink-image.jpg');
});

const FORWARD_SVG = '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>\n```';

test('mention handler renders reply SVGs to PNG and sends them with the message in a channel', async () => {
  const bridge = { reply: async () => `看这张图\n${FORWARD_SVG}` };
  const handler = createMentionHandler({ bridge });
  const { ctx, uploads, sends, replies } = imageCtxFixture();
  await handler(ctx);
  assert.equal(replies.length, 0);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].fileName, 'image-1.png');
  assert.equal(uploads[0].channelId, 'ch-1');
  assert.ok(uploads[0].bytes instanceof Uint8Array);
  assert.ok(uploads[0].bytes.length > 0);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].fileIds, ['file-upload-1']);
  assert.equal(sends[0].text, '看这张图');
  assert.equal(sends[0].channelId, 'ch-1');
  assert.equal(sends[0].topicId, 'topic-1');
});

test('mention handler keeps text-only channel replies on ctx.reply', async () => {
  const bridge = { reply: async () => '纯文本回答' };
  const handler = createMentionHandler({ bridge });
  const { ctx, sends, replies } = imageCtxFixture();
  await handler(ctx);
  assert.equal(sends.length, 0);
  assert.deepEqual(replies, [{ text: '纯文本回答' }]);
});

test('mention handler degrades an SVG in a DM to a text-only reply (no channel to upload into)', async () => {
  const bridge = { reply: async () => FORWARD_SVG };
  const handler = createMentionHandler({ bridge });
  const { ctx, uploads, sends, replies } = imageCtxFixture({ kind: 'dm' });
  await handler(ctx);
  assert.equal(uploads.length, 0);
  assert.equal(sends.length, 0);
  assert.deepEqual(replies, [{ text: FORWARD_SVG }]);
});

test('mention handler degrades a failed SVG upload to a text-only send', async () => {
  const bridge = { reply: async () => FORWARD_SVG };
  const handler = createMentionHandler({ bridge });
  const { ctx, uploads, sends, replies } = imageCtxFixture({ uploadFails: true });
  await handler(ctx);
  assert.equal(uploads.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].fileIds, undefined);
  assert.equal(sends[0].text, '（图片生成失败，已省略）');
});

/** vendor/ 入库（由 prepare:sdk 生成），CI 直接核对 pin 与实物版本一致。 */
test('vendored SDK matches the pinned version and the manifest constants are not stale', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const pinPath = new URL('../sdk-pin.json', import.meta.url);
  const vendorPackage = new URL('../vendor/app-sdk/package.json', import.meta.url);
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  assert.equal(pin.package, '@colink/app-sdk');
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  // vendor 已入库（prepare:sdk 产出），缺失即是构建链坏了，不能静默跳过。
  assert.ok(existsSync(vendorPackage), 'vendor/app-sdk 缺失：先跑 npm run prepare:sdk');
  const vendored = JSON.parse(readFileSync(vendorPackage, 'utf8'));
  assert.equal(vendored.version, pin.version);
});

/**
 * 0.28.1 分页统一契约的 vendor 侧锁定。
 * Why 直接测 vendor：我们自己的工具层用 fixture 打桩，看不出「pin 到的 SDK 到底放不放行 cursor」。
 * 一旦有人回退 vendor 到 0.28.0（dm 只认 beforeId/afterId），线上私聊翻页会以 400 失败，
 * 而工具层测试仍是绿的——这条断言就是那个缺口。
 */
test('vendored SDK 的私聊读取与话题共用 limit/cursor，且拒绝已删除的 beforeId/afterId', async () => {
  const { createTurnActions } = await import('../vendor/app-sdk/src/events/turn.mjs');
  const dmRow = { event: { eventId: 'e1', data: { reason: 'dm_message' } } };
  const seen = [];
  // 平台侧私聊消息结构（wire-schemas:81/83/84/87）——SDK 会校验形状，不能用最小假数据糊过去。
  const dmItem = { id: 'm1', conversationId: 'dm-1', senderId: 'u1', senderKind: 'human', text: 'x',
    attachments: [], createdAt: '2026-11-18T00:00:00.000Z', recalledAt: null };
  const platform = {
    readMessages: async (row, capability, input) => {
      seen.push({ capability, input });
      return { items: [dmItem], hasMore: false, nextCursor: null };
    },
    validate: async () => {},
  };
  const actions = createTurnActions({ row: dmRow, platform, requireActive: () => {}, stageReply: () => {} });
  assert.equal(actions.source.kind, 'dm');

  const page = await actions.source.listMessages({ limit: 20, cursor: 'opaque-cursor' });
  assert.deepEqual(page, { items: [dmItem], hasMore: false, nextCursor: null });
  // 身份与 scope 由平台按事件来源固定：私聊必须走当前用户的 messages:read-private。
  assert.equal(seen.length, 1);
  assert.equal(seen[0].capability.scope, 'messages:read-private');
  assert.equal(seen[0].capability.identity, 'user');
  assert.deepEqual(seen[0].input, { limit: 20, cursor: 'opaque-cursor' });

  for (const legacy of [{ beforeId: 'a'.repeat(36) }, { afterId: 'a'.repeat(36) }]) {
    await assert.rejects(
      () => actions.source.listMessages(legacy),
      error => error.code === 'INVALID_READ_OPTIONS',
      `${Object.keys(legacy)[0]} 已被 0.28.1 删除，必须被 SDK 拒绝`
    );
  }
});
