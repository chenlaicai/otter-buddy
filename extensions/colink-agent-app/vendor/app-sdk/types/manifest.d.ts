import type { Permission } from './permissions.js';
import type { AppTag, InstallationScope, ViewContainer, NavigationParent, ViewRenderer, ProtocolVersion, ExtensionPoint, ApiContextVersion } from './manifest-values.js';
interface ApiDeclaration {
    basePath: string;
    openapiPath: string;
    receiptPath?: string;
    replyContext?: boolean;
    contextVersion?: ApiContextVersion;
}
type PublicInstallationScope = InstallationScope;
type ExtensionPointId = ExtensionPoint;
interface AppEntry {
    entryId: string;
    extensionPoint: {
        id: ExtensionPointId;
        version: typeof ProtocolVersion.ExtensionPointV1_0_0;
    };
    label: string;
    iconId?: string;
    navigation?: {
        parentId: NavigationParent;
        hidePageHeader?: boolean;
    };
    openView?: {
        viewId: string;
        container: ViewContainer;
    };
}
interface AppView {
    viewId: string;
    renderer: ViewRenderer;
    entryPath: string;
    bridgeVersion: typeof ProtocolVersion.BridgeV1_0_0;
}
interface ManifestShape {
    api?: ApiDeclaration;
    icons?: Record<string, string>;
    manifestVersion: typeof ProtocolVersion.ManifestV2_0_0;
    name: string;
    iconId?: string;
    description: string;
    tag: AppTag;
    version: string;
    supportedInstallationScopes: PublicInstallationScope[];
    permissions: readonly Permission[];
    events: {
        path: string;
        types: ('app.user_message_received' | 'app.collaboration_message_received' | 'app.colink_ui_action_invoked' | 'app.message_processing_cancelled' | 'task.execution_requested' | 'task.execution_cancelled')[];
        schemaVersion: typeof ProtocolVersion.EventsV2_0_0;
    };
    agent?: Record<string, never>;
    ui?: {
        contractVersion: typeof ProtocolVersion.UiV1_0_0;
        entries: AppEntry[];
        views: AppView[];
    };
}
type ManifestReadonly<T> = T extends object ? {
    readonly [K in keyof T]: ManifestReadonly<T[K]>;
} : T;
/** Complete wire declaration, retained for producer conformance checks. */
export type WireAppManifest = ManifestReadonly<ManifestShape>;
type ManagedPath = "manifestVersion" | "events.schemaVersion" | "ui.contractVersion" | "ui.entries.*.extensionPoint.version" | "ui.views.*.bridgeVersion" | "api.contextVersion";
type ManifestInput<T, Paths extends string> = T extends (infer Item)[] ? ManifestInput<Item, Paths extends `*.${infer Rest}` ? Rest : never>[] : T extends object ? {
    [K in keyof T as K extends Paths ? never : K]: ManifestInput<T[K], Paths extends `${K & string}.${infer Rest}` ? Rest : never>;
} & {
    [K in keyof T as K extends Paths ? K : never]?: T[K];
} : T;
/** Business declaration. The SDK fills protocol fields before serving /manifest.json. */
export type AppManifest = ManifestReadonly<ManifestInput<ManifestShape, ManagedPath>>;
export {};
