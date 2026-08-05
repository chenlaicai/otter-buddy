/**
 * 共享假 AgentGateway 工厂。替代各测试文件中 4 份重复的 fakeAgentGateway 副本。
 *
 * 定位：seam 掉 pi 层（不落 jsonl 文件），记录 create/reset/destroy 调用供断言。
 * 模式来源：tests/usecases/otter/restart-flow.integration.test.ts。
 */
import type { AgentConfig, AgentContext, AgentGateway } from "@usecases/otter/agent-gateway";

export interface AgentGatewayCall {
  method: "create" | "reset" | "destroy";
  otterId: string;
  config?: AgentConfig;
  context?: AgentContext;
}

export interface FakeAgentGateway extends AgentGateway {
  /** 全部调用记录，按发生顺序 */
  readonly calls: AgentGatewayCall[];
  /** 过滤某方法的调用 */
  callsOf(method: AgentGatewayCall["method"]): AgentGatewayCall[];
  /** 测试钩子：替换 reset 行为（如模拟竞态窗口内建行） */
  onReset?: (otterId: string, context?: AgentContext) => Promise<void>;
}

export function fakeAgentGateway(): FakeAgentGateway {
  const calls: AgentGatewayCall[] = [];
  const gateway: FakeAgentGateway = {
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method),
    async create(otterId, config) {
      calls.push({ method: "create", otterId, config });
    },
    async reset(otterId, context) {
      calls.push({ method: "reset", otterId, context });
      if (gateway.onReset) await gateway.onReset(otterId, context);
    },
    async destroy(otterId) {
      calls.push({ method: "destroy", otterId });
    },
  };
  return gateway;
}
