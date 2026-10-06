/**
 * Matter 工具（F20261005mtlp P1）：list_matters / transition_matter。
 *
 * 通道 A 代执行（§3.5）：搭档对话直复裁决后，被唤醒獭用本工具代执行板上迁移——
 * `on_behalf_of='partner'` 声明代搭档执行（resolution 必填「代搭档执行：<原话>」留痕），
 * 非 owner 獭代 owner 执行同理（`on_behalf_of=<ownerId>`）。不声明 = 獭以自己身份。
 * 空窗期裁决仍走对话直复（通道 A），板上按钮（通道 B）在 P2。
 *
 * 权限模型：守卫在 TransitionMatter usecase（矩阵 + 触发者身份 + 宣告权三层），
 * 工具层透传代执行声明，不做身份判定。
 */

import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import type { MatterRepository } from "@usecases/matter/matter-repository";
import { ListMatters } from "@usecases/matter/list-matters";
import { TransitionMatter, type TransitionMatterInput } from "@usecases/matter/transition-matter";
import { matterShortAnchor } from "@usecases/matter/register-matter";
import type { MatterState } from "@entities/matter/matter";

const VALID_STATES: readonly string[] = [
  'OPEN', 'WAITING_OTTER', 'WAITING_PARTNER', 'DONE_PENDING_CONFIRM',
  'CLOSED', 'SUPERSEDED', 'ABANDONED',
];

/** 短 ID 解析：M-xxx 前缀或 UUID 前 8 位 → 本对话完整 ID（query 回显用短锚） */
async function resolveMatterId(
  ctx: ToolContext,
  matterRepo: MatterRepository,
  idOrAnchor: string,
): Promise<{ id: string } | { error: string }> {
  const raw = idOrAnchor.trim();
  // 完整 UUID 直用（幂等——findById 校验存在性）
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return { id: raw };
  }
  const prefix = raw.replace(/^M-/i, '');
  if (!/^[0-9a-f]{8}$/i.test(prefix)) {
    return { error: `ID「${raw}」不是合法 matter 锚（M-xxxxxxxx 或完整 UUID）。用 list_matters 查清单拿锚。` };
  }
  const candidates = await matterRepo.findByConversation(ctx.conversationId, undefined, 200);
  const hit = candidates.filter(m => m.id.startsWith(prefix));
  if (hit.length === 0) {
    return { error: `锚「${raw}」在本对话 matters 中无匹配。用 list_matters 确认。` };
  }
  if (hit.length > 1) {
    return { error: `锚「${raw}」命中 ${hit.length} 条，请用完整 UUID。` };
  }
  return { id: hit[0].id };
}

/** list_matters：本对话待办清单（open 列表；P1 只读呈现给獭查板） */
export function createListMattersTool(ctx: ToolContext, matterRepo: MatterRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const listMatters = new ListMatters(matterRepo);
    const includeClosed = params.include_closed === true;
    const matters = includeClosed
      ? await listMatters.byConversation(ctx.conversationId, undefined, (params.limit as number) ?? 50)
      : await listMatters.openByConversation(ctx.conversationId, (params.limit as number) ?? 50);
    if (matters.length === 0) {
      return textResponse(includeClosed ? "（本对话无 matters 记录）" : "（本对话待办板为空——无未闭环事项）");
    }
    const lines = matters.map(m =>
      `[${matterShortAnchor(m.id)}] ${m.title}\n` +
      `  状态: ${m.state}${m.level ? ` · ${m.level}` : ''}${m.ownerOtterId ? ` · owner=${m.ownerOtterId.slice(0, 8)}` : ''}\n` +
      (m.waitingOn ? `  等待: ${m.waitingOn}${m.waitingFor ? `（${m.waitingFor}）` : ''}\n` : '') +
      (m.resolution ? `  结果: ${m.resolution.length > 100 ? m.resolution.slice(0, 100) + '…' : m.resolution}` : ''),
    );
    return textResponse(`matters（${matters.length} 件${includeClosed ? '，含已闭环' : '，未闭环'}）：\n${lines.join('\n')}`);
  };
  return {
    name: "list_matters",
    description: "查询本对话的待办清单（matters 表——未闭环事情台账）. When: 獭查板/接班时了解本对话未闭环事项；通道 A 对话直复裁决前确认搭档回复对应哪件 matter. Not for: 迁移状态（用 transition_matter）/ 跨对话查询（matters 按对话隔离）. Output: open 事项列表（短锚 M-xxx/标题/状态/等待方）.",
    parameters: {
      type: "object",
      properties: {
        include_closed: { type: "boolean", description: "true 时含已闭环事项（翻案查看用）；缺省 false 只列未闭环" },
        limit: { type: "number", description: "返回条数上限（默认 50）" },
      },
    },
    execute: exec,
  };
}

/** transition_matter 参数校验（拆出控 exec 复杂度） */
function validateTransitionParams(params: Record<string, unknown>): string | null {
  const to = params.to as string | undefined;
  if (!to || !VALID_STATES.includes(to)) {
    return `[错误] to 必须是合法状态：${VALID_STATES.join(' / ')}。`;
  }
  const resolution = (params.resolution as string | undefined)?.trim();
  if (to === 'SUPERSEDED' && !resolution) {
    return "[错误] 迁移到 SUPERSEDED 必须填 resolution（被哪件新 matter 取代——写新 matter 的短锚或标题）。";
  }
  if ((to === 'CLOSED' || to === 'ABANDONED' || to === 'DONE_PENDING_CONFIRM') && !resolution) {
    return "[错误] 闭环类迁移（CLOSED/ABANDONED/DONE_PENDING_CONFIRM）必须填 resolution——结果/理由留痕是宣告权分权的审计面。";
  }
  return null;
}

/** transition 成功回执文本（拆出控 exec 复杂度） */
function buildTransitionEcho(m: { id: string; title: string; state: string; resolution: string | null; waitingOn: string | null; waitingFor: string | null }): string {
  return `[matter] ${matterShortAnchor(m.id)}「${m.title}」→ ${m.state}` +
    (m.resolution ? `\n  结果: ${m.resolution}` : '') +
    (m.waitingOn ? `\n  等待: ${m.waitingOn}${m.waitingFor ? `（${m.waitingFor}）` : ''}` : '');
}

/** tool 参数 → usecase 输入（未传字段不给值——null 在 usecase 语义 = 显式清空） */
function buildTransitionInput(ctx: ToolContext, params: Record<string, unknown>, matterId: string): TransitionMatterInput {
  const input: TransitionMatterInput = {
    matterId,
    to: params.to as MatterState,
    actor: ctx.otterId,
    resolution: (params.resolution as string | undefined)?.trim() || null,
    waitingFor: (params.waiting_for as string | undefined)?.trim() || null,
  };
  if (params.waiting_on !== undefined) {
    input.waitingOn = (params.waiting_on as string).trim() || null;
  }
  if (params.payload !== undefined) {
    input.payload = (params.payload as string).trim() || null;
  }
  if (params.on_behalf_of !== undefined) {
    input.onBehalfOf = (params.on_behalf_of as string).trim() || undefined;
  }
  return input;
}

/** 代执行声明校验：裁决类/partner 专属迁移代执行时 resolution 必须含留痕 */
function validateProxyParams(params: Record<string, unknown>): string | null {
  const onBehalf = (params.on_behalf_of as string | undefined)?.trim();
  if (!onBehalf) return null;
  const to = params.to as string;
  const proxyRows = ['CLOSED', 'ABANDONED', 'DONE_PENDING_CONFIRM', 'WAITING_OTTER'];
  const resolution = (params.resolution as string | undefined)?.trim();
  if (proxyRows.includes(to) && !resolution) {
    return '[错误] 代执行裁决类迁移（CLOSED/ABANDONED/DONE_PENDING_CONFIRM/WAITING_OTTER）必须填 resolution——' +
      `代${onBehalf === 'partner' ? '搭档' : '执行'}留痕是宣告权分权的审计面。`;
  }
  return null;
}

/** transition_matter：状态迁移单入口的执行载体（守卫在 usecase 三层） */
export function createTransitionMatterTool(ctx: ToolContext, matterRepo: MatterRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const matterId = params.matter_id as string | undefined;
    if (!matterId?.trim()) {
      return errorResponse("[错误] matter_id 必填——用 list_matters 查清单拿短锚（M-xxxxxxxx）。");
    }
    const paramError = validateTransitionParams(params) ?? validateProxyParams(params);
    if (paramError) return errorResponse(paramError);

    const resolved = await resolveMatterId(ctx, matterRepo, matterId);
    if ('error' in resolved) return errorResponse(`[错误] ${resolved.error}`);

    const transition = new TransitionMatter(matterRepo);
    try {
      const updated = await transition.execute(buildTransitionInput(ctx, params, resolved.id));
      return textResponse(buildTransitionEcho(updated));
    } catch (err) {
      return errorResponse(`[错误] ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    name: "transition_matter",
    description: "迁移本对话一件待办的状态（matters 表——状态迁移走 usecase 单入口）. When: 通道 A 对话直复——搭档回复了某件 open matter 的裁决，獭代执行板上迁移并复述确认（on_behalf_of='partner'）；或獭认领 OPEN 事项（→WAITING_OTTER）、宣称完成（→DONE_PENDING_CONFIRM）. Not for: 查清单（用 list_matters）/ 跨对话迁移（守卫拒绝）. Output: 迁移确认（新状态 + 结果/等待方回显）. GOTCHA: ①迁移矩阵守卫（非法组合拒绝）；②触发者守卫——partner 专属迁移（裁决/翻案/不做）须 on_behalf_of='partner' 代执行声明，owner 专属迁移（干完呈拍板/宣称完成）须 owner 自己或 on_behalf_of=<ownerId>；③宣告权——L2 闭环（DONE_PENDING_CONFIRM→CLOSED）必须搭档确认，代执行声明 on_behalf_of='partner' 也算（resolution 必填「代搭档执行：<原话>」）；④闭环类迁移必须填 resolution；⑤代执行时 resolution 写明「代搭档执行：<原话>」留痕.",
    parameters: {
      type: "object",
      properties: {
        matter_id: { type: "string", description: "matter 短锚（M-xxxxxxxx）或完整 UUID" },
        to: { type: "string", enum: [...VALID_STATES], description: "目标状态" },
        resolution: { type: "string", description: "裁决/闭环结果（闭环类迁移必填；代搭档执行写明「代搭档执行：<原话>」）" },
        waiting_on: { type: "string", description: "迁移后的等待方（otter:<id> / partner / none）" },
        waiting_for: { type: "string", description: "在等什么动作（一句话）" },
        payload: { type: "string", description: "决策请求挂点（L2 简报三层结构 JSON——呈拍板时附）" },
        on_behalf_of: { type: "string", description: "§3.5 代执行声明：'partner'（代搭档执行裁决）或 ownerOtterId（代 owner 执行）——不填=以自己身份" },
      },
      required: ["matter_id", "to"],
    },
    execute: exec,
  };
}
