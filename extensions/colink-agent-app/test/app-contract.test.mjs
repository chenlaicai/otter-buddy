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
  assert.equal(manifest.version, '0.6.0');
  assert.deepEqual(manifest.permissions, ['messages:receive', 'messages:write', 'messages:read-public', 'messages:read-private']);
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

/** vendor/ 入库（由 prepare:sdk 生成），CI 直接核对 pin 与实物版本一致。 */
test('vendored SDK matches the pinned version and the manifest constants are not stale', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const pinPath = new URL('../sdk-pin.json', import.meta.url);
  const vendorPackage = new URL('../vendor/app-sdk/package.json', import.meta.url);
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  assert.equal(pin.package, '@colink/app-sdk');
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  if (!existsSync(vendorPackage)) return;
  const vendored = JSON.parse(readFileSync(vendorPackage, 'utf8'));
  assert.equal(vendored.version, pin.version);
});
