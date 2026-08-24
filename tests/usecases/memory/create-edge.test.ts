import { describe, it, expect, vi } from "vitest";
import { CreateEdge } from "@usecases/memory/create-edge";
import type { MemoryReader } from "@usecases/memory/memory-reader";
import type { MemoryWriter } from "@usecases/memory/memory-writer";
import { createTestLogger } from "../../helpers/logger";

/** 最小 reader mock：两端 entry 存在且非 chunk */
function createMocks() {
  const writer = {
    createEdge: vi.fn().mockResolvedValue("edge-id"),
  } as unknown as MemoryWriter;
  const reader = {
    getById: vi.fn().mockResolvedValue({
      id: "entry-x",
      contentType: "message",
    }),
  } as unknown as MemoryReader;
  return { reader, writer };
}

describe("CreateEdge - F20260821scrt note 脱敏", () => {
  it("metadata.note 含密钥时落库为脱敏后内容", async () => {
    const { reader, writer } = createMocks();
    const uc = new CreateEdge(reader, writer, createTestLogger());

    const edgeId = await uc.execute({
      fromEntryId: "entry-a",
      toEntryId: "entry-b",
      edgeType: "produced",
      metadata: { note: "这段讨论产出了部署，密钥：a1b2c3d4e5f6a7b8c9d0e1f2" },
    });

    expect(edgeId).toBe("edge-id");
    const input = (writer.createEdge as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(input.metadata.note)).not.toContain("a1b2c3d4e5f6");
    expect(String(input.metadata.note)).toContain("[REDACTED]");
  });

  it("普通 note 原样落库", async () => {
    const { reader, writer } = createMocks();
    const uc = new CreateEdge(reader, writer, createTestLogger());

    await uc.execute({
      fromEntryId: "entry-a",
      toEntryId: "entry-b",
      edgeType: "references",
      metadata: { note: "回答引用了历史决策 F20260821scrt" },
    });

    const input = (writer.createEdge as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.metadata.note).toBe("回答引用了历史决策 F20260821scrt");
  });
});
