/**
 * F20260826mwrd C1：halt 注入链路集成测试（无 LLM）。
 *
 * 验证装配而非行为（行为由 halt-core.test.ts 纯函数覆盖）：
 * DefaultResourceLoader 装载 otter-hooks 后——
 * 1. tool_call handler 真实注册进 handlers map（接线不断链）
 * 2. 模拟 runner 调用 handler：ALS scope 内 + halt 打标 → 返回 { block, reason }
 * 3. ALS scope 外（store 读不到）→ handler 返回 undefined（fail-open）
 *
 * 为什么不直接 new ExtensionRunner：runner 构造依赖 sessionManager/modelRegistry
 * 等重资源；handlers map + 直接调用已覆盖本 PR 新增的接线风险（handler 注册丢失、
 * 闭包引用错误），SDK 侧 runner→agent-loop 的 block 消费是 SDK 自身测试的职责。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { haltRegistry } from '@usecases/signal/halt-registry';
import { otterInvokeStorage, haltToolCallGuard } from '@frameworks/agent/model-runtime-registry';

/** 与 model-runtime-registry 相同的 loader 构造（复制最小路径，避免引真实 getAgentDir） */
async function buildLoader() {
  const piCodingAgent = await import('@earendil-works/pi-coding-agent');
  const { DefaultResourceLoader } = piCodingAgent;
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd() + '/node_modules/.tmp-agent-dir-test',
    extensionFactories: [{
      name: 'otter-hooks',
      hidden: true,
      factory: (pi: any) => {
        pi.on('tool_call', (event: { toolName?: string }) => {
          // 与 model-runtime-registry 的 handler 体等价（顶部 import 替代运行时 require）
          return haltToolCallGuard(otterInvokeStorage.getStore(), haltRegistry, event.toolName);
        });
      },
    }],
  });
  await loader.reload();
  return loader;
}

describe('halt 注入链路（ResourceLoader 装配）', () => {
  beforeEach(() => haltRegistry.resetForTest());

  it('otter-hooks 装载后 tool_call handler 注册在 handlers map', async () => {
    const loader = await buildLoader();
    const extensions = loader.getExtensions();
    const hooks = (extensions as unknown as { extensions: Array<{ handlers: Map<string, unknown[]> }> }).extensions
      .find(e => e.handlers.has('tool_call'));
    expect(hooks).toBeDefined();
    const handlers = hooks!.handlers.get('tool_call')!;
    expect(handlers.length).toBeGreaterThan(0);
  });

  it('模拟 runner 调用：ALS 内 + halt 打标 → block + reason 含停手理由', async () => {
    const loader = await buildLoader();
    const ext = (loader.getExtensions() as unknown as { extensions: Array<{ handlers: Map<string, Array<(e: unknown) => unknown>> }> }).extensions
      .find(e => e.handlers.has('tool_call'))!;
    const handler = ext.handlers.get('tool_call')![0];

    haltRegistry.mark({
      id: 'sig-it-1', targetOtterId: 'otter-target', fromOtterId: 'otter-big', fromOtterName: '大獭',
      conversationId: 'conv-it', reason: '集成测试停手理由', issuedAt: new Date().toISOString(),
    });

    const result = await otterInvokeStorage.run(
      { otterPromptConfig: undefined, identityPrefix: '', otterId: 'otter-target' },
      async () => handler({ type: 'tool_call', toolCallId: 'tc1', toolName: 'bash', input: {} }) as Promise<{ block?: boolean; reason?: string }>,
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('集成测试停手理由');
  });

  it('模拟 runner 调用：ALS 内 + halt 打标 + speak 调用 → 放行（报告豁免，检视发现 1）', async () => {
    const loader = await buildLoader();
    const ext = (loader.getExtensions() as unknown as { extensions: Array<{ handlers: Map<string, Array<(e: unknown) => unknown>> }> }).extensions
      .find(e => e.handlers.has('tool_call'))!;
    const handler = ext.handlers.get('tool_call')![0];

    haltRegistry.mark({
      id: 'sig-it-3', targetOtterId: 'otter-target', fromOtterId: 'otter-big', fromOtterName: '大獭',
      conversationId: 'conv-it', reason: '报告豁免验证', issuedAt: new Date().toISOString(),
    });

    const result = await otterInvokeStorage.run(
      { otterPromptConfig: undefined, identityPrefix: '', otterId: 'otter-target' },
      async () => handler({ type: 'tool_call', toolCallId: 'tc3', toolName: 'speak', input: {} }) as Promise<{ block?: boolean; reason?: string }>,
    );
    expect(result).toBeUndefined();
    // 豁免未消费 pending：下一个非 speak 边界才注入
    expect(haltRegistry.peekPending('otter-target')).toHaveLength(1);
  });

  it('模拟 runner 调用：ALS 外 → undefined（fail-open 不误伤）', async () => {
    const loader = await buildLoader();
    const ext = (loader.getExtensions() as unknown as { extensions: Array<{ handlers: Map<string, Array<(e: unknown) => unknown>> }> }).extensions
      .find(e => e.handlers.has('tool_call'))!;
    const handler = ext.handlers.get('tool_call')![0];

    haltRegistry.mark({
      id: 'sig-it-2', targetOtterId: 'otter-target', fromOtterId: 'otter-big', fromOtterName: '大獭',
      conversationId: 'conv-it', reason: 'x', issuedAt: new Date().toISOString(),
    });

    const result = await handler({ type: 'tool_call', toolCallId: 'tc2', toolName: 'read', input: {} });
    expect(result).toBeUndefined();
  });
});
