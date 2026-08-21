/**
 * F20260821scrt: secrets 写入前脱敏（PR-3 / issue #366 #2）。
 *
 * LLM 可写持久层（memory_entries / otter_context）的统一 redaction 纯函数。
 * 用户粘贴的 token/密钥会随消息投影、fact、set_context 进入持久层，
 * 此处在 usecase 入口拦截，DB 与 embedding 拿到的都是脱敏后内容。
 *
 * 模式集刻意保守（已知前缀 + 带标签赋值），避免误伤正常文本；
 * 覆盖面是"明文密钥不再入库"，不是全量 PII 清洗。
 */

export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * 已知服务前缀的密钥模式（整串命中即替换）。
 * 顺序无关：每个模式独立全量扫描。
 */
const KNOWN_SECRET_PATTERNS: RegExp[] = [
  // Anthropic: sk-ant-api03-...
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI: sk-... / sk-proj-...
  /sk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{32,}/g,
  // GitHub: ghp_ / gho_ / ghu_ / ghs_ / ghr_
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  // AWS access key id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack: xoxb- / xoxp- / xoxa- / xoxr- / xoxs-
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Google API key
  /AIza[0-9A-Za-z_-]{35,}/g,
  // JWT（三段 base64url）
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g,
  // Bearer 凭据
  /\bBearer\s+[A-Za-z0-9+/=_-]{16,}/g,
];

/**
 * 带标签的赋值：`api_key: XXXX` / `SECRET=XXXX` / `密码：XXXX`。
 * 只替换值部分（捕获组 1），标签保留以便后续阅读定位。
 * 值至少 16 字符，且限定为凭据常见字符集（不含空格/中文），
 * 避免把普通说明文字误伤。
 */
const LABELED_SECRET_PATTERN =
  /\b(?:api[_-]?key|apikey|app[_-]?secret|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{16,})/gi;

const LABELED_SECRET_PATTERN_ZH =
  /(?:密钥|密码|令牌|凭据|口令)\s*[：=]\s*["']?([A-Za-z0-9+/=_.-]{16,})/g;

/** 对自由文本做 secrets 脱敏，返回替换后的文本 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  result = result.replace(LABELED_SECRET_PATTERN, (_m, value: string) =>
    _m.replace(value, REDACTED_PLACEHOLDER),
  );
  result = result.replace(LABELED_SECRET_PATTERN_ZH, (_m, value: string) =>
    _m.replace(value, REDACTED_PLACEHOLDER),
  );
  return result;
}

/**
 * 对 metadata 的所有字符串值（含嵌套对象/数组）做脱敏。
 * 无命中时返回原引用（保持 === 可用于变更检测）。
 */
export function redactMetadataSecrets(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactValue(metadata);
  return redacted as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = redactValue(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      const replaced = redactValue(val);
      if (replaced !== val) changed = true;
      next[key] = replaced;
    }
    return changed ? next : value;
  }
  return value;
}
