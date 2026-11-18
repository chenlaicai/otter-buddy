import { safeMethodUsage, safeWriteRecovery } from "./error-details.mjs";
import { record } from "./data.mjs";
const guidance = {
    PAGE_CONFIG_UNAVAILABLE: ['无法读取页面公开连接配置。', '检查 App 是否提供 /page-config.json；自定义部署可显式传入 hostOrigin 和 issuer。'],
    PAGE_CONFIG_INVALID: ['页面公开连接配置或配置路径无效。', '配置须包含 hostOrigin 和 issuer；configUrl 使用同源根路径，例如 /settings/page.json。'],
    PAGE_INVALID_OPTIONS: ['页面客户端初始化选项无效。', '选择默认配置、显式 hostOrigin/issuer 或 connection/issuer 中一种方式，不混用连接来源。'],
    authorization_required: ['缺少本操作所需的授权。', '核对工具目录、声明与实际批准的 scope；按正常授权流程获取同意，不换身份绕过。'],
    authorization_expired: ['当前身份或页面凭据已失效。', '停止旧执行；在有效页面重新登录或由平台重新触发，不重放旧凭据。'],
    authorization_inactive: ['当前用户执行或授权已结束、撤销或失效。', '停止本轮受保护操作，重新取得有效授权；不要回退到应用身份。'],
    installation_unavailable: ['应用安装当前不可用或授权版本已变化。', '检查目标安装、批准权限与 ready 状态；使用当前版本重新连接。'],
    access_denied: ['当前身份不能访问该资源或执行此操作。', '核对资源 ID、安装范围、工具支持的身份与资源可见性；拒绝不表明资源是否存在，不盲目原样重试。'],
    unavailable: ['本次调用未取得可用结果。', '检查服务状态与 requestId。写入可能已发生，先查询回执或按已声明的幂等协议恢复，不盲目重做。'],
    invalid_request: ['请求参数或当前调用状态不符合接口要求。', '根据工具参数定义与返回的字段说明修正请求后再调用。'],
};
const specific = {
    SOURCE_READ_IDENTITY_UNAVAILABLE: ['原话题缺少可信的频道可见性，无法确定读取身份。', '等待带完整来源的新事件；不要猜测身份、切换客户端或追加目录权限。当前事件仍可按原授权回复。'],
    INVALID_BACKGROUND_QUERY: ['后台委托查询参数无效。', 'findActive 需要 installationId 和 userId；list 需要 installationId，可选 limit 为 1–100、cursor 为上页 nextCursor。不要传入其他字段。'],
    BACKGROUND_PLATFORM_UNAVAILABLE: ['暂时无法访问平台后台委托服务。', '保留当前 grantId 和持久状态，连接恢复后重试；不要重建授权或切换身份。'],
    BACKGROUND_AUTHORIZATION_REQUIRED: ['后台委托或凭据已失效。', '查询安装的后台委托并核对状态；撤销后须由用户重新批准并明确绑定新 grantId，不回退应用身份。'],
    INVALID_EVENT_RESULT: ['onEvent 处理器返回了非 void 的结果。', '完成业务后返回 void；app.user_message_received 使用 await reply({text}) 暂存回复，其他事件通过对应业务方法提交结果。返回文本仅适用于 Agent.runTurn。'],
    CLIENT_IDENTITY_UNAVAILABLE: ['当前上下文没有所选身份的授权。', '使用匹配的可信页面、后台授权、安装或事件上下文；缺少用户授权时重新授权，不回退应用身份。'],
    CLIENT_EXECUTION_INACTIVE: ['此 Client 所属的执行已结束或取消。', '检查取消信号、调用期限和运行时状态；事件或 Provider 的 Client 只能在原回调内使用。'],
    INVALID_CLIENT_BINDING: ['Client 绑定参数不合法。', '只提供 request、installationId 或 grantId 中的一项；不要传入 userId 或 Token。'],
    INVALID_CLIENT_OPTIONS: ['Client 执行选项不合法。', 'signal 必须是 AbortSignal；timeoutMs 必须为 1–1800000 的整数。'],
    PLATFORM_RESPONSE_INVALID: ['平台成功响应不符合接口的数据结构。', '保留 requestId 并核对平台与 SDK 版本；不要把格式错误当作空数据或改用 MCP 猜测解析。'],
    PAGINATION_CURSOR_REPEATED: ['平台分页返回了重复游标，读取未完成。', '停止翻页并记录诊断；不要把已读取的部分数据当作完整结果。'],
    PAGINATION_INCOMPLETE: ['已达到本次读取的页数上限，仍有更多数据。', '缩小查询范围，或显式增加 maxPages；仅在遍历正常结束后声明读取完成。'],
    INVALID_PAGINATION: ['分页上限格式不正确。', 'maxPages 必须为正整数；需要取消翻页时传入 AbortSignal。'],
    STEER_RECEIPT_INVALID: ['Agent 未确认补充输入的投递结果。', 'steer 仅返回 true（已接收）或 false（确定未提交）；结果不确定应抛错并停止本轮，不自动重放。'],
    INTERACTION_STATUS_MANAGED: ['本轮状态由 SDK 自动管理，不能混用手动序号。', '等待确认时调用 turn.setDisplayStatus("suspended")，继续时传 "processing"；需要自行管理完整生命周期时设置 config.interactionStatus=false。'],
    INVALID_INTERACTION_STATUS: ['业务只能将本轮切换为 processing 或 suspended。', '传入 processing 或 suspended；回调结束、失败和取消由 SDK 收尾，不自行设置 finished。'],
    INTERACTION_STATUS_RESPONSE_INVALID: ['平台未返回与本次状态上报匹配的回执。', '检查平台版本及响应；SDK 以原序号和幂等键有限重试，不把此响应视为已显示状态。'],
    INTERACTION_STATUS_EXPIRED: ['状态上报恢复窗口已结束。', '停止重试旧回合；这不会重新执行模型或延长平台授权，界面最终按平台期限清理。'],
    RESOURCE_UNAVAILABLE: ['该资源在当前身份和工具范围内不可用。', '核对目标 topicId/channelId 与安装范围。公共读取与私密读取是不同资源边界；不要把更多权限当作可读全部资源，也不要猜测其他 ID。'],
    INVALID_EXTERNAL_URL: ['当前外链地址不受支持。', '请使用绝对 HTTPS URL。仅在本地回环 HTTP 宿主中，可以打开当前回环 App 的同源 HTTP URL。'],
    INVALID_HOST_ORIGIN: ['可信宿主地址格式不正确，或本地 HTTP 开关未启用。', '使用部署提供的精确 HTTPS origin；仅本地回环测试按可信配置启用 allowInsecureLocal，不从 URL 参数猜测宿主。'],
    BRIDGE_TIMEOUT: ['宿主握手或初始化未在时限内完成。', '检查宿主与 App 的 origin、iframe 加载及浏览器错误；重新打开页面，不把独立页或隐藏 DOM 当作接入成功。'],
    EVENT_CANCELLED: ['原事件对应的执行轮次已经停止。', '停止后续工作，不发送迟到结果；已发出的外部副作用须由 App 核对。新任务轮次使用新的 executionEpoch。'],
    PAGE_INVALID_VIEW_DATA: ['View 数据必须是受限的 JSON 对象。', '使用普通 JSON 对象，深度不超过 8、UTF-8 不超过 16 KiB；不传原型键、循环引用或非 JSON 值。'],
    PAGE_BRIDGE_TIMEOUT: ['宿主未在等待时间内返回操作回执，结果可能未知。', '核对实际界面与业务结果；composer.send 重试保留原 operationId 和内容，不能换标识再次发送。'],
    PAGE_INVALID_COMPOSER_CONTENT: ['输入框内容或操作标识不符合要求。', '使用持久 operationId，正文不超过 4000 字符、图片最多 4 张且合计不超过 10 MiB；图片使用支持的 Blob，不指定发送人或目标。'],
    PAGE_LOGIN_REQUIRED: ['尚未建立当前页面的用户身份。', '只需身份时调用 page.login，需要业务权限时调用 page.authorize 自动登录并授权；共享数据操作由后端 pages.authenticate 核验。'],
    IDEMPOTENCY_KEY_REQUIRED: ['此写操作需要有效的稳定业务操作标识 key，不是 API Key。', '使用持久业务请求 ID 加操作用途，如 request-42:create-task（1–128 位字母、数字或 ._:-）；同一操作始终复用，不在每次重试生成 UUID/时间戳。不同操作使用不同 key。'],
    WRITE_KEY_CONFLICT: ['此 key 已用于参数不同的写入。', '恢复原操作时使用原参数和原 idempotencyKey；只有明确的新业务操作才能使用新 idempotencyKey。原操作结果未知时不要通过换 idempotencyKey 或 HTTP/MCP 重做。'],
    IDEMPOTENCY_KEY_CONFLICT: ['平台幂等标识已用于参数不同的写入。', '核对原操作和参数；不要通过换 idempotencyKey 或 HTTP/MCP 重做结果未知的操作。'],
    IDEMPOTENCY_CONFLICT: ['平台幂等标识已用于参数不同的写入。', '核对原操作和参数；不要通过换 idempotencyKey 或 HTTP/MCP 重做结果未知的操作。'],
    IDEMPOTENCY_EXPIRED: ['平台写入恢复窗口已结束，不是登录过期。', '停止旧操作的重试，核对业务结果；不要换 idempotencyKey 或 HTTP/MCP 重做。'],
    WRITE_RECOVERY_EXPIRED: ['这笔写入已超过 SDK 的安全恢复窗口，不是登录过期。', '停止重试旧操作并核对业务结果；重新登录不会延长恢复窗口。不要换 idempotencyKey 或 HTTP/MCP 重做；没有查询接口时保留操作标识交由操作者核对。'],
    WRITE_PERSISTENCE_FAILED: ['SDK 未能持久保存写入状态。', '根据 write.outcome 区分尚未发送和已确认写入；修复存储后保持原 idempotencyKey、原参数，不用新 idempotencyKey 重做。'],
    OUTPUT_KEY_CONFLICT: ['此阶段输出 key 已用于不同正文。', '恢复原阶段时保留原正文和原 idempotencyKey；只有新的业务阶段使用新的稳定 idempotencyKey，不以调用顺序或每次新建 UUID 标识阶段。'],
    REPLY_RECOVERY_EXPIRED: ['已持久化输出超过安全发送恢复窗口。', '停止旧输出的发送恢复并核对话题中的实际结果；重新登录不延长窗口，不换 idempotencyKey 重做结果未知的输出。'],
    TOOL_UNAVAILABLE: ['当前授权工具目录中没有这个工具。', '重新读取当前目录并核对工具名、身份与批准权限；不要绕过目录直接调用。'],
    PLATFORM_NETWORK_UNAVAILABLE: ['未能取得平台响应，执行结果可能未知。', '检查平台连接；读取可以在恢复后重试，写入先核对回执和幂等窗口。'],
};
function safeText(value, max, secrets = []) {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        return undefined;
    let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    for (const secret of secrets)
        if (typeof secret === 'string' && secret.length >= 4)
            text = text.split(secret).join('[redacted]');
    return text.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]');
}
export function safeCardDiagnostic(input, secrets = []) {
    const value = record(input);
    if (typeof value.reason !== 'string' || !['CARD_TARGET_UNSUPPORTED', 'CARD_JSON_INVALID', 'CARD_SCHEMA_INVALID', 'CARD_VERSION_UNSUPPORTED', 'CARD_EVENT_NOT_SUBSCRIBED', 'CARD_PERMISSION_NOT_DECLARED', 'CARD_PERMISSION_NOT_GRANTED', 'CARD_IMAGE_UNAVAILABLE'].includes(value.reason))
        return undefined;
    const field = safeText(value.field, 160, secrets);
    if (!field || !/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,159}$/.test(field))
        return undefined;
    return { reason: value.reason, field,
        requiredEvents: (Array.isArray(value.requiredEvents) ? value.requiredEvents : []).filter((x) => x === 'app.colink_ui_action_invoked').slice(0, 1),
        requiredScopes: (Array.isArray(value.requiredScopes) ? value.requiredScopes : []).filter((x) => x === 'messages:write' || x === 'messages:receive').slice(0, 2),
        docsUrl: 'https://colink.link/docs/app-extensions/colink-for-ai.zip',
        example: safeText(value.example, 2000, secrets) };
}
/** Only documented diagnostic fields survive; no bodies, tokens or fetch options. */
export class CoLinkError extends Error {
    code;
    status;
    kind;
    hint;
    retryable;
    requestId;
    callId;
    card;
    usage;
    write;
    retryAfterSeconds;
    details;
    /** Safe diagnostic projection for a tool or page; excludes stack and transport options. */
    toJSON() { return errorBody(this); }
    constructor(code, status = 503, requestId, diagnostic = {}) {
        super(code);
        this.name = 'CoLinkError';
        this.code = code;
        this.status = status;
        this.kind = /AUTHORIZATION_REQUIRED|SCOPE_MISSING|PERMISSION_MISSING/.test(code) ? 'authorization_required'
            : ['WRITE_RECOVERY_EXPIRED', 'IDEMPOTENCY_EXPIRED', 'REPLY_RECOVERY_EXPIRED'].includes(code) ? 'invalid_request'
                : /EXPIRED|UNAUTHORIZED/.test(code) || status === 401 ? 'authorization_expired'
                    : /REVOKED|EXECUTION_INACTIVE/.test(code) ? 'authorization_inactive'
                        : /INSTALLATION/.test(code) ? 'installation_unavailable'
                            : status === 403 || status === 404 ? 'access_denied'
                                : status === 429 || status >= 500 ? 'unavailable' : 'invalid_request';
        if (typeof requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(requestId))
            this.requestId = requestId;
        if (typeof diagnostic.callId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(diagnostic.callId))
            this.callId = diagnostic.callId;
        const defaults = Object.hasOwn(specific, code) ? specific[code] : guidance[this.kind];
        const message = safeText(diagnostic.message, 2000) || defaults[0];
        this.message = message.startsWith(code + ': ') ? message : code + ': ' + message;
        this.hint = safeText(diagnostic.hint, 2000) || defaults[1];
        this.retryable = typeof diagnostic.retryable === 'boolean' ? diagnostic.retryable : false;
        const card = safeCardDiagnostic(diagnostic.card);
        if (card)
            this.card = card;
        const usage = safeMethodUsage(diagnostic.usage);
        if (usage)
            this.usage = usage;
        const write = safeWriteRecovery(diagnostic.write);
        if (write)
            this.write = write;
        if (typeof diagnostic.retryAfterSeconds === 'number' && Number.isSafeInteger(diagnostic.retryAfterSeconds) && diagnostic.retryAfterSeconds >= 0)
            this.retryAfterSeconds = diagnostic.retryAfterSeconds;
        if (Array.isArray(diagnostic.details)) {
            const fields = diagnostic.details.slice(0, 20).flatMap((input) => {
                const d = record(input), message = safeText(d.message, 500);
                return typeof d.field === 'string' && /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,159}$/.test(d.field) &&
                    typeof d.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(d.code) && message ? [{ field: d.field, code: d.code, message }] : [];
            });
            if (fields.length)
                this.details = fields;
        }
    }
}
export const fail = (code, status = 503) => new CoLinkError(code, status);
/**
 * @param {unknown} value
 * @param {number} status
 * @param {{ fallback?: string, secrets?: string[] }} [options]
 */
export function responseError(input, status, { fallback = 'PLATFORM_ERROR', secrets: rawSecrets = [] } = {}) {
    const value = record(input), secrets = rawSecrets.filter((value) => typeof value === 'string');
    const candidate = safeText(value.code, 80, secrets), code = candidate && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) ? candidate : fallback;
    return new CoLinkError(code, status, safeText(value?.requestId, 100, secrets), {
        message: safeText(value?.message, 2000, secrets), hint: safeText(value?.hint, 2000, secrets),
        callId: safeText(value?.callId, 100, secrets),
        card: safeCardDiagnostic(value?.card, secrets),
        retryable: value?.retryable, retryAfterSeconds: value?.retryAfterSeconds,
        usage: safeMethodUsage(value?.usage, secrets),
        write: safeWriteRecovery(value?.write, secrets),
        details: Array.isArray(value.details) ? value.details.slice(0, 20).map((input) => { const d = record(input); return { field: safeText(d.field, 160, secrets), code: safeText(d.code, 80, secrets), message: safeText(d.message, 500, secrets) }; }) : undefined,
    });
}
export function errorBody(error, fallback = 'AGENT_UNAVAILABLE') {
    const safe = error instanceof CoLinkError ? error : fail(fallback);
    return { code: safe.code, message: safe.message, hint: safe.hint, retryable: safe.retryable,
        ...(safe.card ? { card: safeCardDiagnostic(safe.card) } : {}),
        ...(safe.usage ? { usage: safeMethodUsage(safe.usage) } : {}),
        ...(safe.write ? { write: safeWriteRecovery(safe.write) } : {}),
        ...(safe.callId ? { callId: safe.callId } : {}),
        ...(safe.requestId ? { requestId: safe.requestId } : {}), ...(safe.details ? { details: safe.details } : {}),
        ...(safe.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: safe.retryAfterSeconds }) };
}
