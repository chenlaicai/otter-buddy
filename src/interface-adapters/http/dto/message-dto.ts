/** F20260913ctlv 批4c：message-dto 收缩——toMessageDTO/toMessageEventDTO/
 *  toMessageSignalDTO 及 MessageDTO 视图族随 messages 表退役删除（消费方为零：
 *  message-controller 的 SSE 消息回调链路批4a 已删，dto-builder 整删）。
 *  保留请求/响应 DTO 转发（SendMessageRequestDTO/MarkReadRequestDTO 等——POST 路由活用）。 */
export type { SendMessageRequestDTO, MessageListResponseDTO, UnreadStateDTO, MarkReadResponseDTO, MarkReadRequestDTO } from "@contract/api/message";
