import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// #1222 / F20261103tsdkk：T5 生效断言集成测试——真实 SDK execute，非 mock。
// 防护目标：SDK 双签名漂移（harness vs unbundled dist）导致的静默退化——
// 若 pi 升级改变 execute 签名/返回结构，本测试第一时间红。
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { wrapBashWithCwdPrefix, CWD_PREFIX_TAG } from "../../../src/frameworks/agent/cwd-awareness";

/** 真实 SDK bash 工具 + cwd 前缀包装。防护强度说明（两层，声明面 = 断言面）：
 *  - createBashToolDefinition 是生产 bash 工具的同源工厂——生产装配走
 *    createAgentSession → SDK createAllToolDefinitions(cwd)，内部即调用本工厂
 *    （agent-session@1.1.0）。SDK execute 签名/返回面漂移在此先红是真的。
 *  - wrapBashWithCwdPrefix 自 F20261014cwsp（删 override 链）起无生产调用方——
 *    休眠工具，本测试固化其行为契约以备复用（非生产路径防护）。 */
function buildWrappedBash(cwd: string) {
  const base = createBashToolDefinition(cwd);
  return wrapBashWithCwdPrefix(base as unknown as ToolDefinition, cwd);
}

/** ExtensionContext 最小面：SDK execute 内部 resolveSpawnContext 需要 sessionManager
 *  （暴露 PI_* 环境变量用，缺它会在命令 spawn 前直接 TypeError——ctx 只传 cwd 不够，
 *  这一点是真实 SDK 抓到的调用面事实）。cwd 可省略以覆盖取值 fallback 分支。
 *  返回类型用 SDK 真名 ExtensionToolContext（SDK 改名/移除该类型编译先红——漂移信号）；
 *  其真实成员面极大（会话/UI/扩展全套），测试只构造 execute 实际消费的两个字段，
 *  类型断言收敛在此单点。 */
function realCtx(cwd?: string): ExtensionToolContext {
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    sessionManager: { getSessionId: () => "t5-integration-test", getSessionFile: () => null },
  } as unknown as ExtensionToolContext;
}

/** 同机并行防碰撞：mkdtempSync 唯一目录（固定 /tmp 路径会被并行跑测的 afterAll 互删） */
function t5Dir(name: string) {
  return mkdtempSync(join(tmpdir(), `t5-${name}-`));
}

describe("T5 生效断言：真实 SDK execute + [cwd:] 前缀注入（#1222）", () => {
  let homeDir: string; // wrap-time cwd（工厂参数 + fallback 值）
  let ctxDir: string; // ctx.cwd 差异化值（≠ homeDir，令取值来源可区分）
  let errDir: string; // 失败路径用例目录
  beforeAll(() => {
    homeDir = t5Dir("home");
    ctxDir = t5Dir("ctx");
    errDir = t5Dir("err");
  });
  afterAll(() => [homeDir, ctxDir, errDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("成功路径 + ctx.cwd 优先：前缀取 ctx 值（≠ wrap cwd，来源可区分）", { timeout: 30_000 }, async () => {
    const wrapped = buildWrappedBash(homeDir);
    const result = (await wrapped.execute(
      "tc-1",
      { command: "echo hello-from-real-sdk" },
      undefined,
      undefined,
      realCtx(ctxDir),
    )) as { content: Array<{ type: string; text?: string }> };

    const first = result.content?.[0];
    expect(first?.type).toBe("text");
    expect(first?.text).toBeTruthy();
    // 前缀注入断言：首行 [cwd: <ctxDir>]（ctx.cwd 优先于 wrap-time cwd），其后是真实命令输出
    expect(first!.text!.startsWith(`${CWD_PREFIX_TAG} ${ctxDir}]`)).toBe(true);
    expect(first!.text).not.toContain(`${CWD_PREFIX_TAG} ${homeDir}]`);
    expect(first!.text).toContain("hello-from-real-sdk");
  });

  it("cwd fallback：ctx 无 cwd 时前缀用包装时传入的 cwd", { timeout: 30_000 }, async () => {
    const wrapped = buildWrappedBash(homeDir);
    const result = (await wrapped.execute(
      "tc-2",
      { command: "echo x" },
      undefined,
      undefined,
      realCtx(), // ctx 不带 cwd → 取值走 fallback 分支
    )) as { content: Array<{ type: string; text?: string }> };

    const text = result.content?.[0]?.text ?? "";
    expect(text.startsWith(`${CWD_PREFIX_TAG} ${homeDir}]`)).toBe(true);
  });

  it("失败命令路径：exit 1 → isError:true 结果仍带 cwd 前缀（失败命令在哪跑的不丢失）", { timeout: 30_000 }, async () => {
    const wrapped = buildWrappedBash(errDir);
    // 真实失败命令 false（必然 exit 1）。当前 SDK（pi 1.x）resolve isError:true 结构化结果
    // ——resolve 分支锁定 pi 1.x isError:true 语义（漂移即红）；catch 分支是 throw 形态
    // 漂移时的失败前诊断（断言前缀仍注入，随后 not.toBeFalsy 报警）。
    const result = await wrapped.execute(
      "tc-3",
      { command: "false" },
      undefined,
      undefined,
      realCtx(errDir), // 完整 ctx（含 sessionManager）：缺它 execute 在 spawn 前 TypeError，false 根本不执行
    ).catch((err: Error) => {
      // throw 形态：Error.message 前缀注入
      expect(err.message.startsWith(`${CWD_PREFIX_TAG} ${errDir}]`)).toBe(true);
      return null;
    });

    expect(result).toBeTruthy(); // 当前 SDK 为 resolve 形态——falsy = 已漂移到 throw 形态（catch 捕获返回 null）或 void 返回，红即报警
    if (result != null) {
      // resolve 形态（pi 1.x isError:true）：content[0].text 前缀注入
      const resolved = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      expect(resolved.isError).toBe(true);
      const text = resolved.content?.[0]?.text ?? "";
      expect(text.startsWith(`${CWD_PREFIX_TAG} ${errDir}]`)).toBe(true);
    }
  });

  it("SDK 结构防护锚：createBashToolDefinition 返回面（name/description/execute）", { timeout: 30_000 }, async () => {
    // 不 mock 的意义：pi 升级若改 execute 签名（参数序/返回结构），上三用例已经会挂；
    // 本用例锁定工厂返回的结构面——漂移的先红点（结构断言先于行为断言，失败定位更快）。
    const base = createBashToolDefinition(homeDir) as unknown as Record<string, unknown>;
    expect(typeof base.name).toBe("string");
    expect(base.name).toBe("bash");
    expect(typeof base.description).toBe("string"); // SDK 若改工具自述面（改名/去 description），此锚先红
    expect(base.description).toBeTruthy();
    expect(typeof base.execute).toBe("function");
  });
});
