import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";

type AssistantContent = AssistantMessage["content"];

/** 真调用在净化后 content 中的位置与聚合的原始参数串缓冲。 */
type RealCall = { index: number; raw: string };

/**
 * 剥离 openai-responses 路径 assistant 消息中的空 text 块。
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

/**
 * 聚合 kimi 流式拆碎的 function_call 碎片，剔除孤儿 error toolResult。
 *
 * Why（2026-11-25 排查实证，与 2026-11-13 空 text 块修复同族的第三形态）：kimi k3.1-pro
 * 流式模式把一次 function call 拆成多个 output_item——仅首个带 call_id/name，
 * 参数按片段分到各 item（curl 原始流复现：`{` / `"command": "grep -n` / `"` /
 * `, "timeout": 120` / `}`）。pi-ai 逐 item 建独立 toolCall block（openai-
 * responses-shared.js createSlot），碎片以空 call_id/空 name 落库（id 形如
 * `|fc_x`）；引擎照样执行空 name 碎片产生「Tool not found」error toolResult。
 * 下轮请求回放时这些条目变成 `call_id:""` 的 function_call（+output），同一
 * 请求出现多条即被 kimi 判 400「tool call id :N is duplicated」（:N 是 kimi
 * 的「名字:序号」显示格式，空名字碎片出现 ≥2 次即触发）——session 每轮必死、
 * 重启无效（新世继承历史 + 首轮响应又拆新碎片，:267→:14 两连挂实证）。
 *
 * 聚合原料：pi 对 parse 失败的 toolCall 在 block 上留 `argumentsError`，内含
 * 「Received arguments:\n」+ 原始片段串（3359 实证：真 block `{` + 碎片四段拼接
 * = `{"command":"grep -n","timeout":120}` 合法 JSON）——信息无损，可完整恢复。
 *
 * 规则：
 * - 碎片判定：toolCall block 的 id call_id 段为空（`id.split("|")[0] === ""`，
 *   仅 openai-responses 用 `${call_id}|${item_id}` 构造 id，其他 api 的 id 不含
 *   `|` 或前段非空，天然不命中）或 name 为空——Responses 协议中合法 function_call
 *   必有 call_id+name，空即碎片，无合法形态误伤。
 * - 聚合：碎片原始串按序并入同消息内最近真 toolCall 的原始串，拼接后 parse
 *   成功则回填 arguments、清除 argumentsError；失败则保持真 block 原状（退化
 *   为仅剔除碎片，死循环仍被切断）。
 * - 孤儿剔除：toolCallId call_id 段为空的 toolResult 全部是碎片执行 error，
 *   零信息损失剔除，保住 fc/output 紧邻配对（既有教训：kimi 校验
 *   邻接，不按 call_id 匹配）。
 * - 收敛域 `api === "openai-responses"`：同 stripEmptyAssistantText 的收敛逻辑。
 *
 * 残余（如实交代）：碎片落库后、下轮请求前仍会被引擎执行一次（error 噪音一
 * 轮，模型看到聚合后的完整参数可自愈重试）；聚合恢复的真调用，其 toolResult
 * 仍是残缺参数（{}）那次的执行结果——协议合法、语义错位，模型可消化。
 *
 * 在 beforeRequest 钩子做（而非落库时）：存量中毒 session（含被继承的前世
 * 历史）无需数据清创即痊愈；历史记录原样保留可审计。
 *
 * @returns 有聚合/剔除时返回新数组（未受影响的 message 保持引用不变）；无需
 *   处理时返回 undefined（hook 语义：零拷贝开销）。
 */
const RECEIVED_ARGS_MARKER = "Received arguments:\n";

/** 从 argumentsError 提取原始参数串；无标记或无 argumentsError 时返回 undefined。 */
function rawArguments(block: ToolCall): string | undefined {
  if (block.argumentsError === undefined) return undefined;
  const idx = block.argumentsError.lastIndexOf(RECEIVED_ARGS_MARKER);
  if (idx < 0) return undefined;
  return block.argumentsError.slice(idx + RECEIVED_ARGS_MARKER.length);
}

/** 双空碎片判定：call_id 段与 name 均空——服务端拆碎的实测形态，参数片段归属最近真调用。 */
function isFragmentBlock(block: ToolCall): boolean {
  const emptyCallId = block.id.includes("|") && block.id.split("|")[0] === "";
  return emptyCallId && block.name === "";
}

/** 单空畸形判定：call_id/name 恰一空（合法 function_call 两者必非空）——防御性形态（未实证），
 * 参数不聚合直接丢弃（并入最近真调用有错归属风险），只保证剔除后配对完整。 */
function isMalformedToolCall(block: ToolCall): boolean {
  const emptyCallId = block.id.includes("|") && block.id.split("|")[0] === "";
  return emptyCallId !== (block.name === "");
}

/** toolResult 孤儿判定：与畸形/碎片剔除对称（call_id 段空或 toolName 空）——
 * 对应的 toolCall 已被剔除，无论 isError 与否保留都会破坏 fc/output 配对。 */
function isOrphanToolResult(message: Message): boolean {
  if (message.role !== "toolResult") return false;
  const { toolCallId, toolName } = message as { toolCallId: string; toolName: string };
  if (toolName === "") return true;
  return toolCallId.includes("|") && toolCallId.split("|")[0] === "";
}

/**
 * 把缓冲的原始串 parse 后回填真调用 arguments；失败保持原状（保守退化路径，
 * 死循环切断优先于参数完美恢复）。
 */
function restoreRealArguments(reals: readonly RealCall[], kept: AssistantContent): void {
  for (const real of reals) {
    if (real.raw === "") continue;
    try {
      const parsed = JSON.parse(real.raw) as ToolCall["arguments"];
      const block = kept[real.index] as ToolCall;
      kept[real.index] = { ...block, arguments: parsed, argumentsError: undefined };
    } catch {
      // 拼接后仍非法（如真调用本身 parse 成功、后又跟碎片）：保持原状，
      // 碎片已被剔除——保守路径，死循环切断优先于参数完美恢复。
    }
  }
}

/**
 * 净化单条 openai-responses assistant 消息：聚合碎片 toolCall、恢复完整参数。
 * 返回 [新 content, 是否有变化]；无碎片返回 [原 content, false]。
 */
function aggregateAssistantContent(
  content: AssistantContent,
): [content: AssistantContent, changed: boolean] {
  const kept: AssistantContent = [];
  const reals: RealCall[] = [];
  let pendingFor: RealCall | undefined;
  let fragmentsDropped = 0;

  for (const block of content) {
    if (block.type === "toolCall") {
      if (isFragmentBlock(block)) {
        // 双空碎片：原始串并入最近真调用（无归属目标时只能丢弃该片段）
        const raw = rawArguments(block);
        if (pendingFor && raw !== undefined) pendingFor.raw += raw;
        fragmentsDropped++;
        continue;
      }
      if (isMalformedToolCall(block)) {
        // 单空畸形：剔除不聚合（并入真调用有错归属风险），其孤儿结果由
        // isOrphanToolResult 对称剔除，保 fc/output 配对。
        fragmentsDropped++;
        continue;
      }
      kept.push(block);
      pendingFor = { index: kept.length - 1, raw: rawArguments(block) ?? "" };
      reals.push(pendingFor);
      continue;
    }
    kept.push(block);
    // 非 toolCall 块（text/thinking）不打断「碎片归属最近真调用」的链——
    // kimi 的空 message item 会插在碎片之间（curl 实证 output_index 1/3/5），
    // 若此处重置 pendingFor，跨空块的后半参数会丢给「无归属」路径。
  }

  if (fragmentsDropped === 0) return [content, false];

  restoreRealArguments(reals, kept);
  return [kept, true];
}

export function aggregateFragmentedToolCalls(messages: readonly Message[]): readonly Message[] | undefined {
  let changed = false;
  const result = messages.map((message) => {
    if (isOrphanToolResult(message)) {
      changed = true;
      return undefined; // 剔除，map 后统一过滤
    }
    if (message.role !== "assistant" || message.api !== "openai-responses") return message;
    const assistant = message as AssistantMessage;
    const [newContent, contentChanged] = aggregateAssistantContent(assistant.content);
    if (!contentChanged) return message;
    changed = true;
    return { ...assistant, content: newContent } as Message;
  });
  if (!changed) return undefined;
  return result.filter((m) => m !== undefined);
}
