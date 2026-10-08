/**
 * Matter 工具（F20261006mtlp P1：list_matters / transition_matter；F20261006mlp2 P2：register_matter；
 * F20261008mlp3 P3：matter_sweep 跨对话停滞扫描——未闭环扫描升格的确定性数据源）。
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
import { RegisterMatter, matterShortAnchor } from "@usecases/matter/register-matter";
import { MatterSweep, type MatterSweepStall, type MatterSweepStalledRow } from "@usecases/matter/matter-sweep";
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

/** 代执行声明校验：on_behalf_of 非空即强制 resolution 留痕（N2——宣告权分权的审计面） */
function validateProxyParams(params: Record<string, unknown>): string | null {
  const onBehalf = (params.on_behalf_of as string | undefined)?.trim();
  if (!onBehalf) return null;
  const resolution = (params.resolution as string | undefined)?.trim();
  if (!resolution) {
    return `[错误] 代执行迁移（on_behalf_of=${onBehalf}）必须填 resolution——` +
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
    description: "迁移本对话一件待办的状态（matters 表——状态迁移走 usecase 单入口）. When: 通道 A 对话直复——搭档回复了某件 open matter 的裁决，獭代执行板上迁移并复述确认（on_behalf_of='partner'）；或獭认领 OPEN 事项（→WAITING_OTTER）、宣称完成（→DONE_PENDING_CONFIRM）. Not for: 查清单（用 list_matters）/ 跨对话迁移（守卫拒绝）. Output: 迁移确认（新状态 + 结果/等待方回显）. GOTCHA: ①迁移矩阵守卫（非法组合拒绝）；②触发者守卫——partner 专属迁移（裁决/翻案/不做）须 on_behalf_of='partner' 代执行声明，owner 专属迁移（干完呈拍板/宣称完成）须 owner 自己或 on_behalf_of=<ownerId>；③宣告权——L2 闭环（DONE_PENDING_CONFIRM→CLOSED）必须搭档确认，代执行声明 on_behalf_of='partner' 也算（resolution 必填「代搭档执行：<原话>」）；④闭环类迁移必须填 resolution；⑤代执行（on_behalf_of 非空）任何迁移都必须填 resolution——写明「代搭档执行：<原话>」留痕.",
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

/**
 * register_matter（F20261006mlp2 P2——通道 B 「+」登记入口的执行载体）。
 *
 * 板上「登记一件事」按钮合成 html-matter-action register 回执（准入路径 2：搭档
 * 手动登记，initialState=OPEN），由被唤醒獭用本工具登记到待办板。这补齐了
 * P1 只把 RegisterMatter 接在 yield 打标路径（准入路径 1）上的缺口——
 * 回执让獭去登记，但工具面没注册登记工具 = 登记必丢（严重1死链）。
 *
 * 准入纪律：登记即 OPEN（搭档手动，非 yield 打标）。title 必填；owner 缺省=
 * 登记獭自己（认领这件事）；level 缺省不标。
 *
 * 防泛滥边界（如实声明，审视 delta 建议①修正）：RegisterMatter usecase **不做**
 * 调用方权限校验（它注释明言「调用方权限不在本层」）；本工具只是物理载体。
 * 防泛滥靠**纪律约束**（identity「待办裁决纪律」——登记仅限搭档板上「+」入口或
 * 搭档明确说「回头再说」），不做代码层校验。若实战出现獭滥用登记，再收紧准入——
 * 本期不过度工程。
 */
export function createRegisterMatterTool(ctx: ToolContext, matterRepo: MatterRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const title = (params.title as string | undefined)?.trim();
    if (!title) {
      return errorResponse("[错误] title 必填——一句话说清这件事（如「回头再看的重构项」）。");
    }
    const register = new RegisterMatter(matterRepo);
    try {
      const created = await register.execute({
        conversationId: ctx.conversationId,
        title,
        ownerOtterId: (params.owner_otter_id as string | undefined)?.trim() || ctx.otterId,
        level: (params.level as 'L1' | 'L2' | undefined) ?? null,
        initialState: 'OPEN',
        waitingOn: null,
        waitingFor: (params.waiting_for as string | undefined)?.trim() || null,
      });
      return textResponse(
        `[matter] 已登记 ${matterShortAnchor(created.id)}「${created.title}」（状态 OPEN，owner=${(created.ownerOtterId ?? '').slice(0, 8) || '未指派'}）`,
      );
    } catch (err) {
      return errorResponse(`[错误] ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    name: "register_matter",
    description: "登记本对话一件待办（matters 表——准入路径 2：搭档手动登记）. When: 搭档在待办板点「+」合成 html-matter-action register 回执、獭被唤醒后照做登记（initialState=OPEN）；或獭在对话里识别搭档说「回头再说/记下这件事」主动登记. Not for: L2 决策拍板项（那走 yield 打标自动登记，准入路径 1）/ 迁移状态（用 transition_matter）. Output: 登记确认（新 matter 短锚 + 状态 OPEN）. GOTCHA: ①登记即 OPEN（非 WAITING_PARTNER——那是 yield 打标路径的态）；②owner 缺省=登记獭自己（认领）；③登记后若要知道后续谁接，看板上 owner。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话事情名（必填）" },
        owner_otter_id: { type: "string", description: "负责獭（缺省=登记獭自己认领）" },
        level: { type: "string", enum: ["L1", "L2"], description: "决策分级（缺省不标；L0 不产生 matter——准入白名单产生不了）" },
        waiting_for: { type: "string", description: "在等什么动作（一句话，可选）" },
      },
      required: ["title"],
    },
    execute: exec,
  };
}

/**
 * matter_sweep（F20261008mlp3 P3——未闭环扫描升格的确定性数据源）。
 *
 * 跨对话停滞扫描：OPEN 无人认领 / WAITING_PARTNER 积压——跨日未收尾（24h 基准）。
 * 只读；调用方（三省吾身大獭）负责提醒，不做自动处置。
 *
 * 权限模型：仅大獭型注册（session-helpers getOtterToolNamesForType 白名单控制），
 * small 型不持有——跨对话查询权与编排权对齐（P3 定案：扫描跑在三省吾身对话，
 * matter 工具按对话隔离，跨对话查询需要大獭专属工具）。
 */
export function createMatterSweepTool(ctx: ToolContext, matterRepo: MatterRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const sweep = new MatterSweep(matterRepo);
    const now = params.now ? new Date(params.now as string) : new Date();
    if (isNaN(now.getTime())) {
      return errorResponse("[错误] now 参数不是合法时间戳（ISO 8601）。");
    }
    const result = await sweep.execute(now, (params.yield_lookback_days as number) ?? 7);

    const lines: string[] = [];
    if (result.stalled.length > 0) {
      lines.push(`停滞 matter（${result.stalled.length} 件）：`);
      for (const m of result.stalled) {
        lines.push(formatStallLine(m));
      }
    } else {
      lines.push("停滞 matter：无");
    }

    lines.push("");
    if (result.unregisteredYields.length > 0) {
      lines.push(`候选漏登记 yield（${result.unregisteredYields.length} 条，近 ${(params.yield_lookback_days as number) ?? 7} 天，已排除已登记 matter）：`);
      for (const y of result.unregisteredYields) {
        lines.push(formatYieldLine(y));
      }
      lines.push("（严重3修复：SQL 已 LEFT JOIN 排除已登记 matter，输出带 originMessageId——去重键=originMessageId；expects_partner_decision 未持久化，L2 甄别看 body/payload 含拍板语义）");
    } else {
      lines.push("候选漏登记 yield：无");
    }

    return textResponse(lines.join("\n"));
  };
  return {
    name: "matter_sweep",
    description: "跨对话停滞扫描（未闭环扫描升格——确定性数据源）. When: 三省吾身每日 7:30 扫描，或獭主动排查跨对话未闭环事项. Not for: 本对话 matters 清单（用 list_matters）/ 迁移状态（用 transition_matter）/ 扫描结果是提醒素材不是处置指令——边界条款「只提醒不处置」. Output: 停滞 matter 列表（短锚+标题+状态+等待方+等待时长）+ 候选漏登记 yield 列表（近 7 天超阈未登记 matter 的 yield 条目）. GOTCHA: ①停滞定义 = OPEN 无人认领 / WAITING_PARTNER 积压（24h 基准）；②提醒语义 = 让等待有声（含短锚+等待时长+等谁的什么动作），不是催办不是自动处置；③跨对话查询权仅大獭型持有（small 型白名单不含本工具）；④yield 兜底半径 = 近 7 天超阈未登记 matter 的 yield 条目，去重键 = originMessageId。",
    parameters: {
      type: "object",
      properties: {
        now: { type: "string", description: "扫描基准时间（ISO 8601，缺省=当前时间——测试可注入）" },
        yield_lookback_days: { type: "number", description: "yield 兜底回看天数（默认 7 天）" },
      },
    },
    execute: exec,
  };
}

/** 停滞 matter 单行格式化（短锚+标题+状态+等待方+等待时长） */
function formatStallLine(m: MatterSweepStall): string {
  const anchor = matterShortAnchor(m.id);
  const stateLabel = m.state === 'OPEN' ? 'OPEN（无人认领）' : 'WAITING_PARTNER（积压）';
  const waitDesc = m.waitingOn
    ? `等待 ${m.waitingOn}${m.waitingFor ? `（${m.waitingFor}）` : ''}`
    : '无明确等待方';
  return `[${anchor}] ${m.title}\n  状态: ${stateLabel} · ${m.stalledHours}h 未动 · ${waitDesc}`;
}

/** 漏登记 yield 单行格式化（yield 条目锚点+去重键+来源+时间） */
function formatYieldLine(y: MatterSweepStalledRow): string {
  const shortId = y.id.slice(0, 8);
  const bodyPreview = y.body ? (y.body.length > 60 ? y.body.slice(0, 60) + '…' : y.body) : '';
  return `[yield:${shortId}] ${y.senderName || y.senderId || '未知獭'} · ${y.createdAt}\n  originMessageId=${y.originMessageId}\n  ${bodyPreview}`;
}
