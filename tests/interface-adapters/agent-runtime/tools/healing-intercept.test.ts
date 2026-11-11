/**
 * issue #1842：interceptHealingReport 契约回归（F20261111hrepl）。
 *
 * 覆盖验收 5 的 repo.create 调用、非法块响亮反馈、讲解示例零落账。
 * 合法 YAML 列表落账+剥离不回归由 healing-alert-registry.test.ts 既有用例覆盖
 * （实现后其返回结构断言同步为 { cleanBody }）。
 */
import { describe, it, expect, vi } from "vitest";
import { interceptHealingReport } from "@interface-adapters/agent-runtime/tools/healing-tools";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";

function makeCtx(): ToolContext {
  return {
    otterId: "otter-1",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
  } as unknown as ToolContext;
}

function makeRepo(): { repo: HealingEventRepository; creates: Array<Record<string, unknown>> } {
  const creates: Array<Record<string, unknown>> = [];
  const repo = {
    create: vi.fn(async (e: Record<string, unknown>) => { creates.push(e); }),
  } as unknown as HealingEventRepository;
  return { repo, creates };
}

describe("issue #1842 intercept 契约", () => {
  it("JSON 单对象现场：repo.create 被调用落账（真实上报不静默丢失）", () => {
    const { repo, creates } = makeRepo();
    const raw = `<healing>
{"type":"runtime_status_mismatch","description":"用户看到休息中，但实际在运行"}
</healing>`;
    interceptHealingReport(raw, makeCtx(), repo);
    expect(creates).toHaveLength(1);
    expect((creates[0] as { errorType: string }).errorType).toBe("runtime_status_mismatch");
  });

  it("非法 JSON 块（缺 type）：返回可操作错误，不静默", () => {
    const { repo } = makeRepo();
    const raw = `<healing>
{"description":"没有 type 字段"}
</healing>`;
    const result = interceptHealingReport(raw, makeCtx(), repo) as unknown as { error: string | null };
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("type");
  });

  it("代码围栏内的讲解示例：repo.create 不调用（零落账）", () => {
    const { repo, creates } = makeRepo();
    const raw = `说明：
\`\`\`text
<healing>[issues]
- type: other
  severity: high
  description: ...
  suggestion: ...
[/issues]
</healing>
\`\`\``;
    interceptHealingReport(raw, makeCtx(), repo);
    expect(creates).toHaveLength(0);
  });

  it("行内代码中的完整 JSON 示例：repo.create 不调用且正文保留", () => {
    const { repo, creates } = makeRepo();
    const raw = '讲解：`<healing>{"type":"other","description":"example"}</healing>`';
    const result = interceptHealingReport(raw, makeCtx(), repo);
    expect(result.error).toBeNull();
    expect(result.cleanBody).toBe(raw);
    expect(creates).toHaveLength(0);
  });

  it("YAML 同块有缺 description 条目：整体报错且 repo.create 零调用", () => {
    const { repo, creates } = makeRepo();
    const raw = `<healing>[issues]
- type: tool_failure
  severity: high
- type: other
  description: otherwise valid
[/issues]</healing>`;
    const result = interceptHealingReport(raw, makeCtx(), repo);
    expect(result.error).toContain("description");
    expect(result.cleanBody).toBe(raw);
    expect(creates).toHaveLength(0);
  });
});
