import { describe, it, expect } from "vitest";
import { ManageContext } from "@usecases/otter/manage-context";
import type { OtterContextRepository } from "@usecases/otter/otter-context-repository";
import { REDACTED_PLACEHOLDER } from "@usecases/security/redact-secrets";

/** 带状态捕获的 OtterContextRepository mock */
function statefulRepo(): OtterContextRepository & {
  stored: { otterId: string; key: string; value: string }[];
} {
  const stored: { otterId: string; key: string; value: string }[] = [];
  return {
    stored,
    get: async () => ({}),
    set: async (otterId, key, value) => {
      stored.push({ otterId, key, value });
    },
    delete: async () => {},
  };
}

describe("ManageContext.set - F20260821scrt secrets 脱敏", () => {
  it("value 含明文密钥时写入脱敏后的值", async () => {
    const repo = statefulRepo();
    const uc = new ManageContext(repo);

    await uc.set(
      "otter-1",
      "deploy_progress",
      "部署到第 3 步，api_key: sk-abcdefghij1234567890abcdefghij",
    );

    expect(repo.stored).toHaveLength(1);
    expect(repo.stored[0].value).not.toContain("sk-abcdefghij");
    expect(repo.stored[0].value).toContain(REDACTED_PLACEHOLDER);
    // key 与 otterId 原样保留
    expect(repo.stored[0].key).toBe("deploy_progress");
    expect(repo.stored[0].otterId).toBe("otter-1");
  });

  it("普通任务状态值原样写入", async () => {
    const repo = statefulRepo();
    const uc = new ManageContext(repo);

    await uc.set("otter-1", "task_step", "已完成数据库迁移，剩 2 步");

    expect(repo.stored[0].value).toBe("已完成数据库迁移，剩 2 步");
  });
});
