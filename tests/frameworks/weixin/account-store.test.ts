import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinAccountStore } from "@frameworks/weixin/account-store";

/**
 * removeAccount 幂等性单测（PR #682 回修——检视 #682 发现 1）。
 *
 * #592 的「删了又复活」防线依赖 removeAccount 可被二次调用而不抛错
 * （主路径 onWeixinAccountDeleted 先删 + account_deleted 分支后到二次删）。
 * 此前幂等性仅靠代码审查确认，本用例锁定行为假设，防重构打破。
 */

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wx-account-store-"));
}

describe("WeixinAccountStore.removeAccount 幂等性", () => {
  it("重复删除不抛错：不存在 key 的 delete 是 no-op，rmSync force 容忍路径不存在", () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    store.saveAccount({ id: "acc-1", token: "tok-1", ilinkUserId: "u1@im.wechat", addedAt: new Date().toISOString() });

    expect(() => {
      store.removeAccount("acc-1");
      store.removeAccount("acc-1"); // 二次删：accounts.json 已无该 key、游标目录已被清
      store.removeAccount("never-existed"); // 从未存在：同样不抛
    }).not.toThrow();

    expect(store.listAccounts()).toHaveLength(0);
    // accounts.json 仍可正常读写（safeWrite 未被二次删除破坏）
    store.saveAccount({ id: "acc-2", token: "tok-2", ilinkUserId: "u2@im.wechat", addedAt: new Date().toISOString() });
    expect(store.getAccount("acc-2")?.token).toBe("tok-2");
  });

  it("删除后其它账号不受影响（连带清理仅限自身目录）", () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    store.saveAccount({ id: "acc-a", token: "tok-a", ilinkUserId: "ua@im.wechat", addedAt: new Date().toISOString() });
    store.saveAccount({ id: "acc-b", token: "tok-b", ilinkUserId: "ub@im.wechat", addedAt: new Date().toISOString() });

    store.removeAccount("acc-a");
    store.removeAccount("acc-a"); // 二次删

    expect(store.getAccount("acc-a")).toBeUndefined();
    expect(store.getAccount("acc-b")?.token).toBe("tok-b");
    expect(store.listAccounts()).toHaveLength(1);
  });
});
