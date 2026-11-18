import { invalidRuntimeConfig } from "../shared/config.mjs";
/** Single-process bounded scheduler. Persistence and authorization belong to runtime. */
export function eventQueueOptions(value = {}) {
    const defaults = { concurrency: 1, perInstallation: 1, maxPending: 1000, maxPendingPerInstallation: 100,
        waitTimeoutMs: 1800000, queuedText: false };
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(defaults, k)))
        throw invalidRuntimeConfig('eventQueue', '使用仅含已声明调度字段的对象。');
    const options = { ...defaults, ...value };
    for (const [key, maximum] of [['concurrency', 32], ['perInstallation', 32], ['maxPending', 2000],
        ['maxPendingPerInstallation', 2000], ['waitTimeoutMs', 7200000]])
        if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > maximum)
            throw invalidRuntimeConfig('eventQueue.' + key, '使用 1–' + maximum + ' 范围内的整数。');
    if (options.queuedText !== false && (typeof options.queuedText !== 'string' || !options.queuedText.trim() || options.queuedText.length > 4000))
        throw invalidRuntimeConfig('eventQueue.queuedText', '使用 false 或不超过 4000 字符的非空安全提示文本。');
    return options;
}
export const eventTerminal = (row) => ['done', 'failed', 'interrupted', 'cancelled'].includes(row.status);
// Deliberately independent of user, scopes and authorization epoch: a shared
// topic/workspace remains one lane even when its model Session is reset.
export const eventLane = (row) => ['steering', 'steered'].includes(row.status) ? 'steer:' + row.event.eventId : JSON.stringify([row.event.deploymentId, row.event.installationId,
    (row.event.data.source || row.event.data).channelId, (row.event.data.source || row.event.data).topicId]);
export function selectEvent(rows, running, options, lastInstallation, now) {
    if (running.size >= options.concurrency)
        return;
    const busy = new Set([...running.values()].map(job => eventLane(job.row)));
    const counts = new Map();
    for (const { row } of running.values())
        counts.set(row.event.installationId, (counts.get(row.event.installationId) || 0) + 1);
    const heads = new Map();
    for (const row of rows) {
        if (eventTerminal(row))
            continue;
        if (['steering', 'steered'].includes(row.status)) {
            const parent = rows.find(parent => parent.event.eventId === row.steerParentId);
            if (parent && !eventTerminal(parent))
                continue;
        }
        const lane = eventLane(row);
        if (!heads.has(lane))
            heads.set(lane, row);
    }
    const groups = new Map();
    for (const [lane, row] of heads) {
        const installation = row.event.installationId;
        if (busy.has(lane) || (row.nextAttempt !== undefined && row.nextAttempt > now) || (counts.get(installation) || 0) >= options.perInstallation)
            continue;
        if (!groups.has(installation))
            groups.set(installation, row);
    }
    const installations = [...groups.keys()];
    const after = lastInstallation === undefined ? -1 : installations.indexOf(lastInstallation);
    return groups.get(installations[(after + 1) % installations.length]);
}
