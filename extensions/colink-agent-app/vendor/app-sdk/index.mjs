import "./src/diagnostics/error-projection.mjs";
import { createAppRuntime } from "./src/runtime/app-runtime.mjs";
import { CoLinkError } from "./src/shared/errors.mjs";
export const createCoLinkRuntime = options => {
    if (options && 'fetcher' in Object(options))
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { message: 'SDK HTTP transport uses the environment fetch.', hint: 'Remove the fetcher option.' });
    if (options && 'now' in Object(options))
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { message: 'The SDK clock is managed internally.', hint: 'Remove the now option.' });
    if (options && 'store' in Object(options))
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { message: 'SDK state storage is managed internally.', hint: 'Configure stateFile and credentialKey instead of passing store.' });
    return createAppRuntime(options);
};
export { CoLinkError };
export { serveCoLinkRuntime } from "./src/runtime/server.mjs";
export { createCoLinkHttpHandler } from "./src/runtime/http-handler.mjs";
export { EventType } from "./src/events/event-types.mjs";
export { Permission } from "./src/shared/permissions.mjs";
export { BridgeProtocol } from "./src/shared/manifest-protocol.mjs";
export { AppTag, InstallationScope, ExtensionPoint, NavigationParent, ViewContainer, ViewRenderer, ProtocolVersion, ApiContextVersion } from "./src/shared/manifest-values.mjs";
