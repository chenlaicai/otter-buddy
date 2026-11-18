import { fail } from "../shared/errors.mjs";
import { userMessageEvent } from "./event-handler.mjs";
// Optional same-principal input steering. It never combines grants or changes
// the running model's identity. Different principals/scopes remain queued.
export function createSteering({ agent, rows, active, controllers, keyFor, contextFor, platform, save, kick }) {
    const lanes = new Map();
    const same = (a, b) => a.version === b.version && keyFor(a) === keyFor(b) &&
        a.event.actor.id === b.event.actor.id && JSON.stringify(a.scopes) === JSON.stringify(b.scopes);
    function offer(row) {
        const steerTurn = agent?.steerTurn?.bind(agent);
        if (!steerTurn || row.dispatch || row.event.type !== 'app.user_message_received')
            return;
        const parent = [...active.values()].find(p => p.status === 'running' && same(p, row));
        if (!parent)
            return;
        const sessionKey = parent.sessionKey, sessionId = parent.sessionId;
        if (!sessionKey || !sessionId)
            throw fail('TURN_INACTIVE', 403);
        let lane = lanes.get(parent);
        if (lane?.closed)
            return;
        if (!lane) {
            lane = { tail: Promise.resolve(), closed: false };
            lanes.set(parent, lane);
        }
        save(row, { status: 'steering', steerParentId: parent.event.eventId, sessionKey: sessionKey, sessionId: sessionId });
        const guard = () => {
            if (active.get(sessionId) !== parent || controllers.get(sessionKey)?.signal.aborted ||
                !['steering', 'steered'].includes(row.status))
                throw fail('TURN_INACTIVE', 403);
        };
        guard.bound = true;
        lane.tail = lane.tail.then(async () => {
            try {
                guard();
                await platform.validate(parent);
                await platform.validate(row);
                guard();
                save(parent, { steerEventIds: [...(parent.steerEventIds || []), row.event.eventId] });
                const signal = controllers.get(sessionKey).signal;
                let onAbort;
                const cancelled = new Promise((_, reject) => { onAbort = () => reject(fail('TURN_INACTIVE', 403)); signal.addEventListener('abort', onAbort, { once: true }); });
                let accepted;
                try {
                    accepted = await Promise.race([cancelled, steerTurn({ key: sessionKey, sessionId: sessionId, eventId: row.event.eventId,
                            event: userMessageEvent(row.event), context: contextFor(row), signal,
                            colink: platform.client(row, guard), async assertActive() {
                                guard();
                                await platform.validate(parent);
                                await platform.validate(row);
                                guard();
                            } })]);
                }
                finally {
                    signal.removeEventListener('abort', onAbort);
                }
                if (accepted === false) {
                    save(parent, { steerEventIds: (parent.steerEventIds || []).filter(id => id !== row.event.eventId) });
                    save(row, { status: 'queued', steerParentId: undefined });
                    return;
                }
                if (accepted !== true)
                    throw fail('STEER_RECEIPT_INVALID', 502);
                guard();
                save(row, { status: 'steered' });
            }
            catch (error) {
                // Unknown native delivery must never be replayed as an ordinary prompt.
                controllers.get(sessionKey)?.abort();
                save(row, { status: 'interrupted', error: 'STEER_DELIVERY_INTERRUPTED' });
            }
        }).catch(() => { controllers.get(sessionKey)?.abort(); }).finally(kick);
    }
    return {
        offer,
        async drain(parent) {
            let lane = lanes.get(parent);
            if (!lane) {
                lane = { tail: Promise.resolve(), closed: true };
                lanes.set(parent, lane);
            }
            lane.closed = true;
            await lane.tail;
        },
        release(parent) { lanes.delete(parent); },
        async settle(row) {
            if (!['steering', 'steered'].includes(row.status))
                return false;
            const parent = row.steerParentId ? rows()[row.steerParentId] : undefined;
            if (row.sessionId && active.get(row.sessionId) === parent)
                return true;
            if (parent && !['done', 'failed', 'interrupted', 'cancelled'].includes(parent.status))
                return true;
            if (row.status === 'steered' && parent?.status === 'done') {
                save(row, { status: 'completion_pending' });
                await platform.complete(row);
                save(row, { status: 'done' });
            }
            else
                save(row, { status: 'interrupted', error: 'STEER_PARENT_INTERRUPTED' });
            return true;
        },
    };
}
