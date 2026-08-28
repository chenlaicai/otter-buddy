import type { Message } from "@entities/conversation/message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";
import { toMessageDTO, toMessageEventDTO, toMessageSignalDTO } from "./message-dto";
import type { MessageDTO } from "./message-dto";

/**
 * F20260828c4sg（合并适配）：MessageDTO 组装 helper——从 message-controller 拆出。
 * controller 在多模态附件注入（#538）+ signals 挂载（C4）叠加后超 max-lines 限制，
 * DTO 组装三件套（批量构建/发送者名解析/SSE 单条信号挂载）内聚在此。
 */
export interface MessageDtoBuilderDeps {
  queryOtter: Pick<QueryOtter, "getById">;
  queryMessage: Pick<QueryMessage, "getMessageEventsByMessageIds">;
  /** F20260826mwrd C4：徽章数据（消息原位渲染，与 events 同挂载面） */
  signalRepo?: Pick<SignalEventRepository, "findByMessageIds">;
  logger: Logger;
}

/** 批量解析 otter 消息的发送者显示名（dissolve 不删行，永远可解析） */
export async function resolveSenderNames(
  messages: Array<{ senderType: string; senderId: string }>,
  queryOtter: Pick<QueryOtter, "getById">,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const otterSenderIds = [...new Set(messages.filter(m => m.senderType === "otter").map(m => m.senderId))];
  await Promise.all(otterSenderIds.map(async id => {
    const otter = await queryOtter.getById(id);
    const resolved = resolveSpeakerName("otter", id, otter?.name);
    if (resolved) names.set(id, resolved);
  }));
  return names;
}

/** 批量构建 MessageDTO（含 events + 发送者名 + signals），list/listAfter/expand 复用，避免 N+1 */
export async function buildMessageDTOs(
  messages: Message[],
  deps: MessageDtoBuilderDeps,
): Promise<MessageDTO[]> {
  const messageIds = messages.filter((m) => m.senderType === "otter").map((m) => m.id);
  const allEvents = messageIds.length > 0
    ? await deps.queryMessage.getMessageEventsByMessageIds(messageIds)
    : [];
  const eventsByMsg = new Map<string, typeof allEvents>();
  for (const evt of allEvents) {
    const arr = eventsByMsg.get(evt.messageId) ?? [];
    arr.push(evt);
    eventsByMsg.set(evt.messageId, arr);
  }
  // F20260826mwrd C4：徽章数据（消息原位渲染，与 events 同挂载面）
  const allSignals = deps.signalRepo && messageIds.length > 0
    ? await deps.signalRepo.findByMessageIds(messageIds)
    : [];
  const signalsByMsg = new Map<string, typeof allSignals>();
  for (const sig of allSignals) {
    const arr = signalsByMsg.get(sig.messageId) ?? [];
    arr.push(sig);
    signalsByMsg.set(sig.messageId, arr);
  }
  const senderNames = await resolveSenderNames(messages, deps.queryOtter);
  return messages.map((msg) => {
    const dto = toMessageDTO(msg, senderNames.get(msg.senderId));
    const evts = eventsByMsg.get(msg.id);
    if (evts && evts.length > 0) {
      dto.events = evts.map(toMessageEventDTO);
    }
    const sigs = signalsByMsg.get(msg.id);
    if (sigs && sigs.length > 0) {
      dto.signals = sigs.map(toMessageSignalDTO);
    }
    return dto;
  });
}

/** F20260826mwrd C4：SSE 单条消息推送前挂载 signals（otter 消息才查，失败不阻断推送） */
export async function decorateWithSignals(
  dto: MessageDTO,
  message: Message,
  deps: Pick<MessageDtoBuilderDeps, "signalRepo" | "logger">,
): Promise<MessageDTO> {
  if (!deps.signalRepo || message.senderType !== "otter") return dto;
  try {
    const sigs = await deps.signalRepo.findByMessageIds([message.id]);
    if (sigs.length > 0) dto.signals = sigs.map(toMessageSignalDTO);
  } catch (err) {
    deps.logger.warn("[decorateWithSignals] signal 挂载失败，推送裸 DTO", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
  }
  return dto;
}
