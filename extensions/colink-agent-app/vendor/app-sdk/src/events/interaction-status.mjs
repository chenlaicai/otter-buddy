import { fail } from "../shared/errors.mjs";
import { record } from "../shared/data.mjs";
const HEARTBEAT_MS = 5 * 60_000;
const RECOVERY_MS = 60 * 60_000;
const RETRY_MS = 3000;
/** One owner, one durable latest report per event. A newer sequence supersedes
 * an unknown older report; retries of the same sequence keep the same wire key.
 * Status is advisory: transport/storage failures never fail the business turn.
 */
export function createInteractionStatus({ rows, save, send, now = Date.now, log = () => { } }) {
    const live = new Set(), lanes = new Map();
    const diagnostic = (row, error) => {
        try {
            log({ eventId: row.event.eventId, code: typeof record(error).code === 'string' && /^[A-Z0-9_]+$/.test(String(record(error).code)) ? String(record(error).code) : 'INTERACTION_STATUS_UNAVAILABLE' });
        }
        catch { /* logging is not business */ }
    };
    const commit = (row, value) => save(row, { interactionStatus: value });
    function select(row, status) {
        const previous = row.interactionStatus;
        if (previous?.stopped || previous?.status === 'finished')
            return;
        commit(row, { sequence: (previous?.sequence || 0) + 1, status, createdAt: now(),
            nextAttempt: now(), sent: false });
    }
    function receipt(row) {
        const state = row.interactionStatus;
        const status = !state || state.stopped ? 'unavailable' : state.sent ? 'sent' : 'pending';
        return Object.freeze({ status, ...(state?.error ? { code: state.error } : {}),
            message: status === 'sent' ? '平台已确认本轮状态，不代表业务完成或界面已收到推送。'
                : status === 'pending' ? '状态尚未获得平台确认，SDK 将在有效窗口内重试。' : '本轮状态暂不可上报，业务可继续。',
            hint: status === 'sent' ? '继续处理业务；回调结束由 SDK 收尾。' : '检查 SDK 安全日志及安装权限；不要重跑业务或自行分配状态序号。' });
    }
    function flush(row) {
        if (lanes.has(row))
            return lanes.get(row);
        const result = (async () => {
            for (;;) {
                const report = row.interactionStatus;
                if (!report || report.sent || report.stopped || report.nextAttempt > now())
                    return receipt(row);
                try {
                    if (now() - report.createdAt >= RECOVERY_MS || now() - row.createdAt >= 2 * RECOVERY_MS)
                        throw fail('INTERACTION_STATUS_EXPIRED', 409);
                    await send(row, report);
                    // A suspended/finished transition can be persisted while HTTP is in flight.
                    if (row.interactionStatus?.sequence !== report.sequence)
                        continue;
                    commit(row, { ...report, sent: true, error: undefined });
                }
                catch (error) {
                    diagnostic(row, error);
                    if (row.interactionStatus?.sequence !== report.sequence)
                        continue;
                    const retry = !record(error).status || Number(record(error).status) >= 500 || record(error).status === 429;
                    try {
                        commit(row, { ...report, nextAttempt: now() + RETRY_MS, stopped: !retry,
                            error: typeof record(error).code === 'string' && /^[A-Z0-9_]+$/.test(String(record(error).code)) ? String(record(error).code) : 'INTERACTION_STATUS_UNAVAILABLE' });
                    }
                    catch (storageError) {
                        diagnostic(row, storageError);
                    }
                }
                return receipt(row);
            }
        })().finally(() => lanes.delete(row));
        lanes.set(row, result);
        return result;
    }
    function change(row, status) {
        try {
            if (row.interactionStatus?.status !== status)
                select(row, status);
        }
        catch (error) {
            diagnostic(row, error);
            return Promise.resolve(receipt({}));
        }
        return flush(row);
    }
    return {
        cancel(row) {
            live.delete(row);
            if (row.interactionStatus && !row.interactionStatus.stopped)
                commit(row, { ...row.interactionStatus, stopped: true });
        },
        begin(row) { live.add(row); void change(row, 'processing'); },
        monitor(row) { if (row.interactionStatus && row.interactionStatus.status !== 'finished')
            live.add(row); },
        api(row, active, enabled) {
            return Object.freeze({ async setDisplayStatus(status) {
                    active();
                    if (!['processing', 'suspended'].includes(status))
                        throw fail('INVALID_INTERACTION_STATUS', 400);
                    if (!enabled)
                        return Object.freeze({ status: 'disabled', message: '本应用已关闭 SDK 自动状态管理。', hint: '由应用维护手动 events.reportStatus 生命周期，或启用 interactionStatus。' });
                    const result = await change(row, status);
                    active();
                    return result;
                } });
        },
        async finish(row) {
            live.delete(row);
            if (row.interactionStatus)
                return change(row, 'finished');
        },
        async pulse() {
            await Promise.all(Object.values(rows()).map(async (row) => {
                try {
                    const report = row.interactionStatus;
                    if (!report || report.stopped)
                        return;
                    if ((!live.has(row) || ['done', 'failed', 'interrupted'].includes(row.status)) && report.status !== 'finished') {
                        await this.finish(row);
                        return;
                    }
                    if (live.has(row) && report.status === 'processing' && report.sent && now() - report.createdAt >= HEARTBEAT_MS)
                        select(row, 'processing');
                    await flush(row);
                }
                catch (error) {
                    diagnostic(row, error);
                }
            }));
        },
        async idle() { await Promise.all([...lanes.values()]); },
    };
}
