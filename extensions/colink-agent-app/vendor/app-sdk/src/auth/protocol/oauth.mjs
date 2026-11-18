// Shared CoLink installation and page OAuth primitives. The caller owns all
// durable state, recovery windows, and authorization decisions.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_OAUTH_CODES = new Set(['invalid_request', 'invalid_grant', 'invalid_scope', 'unsupported_grant_type', 'invalid_client', 'invalid_token', 'insufficient_scope']);
const SAFE_SESSION_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'ACCESS_DENIED', 'EXTENSION_UI_REQUEST_CLAIM_LOST']);
const MAX_RESPONSE_BYTES = 65536;
export class OAuthError extends Error {
    code;
    status;
    outcome;
    /** @param {string} code @param {number} [status] @param {'rejected'|'unknown'|'not_sent'} [outcome] */
    constructor(code, status = 0, outcome = 'rejected') {
        super(code);
        this.name = 'OAuthError';
        this.code = code;
        this.status = status;
        this.outcome = outcome;
    }
}
// Local preflight failures have not reached the platform and must not erase a
// persisted refresh credential as if the platform had rejected it.
/** @param {string} code @returns {never} */
function reject(code) { throw new OAuthError(code, 0, code === 'invalid_configuration' ? 'not_sent' : 'rejected'); }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} [max] @returns {value is string} */
const isString = (value, max = 16384) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);
/** @param {unknown} value @returns {value is number} */
const isVersion = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
// JSON.parse silently accepts repeated keys, which would allow signed JSON to
// be interpreted differently by other participants. Scan before parsing.
/** @param {string} text @returns {unknown} */
function parseUniqueJson(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
        throw Error('invalid_json');
    let pos = 0;
    const ws = () => { while (/[\x20\t\r\n]/.test(text[pos] || ''))
        pos++; };
    /** @returns {string} */
    function string() {
        if (text[pos] !== '"')
            throw Error('invalid_json');
        const start = pos++;
        while (pos < text.length) {
            const c = text[pos++];
            if (c === '"')
                return JSON.parse(text.slice(start, pos));
            if (c === '\\') {
                if (pos >= text.length)
                    throw Error('invalid_json');
                pos++;
            }
        }
        throw Error('invalid_json');
    }
    /** @param {number} depth @returns {void} */
    function value(depth) {
        if (depth > 32)
            throw Error('invalid_json');
        ws();
        if (text[pos] === '"') {
            string();
            return;
        }
        if (text[pos] === '{') {
            pos++;
            ws();
            const keys = new Set();
            if (text[pos] === '}') {
                pos++;
                return;
            }
            while (pos < text.length) {
                ws();
                const key = string();
                if (keys.has(key))
                    throw Error('duplicate_key');
                keys.add(key);
                ws();
                if (text[pos++] !== ':')
                    throw Error('invalid_json');
                value(depth + 1);
                ws();
                if (text[pos] === '}') {
                    pos++;
                    return;
                }
                if (text[pos++] !== ',')
                    throw Error('invalid_json');
            }
            throw Error('invalid_json');
        }
        if (text[pos] === '[') {
            pos++;
            ws();
            if (text[pos] === ']') {
                pos++;
                return;
            }
            while (pos < text.length) {
                value(depth + 1);
                ws();
                if (text[pos] === ']') {
                    pos++;
                    return;
                }
                if (text[pos++] !== ',')
                    throw Error('invalid_json');
            }
            throw Error('invalid_json');
        }
        const match = text.slice(pos).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);
        if (!match)
            throw Error('invalid_json');
        pos += match[0].length;
    }
    value(0);
    ws();
    if (pos !== text.length)
        throw Error('invalid_json');
    return JSON.parse(text);
}
/** @param {unknown} headers @param {string} name @returns {string | undefined} */
function header(headers, name) {
    if (isObject(headers) && typeof headers.get === 'function') {
        const value = Reflect.apply(headers.get, headers, [name]);
        return typeof value === 'string' ? value : undefined;
    }
    if (!headers || typeof headers !== 'object')
        return undefined;
    const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name).map(([, v]) => v);
    return values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined;
}
/** @param {unknown} a @param {unknown} b */
function equal(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
/** @param {unknown} value @returns {Buffer} */
function b64decode(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
        throw Error('invalid_base64url');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value)
        throw Error('invalid_base64url');
    return bytes;
}
/** @param {string} value @returns {string} */
function baseUrl(value) {
    try {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
        if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback) || url.username || url.password || url.search || url.hash)
            throw Error('url');
        return url.href.replace(/\/$/, '');
    }
    catch {
        reject('invalid_configuration');
    }
}
/** @param {unknown} accessToken */
function requireBearer(accessToken) {
    if (!isString(accessToken))
        reject('invalid_configuration');
    return 'Bearer ' + accessToken;
}
/** @param {string} clientId @param {string} clientSecret */
function basic(clientId, clientSecret) {
    if (!isString(clientId, 1024) || !isString(clientSecret, 4096))
        reject('invalid_configuration');
    /** @param {string} value */
    const encode = (value) => new URLSearchParams([['v', value]]).toString().slice(2);
    return 'Basic ' + Buffer.from(encode(clientId) + ':' + encode(clientSecret)).toString('base64');
}
/** Verify the exact raw bytes before parsing an installation control event. */
/** @param {{ rawBody: Uint8Array; headers: unknown; signingSecret: string; nowMs?: number }} options */
export function verifyControlEvent({ rawBody, headers, signingSecret, nowMs = Date.now() }) {
    if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array))
        reject('invalid_event');
    const bytes = Buffer.from(rawBody);
    if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES || !isString(signingSecret, 4096) || !Number.isFinite(nowMs))
        reject('invalid_event');
    const timestamp = header(headers, 'x-colink-timestamp'), id = header(headers, 'x-colink-event-id'), signature = header(headers, 'x-colink-signature');
    if (!/^\d{10}$/.test(timestamp || '') || Math.abs(nowMs / 1000 - Number(timestamp)) > 300 || !UUID.test(id || '') || !/^v1=[0-9a-f]{64}$/.test(signature || ''))
        reject('invalid_signature');
    const expected = 'v1=' + createHmac('sha256', signingSecret).update('v1:' + timestamp + ':' + id + ':').update(bytes).digest('hex');
    if (!equal(signature, expected))
        reject('invalid_signature');
    let event;
    try {
        event = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        reject('invalid_event');
    }
    if (!isObject(event) || Object.keys(event).sort().join(',') !== 'authorizationVersion,eventId,installationId,type' || event.type !== 'installation.authorized' || event.eventId !== id || !isString(event.installationId) || !UUID.test(event.installationId) || !isVersion(event.authorizationVersion))
        reject('invalid_event');
    return event;
}
/** @param {TransportOptions & { route: string; method?: string; headers?: Record<string,string>; body?: string }} options @returns {Promise<Record<string,unknown>>} */
async function requestJson({ apiBase, route, method = 'POST', headers = {}, body, fetcher = fetch, timeoutMs = 4000 }) {
    if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
        reject('invalid_configuration');
    const controller = new AbortController(); /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
        const pending = Promise.resolve().then(async () => {
            const response = await fetcher(baseUrl(apiBase) + route, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: controller.signal });
            if (!response || !Number.isInteger(response.status) || !response.body || typeof response.body.getReader !== 'function')
                throw new OAuthError('invalid_response', 0, 'unknown');
            // Bound bytes while reading, before concatenating or decoding. Abort the
            // transport and cancel the reader as soon as a response exceeds the cap.
            const reader = response.body.getReader(), chunks = [];
            let total = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (!(value instanceof Uint8Array))
                        throw new OAuthError('invalid_response', response.status, 'unknown');
                    total += value.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        controller.abort();
                        void reader.cancel().catch(() => { });
                        throw new OAuthError('invalid_response', response.status, 'unknown');
                    }
                    chunks.push(Buffer.from(value));
                }
            }
            finally {
                reader.releaseLock();
            }
            let data;
            try {
                data = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
            }
            catch {
                throw new OAuthError('invalid_response', response.status, 'unknown');
            }
            if (response.status < 200 || response.status >= 300) {
                const oauthCode = isObject(data) && typeof data.error === 'string' && SAFE_OAUTH_CODES.has(data.error) ? data.error : undefined;
                const sessionCode = isObject(data) && typeof data.code === 'string' && SAFE_SESSION_CODES.has(data.code) ? data.code : undefined;
                const code = oauthCode || sessionCode || 'http_error';
                const rejected = [400, 401, 403, 409].includes(response.status) && Boolean(oauthCode || sessionCode);
                throw new OAuthError(code, response.status, rejected ? 'rejected' : 'unknown');
            }
            if (!isObject(data))
                throw new OAuthError('invalid_response', response.status, 'unknown');
            return data;
        });
        return await Promise.race([pending, /** @type {Promise<never>} */ new Promise((_, fail) => { timer = setTimeout(() => { controller.abort(); fail(new OAuthError('network_error', 0, 'unknown')); }, timeoutMs); })]);
    }
    catch (error) {
        if (error instanceof OAuthError)
            throw error;
        throw new OAuthError('network_error', 0, 'unknown');
    }
    finally {
        clearTimeout(timer);
    }
}
/** @param {unknown} result @param {string} [installationId] @param {number} [authorizationVersion] @returns {TokenResult} */
function tokenResult(result, installationId, authorizationVersion) {
    if (!isObject(result) || result.token_type !== 'Bearer' || !isString(result.access_token) || !isString(result.refresh_token) || !isVersion(result.expires_in) || typeof result.scope !== 'string' || result.scope.length > 4096 || !isString(result.installation_id) || !UUID.test(result.installation_id) || !isVersion(result.authorization_version) || (installationId !== undefined && result.installation_id !== installationId) || (authorizationVersion !== undefined && result.authorization_version !== authorizationVersion))
        throw new OAuthError('invalid_response', 200, 'unknown');
    return { ...result, token_type: 'Bearer', access_token: result.access_token, refresh_token: result.refresh_token, expires_in: result.expires_in, scope: result.scope, installation_id: result.installation_id, authorization_version: result.authorization_version };
}
/** @param {ClientOptions & { fields: Record<string,string>; idempotencyKey?: string }} options */
async function tokenRequest({ apiBase, clientId, clientSecret, fields, idempotencyKey, fetcher, timeoutMs }) {
    if (idempotencyKey !== undefined && (!isString(idempotencyKey, 128) || idempotencyKey.length < 16))
        reject('invalid_configuration');
    return requestJson({ apiBase, route: '/oauth/token', headers: { Authorization: basic(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: new URLSearchParams(fields).toString(), fetcher, timeoutMs });
}
/** @param {ClientOptions & { installationId: string; authorizationVersion: number }} options */
export async function exchangeInstallation({ apiBase, clientId, clientSecret, installationId, authorizationVersion, fetcher, timeoutMs }) {
    if (!UUID.test(installationId || '') || !isVersion(authorizationVersion))
        reject('invalid_configuration');
    const result = await tokenRequest({ apiBase, clientId, clientSecret, fetcher, timeoutMs, fields: { grant_type: 'urn:colink:params:oauth:grant-type:installation', installation_id: installationId, authorization_version: String(authorizationVersion) } });
    return tokenResult(result, installationId, authorizationVersion);
}
/** @param {ClientOptions & { refreshToken: string; idempotencyKey: string; installationId?: string; authorizationVersion?: number }} options */
export async function refreshInstallation({ apiBase, clientId, clientSecret, refreshToken, idempotencyKey, installationId, authorizationVersion, fetcher, timeoutMs }) {
    if (!isString(refreshToken) || !isString(idempotencyKey, 128) || idempotencyKey.length < 16 || (installationId !== undefined && !UUID.test(installationId)) || (authorizationVersion !== undefined && !isVersion(authorizationVersion)))
        reject('invalid_configuration');
    const result = await tokenRequest({ apiBase, clientId, clientSecret, fetcher, timeoutMs, idempotencyKey, fields: { grant_type: 'refresh_token', refresh_token: refreshToken } });
    return tokenResult(result, installationId, authorizationVersion);
}
/** @param {TransportOptions & { installationId: string; authorizationVersion: number; accessToken: string }} options */
export async function confirmReady({ apiBase, installationId, authorizationVersion, accessToken, fetcher, timeoutMs }) {
    if (!UUID.test(installationId || '') || !isVersion(authorizationVersion))
        reject('invalid_configuration');
    const result = await requestJson({ apiBase, route: '/extensions/installations/' + encodeURIComponent(installationId) + '/ready', headers: { Authorization: requireBearer(accessToken) }, fetcher, timeoutMs });
    if (result.installationId !== installationId || result.authorizationVersion !== authorizationVersion || result.status !== 'ready')
        throw new OAuthError('invalid_response', 200, 'unknown');
    return result;
}
/** Verify using trusted issuer/client configuration and keys from trusted JWKS only. */
/** @param {{ token: string; jwks: unknown; issuer: string; clientId: string; expectedNonce: string; accessToken: string; nowMs?: number }} options */
export function verifyIdToken({ token, jwks, issuer, clientId, expectedNonce, accessToken, nowMs = Date.now() }) {
    try {
        if (!isString(token) || !isString(issuer, 2048) || !isString(clientId, 1024) || !isString(expectedNonce, 128) || !isString(accessToken) || !Number.isFinite(nowMs))
            throw Error('input');
        const parts = token.split('.');
        if (parts.length !== 3)
            throw Error('jwt');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const head = parseUniqueJson(decoder.decode(b64decode(parts[0]))), claims = parseUniqueJson(decoder.decode(b64decode(parts[1])));
        if (!isObject(head) || head.alg !== 'RS256' || !isString(head.kid, 128) || 'crit' in head || 'jku' in head || 'x5u' in head || !isObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 20)
            throw Error('header');
        const keys = jwks.keys.filter(key => isObject(key) && key.kid === head.kid && key.kty === 'RSA' && (key.alg === undefined || key.alg === 'RS256') && (key.use === undefined || key.use === 'sig') && (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))));
        if (keys.length !== 1 || !b64decode(keys[0].n).length || !b64decode(keys[0].e).length)
            throw Error('key');
        const key = createPublicKey({ key: { ...keys[0], kty: 'RSA', n: String(keys[0].n), e: String(keys[0].e) }, format: 'jwk' }), bits = key.asymmetricKeyDetails?.modulusLength;
        if (key.asymmetricKeyType !== 'rsa' || typeof bits !== 'number' || !Number.isInteger(bits) || bits < 2048 || bits > 8192 || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64decode(parts[2])))
            throw Error('signature');
        const now = nowMs / 1000, atHash = createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url');
        if (!isObject(claims) || claims.iss !== issuer || claims.aud !== clientId || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now + 310 || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat < now - 310 || claims.iat > now + 30 || claims.iat > claims.exp || !equal(claims.nonce, expectedNonce) || !equal(claims.at_hash, atHash) || !isString(claims.sub, 36) || !isString(claims.installation_id) || !UUID.test(claims.installation_id) || !isVersion(claims.authorization_version))
            throw Error('claims');
        return claims;
    }
    catch {
        throw new OAuthError('invalid_identity', 0, 'rejected');
    }
}
/** @param {ClientOptions & { issuer: string; code: string; codeVerifier: string; expectedNonce: string; nowMs?: number }} options */
export async function exchangeUserLogin({ apiBase, issuer, clientId, clientSecret, code, codeVerifier, expectedNonce, fetcher, timeoutMs, nowMs }) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier || '') || !/^[A-Za-z0-9_-]{22,128}$/.test(expectedNonce || ''))
        reject('invalid_configuration');
    const result = await tokenRequest({ apiBase, clientId, clientSecret, fetcher, timeoutMs, fields: { grant_type: 'authorization_code', code, code_verifier: codeVerifier } });
    if (result.token_type !== 'Bearer' || !isString(result.access_token) || !isVersion(result.expires_in) || result.expires_in > 3600 || !isString(result.id_token) || typeof result.scope !== 'string' || !['openid', 'profile'].every(scope => String(result.scope).split(' ').includes(scope)))
        throw new OAuthError('invalid_response', 200, 'unknown');
    const jwks = await requestJson({ apiBase, route: '/oauth/jwks', method: 'GET', fetcher, timeoutMs });
    const claims = verifyIdToken({ token: result.id_token, jwks, issuer, clientId, expectedNonce, accessToken: result.access_token, nowMs });
    return { accessToken: result.access_token, refreshToken: result.refresh_token, scope: result.scope, expiresIn: result.expires_in, claims };
}
/** @param {TransportOptions & { accessToken: string; nowMs?: number }} options */
export async function validateUserSession({ apiBase, accessToken, fetcher, timeoutMs, nowMs = Date.now() }) {
    if (!Number.isFinite(nowMs))
        reject('invalid_configuration');
    const result = await requestJson({ apiBase, route: '/extensions/session-validations', headers: { Authorization: requireBearer(accessToken) }, fetcher, timeoutMs });
    if (!isString(result.userId, 128) || !isString(result.installationId, 128) || !isObject(result.source) || !isString(result.expiresAt, 64) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result.expiresAt) || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= nowMs)
        throw new OAuthError('invalid_response', 200, 'unknown');
    return result;
}
/** Encrypt credentials with a separately stored, caller-managed 32-byte key. */
/** @param {{ key: Uint8Array; plaintext: string; aad: string }} options */
export function encryptCredential({ key, plaintext, aad }) {
    if (!(key instanceof Uint8Array) || key.length !== 32 || !isString(plaintext, 65536) || !isString(aad, 1024))
        reject('invalid_configuration');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
/** @param {{ key: Uint8Array; ciphertext: string; aad: string }} options */
export function decryptCredential({ key, ciphertext, aad }) {
    try {
        if (!(key instanceof Uint8Array) || key.length !== 32 || !isString(ciphertext, 65536) || !isString(aad, 1024))
            throw Error('input');
        const parts = ciphertext.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1')
            throw Error('format');
        const iv = b64decode(parts[1]), encrypted = b64decode(parts[2]), tag = b64decode(parts[3]);
        if (iv.length !== 12 || tag.length !== 16)
            throw Error('format');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    }
    catch {
        throw new OAuthError('invalid_ciphertext');
    }
}
