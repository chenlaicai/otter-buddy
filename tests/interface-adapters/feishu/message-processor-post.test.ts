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
import type { Attachment } from "@entities/conversation/attachment";

/** F20260829fpst：飞书 post 富文本混排消息的 processor 行为测试。
 *  锁定：多媒体项逐个走管线 → attachmentIds 随消息入库；单项失败单项降级
 *  （其余项照常）；注入载荷透传 dispatch；纯文本 post 走原文本路径。 */

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const FAKE_DOC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // zip magic（.docx 容器）

const uploadCounter = { n: 0 };

interface UploadCall { originalName: string; declaredMimeType: string; stream: Readable }

function makeDeps(overrides?: {
  download?: FeishuResourceGateway["downloadMessageResource"];
  upload?: AttachmentUploadService["upload"];
  injectionValidate?: AttachmentInjectionService["validateForSend"];
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
      // 默认按 key 前缀给不同字节（图 PNG / 文件 zip），可 override
      downloadMessageResource: overrides?.download ?? vi.fn(async (_mid: string, key: string) => {
        if (key.startsWith("img_")) return { buffer: FAKE_PNG, fileName: "" };
        return { buffer: FAKE_DOC, fileName: "需求清单.docx" };
      }),
    } as unknown as FeishuResourceGateway,
    attachmentUpload: {
      upload: overrides?.upload ?? (vi.fn(async (input: UploadCall): Promise<Attachment> => {
        // 按上传顺序返回可预测 id（att-1/att-2…），便于断言顺序
        uploadCounter.n += 1;
        const isImg = input.declaredMimeType === "image/png";
        return {
          id: `att-${uploadCounter.n}`,
          kind: isImg ? "image" : "document",
          mimeType: input.declaredMimeType,
          originalName: input.originalName,
          sizeBytes: 12, width: 100, height: 100, caption: null,
          sha256: "", filePath: "", uploaderId: "ou_x", createdAt: "2026-08-29T00:00:00.000Z",
        };
      }) as unknown as AttachmentUploadService["upload"]),
    } as unknown as AttachmentUploadService,
    attachmentInjection: {
      validateForSend: overrides?.injectionValidate ?? vi.fn().mockResolvedValue(null),
      buildInjectionPayload: vi.fn().mockResolvedValue({
        images: [{ type: "image", data: FAKE_PNG.toString("base64"), mimeType: "image/png" }],
      }),
    } as unknown as AttachmentInjectionService,
    agentDispatchService: { dispatch } as unknown as AgentDispatchService,
    messageBroadcaster: { broadcast: vi.fn().mockResolvedValue(undefined) } as unknown as MessageBroadcaster,
    logger: makeLogger(),
  };
  return { deps, send, dispatch };
}

describe("FeishuMessageProcessor post 混排 ingress（F20260829fpst）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadCounter.n = 0;
  });

  it("图文混排：图+文件逐项走管线，attachmentIds 有序入库，正文完整保留", async () => {
    const { deps, send } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "本周进展：\n\n上图是架构草图", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_v2_aaa111" },
          { kind: "file", key: "file_v3_qrs123", fileName: "需求清单.docx" },
          { kind: "image", key: "img_v2_bbb222" },
        ],
      },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toEqual(["att-1", "att-2", "att-3"]);
    expect(input.body).toContain("本周进展");
    expect(input.body).toContain("架构草图");
  });

  it("三项混排（2 图 + 1 文件）：validateForSend 按全部 attachmentIds 校验（与 Web 同策略）", async () => {
    const { deps, send } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "三张媒体", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_1" },
          { kind: "image", key: "img_2" },
          { kind: "file", key: "file_1", fileName: "x.docx" },
        ],
      },
    });

    const validate = (deps.attachmentInjection as unknown as { validateForSend: ReturnType<typeof vi.fn> }).validateForSend;
    // 全部 attachmentIds 一次性校验（与 Web 同策略）：从捕获参数断言
    expect(validate.mock.calls[0]?.[0]).toEqual(["att-1", "att-2", "att-3"]);
    const input = send.mock.calls[0][0] as { attachmentIds?: string[] };
    expect(input.attachmentIds).toHaveLength(3);
  });

  it("单项下载失败：该媒体项降级提示，其余项照常入库", async () => {
    const { deps, send, dispatch } = makeDeps({
      download: vi.fn(async (_mid: string, key: string) => {
        if (key === "img_v2_bad") return null; // 只有第二张图下载失败
        if (key.startsWith("img_")) return { buffer: FAKE_PNG, fileName: "" };
        return { buffer: FAKE_DOC, fileName: "y.docx" };
      }),
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "看这三张", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_v2_good1" },
          { kind: "image", key: "img_v2_bad" },
          { kind: "file", key: "file_v2_ok", fileName: "z.docx" },
        ],
      },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    // 失败项不进 attachmentIds，其余两项照常（顺序入库）
    expect(input.attachmentIds).toEqual(["att-1", "att-2"]);
    // 降级提示进 body 且含 key 尾串（可区分是哪个媒体项失败）
    expect(input.body).toContain("下载失败");
    expect(input.body).toContain("img_v2_bad".slice(-8));
    // 消息照常 dispatch
    expect(dispatch).toHaveBeenCalled();
  });

  it("单项上传拒绝（白名单外）：该媒体项降级提示含原因，其余项继续", async () => {
    const { deps, send } = makeDeps({
      upload: vi.fn(async (input: UploadCall): Promise<Attachment> => {
        if (input.originalName.includes("evil")) throw new Error("不支持的文件类型：evil.exe");
        uploadCounter.n += 1;
        const isImg = input.declaredMimeType === "image/png";
        return {
          id: `att-${uploadCounter.n}`,
          kind: isImg ? "image" : "document", mimeType: input.declaredMimeType,
          originalName: input.originalName, sizeBytes: 12, width: null, height: null, caption: null,
          sha256: "", filePath: "", uploaderId: "ou_x", createdAt: "2026-08-29T00:00:00.000Z",
        };
      }) as unknown as AttachmentUploadService["upload"],
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "带个坏文件", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_v2_ok1" },
          { kind: "file", key: "file_v3_evil", fileName: "evil.exe" },
        ],
      },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toEqual(["att-1"]);
    expect(input.body).toContain("evil.exe");
    expect(input.body).toContain("附件接收失败");
  });

  it("注入载荷透传 dispatch：post 图文混排消息的图进当轮 LLM", async () => {
    const { deps, dispatch } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "看图", senderId: "ou_x", messageId: "om_1",
      media: { type: "post", postItems: [{ kind: "image", key: "img_v2_a" }] },
    });

    const dispatchArgs = dispatch.mock.calls.at(-1) ?? [];
    const injection = dispatchArgs[3] as { images?: Array<{ mimeType: string }> } | undefined;
    expect(injection?.images).toHaveLength(1);
    expect(injection?.images?.[0].mimeType).toBe("image/png");
  });

  it("纯文本 post（media 无载荷）：走原文本路径，无 attachmentIds", async () => {
    const { deps, send } = makeDeps();
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "只是文字\n\n第二段", senderId: "ou_x", messageId: "om_1",
      // 无 media 字段——frameworks 层对纯文本 post 不带 media
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toBe("只是文字\n\n第二段");
  });

  it("全降级（所有媒体项失败）：正文 + 多条降级提示都进 body，消息不丢", async () => {
    const { deps, send } = makeDeps({
      download: vi.fn().mockResolvedValue(null),
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_v2_x1" },
          { kind: "file", key: "file_v3_y2", fileName: "a.docx" },
        ],
      },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    // 两条降级提示（各含 key 尾串区分）拼接进 body
    expect(input.body).toContain("img_v2_x1".slice(-8));
    expect(input.body).toContain("file_v3_y2".slice(-8));
    expect(input.body).toContain("下载失败");
    // body 非空（sendMessage 不因空串挂掉）
    expect(input.body.trim().length).toBeGreaterThan(0);
  });

  it("validateForSend 拒绝（2 图超限防御）：attachmentIds 不入库，正文+降级提示保留", async () => {
    const { deps, send } = makeDeps({
      injectionValidate: vi.fn().mockResolvedValue("图片附件超过每轮上限（2 张），请减少后重试"),
    });
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({
      chatId: "oc_1", text: "三张图", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_1" },
          { kind: "image", key: "img_2" },
          { kind: "image", key: "img_3" },
        ],
      },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toContain("三张图");
    expect(input.body).toContain("附件被拒");
    expect(input.body).toContain("每轮上限");
  });

  it("管线未装配（旧部署）：混排消息降级提示按媒体类别合并，正文保留", async () => {
    const { deps, send } = makeDeps();
    const { feishuResource, attachmentUpload, ...rest } = deps;
    void feishuResource; void attachmentUpload;
    const processor = new FeishuMessageProcessor(rest);

    await processor.process({
      chatId: "oc_1", text: "你好", senderId: "ou_x", messageId: "om_1",
      media: {
        type: "post",
        postItems: [
          { kind: "image", key: "img_1" },
          { kind: "file", key: "file_1", fileName: "a.docx" },
        ],
      },
    });

    const input = send.mock.calls[0][0] as { attachmentIds?: string[]; body: string };
    expect(input.attachmentIds).toBeUndefined();
    expect(input.body).toContain("你好");
    expect(input.body).toContain("未启用附件");
    expect(input.body).toContain("图片/文件");
  });
});
