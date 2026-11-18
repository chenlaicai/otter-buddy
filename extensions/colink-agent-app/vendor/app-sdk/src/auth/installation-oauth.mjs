import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CoLinkError } from "../shared/errors.mjs";
import { isRecord, record as dataRecord } from "../shared/data.mjs";
const INSTALL_GRANT = "urn:colink:params:oauth:grant-type:installation";
const RECOVERY_MS = 60_000;
const RECEIPT_LIMIT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const error = (code, status = 503) => new CoLinkError(code, status);
const validToken = (value) => typeof value === "string" && value.length > 0 && value.length <= 16384;
const formValue = (value) => new URLSearchParams([["", value]]).toString().slice(1);
/** Installation credentials stay in the supervisor's encrypted control store. */
export function createInstallationOAuth({ config, store, fetch: fetcher = fetch, now = Date.now }) {
    if (!config || !store || typeof config.clientId !== "string" || !config.clientId ||
        typeof config.clientSecret !== "string" || !config.clientSecret ||
        typeof config.signingSecret !== "string" || !config.signingSecret ||
        typeof store.seal !== "function" || typeof store.unseal !== "function" ||
        typeof store.persist !== "function")
        throw new Error("Invalid installation OAuth configuration");
    const api = new URL(config.apiBase);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname);
    if (!["https:", "http:"].includes(api.protocol) ||
        (api.protocol === "http:" && (!local || config.allowInsecureIssuer !== true)) ||
        api.username || api.password || api.search || api.hash || config.issuer !== api.origin)
        throw new Error("Invalid installation OAuth API origin");
    const base = api.origin;
    const basic = "Basic " + Buffer.from(formValue(config.clientId) + ":" + formValue(config.clientSecret)).toString("base64");
    const lanes = new Map();
    let mutations = Promise.resolve();
    const records = () => store.data.oauthInstallations || {};
    const receipts = () => store.data.oauthControlReceipts || [];
    // Writes to the OAuth portion are serialized. Failed writes are never treated as committed.
    function commit(change) {
        const work = mutations.catch(() => { }).then(async () => {
            const beforeRecords = structuredClone(records());
            const beforeReceipts = structuredClone(receipts());
            try {
                store.data.oauthInstallations ||= {};
                store.data.oauthControlReceipts ||= [];
                const result = change();
                await store.persist();
                return result;
            }
            catch (cause) {
                store.data.oauthInstallations = beforeRecords;
                store.data.oauthControlReceipts = beforeReceipts;
                // The platform retries control delivery only on 429/5xx. A full or
                // read-only control store must never turn a recoverable notification
                // into a permanent 409/dead-letter acknowledgement.
                if (dataRecord(cause).code === "STORAGE_LIMIT" || dataRecord(cause).code === "STORAGE_UNAVAILABLE")
                    throw error("STORAGE_UNAVAILABLE", 503);
                throw cause;
            }
        });
        mutations = work.catch(() => { });
        return work;
    }
    function lane(id, fn) {
        const work = (lanes.get(id) || Promise.resolve()).catch(() => { }).then(fn);
        lanes.set(id, work);
        return work.finally(() => { if (lanes.get(id) === work)
            lanes.delete(id); });
    }
    function record(id) { return records()[id]; }
    function credentialRecord(id) {
        const row = record(id);
        if (!row || typeof row.accessToken !== 'string' || typeof row.expiresAt !== 'number')
            throw error('INSTALLATION_NOT_CONNECTED', 409);
        return Object.assign(row, { accessToken: row.accessToken, expiresAt: row.expiresAt });
    }
    function checkWindow(start) {
        return typeof start === 'number' && Number.isFinite(start) && now() >= start && now() - start < RECOVERY_MS;
    }
    async function needsReconnect(id) {
        await commit(() => { if (record(id))
            record(id).status = "reconnect_required"; });
        throw error("INSTALLATION_RECONNECT_REQUIRED");
    }
    async function readBody(response) {
        if (!response.body)
            throw error("OAUTH_RESPONSE_INVALID");
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done)
                    break;
                bytes += part.value.length;
                if (bytes > 65536)
                    throw error("OAUTH_RESPONSE_INVALID");
                chunks.push(part.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
        catch {
            throw error("OAUTH_RESPONSE_INVALID");
        }
    }
    async function request(path, parameters, extraHeaders = {}) {
        let response;
        try {
            response = await fetcher(base + path, {
                method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
                headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded", ...extraHeaders },
                body: new URLSearchParams(parameters).toString(),
            });
        }
        catch {
            throw error("OAUTH_UNAVAILABLE");
        }
        const result = await readBody(response);
        if (!response.ok) {
            const code = typeof dataRecord(result).error === "string" && /^[a-z_]{1,64}$/.test(String(dataRecord(result).error)) ? dataRecord(result).error : "oauth_error";
            throw Object.assign(error("OAUTH_REQUEST_FAILED"), { oauthError: code, oauthStatus: response.status });
        }
        return result;
    }
    function credentials(response, id, version) {
        if (!isRecord(response) ||
            !validToken(response.access_token) || !validToken(response.refresh_token) || response.token_type !== "Bearer" ||
            typeof response.expires_in !== 'number' || !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0 ||
            response.expires_in > 3600 || response.expires_in > Math.floor((Number.MAX_SAFE_INTEGER - now()) / 1000) ||
            typeof response.scope !== "string" || response.scope.length > 4096 ||
            response.installation_id !== id || response.authorization_version !== version)
            throw error("OAUTH_RESPONSE_INVALID");
        return { accessToken: store.seal(response.access_token), refreshToken: store.seal(response.refresh_token),
            expiresAt: now() + response.expires_in * 1000, scope: response.scope };
    }
    async function refreshLocked(id) {
        let current = record(id);
        if (!current || !["ready", "ready_pending"].includes(current.status) || !current.refreshToken)
            throw error("INSTALLATION_NOT_CONNECTED", 409);
        if (current.refreshPending && !checkWindow(current.refreshPending.startedAt))
            return needsReconnect(id);
        if (!current.refreshPending) {
            await commit(() => { record(id).refreshPending = { key: randomUUID(), startedAt: now() }; });
            current = credentialRecord(id);
        }
        const refreshToken = record(id).refreshToken;
        if (typeof refreshToken !== 'string')
            throw error('INSTALLATION_NOT_CONNECTED', 409);
        const oldRefresh = store.unseal(refreshToken);
        const pending = current.refreshPending;
        if (!pending)
            throw error('OAUTH_RESPONSE_INVALID');
        let response;
        try {
            response = await request("/api/v1/oauth/token", { grant_type: "refresh_token", refresh_token: oldRefresh }, { "Idempotency-Key": pending.key });
        }
        catch (cause) {
            if (dataRecord(cause).oauthError === "invalid_grant")
                return needsReconnect(id);
            throw cause;
        }
        const next = credentials(response, id, current.authorizationVersion);
        await commit(() => {
            const currentRecord = record(id);
            if (currentRecord.authorizationVersion !== current.authorizationVersion || currentRecord.refreshPending?.key !== pending.key)
                throw error("INSTALLATION_AUTHORIZATION_CHANGED", 409);
            Object.assign(currentRecord, next);
            delete currentRecord.refreshPending;
        });
        return store.unseal(credentialRecord(id).accessToken);
    }
    async function readyLocked(id) {
        let current = credentialRecord(id);
        if (current.expiresAt <= now() + 30000) {
            await refreshLocked(id);
            current = credentialRecord(id);
        }
        let response;
        try {
            response = await fetcher(base + "/api/v1/extensions/installations/" + encodeURIComponent(id) + "/ready", {
                method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
                headers: { Authorization: "Bearer " + store.unseal(current.accessToken) },
            });
        }
        catch {
            throw error("OAUTH_UNAVAILABLE");
        }
        const result = dataRecord(await readBody(response));
        if (!response.ok) {
            if (result?.error === "invalid_grant" || result?.error === "invalid_token")
                return needsReconnect(id);
            throw error("OAUTH_READY_FAILED");
        }
        if (result?.installationId !== id || result?.authorizationVersion !== current.authorizationVersion || result?.status !== "ready")
            throw error("OAUTH_RESPONSE_INVALID");
        await commit(() => { record(id).status = "ready"; });
    }
    async function handleAuthorization(event) {
        if (!event || event.type !== "installation.authorized" || !UUID.test(event.eventId || "") ||
            !UUID.test(event.installationId || "") || !Number.isSafeInteger(event.authorizationVersion) || event.authorizationVersion < 1)
            throw error("INVALID_EVENT", 400);
        const { installationId: id, authorizationVersion: version, eventId } = event;
        return lane(id, async () => {
            const existingReceipt = receipts().find((item) => item.eventId === eventId);
            if (existingReceipt && (existingReceipt.installationId !== id || existingReceipt.authorizationVersion !== version))
                throw error("IDEMPOTENCY_CONFLICT", 409);
            let current = record(id);
            if (current && current.authorizationVersion >= version && !existingReceipt) {
                await commit(() => {
                    const duplicate = receipts().find((item) => item.eventId === eventId);
                    if (duplicate && (duplicate.installationId !== id || duplicate.authorizationVersion !== version))
                        throw error("IDEMPOTENCY_CONFLICT", 409);
                    if (!duplicate)
                        store.data.oauthControlReceipts.push({ eventId, installationId: id, authorizationVersion: version });
                    if (store.data.oauthControlReceipts.length > RECEIPT_LIMIT)
                        store.data.oauthControlReceipts.shift();
                });
                current = record(id);
            }
            if (current && current.authorizationVersion > version)
                return { status: "stale" };
            if (!current || current.authorizationVersion < version) {
                await commit(() => {
                    const duplicate = receipts().find((item) => item.eventId === eventId);
                    if (duplicate && (duplicate.installationId !== id || duplicate.authorizationVersion !== version))
                        throw error("IDEMPOTENCY_CONFLICT", 409);
                    store.data.oauthInstallations[id] = { authorizationVersion: version, eventId, status: "pending", startedAt: now() };
                    if (!duplicate)
                        store.data.oauthControlReceipts.push({ eventId, installationId: id, authorizationVersion: version });
                    if (store.data.oauthControlReceipts.length > RECEIPT_LIMIT)
                        store.data.oauthControlReceipts.shift();
                });
                current = record(id);
            }
            if (current.status === "ready")
                return { status: "ready" };
            if (current.status === "reconnect_required" || current.status === "revoking" || current.status === "revoked")
                throw error("INSTALLATION_RECONNECT_REQUIRED");
            if (current.status === "pending") {
                if (!checkWindow(current.startedAt))
                    return needsReconnect(id);
                let response;
                try {
                    response = await request("/api/v1/oauth/token", {
                        grant_type: INSTALL_GRANT, installation_id: id, authorization_version: String(version),
                    });
                }
                catch (cause) {
                    if (dataRecord(cause).oauthError === "invalid_grant")
                        return needsReconnect(id);
                    throw cause;
                }
                const next = credentials(response, id, version);
                await commit(() => Object.assign(record(id), next, { status: "ready_pending" }));
            }
            await readyLocked(id);
            return { status: "ready" };
        });
    }
    function verifyEvent(headers, raw) {
        const values = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
        const timestamp = values["x-colink-timestamp"], id = values["x-colink-event-id"], signature = values["x-colink-signature"];
        if (!Buffer.isBuffer(raw) || raw.length > 64 * 1024 || typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) ||
            Math.abs(now() / 1000 - Number(timestamp)) > 300 || typeof id !== "string" || !UUID.test(id) ||
            typeof signature !== "string" || !/^v1=[0-9a-f]{64}$/.test(signature))
            throw error("CHANNEL_SIGNATURE_INVALID", 401);
        const expected = "v1=" + createHmac("sha256", config.signingSecret).update("v1:" + timestamp + ":" + id + ":").update(raw).digest("hex");
        if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
            throw error("CHANNEL_SIGNATURE_INVALID", 401);
        let event;
        try {
            event = JSON.parse(raw.toString("utf8"));
        }
        catch {
            throw error("INVALID_EVENT", 400);
        }
        if (!isRecord(event) || event.eventId !== id)
            throw error("INVALID_EVENT", 400);
        return event;
    }
    async function getAccessToken(id, { forceRefresh = false, rejectedToken } = {}) {
        if (!UUID.test(id || ""))
            throw error("INSTALLATION_NOT_CONNECTED", 409);
        if (rejectedToken !== undefined && !validToken(rejectedToken))
            throw error("INVALID_INPUT", 400);
        return lane(id, async () => {
            const current = record(id);
            if (!current || current.status !== "ready")
                throw error("INSTALLATION_NOT_CONNECTED", 409);
            const credentials = credentialRecord(id);
            const token = store.unseal(credentials.accessToken);
            // Several requests can reject the same stale owner token at once. Once a
            // preceding waiter refreshed it, later waiters reuse the replacement.
            if (!current.refreshPending && credentials.expiresAt > now() + 30000 &&
                (!forceRefresh || (rejectedToken !== undefined && token !== rejectedToken)))
                return token;
            return refreshLocked(id);
        });
    }
    async function revoke(id) {
        if (!UUID.test(id || ""))
            throw error("INSTALLATION_NOT_CONNECTED", 409);
        return lane(id, async () => {
            const current = record(id);
            if (!current || current.status === "revoked")
                return;
            if (!current.refreshToken)
                throw error("INSTALLATION_NOT_CONNECTED", 409);
            await commit(() => { record(id).status = "revoking"; });
            await request("/api/v1/oauth/revoke", { token: store.unseal(current.refreshToken), token_type_hint: "refresh_token" });
            await commit(() => {
                const target = record(id);
                target.status = "revoked";
                delete target.accessToken;
                delete target.refreshToken;
                delete target.refreshPending;
            });
        });
    }
    return { verifyEvent, handleAuthorization, getAccessToken, revoke };
}
