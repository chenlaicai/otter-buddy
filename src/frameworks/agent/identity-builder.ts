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

  /** S1（R20260810piab）：构建首次 invoke 的身份前缀：名称/ID/类型 + 按类型加载的身份文案。类型以 otterConfig 为准（与工具门控同一事实源） */
  async buildIdentityPrefix(otterId: string, otterType: string, conversationId: string): Promise<string> {
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

    return [
      `## 你的身份\n- 名称：${otter.name}\n- 名号：${otter.name}\n- ID：${otterId}\n- 类型：${isBig ? '大獭' : '小獭'}${conversationId ? `\n- 当前对话 ID：${conversationId}（创建特性文档时写入 frontmatter 的 created_in_conversation 字段）` : ''}`,
      userIdentity,
      summonerIdentity,
      identityBody,
      modelGuidance,
    ].filter(Boolean).join("\n\n");
  }

  /** F20260810rout: 构建召唤者身份段（小獭专用）——子獭需知道召唤者是谁，行动权才能交回 */
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
