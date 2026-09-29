/**
 * F20260928fsqr：飞书扫码接入装配（从 app.ts 抽出，控 max-lines）。
 *
 * 职责：运行时注册表（boot + onSuccess 两源统一入表）+ 首号判定（D7 先写先得）
 * + 幂等 provision 闭包 + 登录会话管理。app.ts 只消费返回的句柄组。
 */
import { FeishuAppStore } from "@frameworks/feishu/app-store";
import { botKey } from "@frameworks/feishu/bot-key";
import { maskAppId } from "@frameworks/feishu/long-connection-client";
import { FeishuLoginSessionManager } from "@frameworks/feishu/login-session-manager";
import { buildFeishuRuntime, type FeishuRuntime } from "./platforms";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { Logger } from "@usecases/ports/logger";

/* eslint-disable max-lines-per-function */
export function setupFeishuScanChannels(options: {
  config: Parameters<typeof buildFeishuRuntime>[0]["appConfig"];
  uc: Parameters<typeof buildFeishuRuntime>[0]["uc"];
  repos: Parameters<typeof buildFeishuRuntime>[0]["repos"];
  agentInvoker: Parameters<typeof buildFeishuRuntime>[0]["agentInvoker"];
  dispatchChainEngine: Parameters<typeof buildFeishuRuntime>[0]["dispatchChainEngine"];
  messageBroadcaster: Parameters<typeof buildFeishuRuntime>[0]["messageBroadcaster"];
  logger: Logger;
  registry?: Parameters<typeof buildFeishuRuntime>[0]["registry"];
  signalRouter?: Parameters<typeof buildFeishuRuntime>[0]["signalRouter"];
  globalPartnerResolver: PartnerResolver;
}) {
  const { config, uc, repos, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, registry, signalRouter, globalPartnerResolver } = options;

  const feishuAppStore = new FeishuAppStore();
  /** 运行时注册表（键 = appId，与 store/DELETE 端点一致）；boot 与 onSuccess 两源统一入表 */
  const feishuRuntimes = new Map<string, FeishuRuntime>();
  const stopFeishuRuntime = (appId: string): boolean => {
    const rt = feishuRuntimes.get(appId);
    if (!rt) return false;
    rt.stop();
    feishuRuntimes.delete(appId);
    return true;
  };
  // 首号判定（D7 先写先得）：store 最早的有 owner 的 app
  const feishuFirstOwner = (): string | undefined => {
    const apps = feishuAppStore.listApps().sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    return apps.map((a) => a.ownerOpenId).find((id): id is string => typeof id === "string" && id.trim().length > 0);
  };

  /** 飞书助理线建线（botKey 锚定，微信 provisionAssistantLine 同构；幂等） */
  const provisionFeishuAssistantLine = async (appId: string, name: string): Promise<{ conversationId: string; title: string }> => {
    // 建线键 = botKey(appId)（掩码形态）——与入站路由锚同源（F20260921wxba：键分裂则收不到消息）
    const key = botKey(appId);
    const app = feishuAppStore.getApp(appId);
    const connection = await uc.manageConnection.ensureConnection(key, name, "feishu");
    // 线 owner 落 metadata（称呼链用；ownerOpenId 缺失时首条 p2p 消息 sender 回填，D7 降级）
    if (app?.ownerOpenId) {
      await repos.connection.mergeMetadata(connection.id, { ownerOpenId: app.ownerOpenId }).catch((err) => {
        logger.warn("Feishu provision: ownerOpenId metadata write failed（称呼链降级待首消息回填）", { appId: maskAppId(appId), error: err instanceof Error ? err.message : String(err) });
      });
    }
    // 已有 active 绑定 = 已建过线（幂等：不重复建，返回当前）
    const existing = await uc.manageConnection.getCurrentConversation(connection.id);
    if (existing) {
      if (typeof connection.metadata?.assistantConversationId !== "string") {
        await repos.connection.mergeMetadata(connection.id, { assistantConversationId: existing.id }).catch(() => {
          logger.warn("Feishu provision: assistantConversationId backfill failed（删号归档将走绑定兑底）", { appId: maskAppId(appId) });
        });
      }
      return { conversationId: existing.id, title: existing.title };
    }
    const conv = await uc.assistantSession.ensureAssistantConversation({
      connectionId: connection.id,
      channel: "feishu",
      displayName: name,
      ...(config.im?.assistant?.modelAlias && { modelAlias: config.im.assistant.modelAlias }),
    });
    if (!conv) throw new Error("助理线创建失败");
    await repos.connection.mergeMetadata(connection.id, { assistantConversationId: conv.id }).catch((err) => {
      logger.warn("Feishu provision: assistantConversationId metadata write failed（删号时对话将残留）", { appId: maskAppId(appId), conversationId: conv.id, error: err instanceof Error ? err.message : String(err) });
    });
    return { conversationId: conv.id, title: conv.title };
  };

  const feishuLoginSessions = new FeishuLoginSessionManager({
    logger,
    appPresetName: (userName) => `Otter Buddy 助理 - ${userName}`,
    onSuccess: async ({ appId, appSecret, ownerOpenId, name }) => {
      // 1) 落库（在热启动前——运行时工厂读 store 外的 secret 直传）
      feishuAppStore.saveApp({ appId, appSecret, ...(ownerOpenId && { ownerOpenId }), ...(name && { name }), addedAt: new Date().toISOString() });
      // 2) 首号先写先得（D7，检视严重 4）：**仅首个**扫码人 ownerOpenId 写全局渲染 resolver
      //  （saveApp 后 feishuFirstOwner 若返回本号 = 我是首号；非首号不写——第二扫码人
      //  显示快照名非「搭档」，方案手测清单钉死的语义）；DELETE 不回收（记遗留）
      const firstOwnerNow = feishuFirstOwner();
      if (ownerOpenId && firstOwnerNow === ownerOpenId) globalPartnerResolver.addPartnerId(ownerOpenId);
      // 3) 热启动运行时（同 app 重扫替换旧 runtime，#591 语义）
      //  门禁锚（检视建议⑤）：ownerOpenId 缺失时退 partnerOpenId（config 锚）而非空——
      //  双缺席才真正无锚（遗留安全面，记特性文档）
      stopFeishuRuntime(appId);
      const rt = buildFeishuRuntime({
        appId, appSecret,
        gateOwnerOpenId: ownerOpenId ?? config.feishu?.partnerOpenId, // 检视建议⑤：owner 缺失退 config 锚（静态段退役后该退锥随存量迁移自然消失）
        globalFirstOwnerOpenId: firstOwnerNow,
        appConfig: config, uc, repos, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, registry, signalRouter,
      });
      if (rt) feishuRuntimes.set(appId, rt);
      // 4) 助理线 provision（自动触发一次；失败不阻建 app——「补建线」端点可重试）
      try {
        await provisionFeishuAssistantLine(appId, name?.trim() || maskAppId(appId));
      } catch (err) {
        logger.warn("Feishu login: provision failed（可经 POST /api/feishu/apps/:id/assistant-line 补建）", { appId: maskAppId(appId), error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 启动时拉起存量扫码 apps（启动链与热启动共用工厂）
  for (const app of feishuAppStore.listApps()) {
    const rt = buildFeishuRuntime({
      appId: app.appId,
      appSecret: app.appSecret,
      gateOwnerOpenId: app.ownerOpenId ?? config.feishu?.partnerOpenId, // 检视建议⑤：owner 缺失退 config 锚（静态段退役后该退锥随存量迁移自然消失）
      globalFirstOwnerOpenId: feishuFirstOwner(),
      appConfig: config, uc, repos, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, registry, signalRouter,
    });
    if (rt) feishuRuntimes.set(app.appId, rt);
    // 首号锚启动恢复（D7）：boot 时首号写全局 resolver（进程重启不丢搭档锚）
    if (app.ownerOpenId && feishuFirstOwner() === app.ownerOpenId) {
      globalPartnerResolver.addPartnerId(app.ownerOpenId);
    }
  }

  /** F20260928fsqr（检视严重 5）：删除时释放绑定——微信 releaseWeixinConnectionAndArchiveLine
   *  同构：归档助理对话（被占则跳过）+ 释放 session */
  const releaseFeishuConnectionAndArchiveLine = async (appId: string): Promise<void> => {
    try {
      const conn = await repos.connection.getByExternalId(botKey(appId));
      if (!conn) return;
      const session = await repos.connection.getActiveSession(conn.id);
      const owned = conn.metadata?.assistantConversationId;
      const ownedConversationId = typeof owned === "string" ? owned : session?.conversationId;
      if (ownedConversationId) {
        const occupying = await repos.connection.getActiveSessionByConversation(ownedConversationId);
        if (occupying && occupying.connectionId !== conn.id) {
          logger.info("Feishu app deleted; conversation occupied by another connection, skip archive", { appId: maskAppId(appId), conversationId: ownedConversationId });
        } else {
          await uc.manageConversation.archive(ownedConversationId).catch((err) => {
            logger.warn("Feishu app deleted; assistant conversation archive failed", { appId: maskAppId(appId), conversationId: ownedConversationId, error: err instanceof Error ? err.message : String(err) });
          });
        }
      }
      if (session) await repos.connection.releaseSession(session.id, new Date().toISOString());
    } catch (err) {
      logger.warn("Feishu app deleted; connection release failed", { appId: maskAppId(appId), error: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    feishuAppStore,
    feishuLoginSessions,
    provisionFeishuAssistantLine,
    /** DELETE 端点回调（#592 防复活序——controller 先调本函数再删 store）：
     *  停运行时 + 释放绑定归档线（检视严重 5） */
    onAppDeleted: async (appId: string) => {
      stopFeishuRuntime(appId);
      await releaseFeishuConnectionAndArchiveLine(appId);
    },
    /** dispose 链：停全部运行时（#460） */
    disposeAll: () => {
      for (const rt of feishuRuntimes.values()) rt.stop();
      feishuRuntimes.clear();
    },
  };
}
