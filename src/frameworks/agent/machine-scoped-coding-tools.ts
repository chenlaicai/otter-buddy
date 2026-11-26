import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import { gateExecutionMachine, type ExecutionMachineGateResult, type ExecutionMachinePoolProvider } from "@usecases/execution/execution-machine-gate";

/**
 * 执行机感知的 SDK coding 工具壳（动作级选择的工具层接缝）。
 *
 * 形态：逐个包壳 SDK 原生工具（bash/read/write/edit），schema 增加 machine
 * 参数，execute 前置 fail-closed 校验，通过后**重建 env 并以代理 api 委托**
 * 原工具 execute——prepare 链、结构化输出、文件变更队列全部留在原 execute
 * 链内，委托即继承。
 *
 * 为什么是「env 重建 + 代理」而不是 AsyncLocalStorage 穿透（2026-11-25 修正，
 * 大獭裁决）：SDK 在工具 execute **之前**构造 env（pi-durable harness/tool.js
 * 的时序：env = await runtime.env(context) 先于 tool.execute）——execute 内开
 * ALS 栈时 env 已构造完，穿透链不成立。修正路径在 wrapper 内按显式目标重建
 * env（createExecutionEnvironment 为轻对象构造，无连接/台账副作用），并代理
 * api 对象替换 env 字段；SDK 侧先构造的默认 env 被丢弃（一次轻量浪费）。
 *
 * machine 参数不在 schema required 中（pi-schema 的 obj 重组会让非 opt 字段
 * 隐式必选，required 拦截的错误走 harness 通用文案、丢失机器清单）——用
 * opt(str) + description 声明必选语义，由 gate 在 execute 层强制：缺参报错
 * 含完整可用机器清单，模型读错误自纠错重带参数。
 *
 * 代理 api 守卫（协议）：{...api} 依赖 SDK api 对象的枚举面。SDK 升级若改
 * 内部形态（新增 symbol 键/原型方法/非枚举成员），spread 会丢成员——守卫在
 * 每次委托前断言关键面齐全，缺失即抛错（吵闹失败，不静默降级）。
 */

/** machine 参数 schema（四工具共用；description 承载必选语义与自纠错指引）。 */
const machineParam = opt(str({
  description: [
    "REQUIRED (validated at call time): execution machine id to run this on.",
    "Query the list_execution_machines tool for the pool with online status.",
    "A missing, unknown, or offline machine fails closed with the pool listed in the error; it never falls back to another machine.",
  ].join(" "),
}));

const MACHINE_NOTE = " The `machine` parameter names the execution machine this tool runs on (required; see list_execution_machines for the pool).";

/** 代理 api 必须保住的关键面（inner execute 链会用到的 api 成员；以 SDK tool.js 的 api 字面量为基准）。 */
const PROXY_API_REQUIRED_KEYS = [
  "taskId",
  "conversationId",
  "callId",
  "registry",
  "agent",
  "models",
  "now",
  "output",
  "outputWindow",
  "retainedOutput",
  "diagnostic",
  "details",
  "commit",
  "memo",
  "createTask",
  "getTask",
  "waitForTask",
  "conversation",
  "snapshot",
  "snapshotAsOf",
  "watchDoc",
  "executeTool",
] as const;

/** 代理 api：spread 复制原 api（方法为闭包引用，行为同一），env 替换为目标机器重建的环境。 */
function proxyApiWithEnv(api: ToolExecutionApi<never>, env: ExecutionEnv): ToolExecutionApi<never> {
  const proxied = { ...api, env } as ToolExecutionApi<never>;
  const missing: string[] = [];
  for (const key of PROXY_API_REQUIRED_KEYS) {
    // 键存在性检查（非值检查）：outputWindow 等成员在真 SDK 里本就有合法 undefined 态；
    // 守卫的职责是抖出 spread 丢键（SDK 改内部形态），不是校验成员非空。
    if (!(key in proxied)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `machine-scoped coding tool proxy lost api members after spread: ${missing.join(", ")} — SDK internal api shape changed; refusing silent degradation (fail-closed)`,
    );
  }
  return proxied;
}

export interface MachineScopedCodingToolsDeps {
  /** 机器池快照回调（gate 的清单与在线状态信息源；缺省时 gate 降级文案）。 */
  machinePool?: ExecutionMachinePoolProvider;
  /** 显式目标解析（Registry.resolve；机器未注册时抛错 = gate 之后的二次 fail-closed）。 */
  resolveMachine: (machineId: string) => ExecutionMachine;
  /** SDK 会话 cwd（env 工厂最近一次收到的 EnvTarget.cwd；工具调用前必有 env 构造，时序由 SDK 保证）。 */
  sessionCwd: () => string;
  /** 业务对话 id（remote env 必需；invoke 级上下文读取）。 */
  conversationId: () => string | undefined;
}

type AnyArgs = Record<string, unknown>;

/** 单个 SDK 工具的执行机壳：schema 重组 + gate + env 重建 + 代理委托。 */
function machineScopedTool(inner: ToolRegistration<any>, deps: MachineScopedCodingToolsDeps): ToolRegistration<any> {
  const innerParams = inner.parameters as { properties?: Record<string, unknown> };
  const parameters = obj(
    { ...(innerParams.properties ?? {}), machine: machineParam } as never,
    { open: true },
  );
  return defineTool<any>({
    name: inner.name,
    description: `${inner.description}${MACHINE_NOTE}`,
    parameters,
    ...(inner.structuredOutputSchema !== undefined ? { structuredOutputSchema: inner.structuredOutputSchema } : {}),
    ...(inner.outputLimits !== undefined ? { outputLimits: inner.outputLimits } : {}),
    ...(inner.replay !== undefined ? { replay: inner.replay } : {}),
    ...(inner.executionMode !== undefined ? { executionMode: inner.executionMode } : {}),
    ...(inner.callers !== undefined ? { callers: inner.callers } : {}),
    // 原工具的参数修复（如 edit 的单 edit 形态转数组）先跑，machine 字段从原始
    // 参数回填——修复若重建对象，不能把 machine 一并丢掉。
    ...(inner.prepareArguments !== undefined
      ? {
          prepareArguments: (raw: unknown) => {
            const repaired = inner.prepareArguments!(raw) as AnyArgs;
            const original = raw as AnyArgs;
            return { ...repaired, machine: original?.machine } as never;
          },
        }
      : {}),
    async execute(args: AnyArgs, api: ToolExecutionApi<never>, context) {
      const gate: ExecutionMachineGateResult = await gateExecutionMachine(args.machine, deps.machinePool);
      if (!gate.ok) return { output: [{ type: "text" as const, text: gate.message }], isError: true };
      const machine = deps.resolveMachine(gate.machineId);
      const env = machine.createExecutionEnvironment(deps.sessionCwd(), deps.conversationId());
      api.diagnostic({ severity: "info", message: `execution machine: ${gate.machineId}`, code: "execution_machine" });
      const innerArgs: AnyArgs = { ...args };
      delete innerArgs.machine;
      return await inner.execute(innerArgs as never, proxyApiWithEnv(api, env), context);
    },
  });
}

/** 同构重建 SDK 四工具（bash/read/write/edit）——原字段 description 照抄，附加 machine。 */
export function createMachineScopedCodingTools(deps: MachineScopedCodingToolsDeps): Extension {
  const bash = createBashTool();
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();
  const wrapped = [bash, read, write, edit].map(inner => machineScopedTool(inner, deps));
  return defineExtension({
    name: "machine-scoped-coding-tools",
    tools: wrapped,
  });
}
