/**
 * IdentityBuilder：负责 Otter 身份文案构建。
 *
 * 从 PiSessionFactory 拆出（D2 瘦身），职责：
 * - 加载身份文案文件（BIG_OTTER.md / SMALL_OTTER.md）
 * - 构建首次 invoke 的身份前缀（名称/ID/类型 + 按类型加载的身份文案）
 * - 构建召唤者身份段（小獭专用）
 * - 构建模型选择指南（注入大獭 prompt）
 */

import type { Logger } from "@usecases/ports/logger";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { loadPromptFile } from "./prompt-loader";
import type { ModelPool } from "@frameworks/llm/model-pool";

export class IdentityBuilder {
  /** 大獭身份文案（首次 invoke 时注入，从 identityPromptDir 加载） */
  private bigOtterIdentity = "";
  /** 小獭身份文案（首次 invoke 时注入，从 identityPromptDir 加载） */
  private smallOtterIdentity = "";

  constructor(
    private readonly otterRepo: OtterRepository,
    private readonly settingsRepo: SettingsRepository | undefined,
    private readonly modelPool: ModelPool | undefined,
    private readonly logger: Logger,
    identityPromptDir?: string,
  ) {
    if (identityPromptDir) {
      this.bigOtterIdentity = loadPromptFile(`${identityPromptDir}/BIG_OTTER.md`) ?? "";
      this.smallOtterIdentity = loadPromptFile(`${identityPromptDir}/SMALL_OTTER.md`) ?? "";
      if (!this.bigOtterIdentity || !this.smallOtterIdentity) {
        this.logger.warn('Otter 身份文案缺失，身份注入降级为仅名称/类型', {
          dir: identityPromptDir,
          bigOtterLoaded: Boolean(this.bigOtterIdentity),
          smallOtterLoaded: Boolean(this.smallOtterIdentity),
        });
      }
    } else {
      this.logger.warn('未配置 identityPromptDir，身份注入降级为仅名称/类型');
    }
  }

  /** S1（R20260810piab）：构建首次 invoke 的身份前缀：名称/ID/类型 + 按类型加载的身份文案。类型以 otterConfig 为准（与工具门控同一事实源）
   * @param modelAlias 当前 otter 的模型别名（来自 otterConfigProvider），用于注入模型身份段 */
  /** F20260903cmpk（#770 检视发现 2）：otter 显示名（压缩钩子 meta 行用）。查不到返回 undefined */
  async getOtterName(otterId: string): Promise<string | undefined> {
    const otter = await this.otterRepo.getById(otterId);
    return otter?.name;
  }

  async buildIdentityPrefix(otterId: string, otterType: string, conversationId: string, modelAlias?: string): Promise<string> {
    const otter = await this.otterRepo.getById(otterId);
    if (!otter) {
      this.logger.warn('身份注入跳过：otters 表中不存在该记录', { otterId });
      return "";
    }
    /** 未知类型按小獭处理（文案侧的保守默认；schema 约束下不可达，工具门控独立判定） */
    const isBig = otterType === 'big';
    const identityBody = isBig ? this.bigOtterIdentity : this.smallOtterIdentity;

    // 大獭且多模型时注入模型选择指南
    const modelGuidance = isBig ? this.buildModelSelectionGuidance() : '';

    // 用户身份段：告诉海獭搭档叫什么名字
    const rawName = this.settingsRepo ? ((await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || undefined) : undefined;
    const userName = rawName?.replace(/[\r\n]/g, '');
    const userIdentity = userName ? `## 你的搭档\n- 名字：${userName}\n- 称呼：搭档（你可以用名字称呼 ta）` : '';

    // F20260810rout: 小獭注入召唤者身份（修复行动权路由 bug——子獭需知道召唤者是谁，结论才能交回）
    const summonerIdentity = isBig ? '' : await this.buildSummonerIdentity(otter);

    // F20260824aibd: 注入模型身份段——海獭知道自己运行在什么模型上，对抗性协作场景据此选择异模型
    const modelIdentity = this.buildModelIdentity(modelAlias);

    // F20260825m422a: 注入当前日期时间——干净 session 无日期锚点导致特性 ID 日期臆断（#422）
    // F20260829cach: 锚点改日粒度。原分钟级字符串每次 invoke 都变，而本段拼在 system prompt
    // 前部（身份文案/工具定义之前），一变即打断整个 prompt 前缀缓存（实测 invoke 边界命中率
    // 从 95%+ 掉到 0-30%，详见 F20260829cach）。分钟级新鲜度不损失——由派发链在每条
    // user message 注入「当前任务」前缀（见 dispatch-chain-engine），不占缓存前缀。
    const now = new Date();
    const dateStr = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false });
    const dateAnchor = `## 当前日期时间\n- 今天是 ${dateStr}（Asia/Shanghai）`;

    return [
      `## 你的身份\n- 名称：${otter.name}\n- 名号：${otter.name}\n- ID：${otterId}\n- 类型：${isBig ? '大獭' : '小獭'}${conversationId ? `\n- 当前对话 ID：${conversationId}（创建特性文档时写入 frontmatter 的 created_in_conversation 字段）` : ''}`,
      userIdentity,
      summonerIdentity,
      dateAnchor,
      identityBody,
      modelIdentity,
      modelGuidance,
    ].filter(Boolean).join("\n\n");
  }

  /** F20260824aibd: 构建模型身份段——告诉海獭自己是什么模型、擅长什么，用于对抗性协作时选择异模型 */
  private buildModelIdentity(alias: string | undefined): string {
    if (!this.modelPool) return '';
    const models = this.modelPool.describeModels();
    // 单模型池省略："你用的是唯一模型"信息量为零，徒增 token
    if (models.length <= 1) return '';

    const target = alias
      ? (models.find(m => m.alias === alias) ?? models.find(m => m.alias === this.modelPool!.getDefaultAlias()))
      : models.find(m => m.alias === this.modelPool!.getDefaultAlias());
    if (!target) return '';

    const strengths = target.strengths?.length ? target.strengths.join('、') : '未指定';
    const weaknesses = target.weaknesses?.length ? target.weaknesses.join('、') : '未指定';

    return [
      '## 你的运行时模型',
      `- 模型：${target.alias}——${target.description ?? '无描述'}`,
      `- 优势：${strengths}`,
      `- 劣势：${weaknesses}`,
      '- 以上信息由系统注入，以此为准判断自己的能力边界，不要凭预训练记忆推测或声称其他模型身份',
      '- 对抗性协作提示：在开发/检视、编写/审核等配对场景中，你与对方使用不同模型。',
      '  训练路径不同 → 思考盲区不同，这正是对抗价值的来源。审视对方产出时，',
      '  优先从你的优势维度切入，不要假设“我想不到的对方也想不到”。',
    ].join('\n');
  }

  /** 构建召唤者身份段（小獭专用）——子獭需知道召唤者是谁，行动权才能交回 */
  private async buildSummonerIdentity(otter: { parentOtterId: string | null }): Promise<string> {
    if (!otter.parentOtterId) return '';
    const parentOtter = await this.otterRepo.getById(otter.parentOtterId);
    if (!parentOtter) return '';
    return [
      '## 你的召唤者',
      `- 召唤你的海獭：${parentOtter.name}（本次任务的主导者）`,
      `- **子任务完成后，行动权默认交回 ${parentOtter.name} 处置，不要传 'user'**`,
      `- 只有整个协作任务真正完成、需要搭档（用户）拍板时，才传 'user'`,
    ].join('\n');
  }

  /** 构建模型选择指南（注入大獭 prompt） */
  private buildModelSelectionGuidance(): string {
    if (!this.modelPool) return "";
    const models = this.modelPool.describeModels();
    if (models.length <= 1) return "";

    const lines = models.map(m => {
      const strengths = m.strengths?.length ? `优势: ${m.strengths.join("、")}` : "";
      const weaknesses = m.weaknesses?.length ? `劣势: ${m.weaknesses.join("、")}` : "";
      const details = [strengths, weaknesses].filter(Boolean).join("；");
      return `- **${m.alias}**：${m.description ?? "无描述"}${details ? `\n  ${details}` : ""}`;
    });

    return [
      "",
      "## 可用模型",
      "",
      ...lines,
      "",
      "创建小獭时可通过 `modelAlias` 参数选择模型。不指定则使用默认模型。",
      "只在任务有明确的模型适配需求时才选择，大多数情况下默认模型即可。",
    ].join("\n");
  }
}
