import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/**
 * 占位执行环境（统一注册制的 SDK env 工厂产物）。
 *
 * 背景：SDK（pi-durable harness）在每次工具 execute 之前构造 env
 * （`env = await runtime.env(context)`），构造失败会炸掉所有工具调用——
 * 所以 env 工厂必须恒成功。统一注册制下机器池没有默认机（中枢机器也由
 * connector 注册），「无显式落点的 env」无从构造。
 *
 * 真执行路径全部不经过它：SDK 四工具（bash/read/write/edit）在机器壳内
 * gate 通过后按显式 machine 重建 env；workspace 系与 upload 走
 * ActionRunner。占位 env 的任何方法调用 fail-closed 抛错——漏网路径
 * （未来新增工具忘了接 machine 面）吵着失败，不静默猜落点。
 *
 * 形态取舍：ExecutionEnv 接口 30+ 方法，手写占位类会在 SDK 升级增面时
 * 静默失配；Proxy 动态拦截天然覆盖全接口面——id/cwd 透传，执行面字符串
 * 属性统一返回失败桩，直接调用与可选能力检测都不会静默跳过；then 必须
 * 保持缺省，避免 await 的 Promise assimilation 把占位 env 当成 thenable。
 */
export function createPlaceholderExecutionEnv(cwd: string): ExecutionEnv {
  const target = { id: "unbound", cwd } as ExecutionEnv;
  const failures = new Map<string, () => never>();
  const failureFor = (prop: string): (() => never) => {
    let failure = failures.get(prop);
    if (!failure) {
      failure = () => {
        throw new Error(
          `execution environment method \`${prop}\` called without a bound machine `
          + "(uniform registration: no default machine). "
          + "Machine-scoped tools must rebuild env from the explicit `machine` parameter; "
          + "central-only tools must not touch the file/shell face.",
        );
      };
      failures.set(prop, failure);
    }
    return failure;
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "cwd" || prop === "id") return Reflect.get(t, prop, receiver);
      if (prop === "then") return undefined;
      if (typeof prop === "string") return failureFor(prop);
      return Reflect.get(t, prop, receiver);
    },
    set(t, prop, value, receiver) {
      return Reflect.set(t, prop, value, receiver);
    },
  });
}
