import type { Message } from "@earendil-works/pi-ai";

/**
 * F20261113etsan：剥离 openai-responses 路径 assistant 消息中的空 text 块。
 *
 * Why（2026-11-13《严重错误2》排查实证）：kimi k3 会在并行 toolCall 的响应里附带
 * 空 output_text item；pi-durable 原样落库后，下一轮请求回放时该空块被转成
 * assistant output_text 消息，正好插在 function_call 与 function_call_output
 * 之间——kimi /responses 端点要求 fc output 紧邻 fc（比 OpenAI 官方按 call_id
 * 匹配严格），邻接被打破即 400「tool_calls must be followed by tool messages」，
 * session 每轮必死、重启无效（新一轮首个工具回合又产生空块）。curl 对照实验
 * 逐字节复现：不夹 assistant 消息 → 200；夹（空或非空）→ 同款 400。
 *
 * 只收敛到 `api === "openai-responses"`：只有该路径的转换器不自行跳过空 text、
 * 且夹塞即 400。其余路径要么已自行过滤（openai-completions / anthropic-messages），
 * 要么必须原样保留空块——google 会把加密 thoughtSignature 挂在空 text 块上、剥掉
 * 会断推理链（pi-ai google-shared 注释「unless they carry a thought signature…
 * dropping it breaks the reasoning chain」），全局剥除会误伤未来接入的 provider。
 *
 * 空 text 块零信息量，剥离无副作用；在 beforeRequest 钩子里做（而非落库时），
 * 可同时覆盖存量中毒 session——历史记录保持原样可审计，只在上线前净化。
 *
 * @returns 有剥离时返回新数组（未受影响的 message 保持引用不变）；无空块时返回
 *   undefined（hook 语义：undefined = 不替换，零拷贝开销）。
 */
export function stripEmptyAssistantText(messages: readonly Message[]): readonly Message[] | undefined {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "assistant" || message.api !== "openai-responses") return message;
    const filtered = message.content.filter(
      (block) => !(block.type === "text" && block.text.trim() === ""),
    );
    if (filtered.length === message.content.length) return message;
    changed = true;
    return { ...message, content: filtered };
  });
  return changed ? result : undefined;
}
