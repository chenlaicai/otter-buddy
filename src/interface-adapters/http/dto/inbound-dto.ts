import type {
  InboundPayload,
  RecruitMessageInput,
  StatusEventInput,
} from '@usecases/recruiting/process-inbound-recruit';

/** 招聘消息元素（请求体） */
export interface RecruitMessageRequestDTO {
  externalId: unknown;
  bossId: unknown;
  mid?: unknown;
  hrName: unknown;
  hrTitle?: unknown;
  company: unknown;
  position: unknown;
  content: unknown;
  time: unknown;
}

/** 状态事件元素（请求体） */
export interface StatusEventRequestDTO {
  type: unknown;
  severity: unknown;
  detail?: unknown;
  at: unknown;
}

/** 整体请求体 */
export interface InboundRequestDTO {
  source?: unknown;
  kind?: unknown;
  payload?: unknown;
}

type ParseError = { ok: false; error: string };
type ParseSuccess = { ok: true; source: string; payload: InboundPayload };
export type ParseResult = ParseSuccess | ParseError;

/** 校验 + 强类型化招聘消息元素 */
function parseRecruitMessage(raw: RecruitMessageRequestDTO): RecruitMessageInput | string {
  const checks: Array<[unknown, string]> = [
    [raw.externalId && typeof raw.externalId === 'string', 'externalId 必填'],
    [raw.bossId && typeof raw.bossId === 'string', 'bossId 必填'],
    [typeof raw.hrName === 'string', 'hrName 必填'],
    [typeof raw.company === 'string', 'company 必填'],
    [typeof raw.position === 'string', 'position 必填'],
    [typeof raw.content === 'string', 'content 必填'],
    [typeof raw.time === 'number' && Number.isFinite(raw.time), 'time 必填且为 unix ms 数字'],
  ];
  for (let i = 0; i < checks.length; i++) {
    if (!checks[i][0]) return checks[i][1];
  }
  return {
    externalId: raw.externalId as string,
    bossId: raw.bossId as string,
    mid: typeof raw.mid === 'string' ? raw.mid : undefined,
    hrName: raw.hrName as string,
    hrTitle: typeof raw.hrTitle === 'string' ? raw.hrTitle : undefined,
    company: raw.company as string,
    position: raw.position as string,
    content: raw.content as string,
    time: raw.time as number,
  };
}

/** 校验 + 强类型化状态事件元素 */
function parseStatusEvent(raw: StatusEventRequestDTO): StatusEventInput | string {
  if (typeof raw.type !== 'string' || !raw.type) return 'type 必填';
  if (raw.severity !== 'warning' && raw.severity !== 'critical') {
    return 'severity 必须是 "warning" 或 "critical"（info 事件不推送到 otter）';
  }
  if (typeof raw.at !== 'string') return 'at 必填（ISO string）';
  return {
    type: raw.type,
    severity: raw.severity,
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    at: raw.at,
  };
}

function parseRecruitPayload(payload: unknown): ParseResult {
  const p = payload as { messages?: unknown };
  if (!Array.isArray(p.messages)) {
    return { ok: false, error: 'payload.messages 必须是数组' };
  }
  const messages: RecruitMessageInput[] = [];
  for (let i = 0; i < p.messages.length; i++) {
    const result = parseRecruitMessage(p.messages[i] as RecruitMessageRequestDTO);
    if (typeof result === 'string') return { ok: false, error: `messages[${i}]: ${result}` };
    messages.push(result);
  }
  return { ok: true, source: 'boss-zhipin-bridge', payload: { kind: 'recruit', messages } };
}

function parseStatusPayload(payload: unknown): ParseResult {
  const p = payload as { events?: unknown };
  if (!Array.isArray(p.events)) {
    return { ok: false, error: 'payload.events 必须是数组' };
  }
  const events: StatusEventInput[] = [];
  for (let i = 0; i < p.events.length; i++) {
    const result = parseStatusEvent(p.events[i] as StatusEventRequestDTO);
    if (typeof result === 'string') return { ok: false, error: `events[${i}]: ${result}` };
    events.push(result);
  }
  return { ok: true, source: 'boss-zhipin-bridge', payload: { kind: 'status', events } };
}

/** 校验整体请求体。返回 { ok: true, payload } 或 { ok: false, error } */
export function parseInboundRequest(raw: InboundRequestDTO): ParseResult {
  if (typeof raw.source !== 'string' || !raw.source) {
    return { ok: false, error: 'source 必填（如 "boss-zhipin-bridge"）' };
  }
  if (raw.source !== 'boss-zhipin-bridge') {
    return { ok: false, error: `unknown source: ${raw.source}（当前仅支持 boss-zhipin-bridge）` };
  }
  if (raw.kind !== 'recruit' && raw.kind !== 'status') {
    return { ok: false, error: 'kind 必须是 "recruit" 或 "status"' };
  }
  if (typeof raw.payload !== 'object' || raw.payload === null) {
    return { ok: false, error: 'payload 必填且为 object' };
  }
  return raw.kind === 'recruit'
    ? parseRecruitPayload(raw.payload)
    : parseStatusPayload(raw.payload);
}
