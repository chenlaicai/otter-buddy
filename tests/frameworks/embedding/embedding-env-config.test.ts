import { describe, it, expect } from "vitest";
import { resolveEmbeddingDtype, resolveEnvSettings, resolveReadyTimeoutMs } from "../../../src/frameworks/embedding/embedding-env-config";

describe("resolveEmbeddingDtype", () => {
  it("真实语料基准通过后默认 q8，fp32 为显式回滚", () => {
    expect(resolveEmbeddingDtype(undefined)).toBe("q8");
    expect(resolveEmbeddingDtype("q8")).toBe("q8");
    expect(resolveEmbeddingDtype("fp32")).toBe("fp32");
  });
});

describe("resolveReadyTimeoutMs", () => {
  it("默认 60s，fp32 慢盘回滚可显式延长；非法值不静默", () => {
    expect(resolveReadyTimeoutMs(undefined)).toBe(60_000);
    expect(resolveReadyTimeoutMs("600000")).toBe(600_000);
    expect(resolveReadyTimeoutMs("0")).toBe(60_000);
    expect(resolveReadyTimeoutMs("abc")).toBe(60_000);
  });
});

describe("resolveEnvSettings", () => {
  describe("local 模式（localModelPath 设了）", () => {
    it("相对路径相对 cwd 解析为绝对路径", () => {
      const s = resolveEnvSettings({ modelPath: "bge-m3", localModelPath: "./models" }, "/repo");
      expect(s.allowLocalModels).toBe(true);
      expect(s.allowRemoteModels).toBe(false);
      expect(s.localModelPath).toBe("/repo/models");
      expect(s.modelId).toBe("bge-m3");
      expect(s.remoteHost).toBeUndefined();
    });

    it("绝对路径保持不变", () => {
      const s = resolveEnvSettings({ localModelPath: "/abs/models" }, "/repo");
      expect(s.localModelPath).toBe("/abs/models");
    });

    it("未设 modelPath 时回退默认 Xenova/bge-m3", () => {
      const s = resolveEnvSettings({ localModelPath: "./models" }, "/repo");
      expect(s.modelId).toBe("Xenova/bge-m3");
    });

    it("忽略 HF_ENDPOINT 环境变量（本地模式不联网）", () => {
      const s = resolveEnvSettings({ localModelPath: "./models" }, "/repo", "https://hf-mirror.com");
      expect(s.remoteHost).toBeUndefined();
      expect(s.allowRemoteModels).toBe(false);
    });
  });

  describe("remote 模式（未设 localModelPath）", () => {
    it("默认允许远程、禁用本地", () => {
      const s = resolveEnvSettings({ modelPath: "Xenova/bge-m3" }, "/repo");
      expect(s.allowLocalModels).toBe(false);
      expect(s.allowRemoteModels).toBe(true);
      expect(s.localModelPath).toBeUndefined();
      expect(s.remoteHost).toBeUndefined();
      expect(s.modelId).toBe("Xenova/bge-m3");
    });

    it("HF_ENDPOINT 无尾斜杠时补尾斜杠（与默认值格式一致）", () => {
      const s = resolveEnvSettings({}, "/repo", "https://hf-mirror.com");
      expect(s.remoteHost).toBe("https://hf-mirror.com/");
    });

    it("HF_ENDPOINT 有尾斜杠时不重复添加", () => {
      const s = resolveEnvSettings({}, "/repo", "https://hf-mirror.com/");
      expect(s.remoteHost).toBe("https://hf-mirror.com/");
    });

    it("未设 HF_ENDPOINT 时 remoteHost 为 undefined（用 transformers.js 默认 huggingface.co）", () => {
      const s = resolveEnvSettings({}, "/repo", undefined);
      expect(s.remoteHost).toBeUndefined();
    });

    it("空 cfg 走 remote 模式 + 默认 model id", () => {
      const s = resolveEnvSettings({}, "/repo");
      expect(s.allowRemoteModels).toBe(true);
      expect(s.modelId).toBe("Xenova/bge-m3");
    });
  });
});
