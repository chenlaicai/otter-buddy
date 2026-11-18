import { ProtocolVersion, ApiContextVersion } from "./manifest-values.mjs";
// SDK implementation choices. The platform may support more than this SDK emits.
// The same data is shipped for offline tools; never infer it from the latest Host.
export const MANIFEST_PROTOCOL_DEFAULTS = Object.freeze({
    manifestVersion: ProtocolVersion.ManifestV2_0_0,
    'events.schemaVersion': ProtocolVersion.EventsV2_0_0,
    'ui.contractVersion': ProtocolVersion.UiV1_0_0,
    'ui.entries.*.extensionPoint.version': ProtocolVersion.ExtensionPointV1_0_0,
    'ui.views.*.bridgeVersion': ProtocolVersion.BridgeV1_0_0,
    'api.contextVersion': ApiContextVersion.V2,
});
export const BridgeProtocol = 'colink.ui/' + MANIFEST_PROTOCOL_DEFAULTS['ui.views.*.bridgeVersion'];
