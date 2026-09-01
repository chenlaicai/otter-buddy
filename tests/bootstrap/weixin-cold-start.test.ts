import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { ensureWeixinConfig, startWeixinChannels } from "../../src/bootstrap/platforms";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20260831wxsp：微信冷启动三缺陷回归测试。
 * 1. ensureWeixinConfig 缺省路径曾是 "./config.yaml"（真实配置在 config/config.yaml）——
 *    扫码后补写 ENOENT 静默失败，重启后 weixin 段丢失、轮询无声消失。
 * 2. yaml.dump 全量重写抹掉人工注释——文本追加保注释。
 * 3. 有账号但 config 无 weixin 段时 startWeixinChannels 静默 return []——降级启动 + warn。
 */

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };

function tmpDirWithConfig(content: string): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-ensure-"));
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(configPath, content, "utf8");
  return { dir, configPath };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureWeixinConfig（F20260831wxsp bugfix 1/2/3）", () => {
  it("追加 weixin 段且保留原有注释（文本追加，非 dump 重写）", () => {
    const { configPath } = tmpDirWithConfig([
      "# Otter Buddy 配置文件",
      "server:",
      "  port: 3000",
    ].join("\n"));
    ensureWeixinConfig({ configPath, ilinkUserId: "u1@im.wechat", logger });
    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("# Otter Buddy 配置文件"); // 注释保留
    const parsed = yaml.load(after) as { weixin?: { partnerUserId?: string } };
    expect(parsed.weixin?.partnerUserId).toBe("u1@im.wechat");
  });

  it("已有 weixin 段时幂等不写（内容不变）", () => {
    const original = ["llm:", "  default: faux", "weixin:", "  partnerUserId: existing@im.wechat"].join("\n");
    const { configPath } = tmpDirWithConfig(original);
    ensureWeixinConfig({ configPath, ilinkUserId: "new@im.wechat", logger });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original); // 一字不动
  });

  it("stateDir 与 ilinkUserId 同时写入，缩进为顶层段", () => {
    const { configPath } = tmpDirWithConfig("server:\n  port: 3000");
    ensureWeixinConfig({ configPath, stateDir: "./data/weixin", ilinkUserId: "u2@im.wechat", logger });
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) as {
      weixin?: { stateDir?: string; partnerUserId?: string };
    };
    expect(parsed.weixin?.stateDir).toBe("./data/weixin");
    expect(parsed.weixin?.partnerUserId).toBe("u2@im.wechat");
  });

  it("文件不存在时 warn 而非抛出（扫码回调不允许炸主流程）", () => {
    const warn = vi.fn();
    const l: Logger = { ...logger, warn };
    ensureWeixinConfig({ configPath: "/nonexistent/dir/config.yaml", ilinkUserId: "u@im.wechat", logger: l });
    expect(warn).toHaveBeenCalled();
    expect(() => fs.accessSync("/nonexistent/dir/config.yaml")).toThrow();
  });
});

describe("startWeixinChannels 冷启动降级（F20260831wxsp bugfix 4）", () => {
  // startWeixinAccount 依赖一整条装配链（repos/uc/agentInvoker...），降级路径测试聚焦
  // 分支行为：无 weixin 段 + 无账号 → 空数组且不 warn（既有零配置行为不回归）。
  // 有账号分支由 build-app 级集成测试覆盖（装配链真实拉起）。
  it("无 weixin 段且无已登录账号：返回空数组（零配置首次使用，不误报）", () => {
    const opts = {
      appConfig: { weixin: undefined } as never,
      repos: {} as never,
      uc: {} as never,
      agentInvoker: {} as never,
      dispatchChainEngine: {} as never,
      messageBroadcaster: {} as never,
      logger,
    };
    const result = startWeixinChannels(opts);
    expect(result).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
