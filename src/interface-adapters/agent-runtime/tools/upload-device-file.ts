import { Readable } from "node:stream";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv, BinaryReader } from "@earendil-works/pi-durable/env";
import { gateExecutionMachine } from "@usecases/execution/execution-machine-gate";

/** 上传分块大小（与 SDK read 工具一致——64KB 分块经回环/WS 全链传输） */
const UPLOAD_CHUNK_BYTES = 64 * 1024;

/** 文件错误 → 人类可读描述（code + message；FileError 分类已由设备侧语义给出） */
function describeFileError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** 读器 → 上传流：64KB 分块直到 EOF。读错时让流 throw——upload 管线会 reject，工具层捕获转错误响应。 */
function readerToStream(reader: BinaryReader): Readable {
  let offset = 0;
  return Readable.from((async function* () {
    for (;;) {
      const chunk = await reader.read(offset, UPLOAD_CHUNK_BYTES, BACKGROUND_CONTEXT as Context);
      if (!chunk.ok) throw new Error(`设备文件读取失败: ${describeFileError(chunk.error)}`);
      if (chunk.value.length === 0) return; // EOF
      offset += chunk.value.length;
      yield Buffer.from(chunk.value);
    }
  })());
}

/** 从路径推断缺省 MIME（声明值仅供嗅探参考，服务端 sniff 说了算） */
function guessMimeType(filePath: string): string {
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(filePath)) return "image/png";
  if (/\.pdf$/i.test(filePath)) return "application/pdf";
  if (/\.(mp3|wav|ogg|m4a)$/i.test(filePath)) return "audio/mpeg";
  if (/\.(mp4|mov|webm)$/i.test(filePath)) return "video/mp4";
  return "application/octet-stream";
}

/** 工具上下文要求的上传双依赖（缺一则不注册） */
export interface UploadChannelDeps {
  attachmentUpload: NonNullable<ToolContext["attachmentUpload"]>;
  resolveExecutionEnv: NonNullable<ToolContext["resolveExecutionEnv"]>;
}

/** 前置两查（缺参 filePath / 落点 gate）——独立函数保 execute 圈复杂度。 */
async function preflightUpload(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<{ error: string } | { machineId: string; filePath: string }> {
  const filePath = params.filePath;
  if (typeof filePath !== "string" || !filePath) {
    return { error: "[错误] filePath 为必填（设备绝对路径 / ~/ / file://）" };
  }
  const gate = await gateExecutionMachine(params.machine, ctx.listExecutionMachines);
  if (!gate.ok) return { error: gate.message };
  return { machineId: gate.machineId, filePath };
}

/** 打开文件读器（设备侧 openBinaryReader；错误分类原样透出）。调用方负责 finally close。 */
async function openReader(env: ExecutionEnv, filePath: string) {
  const opened = await env.openBinaryReader(filePath, undefined, BACKGROUND_CONTEXT);
  return opened.ok
    ? { reader: opened.value as BinaryReader }
    : { error: `打开文件失败（${filePath}）: ${describeFileError(opened.error)}` };
}

/** 读器收尾：显式 close（SDK read 工具同语义——finally 里 await，close 错不覆盖主结果）。 */
async function closeReader(reader: BinaryReader): Promise<void> {
  await reader.close(BACKGROUND_CONTEXT as Context).catch(() => { /* 收尾失败不覆盖上传主结果/主错误 */ });
}

interface UploadRequest {
  env: ExecutionEnv;
  filePath: string;
  originalName: string;
  mimeType?: string;
}

/** 流式上传主体：读器 → 上传管线 → 附件元数据 JSON 文本（env 由调用方解析传入） */
async function streamUpload(deps: UploadChannelDeps, ctx: ToolContext, request: UploadRequest): Promise<string> {
  const { env, filePath, originalName, mimeType } = request;
  const opened = await openReader(env, filePath);
  if ("error" in opened) throw new Error(opened.error);
  try {
    const info = await opened.reader.info(BACKGROUND_CONTEXT);
    if (!info.ok) throw new Error(`读取文件元数据失败: ${describeFileError(info.error)}`);
    const attachment = await deps.attachmentUpload.upload({
      stream: readerToStream(opened.reader),
      originalName,
      declaredMimeType: mimeType || guessMimeType(originalName),
      uploaderId: ctx.otterId,
    });
    return JSON.stringify({
      id: attachment.id,
      kind: attachment.kind,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      filePath: attachment.filePath,
    });
  } finally {
    // 句柄生命周期：打开成功后任一出口（成功/读错/上传拒）都显式 close——
    // connector 端 ReaderHandleTable 不留残留（检视回归：远端 openHandleCount 归零）。
    await closeReader(opened.reader);
  }
}

/**
 * upload_device_file：执行机侧文件显式上传为中枢可寻址附件。
 *
 * 三层数据边界的显式通道：设备产物默认留在设备，本工具是唯一「设备 → 中枢附件存储」
 * 上传动作。读通道经显式 machine 落点的执行机 env（远端设备经 binary reader 协议流式拉出，
 * 中枢 connector 同机直读），落盘复用既有附件管线（内容寻址 + sha256 去重 + MIME 双路径
 * 校验 + 尺寸闸——附件 kind 白名单边界同样生效，非白名单类型明确拒绝）。
 * 统一注册制下无内置默认机：machine 必选（fail-closed gate，与 bash/workspace 系同款）。
 * 无默认设备盘同步；不自动登记 linked_resource（需要时显式
 * create_linked_resource 指向 /api/attachments/<id>）。
 */
export function createUploadDeviceFileTool(ctx: ToolContext): AgentTool {
  return {
    name: "upload_device_file",
    description: "把执行机上的文件显式上传为中枢可寻址附件。When: 本地产物需要成为中枢可寻址副本（给人下载、随消息引用、登记产物）时——远端会话不默认上传附件或构建产物，必须经本显式动作。Not for: 设备到设备传输（无产品面）、自动同步设备目录。Output: 附件元数据（id/kind/sizeBytes/sha256/originalName/filePath）——id 经既有附件 API 可寻址。GOTCHA: machine 必选（执行机池经 list_execution_machines 查询；缺参/离线报错含可用清单）；filePath 走 SDK coding face 语义（设备绝对路径 / ~/ / file://）；附件存储 kind 白名单（png/jpeg/webp/gif、wav/mp3、mp4、pdf/txt/md/csv/json）外的类型会被拒；尺寸超上限同样明确报错。",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "执行机上的文件路径（设备绝对路径 / ~/ / file://；SDK coding face 语义，不碰 workspace 管理面）",
        },
        machine: {
          type: "string",
          description: "必选：文件所在执行机 id（读通道落点）。机器池可用 list_execution_machines 实时查询；缺参/机器不存在/离线会报错并附可用机器清单（fail-closed，不自动换机）。",
        },
        originalName: {
          type: "string",
          description: "展示用原始文件名（缺省取路径 basename；不可信，服务端清洗）",
        },
        mimeType: {
          type: "string",
          description: "声明 MIME（仅供嗅探参考，服务端 sniff 说了算）",
        },
      },
      required: ["filePath"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      if (!ctx.attachmentUpload || !ctx.resolveExecutionEnv) {
        return errorResponse("[错误] 上传通道未装配（resolveExecutionEnv/attachmentUpload 缺失）——联系大獭检查装配");
      }
      const deps: UploadChannelDeps = { attachmentUpload: ctx.attachmentUpload, resolveExecutionEnv: ctx.resolveExecutionEnv };
      const pre = await preflightUpload(ctx, params);
      if ("error" in pre) return errorResponse(pre.error);
      const { machineId, filePath } = pre;
      const originalName = (params.originalName as string | undefined)
        || filePath.split("/").filter(Boolean).pop() || "upload.bin";
      let env: ExecutionEnv;
      try {
        env = await deps.resolveExecutionEnv(machineId, ctx.conversationId);
      } catch (err) {
        return errorResponse(`[错误] 解析执行机失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        return textResponse(await streamUpload(deps, ctx, { env, filePath, originalName, mimeType: params.mimeType as string | undefined }));
      } catch (err) {
        // 流式读取中断 / 上传管线拒绝（kind 白名单、尺寸超限）统一在此转错误响应
        return errorResponse(`[错误] 上传失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 注：读器句柄由 streamUpload 的 finally 显式 close（成功/失败所有出口）——
      // 远端 connector 的 ReaderHandleTable 零残留，不依赖会话更替兜底回收。
    },
  };
}
