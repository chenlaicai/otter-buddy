import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(manifest.version, '0.3.3');
  assert.deepEqual(manifest.permissions, ['messages:receive', 'messages:write', 'messages:read-public', 'messages:read-private']);
});

function turnFixture(input, replies, userId = 'owner') {
  return {
    input: { text: '你好', ...input },
    context: { userId, installationId: 'installation' },
    signal: new AbortController().signal,
    reply: async value => replies.push(value),
  };
}

test('mention handler routes DM and channel to their respective Otter mappings', async () => {
  const calls = [];
  const replies = [];
  const bridge = { reply: async input => { calls.push(input); return '回答'; } };
  const handler = createMentionHandler({ bridge, deploymentId: 'deployment' });
  await handler(turnFixture({ reason: 'dm_message', conversationId: 'same-id' }, replies, 'teammate-dm'));
  await handler(turnFixture({ reason: 'mention', channelId: 'same-id' }, replies, 'teammate'));
  assert.equal(calls[0].kind, 'dm');
  assert.equal(calls[1].kind, 'channel');
  assert.equal(calls[0].conversationId, 'same-id');
  assert.equal(calls[1].conversationId, 'same-id');
  assert.equal(calls[1].actorId, 'teammate');
  assert.equal(calls[0].turn.input.reason, 'dm_message');
  assert.equal(calls[1].turn.input.reason, 'mention');
  assert.deepEqual(replies, [{ text: '回答' }, { text: '回答' }]);
});

test('mention handler allows personal DM without a user allowlist and rejects unsupported events', async () => {
  let executions = 0;
  const replies = [];
  const bridge = { reply: async () => { executions++; return '同事回答'; } };
  const handler = createMentionHandler({ bridge, deploymentId: 'deployment' });
  await handler(turnFixture({ reason: 'dm_message', conversationId: 'dm' }, replies, 'colleague-not-in-old-allowlist'));
  await assert.rejects(handler(turnFixture({ reason: 'mention', channelId: null }, [])), /ONLY_DM_AND_CHANNEL_TEXT_SUPPORTED/);
  assert.equal(executions, 1);
  assert.deepEqual(replies, [{ text: '同事回答' }]);
});
