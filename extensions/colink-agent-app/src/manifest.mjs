import { readFileSync } from 'node:fs';
import { AppTag, EventType, ExtensionPoint, InstallationScope, NavigationParent, Permission, ViewContainer, ViewRenderer } from '../vendor/app-sdk/index.mjs';

const icon = readFileSync(new URL('../assets/otter-icon.svg', import.meta.url), 'utf8');

// Why: 清单里的协议字段一律用 SDK 常量，升级 SDK 时类型/值漂移在测试里就能暴露，
// 不靠手抄字符串（0.28 的扩展点、事件名、权限都在这份常量表里）。
export function createManifest() {
  return {
    manifestVersion: '2.0.0',
    name: '海獭',
    description: '由 Otter Buddy 执行的个人私聊与项目频道 Agent，可在授权范围内读取话题、频道和私聊历史。',
    version: '0.6.0',
    tag: AppTag.Agent,
    agent: {},
    icons: { otter: `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}` },
    iconId: 'otter',
    supportedInstallationScopes: [InstallationScope.Personal, InstallationScope.Project],
    permissions: [Permission.MessagesReceive, Permission.MessagesWrite, Permission.MessagesReadPublic, Permission.MessagesReadPrivate],
    events: { path: '/events', schemaVersion: '2.0.0', types: [EventType.UserMessageReceived] },
    ui: {
      contractVersion: '1.0.0',
      entries: [
        {
          entryId: 'otter.home',
          label: '打开海獭面板',
          extensionPoint: { id: ExtensionPoint.AppHome, version: '1.0.0' },
          openView: { viewId: 'otter.embed', container: ViewContainer.SidePanel },
        },
        {
          entryId: 'otter.project',
          label: '海獭',
          extensionPoint: { id: ExtensionPoint.NavigationModules, version: '1.0.0' },
          navigation: { parentId: NavigationParent.Project },
          openView: { viewId: 'otter.embed', container: ViewContainer.PageContent },
        },
        {
          entryId: 'otter.dm',
          label: '海獭',
          extensionPoint: { id: ExtensionPoint.DmActions, version: '1.0.0' },
          openView: { viewId: 'otter.embed', container: ViewContainer.SidePanel },
        },
      ],
      views: [
        { viewId: 'otter.embed', renderer: ViewRenderer.App, entryPath: '/embed.html', bridgeVersion: '1.0.0' },
      ],
    },
  };
}
