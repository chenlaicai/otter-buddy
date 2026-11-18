/** Public agent entry. Declaration organization does not add runtime subpaths. */
export { Permission } from '../permissions.js';
export { BridgeProtocol } from '../shared.js';
export { AppTag, InstallationScope, ExtensionPoint, NavigationParent, ViewContainer, ViewRenderer, ProtocolVersion, ApiContextVersion } from '../manifest-values.js';
export type { AppManifest } from '../manifest.js';
export { EventType } from '../events.js';
export type { PageScope, BackgroundScope, InstallationPermission } from '../shared.js';
export type { ToolDescription } from '../agent.js';
export type { ToolResultTransformer } from '../agent.js';
export type { AgentToolOptions } from '../agent.js';
export type { AgentConfig } from '../agent.js';
export type { AgentRuntime } from '../agent.js';
export type { LocalMcpConnection } from '../agent.js';
export type { AgentTurn } from '../agent.js';
export type { AgentMcpOptions } from '../agent.js';
export type { AgentSteerTurn } from '../agent.js';
export type { AgentAdapter } from '../agent.js';
export { createCoLinkAgent } from '../agent.js';
