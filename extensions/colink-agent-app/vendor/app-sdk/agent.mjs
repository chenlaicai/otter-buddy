import "./src/diagnostics/error-projection.mjs";
export { Permission } from "./src/shared/permissions.mjs";
export { BridgeProtocol } from "./src/shared/manifest-protocol.mjs";
export { AppTag, InstallationScope, ExtensionPoint, NavigationParent, ViewContainer, ViewRenderer, ProtocolVersion, ApiContextVersion } from "./src/shared/manifest-values.mjs";
export { EventType } from "./src/events/event-types.mjs";
import { CoLinkError } from "./src/shared/errors.mjs";
import { createRuntime } from "./src/runtime/runtime.mjs";
export const createCoLinkAgent = options => {
    if (options && 'fetcher' in Object(options))
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { message: 'SDK HTTP transport uses the environment fetch.', hint: 'Remove the fetcher option.' });
    if (options && 'now' in Object(options))
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { message: 'The SDK clock is managed internally.', hint: 'Remove the now option.' });
    if (options && 'store' in Object(options))
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { message: 'SDK state storage is managed internally.', hint: 'Configure stateFile and credentialKey instead of passing store.' });
    if (!options.agent)
        throw Error('Agent adapter is required');
    return createRuntime(options);
};
