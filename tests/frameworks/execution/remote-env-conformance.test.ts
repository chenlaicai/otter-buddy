import { describe, it } from "vitest";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createRemoteLoopback } from "../../helpers/remote-loopback";

/**
 * pi-durable 官方 env conformance 子集——RemoteExecutionEnv 经回环桥
 * （真 hub machine ↔ 内存 channel ↔ 真 connector 执行栈）跑 SDK 契约用例。
 *
 * 覆盖：binary reader（5）、directory reader（4）、exec（6）——读器句柄协议与
 * shell.exec 的 SDK 级契约证据。
 * 排除：watch 九个用例（远程监视显式禁用——SDK env.watch 无生产调用方，
 * not_supported 为契约化降级信号）；listFiles 用例默认不开（契约可选面，
 * 远程同样显式禁用）。
 */

interface ConformanceCase {
  name: string;
  timeoutMs?: number;
  run(): Promise<void>;
}

function vitestAssertions() {
  return {
    ok(value: unknown, message?: string) {
      if (!value) throw new Error(`assertion failed (ok): ${message ?? String(value)}`);
    },
    strictEqual(actual: unknown, expected: unknown) {
      if (!Object.is(actual, expected)) {
        throw new Error(`strictEqual failed: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      }
    },
    deepEqual(actual: unknown, expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`deepEqual failed: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      }
    },
    partialDeepEqual(actual: unknown, expected: unknown) {
      assertPartialDeepEqual(actual, expected, "$");
    },
    greaterThan(actual: number, expected: number) {
      if (!(actual > expected)) throw new Error(`greaterThan failed: ${actual} <= ${expected}`);
    },
    async rejects(promise: Promise<unknown>) {
      let rejected = false;
      try {
        await promise;
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("expected promise to reject, but it resolved");
    },
  };
}

function assertPartialDeepEqual(actual: unknown, expected: unknown, at: string): void {
  if (expected === null || typeof expected !== "object") {
    if (!Object.is(actual, expected)) throw new Error(`partialDeepEqual failed at ${at}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`partialDeepEqual failed at ${at}: array mismatch`);
    expected.forEach((item, index) => assertPartialDeepEqual((actual as unknown[])[index], item, `${at}[${index}]`));
    return;
  }
  if (actual === null || typeof actual !== "object") throw new Error(`partialDeepEqual failed at ${at}: not an object`);
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    assertPartialDeepEqual((actual as Record<string, unknown>)[key], value, `${at}.${key}`);
  }
}

const allCases = createEnvConformance({
  assertions: vitestAssertions(),
  withEnv: async (run: (env: ExecutionEnv) => Promise<void>) => {
    const stack = await createRemoteLoopback();
    try {
      const conversationId = `conf-${Math.random().toString(36).slice(2, 10)}`;
      const env = stack.machine.createExecutionEnvironment(`/hub/workspaces/${conversationId}`, conversationId);
      await run(env as unknown as ExecutionEnv);
    } finally {
      await stack.cleanup();
    }
  },
});

// watch 族显式禁用（远程无事件流协议）——其余用例全跑
const cases = (allCases as ConformanceCase[]).filter(c => !c.name.startsWith("watch "));

describe("pi-durable env conformance（RemoteExecutionEnv 回环，watch 显式禁用面除外）", () => {
  for (const c of cases) {
    it(c.name, { timeout: c.timeoutMs ?? 30_000 }, async () => {
      await c.run();
    });
  }
});
