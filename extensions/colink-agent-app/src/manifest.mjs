import { readFileSync } from 'node:fs';

const icon = readFileSync(new URL('../assets/otter-icon.svg', import.meta.url), 'utf8');

export function createManifest() {
  return {
    manifestVersion: '2.0.0',
    name: '海獭',
    description: '由 Otter Buddy 执行的个人私聊与项目频道 Agent，可在授权范围内读取话题、频道和私聊历史。',
    version: '0.5.1',
    tag: 'Agent',
    agent: {},
    icons: { otter: `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}` },
    iconId: 'otter',
    supportedInstallationScopes: ['personal', 'project'],
    permissions: ['messages:receive', 'messages:write', 'messages:read-public', 'messages:read-private'],
    events: { path: '/events', schemaVersion: '2.0.0', types: ['app.mentioned'] },
    ui: {
      contractVersion: '1.0.0',
      entries: [
        {
          entryId: 'otter.home',
          label: '打开海獭面板',
          extensionPoint: { id: 'colink.app.home', version: '1.0.0' },
          openView: { viewId: 'otter.embed', container: 'side_panel' },
        },
        {
          entryId: 'otter.project',
          label: '海獭',
          extensionPoint: { id: 'colink.navigation.modules', version: '1.0.0' },
          navigation: { parentId: 'nav.project' },
          openView: { viewId: 'otter.embed', container: 'page_content' },
        },
        {
          entryId: 'otter.topic',
          label: '海獭',
          extensionPoint: { id: 'colink.topic.actions', version: '1.0.0' },
          openView: { viewId: 'otter.embed', container: 'side_panel' },
        },
      ],
      views: [
        { viewId: 'otter.embed', renderer: 'app', entryPath: '/embed.html', bridgeVersion: '1.0.0' },
      ],
    },
  };
}
