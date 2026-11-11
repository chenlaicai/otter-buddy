import { readFileSync } from 'node:fs';

const icon = readFileSync(new URL('../assets/otter-icon.svg', import.meta.url), 'utf8');

export function createManifest() {
  return {
    manifestVersion: '2.0.0',
    name: '海獭',
    description: '由 Otter Buddy 执行的个人私聊与项目频道 Agent，可在授权范围内读取话题、频道和私聊历史。',
    version: '0.4.0',
    tag: 'Agent',
    agent: {},
    icons: { otter: `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}` },
    iconId: 'otter',
    supportedInstallationScopes: ['personal', 'project'],
    permissions: ['messages:receive', 'messages:write', 'messages:read-public', 'messages:read-private'],
    events: { path: '/events', schemaVersion: '2.0.0', types: ['app.mentioned'] },
  };
}
