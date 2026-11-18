import { CoLinkError } from "./errors.mjs";
/** HTTP is opt-in and limited to an exact loopback origin for local development. */
export function validateIssuer(issuer, allowInsecureLocal = false) {
    const url = new URL(issuer ?? '');
    const localHttp = allowInsecureLocal === true && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== issuer || (url.protocol !== 'https:' && !localHttp))
        throw Error('COLINK_ISSUER requires HTTPS; local HTTP requires allowInsecureIssuer=true and an exact loopback origin');
}
/** Resolve once per runtime. Explicit configuration never inherits process credentials. */
export function resolveAppConfig(input) {
    let config = input;
    if (input === undefined) {
        const env = process.env;
        const insecure = env.COLINK_ALLOW_INSECURE_ISSUER;
        config = {
            appId: env.COLINK_APP_ID,
            appInstanceId: env.COLINK_APP_INSTANCE_ID,
            clientId: env.COLINK_CLIENT_ID,
            clientSecret: env.COLINK_CLIENT_SECRET,
            signingSecret: env.COLINK_SIGNING_SECRET,
            issuer: env.COLINK_ISSUER,
            stateFile: env.COLINK_STATE_FILE,
            credentialKey: env.COLINK_CREDENTIAL_KEY,
            appOrigin: env.COLINK_APP_ORIGIN,
            hostOrigin: env.COLINK_HOST_ORIGIN,
            bindHost: env.COLINK_BIND_HOST,
            port: env.COLINK_PORT === undefined ? undefined : /^\d+$/.test(env.COLINK_PORT) ? Number(env.COLINK_PORT) : NaN,
            allowInsecureIssuer: insecure === undefined || insecure === 'false' ? false : insecure === 'true' ? true : insecure,
        };
    }
    validateAppConfig(config);
    return { ...config, stateFile: config.stateFile === undefined ? './.colink/state.enc' : config.stateFile, apiBase: config.issuer + '/api/v1' };
}
export function invalidRuntimeConfig(field, message) {
    return new CoLinkError('INVALID_APP_CONFIG', 400, undefined, {
        message: 'App 配置不符合约束。', hint: '检查 config 对应字段；使用环境配置时检查 app.env.example 中的 COLINK_* 变量。',
        details: [{ field: 'config.' + field, code: 'INVALID_CONFIG_FIELD', message }],
    });
}
export function resolvePageOptions(pages, manifest, config) {
    if (pages !== undefined)
        return pages;
    if (!manifest?.ui?.views?.some(view => view.renderer === 'app'))
        return undefined;
    try {
        validateIssuer(config.appOrigin, config.allowInsecureIssuer);
    }
    catch {
        throw invalidRuntimeConfig('appOrigin', '声明 App 渲染页面时需要可信 App origin；环境变量为 COLINK_APP_ORIGIN。');
    }
    if (config.appOrigin === undefined)
        throw invalidRuntimeConfig('appOrigin', '声明 App 渲染页面时需要可信 App origin。');
    return { origin: config.appOrigin };
}
/** Validate without ever including supplied values or secrets in diagnostics. */
export function validateAppConfig(config) {
    const details = [];
    const invalid = (field, message) => details.push({ field: 'config.' + field, code: 'INVALID_CONFIG_FIELD', message });
    for (const field of ['appId', 'appInstanceId', 'clientId', 'clientSecret'])
        if (typeof config?.[field] !== 'string' || !config[field].trim() || (field !== 'clientSecret' && config[field].length > 200))
            invalid(field, '需要非空的登记值；不要填写示例占位符。');
    try {
        validateIssuer(config?.issuer, config?.allowInsecureIssuer);
    }
    catch {
        invalid('issuer', '使用精确 HTTPS origin；本地回环 HTTP 另需 allowInsecureIssuer=true。');
    }
    if (config?.hostOrigin !== undefined) {
        try {
            validateIssuer(config.hostOrigin, config.allowInsecureIssuer);
        }
        catch {
            invalid('hostOrigin', '使用精确 HTTPS origin；省略时与 issuer 一致，本地回环 HTTP 需 allowInsecureIssuer=true。');
        }
    }
    if (config != null && Object.hasOwn(config, 'apiBase'))
        invalid('apiBase', '不再接受 apiBase；删除该字段，SDK 根据 issuer 自动生成 API 地址。');
    if (config?.allowInsecureIssuer !== undefined && typeof config.allowInsecureIssuer !== 'boolean')
        invalid('allowInsecureIssuer', '显式配置使用 boolean；环境变量 COLINK_ALLOW_INSECURE_ISSUER 仅接受 true 或 false。');
    if (typeof config?.signingSecret !== 'string' || config.signingSecret.length < 32 || config.signingSecret === config.clientSecret)
        invalid('signingSecret', '使用至少 32 字符且独立于 clientSecret 的签名密钥。');
    if (details.length)
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, { details,
            message: 'App 配置不完整或不符合约束。', hint: '逐项修正 details；省略 config 时检查 COLINK_* 环境变量，显式 config 必须完整且不从环境补齐。本地使用 Playground 生成配置。' });
}
