---
id: F20261113etsan
title: kimi 空 text 块回放致 400 死循环：beforeRequest 剥除 openai-responses 空 text
change_type: fix
status: development
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 仅净化发往 provider 的消息历史，不改变任何工具/生成式能力语义"
intent:
  problem: "kimi k3 在并行 toolCall 响应中附带空 output_text item；pi-durable 原样落库后，下一轮请求回放时该空块被转成 assistant output_text 消息插在 function_call 与 function_call_output 之间；kimi /responses 端点要求 fc output 紧邻 fc（比 OpenAI 官方按 call_id 匹配严格），邻接断裂即 400『tool_calls must be followed by tool messages』——session 每轮必死、重启无效（新一轮首个工具回合又产生空块）。《严重错误2》大獭 2026-11-13 晨连死 4 次实证。"
  expected_effect: "发往 openai-responses 端点的消息历史中不再出现空 text 块；中毒 session（含存量）无需清理数据即恢复；kimi-256k 工具回合不再因该形态 400；其余 api（openai-completions/anthropic-messages/google 等）消息不受影响。"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "单测：openai-responses 空/纯空白 text 块被剥除（含带 textSignature 元数据者），thinking/toolCall 原序保留；无空块返回 undefined（零拷贝）；非 assistant 消息不动；混合历史只改中毒消息；非 openai-responses（google 等）空 text 不剥除"
      - "curl 对照实验留档（本 PR body）：不夹 assistant 消息 200 / 夹空或非空均 400，报错文本与线上一字不差"
      - "回归：tests/frameworks/agent 全绿；tsc 0"
    rollback: "git revert 本 PR；仅请求前净化逻辑，无落库格式/schema 变更"
    risk_note: "剥除仅限 openai-responses 路径的 trim 后为空 text 块；有内容文本不动。google（Gemini）会把加密 thoughtSignature 挂在空 text 块上、要求原样回传以维持推理链连续性（pi-ai google-shared 注释实证），故本修复刻意不触碰该路径；当前 VALID_PROVIDERS 未启用 google，不影响上线，但换 provider 前必须维持此 api 守卫。"
causal_links: []
summary: kimi /responses 端点对 function_call/output 邻接校验严格，openai-responses 路径的空 text 块回放夹塞必 400；在 pi-durable GenerationTask 的 beforeRequest 钩子只剥 openai-responses 的 assistant 空 text 块，覆盖存量与增量 session，不误伤 google 签名空块。
---

# kimi 空 text 块回放致 400 死循环修复

## 案发现场（2026-11-13《严重错误2》）

对话《严重错误2》的大獭（kimi-256k）08:56–08:58 连死 4 次，每次 invoke 都在第一轮
工具调用后被 `400 tool_calls must be followed by tool messages (search_memory:0,
search_messages:1)` 终结。两次重启无效。

## 根因链（逐环节证据等级见 PR body）

1. kimi k3 响应含空 output_text item（session 落库记录实证：content =
   [thinking, toolCall, toolCall, text("")]）。
2. pi-durable 原样落库；pi-ai 回放时按序转换，空 text → assistant output_text
   消息，正好插在 function_call ×2 与 function_call_output ×2 之间。
3. kimi /responses 端点要求 output 紧邻 call（OpenAI 官方按 call_id 匹配、容忍
   夹塞，kimi 更严），邻接断裂即 400。报错里的 `search_memory:0` 是 kimi 的
   「名字:序号」显示格式，不是真实 call_id，也不存在 id 不匹配。
4. 为什么以前不死：11-09 #1783 切 pi-durable 原生运行时后空 text 块才开始
   进入持久化历史。

curl 对照实验（真实端点）：不夹 assistant 消息 → 200；夹（空或非空）→ 400，
报错文本与线上一字不差。

## 修复

`src/frameworks/agent/assistant-message-sanitizer.ts`：
`stripEmptyAssistantText(messages)` 只剥除 `api === "openai-responses"` 的 assistant
消息中 trim 后为空的 text 块（含带 textSignature 元数据的空块——那是消息元数据、
非思维载荷）；其余 api 一律不动（google 会把加密 thoughtSignature 挂在空 text 块
上，剥掉断推理链）；无空块返回 undefined（零拷贝）。

`durable-session.ts` 注册 pi-durable `GenerationTask` 的 `beforeRequest` 钩子，
每次请求（含重试、恢复）前净化——存量中毒 session 无需任何数据修复即痊愈，
历史记录保持原样可审计。

不做的：不改 pi-ai/kimi 端行为（上游可另报）；不在落库时改历史（保留现场）。

## Acceptance Test

- [x] `tests/frameworks/agent/assistant-message-sanitizer.test.ts` 8/8（含 openai-responses 带签名空块剥除、google 签名空块保留）
- [x] `tests/frameworks/agent/` 全量 679/679（含 durable-runtime SIGKILL 回归）
- [x] `npx tsc --noEmit` 0
- [ ] 合入部署后《严重错误2》大獭首发消息不再 400（真实环境终验）
