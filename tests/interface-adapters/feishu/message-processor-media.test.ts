import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuResourceGateway } from "@usecases/im/feishu-resource-gateway";
import type { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import type { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";

/** 多模态 Phase 2：飞书 ingress 收图/收文件的行为测试。
 *  锁定关键行为：media → 下载 → 上传管线 → attachmentIds 随消息入库；
 *  注入载荷透传 dispatch；四类降级（未装配/下载失败/校验拒绝/上传异常）消息不丢。 */

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** 最小真实 PNG 头（magic bytes 校验在真上传管线里做——本测试 mock 上传服务） */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeDeps(overrides?: {
  download?: FeishuResourceGateway["downloadMessageResource"];
  upload?: AttachmentUploadService["upload"];
  injectionValidate?: AttachmentInjectionService["validateForSend"];
  injectionBuild?: AttachmentInjectionService["buildInjectionPayload"];
}) {
  const send = vi.fn().mockResolvedValue({ message: { id: "m-1" }, mentionFeedback: null });
  const dispatch = vi.fn().mockResolvedValue({});
  const deps = {
    manageConnection: {
      ensureConnection: vi.fn().mockResolvedValue({ id: "conn-1" }),
      getCurrentConversation: vi.fn().mockResolvedValue({ id: "conv-1", title: "测试" }),
    } as unknown as ManageConnection,
    sendMessage: { send } as unknown as SendMessage,
    commandDispatcher: {} as unknown as CommandDispatcher,
    feishuGateway: { replyText: vi.fn() } as unknown as FeishuGateway,
    feishuResource: {
      downloadMessageResource: overrides?.download ?? vi.fn().mockResolvedValue({ buffer: FAKE_PNG, fileName: "" }),
    } as unknown as FeishuResourceGateway,
    attachmentUpload: {
      upload: overrides?.upload ?? vi.fn().mockResolvedValue({
        id: "att-1", kind: "image", mimeType: "image/png", originalName: "x.png",
        sizeBytes: 12, width: 100, height: 100, caption: null,
      }),
    } as unknown as AttachmentUploadService,
    attachmentInjection: {
      validateForSend: overrides?.injectionValidate ?? vi.fn().mockResolvedValue(null),
      buildInjectionPayload: overrides?.injectionBuild ?? vi.fn().mockResolvedValue({
        images: [{ type: "image", data: FAKE_PNG.toString("base64"), mimeType: "image/png" }],
      }),
    } as unknown as AttachmentInjectionService,
    agentDispatchService: { dispatch } as unknown as AgentDispatchService,
    messageBroadcaster: { broadcast: vi.fn().mockResolvedValue(undefined) } as unknown as MessageBroadcaster,
    logger: makeLogger(),
  };
  return { deps, send, dispatch };
}

describe("FeishuMessageProcessor 多模态 ingress（Phase 2）", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("image 消息：下载 → 上传管线 → attachmentIds 随消息入库", async () => {
    const { deps, send } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_abc123" },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toEqual(["att-1"]);
    // 纯图无文本：body 非空（占位语义由 sendMessage 的 body 校验决定，此处保证不因空串挂掉）
    expect(typeof input.body).toBe("string");
  });

  it("file 消息：file_name 透传上传管线作为 originalName", async () => {
    const upload = vi.fn().mockResolvedValue({
      id: "att-2", kind: "document", mimeType: "text/plain", originalName: "notes.txt",
      sizeBytes: 10, width: null, height: null, caption: null,
    });
    const { deps, send } = makeDeps({ upload });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "", senderId: "ou_x", messageId: "om_1",
      media: { type: "file", fileKey: "file_v2_xyz", fileName: "笔记.txt" },
    });

    const uploadInput = upload.mock.calls[0][0] as { originalName: string; stream: Readable };
    expect(uploadInput.originalName).toBe("笔记.txt");
    const input = send.mock.calls[0][0] as { attachmentIds?: string[] };
    expect(input.attachmentIds).toEqual(["att-2"]);
  });

  it("图片附件注入载荷透传 agent dispatch（vision 真图进当轮 LLM）", async () => {
    const { deps, dispatch } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "看下这张图", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_abc123" },
    });

    const dispatchArgs = dispatch.mock.calls.at(-1) ?? [];
    // dispatch(conversationId, userMessageContent, senderId, injection)
    expect(dispatchArgs[0]).toBe("conv-1");
    expect(dispatchArgs[2]).toBe("ou_x");
    const injection = dispatchArgs[3] as { images?: Array<{ mimeType: string }> } | undefined;
    expect(injection?.images).toHaveLength(1);
    expect(injection?.images?.[0].mimeType).toBe("image/png");
  });

  it("下载失败：消息不丢，降级提示进 body，无 attachmentIds", async () => {
    const { deps, send, dispatch } = makeDeps({
      download: vi.fn().mockResolvedValue(null),
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_abc123" },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toContain("下载失败");
    // 降级仍触发 dispatch（文本可见）
    expect(dispatch).toHaveBeenCalled();
  });

  it("上传管线拒绝（类型白名单/大小超限）：降级提示含拒绝原因", async () => {
    const { deps, send } = makeDeps({
      upload: vi.fn().mockRejectedValue(new Error("不支持的文件类型：evil.exe")),
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "", senderId: "ou_x", messageId: "om_1",
      media: { type: "file", fileKey: "file_v2_bad", fileName: "evil.exe" },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toContain("evil.exe");
  });

  it("管线未装配（旧部署）：降级提示，消息照常入库", async () => {
    const { deps, send } = makeDeps();
    const { feishuResource, attachmentUpload, ...rest } = deps;
    void feishuResource; void attachmentUpload;
    const processor = new FeishuMessageProcessor(rest);

    await processor.process({
      chatId: "oc_1", text: "你好", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_abc123" },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toContain("你好");
    expect(input.body).toContain("未启用附件");
  });

  it("injection validateForSend 拒绝（图超限防御）：attachmentIds 不入库，降级提示", async () => {
    const { deps, send } = makeDeps({
      injectionValidate: vi.fn().mockResolvedValue("图片附件超过每轮上限（2 张）"),
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_abc123" },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toContain("每轮上限");
  });

  it("文本+图片混合消息：text 进 body，附件独立挂载", async () => {
    const { deps, send } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "这是白板照片", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_abc123" },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.body).toBe("这是白板照片");
    expect(input.attachmentIds).toEqual(["att-1"]);
  });

  it("纯文本消息（无 media）：原路径不受影响", async () => {
    const { deps, send, dispatch } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({ chatId: "oc_1", text: "普通消息", senderId: "ou_x", messageId: "om_1" });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.body).toBe("普通消息");
    expect(input.attachmentIds).toBeUndefined();
    // 纯文本 dispatch 不带 injection（第四参 undefined）
    const dispatchArgs = dispatch.mock.calls.at(-1) ?? [];
    expect(dispatchArgs[3]).toBeUndefined();
  });

  // ── #608：降级提示不进 agent dispatch 上下文（PR #603 检视建议 1 同款）──

  it("媒体下载失败：降级提示入消息体可见，agent dispatch 用原始正文（#608）", async () => {
    const { deps, send, dispatch } = makeDeps();
    // 下载失败：downloadMessageResource 返回 null（资源过期/权限不足）
    deps.feishuResource = { downloadMessageResource: vi.fn().mockResolvedValue(null) } as unknown as typeof deps.feishuResource;
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "看这图", senderId: "ou_x", messageId: "om_1",
      media: { type: "image", imageKey: "img_v2_dead00" },
    });

    // 消息体：降级提示可见（用户感知）
    const input = send.mock.calls[0][0] as { body: string };
    expect(input.body).toContain("看这图");
    expect(input.body).toContain("下载失败");
    // dispatch：原始正文，不含降级提示（运维文本不进 agent 上下文）
    const dispatchArgs = dispatch.mock.calls.at(-1) ?? [];
    expect(dispatchArgs[1]).toBe("看这图");
  });
});
