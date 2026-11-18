/** shared: declarations for the matching SDK reference book. */
import type { MessageContent } from './business.js';
/** Local diagnostic state; ready is not an online authorization proof. */
export type InstallationStatus = 'pending' | 'ready_pending' | 'ready' | 'reconnect_required' | 'revoking' | 'revoked';
export type { PageScope, BackgroundScope, InstallationPermission } from './permissions.js';
export interface PageIdentity {
    readonly sessionId: string;
    readonly authorizationVersion: number;
    readonly userId: string;
    readonly installationId: string;
    readonly pageSessionId: string;
    readonly displayName?: string | null;
    readonly username?: string | null;
    readonly source: Readonly<Record<string, unknown>>;
    readonly content?: Readonly<MessageContent>;
    readonly viewData?: Readonly<Record<string, unknown>>;
    readonly scopes: readonly string[];
    readonly expiresAt: string;
    readonly backgroundGrant?: BackgroundGrant;
}
export interface BackgroundGrant {
    readonly grantId: string;
    readonly installationId: string;
    readonly userId: string;
    readonly projectId: string | null;
    readonly scopes: readonly string[];
    readonly version: number;
    readonly authorizationVersion: number;
    readonly status: 'active' | 'inactive';
}
export interface CapabilityPolicy {
    readOnly?: boolean;
    tools?: string[];
    resources?: Partial<Record<'projectId' | 'channelId' | 'topicId' | 'taskId' | 'fileId' | 'messageId' | 'providerInstallationId' | 'appId', string[]>>;
}
/** Protocol identifier for custom Bridge receivers; normal page clients manage it internally. */
export declare const BridgeProtocol: string;
