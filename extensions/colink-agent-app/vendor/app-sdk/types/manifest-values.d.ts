export declare const AppTag: {
    readonly App: "App";
    readonly Agent: "Agent";
};
export type AppTag = (typeof AppTag)[keyof typeof AppTag];
export declare const InstallationScope: {
    readonly Personal: "personal";
    readonly Project: "project";
};
export type InstallationScope = (typeof InstallationScope)[keyof typeof InstallationScope];
export declare const ViewContainer: {
    readonly PageContent: "page_content";
    readonly SidePanel: "side_panel";
    readonly ModalDialog: "modal_dialog";
    readonly EmbeddedCard: "embedded_card";
    readonly EmojiPanel: "emoji_panel";
};
export type ViewContainer = (typeof ViewContainer)[keyof typeof ViewContainer];
export declare const NavigationParent: {
    readonly Primary: "nav.primary";
    readonly Home: "nav.home";
    readonly Project: "nav.project";
};
export type NavigationParent = (typeof NavigationParent)[keyof typeof NavigationParent];
export declare const ViewRenderer: {
    readonly App: "app";
};
export type ViewRenderer = (typeof ViewRenderer)[keyof typeof ViewRenderer];
export declare const ProtocolVersion: {
    readonly ManifestV2_0_0: "2.0.0";
    readonly EventsV2_0_0: "2.0.0";
    readonly UiV1_0_0: "1.0.0";
    readonly ExtensionPointV1_0_0: "1.0.0";
    readonly BridgeV1_0_0: "1.0.0";
};
export type ProtocolVersion = (typeof ProtocolVersion)[keyof typeof ProtocolVersion];
export declare const ExtensionPoint: {
    readonly AppHome: "colink.app.home";
    readonly NavigationModules: "colink.navigation.modules";
    readonly MessageActions: "colink.message.actions";
    readonly DmActions: "colink.dm.actions";
    readonly TopicActions: "colink.topic.actions";
    readonly TaskActions: "colink.task.actions";
    readonly ProjectSpaceCards: "colink.project.space.cards";
    readonly MarketProviders: "colink.market.providers";
    readonly EmojiTabs: "colink.emoji.tabs";
};
export type ExtensionPoint = (typeof ExtensionPoint)[keyof typeof ExtensionPoint];
export declare const ApiContextVersion: {
    readonly V1: 1;
    readonly V2: 2;
};
export type ApiContextVersion = (typeof ApiContextVersion)[keyof typeof ApiContextVersion];
