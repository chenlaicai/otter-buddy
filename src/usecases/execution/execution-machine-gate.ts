import type { ExecutionMachinePoolEntry, ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

/**
 * 执行机落点校验（动作级选择的 fail-closed 闸）。
 *
 * 三条失败路径共用一套文案骨架：原因 + fail-closed 声明（不自动换机）+
 * 当前机器池全量清单（id/名称/在线状态）+ 重试指引——海獭（模型）读错误
 * 即可自纠错重带参数，不需要人介入。清单与 list_execution_machines 工具、
 * /api/execution-machines 同一投影源，不另起拼装。
 *
 * 池快照回调缺省（旧装配/部分测试）时降级：仍强制必选语义，但报错不含
 * 清单，改为指向感知工具查询。池回调抛错不吞（fail-loud）——校验信息源
 * 故障时拒绝执行，不在盲态放行。
 */

/** 池快照回调（ToolContext.listExecutionMachines 与 DurableSessionOptions.machinePool 同形）。 */
export type ExecutionMachinePoolProvider = () => Promise<ExecutionMachinePoolSnapshot>;

export interface ExecutionMachineGatePass {
  ok: true;
  machineId: string;
}

export interface ExecutionMachineGateFail {
  ok: false;
  /** 模型可读的完整报错文案（含机器池清单与重试指引）。 */
  message: string;
}

export type ExecutionMachineGateResult = ExecutionMachineGatePass | ExecutionMachineGateFail;

const REQUIRED_HINT = "执行机类工具（bash/read/write/edit/workspace 系）每次调用必须显式指定 machine 参数";
const POOL_QUERY_HINT = "机器池可用 list_execution_machines 工具实时查询（deferred，经 tool_search 激活）";

type PoolView =
  | { kind: "snapshot"; snapshot: ExecutionMachinePoolSnapshot }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

async function readPool(pool: ExecutionMachinePoolProvider | undefined): Promise<PoolView> {
  if (!pool) return { kind: "unavailable" };
  try {
    return { kind: "snapshot", snapshot: await pool() };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function formatPool(machines: ExecutionMachinePoolEntry[]): string {
  if (!machines.length) return "（机器池为空）";
  return machines
    .map(m => {
      const seen = m.lastSeenAt ? `，lastSeen ${m.lastSeenAt}` : "";
      return `- ${m.id}（${m.name}，${m.online ? "在线" : "离线"}${seen}）`;
    })
    .join("\n");
}

function poolSection(view: PoolView): string {
  switch (view.kind) {
    case "snapshot":
      return `当前执行机池：\n${formatPool(view.snapshot.machines)}`;
    case "unavailable":
      return `当前无法获取机器池快照（池投影回调未装配）。${POOL_QUERY_HINT}。`;
    case "error":
      return `机器池快照查询失败：${view.message}（校验信息源故障，本次调用不执行——fail-closed 不盲态放行）。`;
  }
}

function missingMachineMessage(view: PoolView): string {
  return [
    `[执行机错误] 缺少必选参数 machine——${REQUIRED_HINT}，不自动回落（fail-closed）。`,
    poolSection(view),
    `请选择一台在线机器，携带 machine 参数重试。${POOL_QUERY_HINT}。`,
  ].join("\n");
}

function unknownMachineMessage(machineId: string, view: PoolView): string {
  return [
    `[执行机错误] 指定的执行机 "${machineId}" 不在机器池中（fail-closed，不自动换机）。`,
    poolSection(view),
    `请从清单中选择正确的机器 id，携带 machine 参数重试。${POOL_QUERY_HINT}。`,
  ].join("\n");
}

function offlineMachineMessage(machineId: string, name: string | undefined, view: PoolView): string {
  const label = name && name !== machineId ? `（${name}）` : "";
  return [
    `[执行机错误] 指定的执行机 "${machineId}"${label} 当前离线（fail-closed，不自动换机）。`,
    poolSection(view),
    `请改选在线机器，或等待其上线后重试。${POOL_QUERY_HINT}。`,
  ].join("\n");
}

/**
 * 校验执行机类工具调用的 machine 参数。
 *
 * 通过 ⇔ 参数为非空字符串，且（池快照可用时）机器在池中且在线。
 * 池快照不可用时仅做形态校验（降级文案指向感知工具）——生产装配恒有池投影。
 */
export async function gateExecutionMachine(
  machineId: unknown,
  pool?: ExecutionMachinePoolProvider,
): Promise<ExecutionMachineGateResult> {
  if (typeof machineId !== "string" || machineId.length === 0) {
    return { ok: false, message: missingMachineMessage(await readPool(pool)) };
  }
  const view = await readPool(pool);
  if (view.kind === "error") {
    return { ok: false, message: `[执行机错误] 机器池快照查询失败，本次调用不执行。\n${poolSection(view)}` };
  }
  if (view.kind === "snapshot") {
    const entry = view.snapshot.machines.find(m => m.id === machineId);
    if (!entry) return { ok: false, message: unknownMachineMessage(machineId, view) };
    if (!entry.online) return { ok: false, message: offlineMachineMessage(machineId, entry.name, view) };
  }
  return { ok: true, machineId };
}
