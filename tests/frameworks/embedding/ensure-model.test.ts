import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSpawnSync = vi.fn();
const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("node:child_process", () => ({ spawnSync: mockSpawnSync }));
vi.mock("node:fs", () => ({ existsSync: mockExistsSync, statSync: mockStatSync }));

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: function () { return this; },
};

let ensureBgeM3Model: typeof import("../../../src/frameworks/embedding/ensure-model").ensureBgeM3Model;
let isModelPresent: typeof import("../../../src/frameworks/embedding/ensure-model").isModelPresent;

beforeEach(async () => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockStatSync.mockReturnValue({ size: 1024 });
  mockSpawnSync.mockReturnValue({ status: 0 });
  const mod = await import("../../../src/frameworks/embedding/ensure-model");
  ensureBgeM3Model = mod.ensureBgeM3Model;
  isModelPresent = mod.isModelPresent;
});

describe("isModelPresent", () => {
  it("all files present with correct sizes -> true", () => {
    mockExistsSync.mockReturnValue(true);
    const sizes = [770, 17082821, 1173, 964, 607298, 2266820608];
    mockStatSync.mockImplementation(() => ({ size: sizes.shift() }));
    expect(isModelPresent("/models/bge-m3")).toBe(true);
  });

  it("file missing -> false", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isModelPresent("/models/bge-m3")).toBe(false);
  });

  it("size mismatch -> false", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 999 });
    expect(isModelPresent("/models/bge-m3")).toBe(false);
  });
});

describe("ensureBgeM3Model", () => {
  it("remote mode (no localModelPath) -> skip, no download triggered", () => {
    ensureBgeM3Model({}, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("local mode + files present -> logs present, no download", () => {
    const sizes = [770, 17082821, 1173, 964, 607298, 2266820608];
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => ({ size: sizes.shift() }));
    ensureBgeM3Model({ localModelPath: "./models", modelPath: "bge-m3" }, logger);
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("local mode + files missing + script missing -> warns fallback, not throw", () => {
    // 所有 existsSync 返回 false：isModelPresent 缺失 + 脚本不存在
    mockExistsSync.mockReturnValue(false);
    expect(() => ensureBgeM3Model({ localModelPath: "./models", modelPath: "bge-m3" }, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("local mode + files missing + download fails -> warns fallback, not throw", () => {
    // 文件缺失，脚本存在，但 spawn 返回失败
    mockExistsSync
      .mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false)
      .mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false)
      .mockReturnValueOnce(true)  // 脚本路径检查通过
      .mockReturnValue(false);    // 下载后复查仍缺失
    mockStatSync.mockReturnValue({ size: 0 });
    mockSpawnSync.mockReturnValue({ status: 1 });
    expect(() => ensureBgeM3Model({ localModelPath: "./models", modelPath: "bge-m3" }, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
