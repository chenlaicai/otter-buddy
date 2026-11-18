/**
 * F20261118belif P1a：主动记忆层（belief）写入守卫。
 *
 * 四维出处校验（otter-memory-design v4 §3.2）+ 状态机迁移守卫（§3.3）+ 防环（§3.3）。
 * 机器校验挡「无源之水」：空出处 / ID 不存在 / 来源身份不符 = 拒收（视为编造）。
 * 代码校验不靠提示词（v4 §5 硬约束 2）。
 */
import type { BeliefKind, BeliefStatus } from "@entities/memory/belief";
import type { MemoryEntry } from "@entities/memory/memory-entry";

/** 锚点消息发送者身份（entries 表读取） */
export interface MessageSender {
  senderType: string | null;
  senderId: string | null;
}

/** belief 守卫所依赖的读取端口（窄接口，便于测试与实现解耦） */
export interface BeliefGuardPorts {
  /** 按 id 查 memory_entries 条目（出处锚点存在性 + conversationId 引用范围） */
  getEntryById(id: string): Promise<MemoryEntry | null>;
  /** 按 message 条目 id 查其发送者身份（entries 表；四维校验第 2 条） */
  getMessageSender(messageEntryId: string): Promise<MessageSender | null>;
}

export interface ValidateBeliefInput {
  kind: BeliefKind;
  status: BeliefStatus;
  content: string;
  anchors: string[];
  inferredFrom?: string[];
  supersedes?: string;
  /** 本次写入所属对话（引用范围校验：message 锚点必须属于本对话） */
  conversationId: string;
  /** 本对话搭档（用户）id——preference 来源身份校验用 */
  partnerUserId: string;
  /** 当前时间（防环比较用；测试注入） */
  nowMs?: number;
}

/** belief 内容长度上限（对齐 fact ≤500 先例，v4 §7 防主动记忆噪声增长） */
export const BELIEF_MAX_CONTENT_CHARS = 500;

/** 一条校验失败（结构化，便于调用方透出给 agent） */
export interface BeliefGuardError {
  dimension: "anchor_existence" | "anchor_identity" | "anchor_scope" | "inference_basis" | "transition" | "cycle" | "content_length";
  message: string;
}

export type BeliefGuardResult =
  | { ok: true }
  | { ok: false; errors: BeliefGuardError[] };

/**
 * P1a: 合法状态机迁移矩阵（§3.3）。
 * - recorded → verified：夜间核实通过
 * - recorded → disputed：夜间打回 / 搭档否决
 * - recorded → superseded：现场即时纠正（尚未核实即被取代）
 * - verified → disputed：复审发现错 / 搭档否决
 * - verified → superseded：带正确锚点的纠正重写
 * - disputed → recorded：重新入审
 * - disputed → superseded：打回后被新 belief 取代
 * superseded 为终态，无出边。
 */
const LEGAL_TRANSITIONS: ReadonlyMap<BeliefStatus, ReadonlySet<BeliefStatus>> = new Map([
  ["recorded", new Set<BeliefStatus>(["verified", "disputed", "superseded"])],
  ["verified", new Set<BeliefStatus>(["disputed", "superseded"])],
  ["disputed", new Set<BeliefStatus>(["recorded", "superseded"])],
  ["superseded", new Set<BeliefStatus>()],
]);

/** 纯函数：判断 from→to 状态迁移是否合法（供工具层与测试复用） */
export function isLegalBeliefTransition(from: BeliefStatus, to: BeliefStatus): boolean {
  return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

export class BeliefGuard {
  constructor(private readonly ports: BeliefGuardPorts) {}

  /** 校验一条新 belief 的完整合法性（写入前调用；新条目 status 必须为 recorded） */
  async validate(input: ValidateBeliefInput): Promise<BeliefGuardResult> {
    // 新条目只能以 recorded 出生（verified/disputed/superseded 是后续迁移态，不由写入路径产生）
    if (input.status !== "recorded") {
      return {
        ok: false,
        errors: [{
          dimension: "transition",
          message: `新 belief 条目 status 必须为 recorded（收到 ${input.status}）——verified/disputed/superseded 只由状态迁移产生`,
        }],
      };
    }

    const errors: BeliefGuardError[] = [];
    this.validateBasicConstraints(input, errors);
    await this.validateAnchors(input, errors);
    await this.validateInferenceBasis(input, errors);
    await this.validateSupersede(input, errors);
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }

  /** 空出处 + 内容长度上限（两者都属「拒收」级硬约束） */
  private validateBasicConstraints(input: ValidateBeliefInput, errors: BeliefGuardError[]): void {
    if (input.anchors.length === 0) {
      errors.push({ dimension: "anchor_existence", message: "出处锚点为空——空出处拒收（v4 硬约束 2：空 = 拒收）" });
    }
    if (input.content.trim().length > BELIEF_MAX_CONTENT_CHARS) {
      errors.push({
        dimension: "content_length",
        message: `belief 内容超长（${input.content.trim().length} > ${BELIEF_MAX_CONTENT_CHARS}）——防主动记忆噪声增长限长`,
      });
    }
  }

  /** 四维 1/2/3：anchors 存在性 + 来源身份 + 引用范围 */
  private async validateAnchors(input: ValidateBeliefInput, errors: BeliefGuardError[]): Promise<void> {
    for (const anchorId of input.anchors) {
      const entry = await this.ports.getEntryById(anchorId);
      if (!entry) {
        errors.push({ dimension: "anchor_existence", message: `出处锚点 ${anchorId} 不存在——空/编造出处拒收` });
        continue;
      }
      await this.validateAnchorIdentityAndScope(input, entry, anchorId, errors);
    }
  }

  /** 四维 4：state（推断类）必须给推断依据，且依据条目存在 */
  private async validateInferenceBasis(input: ValidateBeliefInput, errors: BeliefGuardError[]): Promise<void> {
    if (input.kind !== "state") return;
    if (!input.inferredFrom || input.inferredFrom.length === 0) {
      errors.push({ dimension: "inference_basis", message: "state 类 belief 必须标注「推断」并给出 inferredFrom 依据条目" });
      return;
    }
    for (const basisId of input.inferredFrom) {
      const basis = await this.ports.getEntryById(basisId);
      if (!basis) {
        errors.push({ dimension: "inference_basis", message: `推断依据条目 ${basisId} 不存在` });
      }
    }
  }

  /** 防环：supersedes 目标必须存在、为 belief、且 createdAt 早于本条目 */
  private async validateSupersede(input: ValidateBeliefInput, errors: BeliefGuardError[]): Promise<void> {
    if (!input.supersedes) return;
    const target = await this.ports.getEntryById(input.supersedes);
    if (!target) {
      errors.push({ dimension: "cycle", message: `supersedes 目标 ${input.supersedes} 不存在` });
      return;
    }
    if (target.contentType !== "belief") {
      errors.push({ dimension: "cycle", message: `supersedes 目标 ${input.supersedes} 不是 belief 条目（contentType=${target.contentType}）` });
      return;
    }
    const targetMs = Date.parse(target.createdAt);
    const sourceMs = input.nowMs ?? Date.now();
    if (!Number.isFinite(targetMs) || targetMs >= sourceMs) {
      errors.push({
        dimension: "cycle",
        message: `supersedes 目标 ${input.supersedes} createdAt 未早于源条目——记忆图不允许 A↔B 互替环`,
      });
    }
  }

  /** 四维 2 + 3：单个锚点的来源身份与引用范围 */
  private async validateAnchorIdentityAndScope(
    input: ValidateBeliefInput,
    anchorEntry: MemoryEntry,
    anchorId: string,
    errors: BeliefGuardError[],
  ): Promise<void> {
    if (input.kind !== "preference") {
      // state 类不卡来源身份（推断本就来自消息）；message 锚点仍卡本对话引用范围
      if (anchorEntry.contentType === "message" && anchorEntry.conversationId !== input.conversationId) {
        errors.push({
          dimension: "anchor_scope",
          message: `出处锚点 ${anchorId} 属于其他对话，不在本会话可引用范围`,
        });
      }
      return;
    }

    // preference：锚点必须 senderType=user ∧ senderId=本对话搭档
    const sender = await this.ports.getMessageSender(anchorId);
    if (!sender) {
      errors.push({
        dimension: "anchor_identity",
        message: `preference 锚点 ${anchorId} 无法解析发送者身份（非消息条目或已不存在）`,
      });
      return;
    }
    if (sender.senderType !== "user" || sender.senderId !== input.partnerUserId) {
      errors.push({
        dimension: "anchor_identity",
        message: `preference 锚点 ${anchorId} 不是本对话搭档原话（senderType=${sender.senderType}, senderId=${sender.senderId}）——搭档喜好只能锚搭档原话`,
      });
    }
  }
}