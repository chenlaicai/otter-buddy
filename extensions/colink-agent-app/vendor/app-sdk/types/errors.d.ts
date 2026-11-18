/** errors: declarations for the matching SDK reference book. */
export interface WriteRecovery {
    outcome: 'not_sent' | 'unknown' | 'confirmed';
    action: 'fix_request' | 'same_key' | 'inspect' | 'stop';
    operationId?: string;
    remainingMs?: number;
}
export interface MethodParameter {
    name: string;
    type: string;
    required: boolean;
    description: string;
}
export interface MethodVariant {
    type: string;
    parameters: MethodParameter[];
    forbidden: string[];
    open: boolean;
}
export interface MethodUsage {
    method: string;
    route?: string;
    tool?: string;
    toolIdentity?: 'app' | 'user';
    toolReadOnly?: boolean;
    arguments: Array<{
        name: string;
        optional: boolean;
        type: string;
        open: boolean;
        parameters: MethodParameter[];
        variants?: MethodVariant[];
    }>;
    example: string;
    docs: string;
    reference: string;
    note: string;
    write?: {
        mode: 'journal' | 'single_attempt';
        key: 'required' | 'none';
        keyParameter?: 'requestKey' | 'operationId';
        recoveryWindowMs?: number;
        scope: string;
        onUnknown: string;
        managedAlternative?: string;
    };
    authorization: {
        alternatives: Array<{
            identity: 'app' | 'user';
            requiredScopes: string[];
            identityAvailable?: boolean;
            missingScopes?: string[];
        }>;
        note: string;
        recovery: string;
    };
}
export interface CardDiagnostic {
    reason: string;
    field: string;
    requiredEvents: string[];
    requiredScopes: string[];
    docsUrl: string;
    example?: string;
}
export declare class CoLinkError extends Error {
    card?: CardDiagnostic;
    code: string;
    status: number;
    kind: 'authorization_required' | 'authorization_expired' | 'authorization_inactive' | 'installation_unavailable' | 'access_denied' | 'unavailable' | 'invalid_request';
    requestId?: string;
    callId?: string;
    hint: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    details?: Array<{
        field: string;
        code: string;
        message: string;
    }>;
    usage?: MethodUsage;
    write?: WriteRecovery;
    /** @sdkFailure error
     * @remarks 同步构造与序列化：CoLinkError 是 SDK 结构化错误之一，不是所有异常的总类型。toJSON 输出安全诊断字段，不携带原始凭据。
     * @remarks 以 code / status / hint / write 分支处理；未知错误保留安全日志，不解析 message 猜测是否可重试。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#结构化错误对象
     */
    toJSON(): {
        card?: CardDiagnostic;
        code: string;
        message: string;
        hint: string;
        retryable: boolean;
        usage?: MethodUsage;
        write?: WriteRecovery;
        requestId?: string;
        callId?: string;
        retryAfterSeconds?: number;
        details?: Array<{
            field: string;
            code: string;
            message: string;
        }>;
    };
    /** @sdkFailure error
     * @remarks 同步构造与序列化：CoLinkError 是 SDK 结构化错误之一，不是所有异常的总类型。toJSON 输出安全诊断字段，不携带原始凭据。
     * @remarks 以 code / status / hint / write 分支处理；未知错误保留安全日志，不解析 message 猜测是否可重试。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#结构化错误对象
     */
    constructor(code: string, status?: number, requestId?: string, diagnostic?: {
        card?: CardDiagnostic;
        callId?: string;
        message?: string;
        hint?: string;
        retryable?: boolean;
        usage?: MethodUsage;
        write?: WriteRecovery;
        retryAfterSeconds?: number;
        details?: Array<{
            field: string;
            code: string;
            message: string;
        }>;
    });
}
/** Development-time inventory. Does not request or grant authorization. */
export interface PermissionUse {
    method: string;
    identity?: 'app' | 'user';
    source?: string;
    tool?: string;
}
export interface PermissionPlanInput {
    uses?: PermissionUse[];
    events?: string[];
    permissions?: string[];
}
export interface PermissionDiagnostic {
    code: string;
    source: string;
    message: string;
    hint: string;
    scope?: string;
    alternatives?: Array<{
        identity: 'app' | 'user';
        requiredScopes: string[];
    }>;
    requiredBy?: string[];
    methods?: string[];
}
export interface PermissionNotice {
    code: 'PERMISSION_IDENTITY_SCOPES' | 'PERMISSION_MULTIPLE_SCOPES' | 'PERMISSION_SOURCE_SCOPES';
    method: string;
    source: string;
    mode: 'by_identity' | 'by_source' | 'all';
    selectedIdentity?: string | null;
    requiredScopes?: string[];
    alternatives?: Array<{
        identity: 'app' | 'user';
        requiredScopes: string[];
    }>;
    message: string;
    hint: string;
}
export interface PermissionPlan {
    notices: PermissionNotice[];
    complete: boolean;
    permissions: string[];
    requirements: Array<{
        source: string;
        method?: string;
        identity: string;
        requiredScopes: string[];
        mode?: 'by_source';
        alternatives?: Array<{
            identity: 'app' | 'user';
            requiredScopes: string[];
        }>;
    }>;
    diagnostics: PermissionDiagnostic[];
}
/** @sdkFailure diagnostic
 * @throws 同步核对显式能力和清单约束：非法显式输入可抛出 TypeError；已知方法、身份、事件与权限约束返回 diagnostics。
 * @remarks 仅处理显式能力清单，不读取或执行 App 源码，不证明覆盖未运行分支，也不判断多余权限。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#权限诊断方法
 */
declare function planPermissions(input?: PermissionPlanInput): PermissionPlan;
export interface PermissionCheck extends PermissionPlan {
    passed: boolean;
    missing: string[];
    extra: never[];
    extraCheck: 'not_evaluated';
    coverage: 'explicit_uses_only';
    note: string;
}
/** @sdkFailure diagnostic
 * @throws 同步核对显式能力和清单约束：非法显式输入可抛出 TypeError；已知方法、身份、事件与权限约束返回 diagnostics。
 * @remarks 仅处理显式能力清单，不读取或执行 App 源码，不证明覆盖未运行分支，也不判断多余权限。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#权限诊断方法
 */
declare function checkPermissions(input: PermissionPlanInput & {
    manifest: {
        permissions: string[];
        events?: {
            types: string[];
        };
    };
}): PermissionCheck;
export declare const permissions: Readonly<{
    plan: typeof planPermissions;
    check: typeof checkPermissions;
}>;
export {};
