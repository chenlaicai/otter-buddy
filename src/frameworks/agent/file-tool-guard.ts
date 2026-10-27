/**
 * F20261027gscv Phase 1：write/edit 结构化工具接防（guarded operations）。
 *
 * 设计依据：F20261027gscv-guard-bounded-convergence.md §5.2——write/edit 在 SDK
 * 真实副作用 operations 上接防，不解析 bash、不只检查工具入参文本。
 *
 * SDK 契约（@earendil-works/pi-coding-agent 1.1.0 实证，dist/core/tools/write.js /
 * edit.js）：execute 先 `resolveToCwd(path, ctx?.cwd || cwd)` 再调 operations——
 * operations 收到的就是实际委托的绝对路径，判定与写入同路径。所有副作用必经 operations：
 * - write：mkdir（create 目录副作用）→ writeFile；两者每次委托前均校验
 * - edit：access（R_OK|W_OK 探测）→ readFile（只读）→ writeFile（唯一写副作用）；
 *   写意图在 access 前即拒（主仓文件不该走到「能读不能写」的报错体验）；
 *   readFile 透传默认实现——主仓只读文件允许读，不误作「禁止读取」
 *
 * 拒绝语义：抛错传回 LLM（SDK 默认 operations 同样以异常为失败通道），
 * 文案含 ruleId/工具/操作/正道指引，不含目标文件内容。解析失败 fail-closed。
 *
 * 诚实边界：不防恶意宿主进程 TOCTOU 竞态（设计 §5.2）；sg=false 下同样接防——
 * 本守卫是结构化层，独立于 bash 物理沙箱，`sandboxGuarded` 仍只代表 bash 物理状态。
 */

import { access, constants, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EditOperations, EditToolOptions, WriteOperations, WriteToolOptions } from "@earendil-works/pi-coding-agent";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { type FileWritePolicy, type FileWriteRegion, createFileWritePolicy, type FileWritePolicyOptions } from "./file-write-policy";
import type { OtterInvokeContext } from "./model-runtime-registry";

/** 拦截审计事件——落账不含文件内容（设计 §5.5） */
export interface FileToolGuardInterceptEvent {
  tool: "write" | "edit";
  /** 触发校验的 operation 名（SDK WriteOperations/EditOperations 的键） */
  operation: string;
  /** 真实落点判定路径（不含内容） */
  resolvedPath: string;
  region?: FileWriteRegion;
  ruleId: string;
  /** 保证等级（设计 §5.5：physical/structured/best-effort——本层恒 structured） */
  assurance: "structured";
}

/** 可选同步审计回调；回调抛错不改变拒绝结果，审计异常走 onAuditError */
export type FileToolGuardOnIntercept = (event: FileToolGuardInterceptEvent) => void;

/** 审计失败的本地同步报告口；不等于已接生产 healing（由装配方显式注入适配器） */
export type FileToolGuardOnAuditError = (error: Error, event: FileToolGuardInterceptEvent) => void;

/** guard 工厂注入参数——policy 可外部注入（共享写区事实源），缺省自建 */
export interface FileToolGuardOptions extends FileWritePolicyOptions {
  /** 可选审计回调；不传行为完全相同（仅无审计） */
  onIntercept?: FileToolGuardOnIntercept;
  /** 可选审计异常报告口；同步调用，绝不以异步 rejected Promise 制造 unhandled rejection */
  onAuditError?: FileToolGuardOnAuditError;
  /** 测试/外部注入已建 policy */
  policy?: FileWritePolicy;
  /** 生产由 createSandboxedTools 注入 invoke 级读取器，复用统一 healing 适配器。 */
  getInvokeContext?: () => Pick<OtterInvokeContext, "guardOnIntercept"> | undefined;
}

const GUIDANCE =
  "写文件请走正道：獭对话工作区（data/workspaces/<对话ID>/）、开发 worktree（.otter/worktrees/）" +
  "或对话工作区工具（workspace_write）；改主仓代码走 worktree + PR。";

/** 构造拒绝错误：含 ruleId/工具/操作/正道指引，不含文件内容 */
function denyError(tool: string, operation: string, ruleId: string, reason: string): Error {
  return new Error(
    `[file-tool-guard] 拒绝 ${tool}.${operation}（ruleId=${ruleId}）：${reason}。${GUIDANCE}`,
  );
}

/** 审计发射：回调异常不覆盖拒绝；同步报告审计错误，不产生 unhandled rejection */
function emit(
  onIntercept: FileToolGuardOnIntercept | undefined,
  onAuditError: FileToolGuardOnAuditError | undefined,
  event: FileToolGuardInterceptEvent,
): void {
  if (!onIntercept) return;
  try {
    onIntercept(event);
  } catch (error) {
    const auditError = error instanceof Error ? error : new Error(String(error));
    if (!onAuditError) return;
    try {
      onAuditError(auditError, event);
    } catch {
      // 连错误报告口也失败时仍保留原拒绝；不向事件循环投放无人接收的异常。
    }
  }
}

interface GuardHooks {
  onIntercept?: FileToolGuardOnIntercept;
  onAuditError?: FileToolGuardOnAuditError;
  getInvokeContext?: FileToolGuardOptions["getInvokeContext"];
}

/** 单次校验：policy 判定 → 允许返回写区 / 拒绝抛错 + 审计 */
function gate(
  policy: FileWritePolicy,
  hooks: GuardHooks,
  tool: "write" | "edit",
  operation: string,
  absolutePath: string,
): FileWriteRegion {
  const verdict = policy.checkWriteTarget(absolutePath);
  if (verdict.allowed && verdict.region) {
    return verdict.region;
  }
  const ruleId = verdict.ruleId ?? "file-tool-guard/path-resolve-failed";
  const reason = verdict.reason ?? "路径校验失败";
  const event: FileToolGuardInterceptEvent = {
    tool,
    operation,
    resolvedPath: verdict.resolvedPath,
    ruleId,
    assurance: "structured",
  };
  // 同步拒绝先成立，再复用 invoke 级 healing 适配器。无 invoke 上下文时才回落到
  // 测试/独立调用方的结构化回调；不会伪造成 bash 命令，也不会异步抛错。
  const context = hooks.getInvokeContext?.();
  try {
    if (context?.guardOnIntercept) {
      context.guardOnIntercept({
        command: `ruleId=${ruleId} tool=${tool} operation=${operation} path=${JSON.stringify(verdict.resolvedPath)}`,
        reason: `[file-tool-guard] ${tool}.${operation} 拒绝（ruleId=${ruleId}）：${reason}`,
      });
    } else {
      emit(hooks.onIntercept, hooks.onAuditError, event);
    }
  } catch (error) {
    const auditError = error instanceof Error ? error : new Error(String(error));
    try { hooks.onAuditError?.(auditError, event); } catch { /* 原拒绝优先 */ }
  }
  throw denyError(tool, operation, ruleId, reason);
}

/** write 工具的 guarded operations：mkdir 与 writeFile 每次委托前均校验 */
export function createGuardedWriteOperations(
  policy: FileWritePolicy,
  onIntercept?: FileToolGuardOnIntercept,
  onAuditError?: FileToolGuardOnAuditError,
  getInvokeContext?: FileToolGuardOptions["getInvokeContext"],
): WriteOperations {
  const hooks: GuardHooks = { onIntercept, onAuditError, getInvokeContext };
  return {
    mkdir: async (dir: string) => {
      gate(policy, hooks, "write", "mkdir", dir);
      await fsMkdir(dir, { recursive: true });
    },
    writeFile: async (absolutePath: string, content: string) => {
      gate(policy, hooks, "write", "writeFile", absolutePath);
      await fsWriteFile(absolutePath, content, "utf-8");
    },
  };
}

/** edit 工具的 guarded operations：写意图 access 前拒；readFile 只读透传；writeFile 委托前再校验 */
export function createGuardedEditOperations(
  policy: FileWritePolicy,
  onIntercept?: FileToolGuardOnIntercept,
  onAuditError?: FileToolGuardOnAuditError,
  getInvokeContext?: FileToolGuardOptions["getInvokeContext"],
): EditOperations {
  const hooks: GuardHooks = { onIntercept, onAuditError, getInvokeContext };
  return {
    access: async (absolutePath: string) => {
      // 写意图先于 SDK 默认 access：主仓目标在探测可写性之前即拒，错误文案走守卫
      gate(policy, hooks, "edit", "access", absolutePath);
      // 允许区：复刻默认语义（R_OK|W_OK 探测），保持 SDK 对不存在文件的原生报错形态
      await access(absolutePath, constants.R_OK | constants.W_OK);
    },
    readFile: async (absolutePath: string) => {
      // 只读操作不拦截（主仓只读文件允许读——设计 §5.2 第 4 条）
      return fsReadFile(absolutePath);
    },
    writeFile: async (absolutePath: string, content: string) => {
      gate(policy, hooks, "edit", "writeFile", absolutePath);
      await fsWriteFile(absolutePath, content, "utf-8");
    },
  };
}

/**
 * 组装 guarded write/edit 工具（供 createSandboxedTools 装配）。
 * 与 SDK 一致：operations 显式全量提供，默认 operations 完全不被引用——
 * LLM 无法经工具入参绕回未包裹路径。
 */
export function createGuardedFileTools(
  cwd: string,
  options: FileToolGuardOptions,
): { write: AgentTool; edit: AgentTool } {
  const policy = options.policy ?? createFileWritePolicy(options);
  const writeOptions: WriteToolOptions = {
    operations: createGuardedWriteOperations(policy, options.onIntercept, options.onAuditError, options.getInvokeContext),
  };
  const editOptions: EditToolOptions = {
    operations: createGuardedEditOperations(policy, options.onIntercept, options.onAuditError, options.getInvokeContext),
  };
  return {
    write: createWriteTool(cwd, writeOptions),
    edit: createEditTool(cwd, editOptions),
  };
}

/**
 * 构造期基础装配断言：只验证「tools 已创建且 execute 可调用 + policy 对白名单外路径拒绝」。
 *
 * 诚实边界：SDK 不暴露 operations 句柄，本函数不能单独证明 execute 闭包已接 guarded
 * operations，也不做 monkey patch 或异步副作用探针。真实 SDK execute 接防由
 * tests/frameworks/agent/file-tool-guard.test.ts 补证；此处失败仅表示基础装配不成立，
 * 调用方 fail-closed，不把本断言冒充完整注入证明。
 */
export function assertGuardedFileToolsAssembled(
  tools: { write: AgentTool; edit: AgentTool },
  policy: FileWritePolicy,
): void {
  if (typeof tools.write?.execute !== "function" || typeof tools.edit?.execute !== "function") {
    throw new Error("[file-tool-guard] guarded write/edit 工具缺少 execute——装配失败，拒绝静默使用默认 operations");
  }
  const probe = policy.checkWriteTarget("/nonexistent-otter-probe/forbidden");
  if (probe.allowed) {
    throw new Error("[file-tool-guard] policy 对白名单外路径放行——guard 未生效，拒绝装配");
  }
}
