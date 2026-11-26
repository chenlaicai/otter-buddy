/**
 * 对话状态（弱状态两态管理）
 * 搭档原话：「对话是弱状态管理，归档即移到独立空间」——completed 状态退役，
 * 只剩 active | archived；生产库零 completed 存量（2026-09-22 已核实），无需迁移。
 * completedAt 字段保留（DB 列不动，历史数据可读）。
 */
export type ConversationStatus = "active" | "archived";

/** ConversationKind 运行时单源（穷尽数组）+ 类型守卫。
 *  类型从数组派生（typeof[number]）——新增枚举值只改 CONVERSATION_KINDS 一处，
 * 漏进类型或漏进数组在编译期不可能（同一实体，1725-严重 1 证伪了
 * satisfies 子集锁的两个方向中防 有害方向的那个）。其余消费点
 *  （db mapper 白名单 / controller query 解析 / repo filter / api-contract /
 * 前端 mapper）均从本源派生或经守卫过滤——同型 bug 成因模式消除。 */
export const CONVERSATION_KINDS = ["normal", "assistant", "web-assistant", "external"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** 类型守卫：v 是否 ConversationKind 合法值（db mapper 白名单 / query 解析用） */
export function isConversationKind(v: unknown): v is ConversationKind {
  return typeof v === "string" && (CONVERSATION_KINDS as readonly string[]).includes(v);
}

/** 对话实体（无对话树，独立实体） */
export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  summary: string | null;
  pinned: boolean;
  /** 对话类别——assistant = IM 助理自动开户（schema 字段取代 title 前缀约定）；
   * web-assistant = web 浮动獭全局唯一助理对话 */
  kind: ConversationKind;
  /** 工作区相对路径（相对于 dataDir），null 表示无工作区（旧数据） */
  workspaceDir: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 测试/存量构造便捷类型——kind 可缺省（normal 默认）。
 *  实体接口 Conversation.kind 仍为必填，避免读端到处判 undefined；
 *  写端（create/insert）用 Conversations 兼容形式收敛可逃逸的可选性 */
export type ConversationInput = Omit<Conversation, "kind"> & { kind?: ConversationKind };

/** 归一化：缺省 kind 补 normal（构造入口统一，防止 undefined 流入写库路径） */
export function normalizeConversationInput(input: ConversationInput): Conversation {
  return { ...input, kind: input.kind ?? "normal" };
}

/** 产物生命周期状态 */
export type ArtifactStatus = "active" | "superseded" | "archived";

/** 链接资源实体（统一产物模型，resourceType="fact" 为文本类事实） */
export interface LinkedResource {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string | null;
  title: string | null;
  content: string | null;
  category: string | null;
  userFlagged: boolean;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
  status: ArtifactStatus;
  groupId: string | null;
  supersededBy: string | null;
  /** 对账归档审计：受控跨对话归档路径写入，普通 update_artifact_status 不写。 */
  archivedByOtterId: string | null;
  archivedAt: string | null;
  archiveEvidence: string | null;
}

/** 对话参与者状态（UA-4~UA-10 进场/退场机制） */
export type ParticipantStatus = "active" | "left";

/**
 * 对话参与者实体（UA-7 动态在场名单的唯一真相源）。
 *
 * - 初始参与者在 create() 时创建，后进场者通过 join() 创建
 * - 退场时更新 leftAt/status
 * - 每个 Otter 实例在一个对话中只进场/退场一次（UA-10）
 * - turn 戳字段（joinedAtTurnId/lastActiveTurnNumber 等）随 turn 系统退役；
 * 已读游标唯一刻度 = lastReadSeq（）
 */
export interface ConversationParticipant {
  id: string;
  conversationId: string;
  otterId: string;
  status: ParticipantStatus;
  createdAt: string;
  leftAt: string | null;
  /** 进场游标初值（写入时语义——仅 createParticipant(s) 落库时生效）。
   *  缺省 0 = 新对话初始化（空对话天然正确）；加入已有对话时由域层传进场时刻
   *  max(seq)（进场前历史不是未读）。读取侧游标真值在 participants 行上
   *  （rowToParticipant 不回填本字段）。 */
  lastReadSeq?: number;
}

/**
 * 对话状态转换（弱状态管理）：active -> archived
 * archived 为终态，不可再转换（无 unarchive 机制——归档即移到独立空间）
 */
export function canArchiveConversation(status: ConversationStatus): boolean {
  return status === "active";
}

/**
 * Otter 是否可以进场（UA-10）。
 * 无已有参与记录时可以进场（每个 Otter 实例只进场一次）。
 */
export function canJoinConversation(
  existingParticipant: ConversationParticipant | null,
): boolean {
  return existingParticipant === null;
}

/**
 * Otter 是否可以退场（UA-7）。
 * 当前状态为 active 时可以退场。
 */
export function canLeaveConversation(
  participant: ConversationParticipant | null,
): boolean {
  return participant !== null && participant.status === "active";
}

/**
 * 产物状态转换校验。
 * active -> superseded | archived
 * superseded -> archived
 * archived 为终态，不可转换。
 */
export function canTransitionArtifactStatus(
  from: ArtifactStatus,
  to: ArtifactStatus,
): boolean {
  if (from === to) return false;
  if (from === "archived") return false;
  if (from === "active") return to === "superseded" || to === "archived";
  if (from === "superseded") return to === "archived";
  return false;
}

/**
 * 受控对账归档的资源类型白名单。
 * 机械终态可判的资源类型 = 有明确外部机器证据的交付物：
 * pr（PR MERGED/CLOSED）、worktree（路径不存在/PR 已合入）、branch（PR 已合入）。
 * fact 不在此列但可走 merge-fact 判据（checkMergeFactResource——日报对账段真相源口径：
 * title 含「合入」+ PR 号可解析 + evidence 含终态词与对应号）；file/url/game 一律拒绝。
 */
export const RECONCILIATION_ARCHIVABLE_RESOURCE_TYPES: ReadonlySet<string> = new Set(["pr", "worktree", "branch"]);

/** 资源类型是否可经受控对账路径归档。 */

export type MergeFactCheck =
  | { ok: true; prNums: string[] }
  | { ok: false; reason: "not_merge_fact" | "no_pr_number" | "no_terminal_evidence" };

/**
 * 「合入事实」类 fact 的结构判据（对账归档扩展，统一工具与日报对账段契约）。
 * 与 pr/worktree/branch 同信任模型：工具做结构校验（title 含「合入」+ PR 号可解析 +
 * evidence 含 MERGED/CLOSED 终态词且含对应 PR 号），PR 终态的真实性由调用方核实、
 * evidence 全文落审计三列事后可查——工具不执行外部命令。
 * 三类结构缺陷分别对应日报关闭标准的拒绝面：非合入事实 / 无法解析 PR / 非终态证据缺失。
 */
export function checkMergeFactResource(
  resource: { resourceType: string; title?: string | null; content?: string | null },
  evidence: string,
): MergeFactCheck {
  if (resource.resourceType !== "fact") return { ok: false, reason: "not_merge_fact" };
  const title = resource.title ?? "";
  if (!title.includes("合入")) return { ok: false, reason: "not_merge_fact" };
  const body = `${title} ${resource.content ?? ""}`;
  const prNums = [...body.matchAll(/#(\d+)/g)].map(m => m[1]);
  if (prNums.length === 0) return { ok: false, reason: "no_pr_number" };
  // 证据行绑定（对抗审视对抗审视发现）：终态词与对应 PR 号必须在**同一行**内绑定出现——
  // 全文聚合匹配可被拼凑证据绕过（A 行 9999 MERGED + B 行 1378 OPEN、日期年份撞 对应编号 号）。
  // 否定形态（NOT MERGED / NOT CLOSED / 未合入 / 未合并）不计终态。
  // 残余边界：同一行内混排多个 PR 时以「号在行内出现 + 行内有终态词」近似绑定，
  // 构造性行内错配靠 evidence 全文审计留痕兜底（事后可查可追责）。
  const hasTerminal = evidence
    .split(/\r?\n|；|;/)
    .some(rawLine => {
      // 日期形态先剥离（日期年份恰好等于声明 PR 号时会误配；对抗回归用例钉住）
      const line = rawLine.replace(/\d{4}-\d{2}-\d{2}/g, "[date]");
      if (!/\b(MERGED|CLOSED)\b/i.test(line)) return false;
      if (/\bNOT[ -]?MERGED\b|\bNOT[ -]?CLOSED\b|未合入|未合并/i.test(line)) return false;
      return prNums.some(n => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(line));
    });
  if (!hasTerminal) return { ok: false, reason: "no_terminal_evidence" };
  return { ok: true, prNums };
}
export function isReconciliationArchivableType(resourceType: string): boolean {
  return RECONCILIATION_ARCHIVABLE_RESOURCE_TYPES.has(resourceType);
}

/** 产物是否处于活跃状态 */
export function isArtifactActive(status: ArtifactStatus): boolean {
  return status === "active";
}

/** 产物是否可见（active + superseded 可见，archived 不可见） */
export function isArtifactVisible(status: ArtifactStatus): boolean {
  return status === "active" || status === "superseded";
}

/** 产物分组值对象 */
export interface ArtifactGroup {
  groupId: string;
  resources: LinkedResource[];
  latestActive: LinkedResource | null;
}

/** 产物索引值对象 */
export interface ArtifactIndex {
  ungrouped: LinkedResource[];
  groups: ArtifactGroup[];
}
