const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(value);
/** Tolerant reader; writers must reject undefined when the field was supplied. Never parse names on failure. */
export function parseMessageMentions(value) {
    if (!object(value) || !keys(value, ['version', 'items']) || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 100)
        return;
    const items = [];
    for (const item of value.items) {
        if (!object(item) || !keys(item, ['start', 'end', 'label', 'target']) || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
            || Number(item.start) < (items.at(-1)?.end ?? 0) || Number(item.end) <= Number(item.start)
            || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 255 || /[\r\n\u0000-\u001f]/.test(item.label) || !object(item.target))
            return;
        const target = item.target;
        if (target.type === 'user' && keys(target, ['type', 'userId']) && id(target.userId)) {
            items.push({ start: Number(item.start), end: Number(item.end), label: item.label, target: { type: 'user', userId: target.userId } });
        }
        else if (target.type === 'app' && keys(target, ['type', 'installationId']) && id(target.installationId)) {
            items.push({ start: Number(item.start), end: Number(item.end), label: item.label, target: { type: 'app', installationId: target.installationId } });
        }
        else
            return;
    }
    return { version: 1, items };
}
