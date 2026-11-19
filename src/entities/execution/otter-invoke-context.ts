import { AsyncLocalStorage } from "node:async_hooks";
import type { OtterPromptConfig } from "@contract/api/otter";

/**
 * （搬家）：per-invoke 上下文自 model-runtime-registry
 * 抽出为独立小模块——原位置头部拖 pi-ai/pi-coding-agent 全家桶依赖，而 execution 侧
 * （local-execution-machine / recording-node-execution-env）只用它 getStore() 读
 * invokeId 归因，公共执行器抽包（connector 复用）闭包因此不干净。本模块纯
 * AsyncLocalStorage + 类型（唯一外部依赖 contract 层），entities 是 agent 与
 * execution 两族 frameworks 的共同底层。model-runtime-registry 转发导出保持
 * agent 侧既有 import 点零改动。
 */

/** per-invoke 上下文，通过 AsyncLocalStorage 传递给 extension handler。 */
export interface OtterInvokeContext {
  /** 当前 invoke id——动作台账归属用。 */
  currentInvokeId?: string;
  /** 当前正在执行的工具调用 id（DurableSession.beforeTool 写入、
   * 下一枚 beforeTool 覆盖）——动作台账按 toolCallId 铸造 actionId。 */
  currentToolCallId?: string;
  /** otterConfig.systemPrompt（string 或 OtterPromptConfig 含 reminders） */
  otterPromptConfig: string | OtterPromptConfig | undefined;
  /** 首次 invoke 的身份前缀（名称/ID/类型/身份文案/模型指南/搭档名）；非首次为空串 */
  identityPrefix: string;
  /** 当前 invoke 的 otterId——tool_call handler 查 halt 标用 */
  otterId: string;
  /** per-invoke 幂等标记，避免重复 abort 与重复覆盖退出原因。 */
  haltAbortRequested?: boolean;
  /** 装配完成后由 attachGuards 注入；处理器内只发同步 abort，不等待其 Promise。 */
  requestHaltAbort?: () => void;
  /** otter 显示名（otters.name）——压缩钩子合成 prompt 的 meta 行用 */
  displayName?: string;
  /** per-turn 循环硬熔断标记（签名→阻断理由）。检测器报警时写入，
   *  tool_call 门读到即物理阻断该工具后续调用（speak/yield 豁免）。粘滞不被穿插调用清零，
   *  堵死「speak 重置 steerStrikes」逃逸；随本 store（每 execute 新建）生灭，作用域=至回合结束。 */
  loopBlockedTools?: Map<string, string>;
  /** （M-2bf6e98c）→ （guard-v4）：bash 守卫门（tool_call 层显式落痕）
   *  所需守卫参数。projectRoot/sessionCwd 由 _executeWithSession 注入（铸造点单一）。
   *  v4：无沙箱层无 abort 兜底链——本门是 bash 守卫唯一执行点；缺省时 fail-open
   *  （不拦，与守卫空窗过渡态同语义），因此 store 缺失 = 守卫不生效，而非误拦。 */
  guardProjectRoot?: string;
  guardSessionCwd?: string;
  /** 退役兼容字段：B 类外发域名表已删（原 bashGuard.allowedEgressDomains
   *  配置链同废），恒 undefined（保留接口形状兼容存量 store 消费方/测试桩，判定不再读取）。 */
  guardAllowedEgressDomains?: string[];
  /** 拦截落 healing 钩子——门拦截时上报（写 guard_intercept
   *  healing 事件），守卫行为以真实使用为准（回放库语料来源）。缺省时拦截照常。 */
  guardOnIntercept?: (input: { command: string; reason: string; ruleId?: string; ruleLayer?: string }) => void;
  /** 循环硬熔断门拦截落 healing 钩子——门拦截时上报
   *  （签名+工具名+拉黑理由），写 healing loop_tool_block 事件；同签名去重防淹漫。
   *  缺省时拦截照常（fail-open 落账，不阻断拦截本身）。 */
  loopBlockOnIntercept?: (input: { toolName: string; signature: string; reason: string }) => void;
  /** 已落账签名去重集（与 loopBlockedTools 同生命周期）*/
  loopBlockLoggedSignatures?: Set<string>;
}

export const otterInvokeStorage = new AsyncLocalStorage<OtterInvokeContext>();
