/**
 * F20260821scrt: secrets 写入前脱敏（PR-3 / issue #366 #2）。
 *
 * LLM 可写持久层（memory_entries / otter_context / linked_resources /
 * otter_sessions.summary / memory_edges）的统一 redaction 纯函数。
 * 用户粘贴的 token/密钥会随消息投影、fact、set_context 进入持久层，
 * 此处在 usecase 入口拦截，DB 与 embedding 拿到的都是脱敏后内容。
 *
 * 模式集刻意保守（已知前缀 + 带标签赋值），避免误伤正常文本；
 * 覆盖面是"明文密钥不再入库"，不是全量 PII 清洗。
 * 已知边界（对抗审视 F20260821scrt 记录）：换行切断的 key、二次编码
 * （整体 base64/URL 编码/HTML 实体）不覆盖——regex 追不完，属声明边界。
 */

export const REDACTED_PLACEHOLDER = "[REDACTED]";

/** PEM 私钥块（多行，非贪婪到 END 行） */
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * 已知服务前缀的密钥模式（整串命中即替换）。
 * 顺序无关：每个模式独立全量扫描。
 */
const KNOWN_SECRET_PATTERNS: RegExp[] = [
  // Anthropic: sk-ant-api03-...
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI: sk-... / sk-proj- / sk-svcacct-
  /sk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{32,}/g,
  // Stripe: sk_live_ / sk_test_ / rk_live_ / rk_test_
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g,
  // GitHub: ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  // GitLab PAT
  /glpat-[A-Za-z0-9_-]{20,}/g,
  // HuggingFace / npm
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  // AWS access key id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack: xoxb- / xoxp- / xoxa- / xoxr- / xoxs-（要求首段以数字开头，防 "xoxb-my-token" 型误报）
  /xox[baprs]-\d[A-Za-z0-9-]{15,}/g,
  // Google API key
  /AIza[0-9A-Za-z_-]{35,}/g,
  // JWT（三段 base64url）
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g,
];

/**
 * 带标签的赋值（宽松阈值 8+）：密码类标签。真实密码大量在 8-15 位，
 * 只有密码类降阈值，其余标签保持 16+ 防误伤。
 * 支持全角/半角引号与全角/半角冒号（中文用户混用普遍）。
 * 标签允许 `X_password` / `X-password` 形前缀（二轮审视#2：词表外复合标签漏检）；
 * 前缀与词根之间必须有 `_`/`-` 分隔，故 `csrftoken`/`pretoken` 这类无分隔
 * 粘合词不命中；左侧 lookbehind 防止从粘合词中间起配。
 */
const LABELED_PASSWORD_PATTERN =
  /((?:(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+[_-])?(?:password|passwd)|密码|口令)\s*[：:=]\s*)(["'\u201c\u2018]?)([A-Za-z0-9+/=_.-]{8,})/gi;

/**
 * 带标签的赋值（严格阈值 16+）：密钥/token 类标签。
 * 复合词（access_token / client_secret 等）通过前缀组泛化覆盖，无需逐一词表。
 */
const LABELED_SECRET_PATTERN =
  /((?:(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|apikey|app[_-]?secret|client[_-]?secret|account[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|secret|token|credential)|访问令牌|密钥|秘钥|私钥|令牌|凭据)\s*[：:=]\s*)(["'\u201c\u2018]?)([A-Za-z0-9+/=_.-]{16,})/gi;

/**
 * 环境变量引用不是密钥值（二轮审视#3 误报：`apiKey: process.env.OPENAI_API_KEY`
 * 被吞）。值命中以下形态时跳过脱敏。
 */
const ENV_REFERENCE_PATTERN = /process\.env\.|os\.environ|\$\{/;

/**
 * Bearer 凭据：保留 "Bearer" 字样（说明性文字常用），只脱凭据部分。
 */
const BEARER_PATTERN = /(\bBearer\s+)([A-Za-z0-9+/=_.-]{16,})/g;

/** 对自由文本做 secrets 脱敏，返回替换后的文本 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  result = result.replace(PEM_PRIVATE_KEY_PATTERN, REDACTED_PLACEHOLDER);
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  result = result.replace(BEARER_PATTERN, (_m, prefix: string, value: string) =>
    prefix + stripTrailingPeriod(value, REDACTED_PLACEHOLDER),
  );
  result = applyLabeled(result, LABELED_SECRET_PATTERN);
  result = applyLabeled(result, LABELED_PASSWORD_PATTERN);
  return result;
}

/**
 * 带标签替换：保留捕获组 1（标签+分隔符）与捕获组 2（引号），值替换为占位符；
 * 值为环境变量引用时跳过（配置代码常见，非密钥本体）；
 * 值尾部的 `.` 视为句读标点，保留在占位符之后（base64 以 `=` 结尾，不以 `.` 结尾）。
 */
function applyLabeled(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match, label: string, quote: string, value: string) => {
    if (ENV_REFERENCE_PATTERN.test(value)) return match;
    return label + quote + stripTrailingPeriod(value, REDACTED_PLACEHOLDER);
  });
}

function stripTrailingPeriod(value: string, replacement: string): string {
  const trailing = value.match(/[.]+$/)?.[0] ?? "";
  return replacement + trailing;
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
