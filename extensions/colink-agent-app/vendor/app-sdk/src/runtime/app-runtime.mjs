import { CoLinkError } from "../shared/errors.mjs";
import { createRuntime } from "./runtime.mjs";
import { assertEventHandler } from "../events/event-handler.mjs";
/** Event-driven App without a model or session adapter. */
export function createAppRuntime(options) {
    for (const field of ['tools', 'transformToolResult'])
        if (field in options)
            throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, {
                message: 'Tool configuration is available only on Agents.', hint: 'Use business clients in App handlers; configure tools.transformResult on createCoLinkAgent.',
                details: [{ field, code: 'INVALID_CONFIG_FIELD', message: 'Remove this App option.' }],
            });
    const { config, store, manifest, pages, provider, fetcher, now, log, onEvent } = options;
    if (Object.hasOwn(options, "onMention"))
        throw new CoLinkError("INVALID_APP_CONFIG", 400, undefined, { message: "onMention has been removed.", hint: "Register onEvent(\"app.user_message_received\", handler) and use reply({ text })." });
    // Snapshot and validate all handlers before acquiring any runtime resources.
    const handlers = [];
    if (onEvent !== undefined) {
        if (!onEvent || typeof onEvent !== 'object' || Array.isArray(onEvent) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(onEvent)))
            throw new CoLinkError('HANDLER_REGISTRATION_INVALID', 409);
        for (const type of Reflect.ownKeys(onEvent)) {
            const handler = Reflect.get(onEvent, type);
            assertEventHandler(type, handler);
            handlers.push([type, handler]);
        }
    }
    const runtime = createRuntime({ config, store, manifest, pages, provider, fetcher, now, log });
    for (const [type, handler] of handlers)
        Reflect.apply(runtime.onEvent, runtime, [type, handler]);
    return runtime;
}
