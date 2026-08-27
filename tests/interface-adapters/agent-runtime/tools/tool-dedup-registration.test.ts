/**
 * F20260826mwrd C3（#534）：manage_healing_events 双注册修复的防回归断言。
 *
 * 双注册史：tool-factory 内注册 + platforms.ts 闭包二次 push（C1 审视顺手发现）。
 * 修复后唯一注册点 = tool-factory（healingRepo 注入时）。
 * 本测试锚定「同一工具名不重复出现」不变量——任何注册路径回归都会红。
 */
import { describe, it, expect } from 'vitest';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';

function makeCtx(): ToolContext {
  return {
    client: {},
    otterId: 'otter-1',
    conversationId: 'conv-1',
    currentMessageId: 'msg-1',
  } as unknown as ToolContext;
}

const healingRepo = {} as HealingEventRepository;

describe('#534 manage_healing_events 唯一注册（tool-factory 是唯一注册点）', () => {
  it('healingRepo 注入时 createTools 返回的工具名无重复', () => {
    const tools = createTools(makeCtx(), healingRepo);
    const names = tools.map(t => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `重复注册: ${dupes.join(', ')}`).toEqual([]);
    expect(names).toContain('manage_healing_events');
  });

  it('healingRepo 缺省时 manage_healing_events 不注册（manifest 面不变）', () => {
    const tools = createTools(makeCtx());
    expect(tools.map(t => t.name)).not.toContain('manage_healing_events');
  });
});
