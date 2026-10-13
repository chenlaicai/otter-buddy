import type { AppConfig } from "@frameworks/config";
import { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { Logger } from "@usecases/ports/logger";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import type { Repositories, UseCases } from "./types";
import { buildResolveTargetsDeps } from "@usecases/conversation/resolve-send-targets";
import { SearchEngine } from "@usecases/memory/search-engine";
import { ManageMemory } from "@usecases/memory/manage-memory";
import { ManageTerminology } from "@usecases/memory/manage-terminology";
import { SearchMemory } from "@usecases/memory/search-memory";
import { CreateEdge } from "@usecases/memory/create-edge";
import { GetRelated } from "@usecases/memory/get-related";
import { DeleteEdge } from "@usecases/memory/delete-edge";
import { GetDocProvenance } from "@usecases/memory/get-doc-provenance";
import { QueryMessage } from "@usecases/conversation/query-message";
import { RecordSearchQuery } from "@usecases/memory/record-search-query";
import { ManageReadState } from "@usecases/conversation/manage-read-state";

import { ManageParticipant } from "@usecases/conversation/manage-participant";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import { QueryOtter } from "@usecases/otter/query-otter";
import { CreateOtter } from "@usecases/otter/create-otter";
import { ManageConversation } from "@usecases/conversation/manage-conversation";
import { ManageSession } from "@usecases/otter/manage-session";
import { DissolveOtter } from "@usecases/otter/dissolve-otter";
import { ManageContext } from "@usecases/otter/manage-context";
import { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { ManageConnection } from "@usecases/im/manage-connection";
import { AssistantSessionManager } from "@usecases/im/assistant-session";
/** F20260924wast：web 助理开户（幂等 + 人设后端注入） */
import { WebAssistantProvisioner } from "@usecases/conversation/web-assistant-provisioner";
import { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import { ManageWorkspace } from "@usecases/conversation/manage-workspace";
import { SendEntry } from "@usecases/conversation/send-entry";
import type { ResolveTargetsDeps } from "@usecases/conversation/resolve-send-targets";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { SqliteUnfurlCacheRepository } from "@frameworks/db/conversation/sqlite-unfurl-cache-repository";
import { parseGithubUrl, fetchGithubMeta } from "@interface-adapters/http/controllers/github-unfurl";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";

export interface UseCaseDeps {
  repos: Repositories;
  entryRepo: EntryRepository;
  invokeRepo: InvokeRepository;
  agentGateway: PiSessionFactory;
  embeddingService: EmbeddingGateway;
  memoryIndex: MemoryIndexGateway;
  appConfig: AppConfig;
  logger: Logger;
  workspaceGateway?: WorkspaceGateway;
  /** Otter 配置提供方（ManageParticipant 读 modelAlias 注入 ParticipantDTO） */
  otterConfigProvider?: OtterConfigProvider;
  /** F20260908efmd: 模型池（有效模型解析 / session 快照 / restart 切模型）。未注入时 T1/T2/T3 降级 */
  modelPool?: ModelPoolLike;
}

export function initUseCases(deps: UseCaseDeps): UseCases {
  const { repos, entryRepo, invokeRepo, agentGateway, embeddingService, memoryIndex, appConfig, logger, workspaceGateway, otterConfigProvider, modelPool } = deps;
  const memoryUcs = buildMemoryUseCases(repos, embeddingService, appConfig, logger);
  const { searchMemory, createEdge, getRelated, deleteEdge, getDocProvenance, manageMemory, manageTerminology, scanDarkEntries } = memoryUcs;
  // F20260913ctlv 彻底切换：未读状态读 entries
  const queryMessage = new QueryMessage(repos.conversation, entryRepo);
  // F20260826rcmm Phase 0：检索埋点（评估基线数据源）
  // F20260913ctlv 收尾批3：上下文快照数据源切 entries
  const recordSearchQuery = new RecordSearchQuery(repos.searchQueryLog, entryRepo, logger);
  const manageReadState = new ManageReadState(repos.conversation, entryRepo);
  // 信号轨迹查询退役（F20260908rlcp）
  const manageParticipant = new ManageParticipant(
    repos.conversation, repos.otter,
    // F20260913ctlv 批4c：进场/退场 system entry（必注入）
    { entryRepo, invokeRepo },
    otterConfigProvider, modelPool,
  );
  const manageKeyInfo = new ManageKeyInfo(repos.conversation, memoryIndex);
  const queryOtter = new QueryOtter(repos.otter);
  // F20260908efmd: 注入 configProvider + modelPool，首世建账快照有效模型
  const createOtter = new CreateOtter(repos.otter, agentGateway, logger, otterConfigProvider, modelPool);
  const manageConversation = new ManageConversation(repos.conversation, createOtter, workspaceGateway);
  // F20260908efmd: 注入 configProvider + modelPool，createSession/restartSession 快照有效模型
  const manageSession = new ManageSession(
    repos.otter, agentGateway, manageConversation, manageMemory, logger, otterConfigProvider, modelPool,
  );
  const dissolveOtter = buildDissolveOtter(repos, agentGateway, manageSession, logger);
  const manageContext = new ManageContext(repos.otterContext);
  const manageScheduledTask = new ManageScheduledTask(repos.scheduledTask);
  const manageConnection = new ManageConnection(repos.connection, repos.conversation, logger);
  // F20260918imas / F20260920imax：IM 助理会话管理（p2p/微信私聊自动开户；对话永续 +
  // 8h 静默 session 重启）。
  // enabled 总开关不在此层拦截——UseCases 恒持实例（供其他消费方），
  // 拦截面在 platforms.ts 注入点（enabled=false 时不注入处理器，回退拒聊）
  const assistantSession = new AssistantSessionManager({
    manageConnection,
    manageConversation,
    conversationRepo: repos.conversation,
    entryRepo,
    ...(memoryIndex ? { memoryIndex } : {}),
    // F20260920imax：8h 静默 → restartSession（机械交接摘要，非 Pi 内置压缩）
    manageSession,
    getOtterIds: (conversationId: string) => repos.conversation.getOtterIds(conversationId),
    logger,
    sessionIdleHours: appConfig.im?.assistant?.sessionIdleHours ?? 8,
  });
  // F20260924wast：web 助理开户（全局唯一 kind=web-assistant 对话；幂等 + 人设注入；
  // modelAlias 共用 im.assistant.modelAlias——对话实例各自独立，改配置下个 session 生效）
  const webAssistantProvisioner = buildWebAssistantProvisioner(repos.conversation, createOtter, appConfig, logger);
  // 多模态 Phase 1：附件上传服务（storageRoot 等来自 config.attachments）
  const attachmentUpload = buildAttachmentUploadService(repos, appConfig, logger);
  // 工作区文件浏览（只读）——workspaceGateway 可选注入
  const manageWorkspace = workspaceGateway ? new ManageWorkspace(workspaceGateway, logger) : undefined;
  // F20260913ctlv 彻底切换：目标解析依赖（默认派发数据源 = entries.speak + invokes running）
  const resolveDeps = buildResolveTargetsDeps(
    (conversationId) => repos.conversation.getActiveParticipants(conversationId),
    entryRepo,
    repos.otter,
    invokeRepo,
  );
  const sendEntry = buildSendEntry({ entryRepo, invokeRepo, repos, logger, resolveDeps, memoryIndex });
  return {
    manageConversation, manageMemory, manageTerminology, searchMemory, scanDarkEntries,
    queryMessage, manageReadState, manageParticipant, manageKeyInfo, recordSearchQuery,
    // querySignalTrail 退役（F20260908rlcp）
    queryOtter, createOtter, manageSession, dissolveOtter, manageContext,
    manageScheduledTask, manageConnection,
    assistantSession,
    webAssistantProvisioner,
    createEdge, getRelated, deleteEdge, getDocProvenance,
    attachmentUpload,
    manageWorkspace,
    sendEntry,
  };
}

/** F20261006mtlp：DissolveOtter 工厂（initUseCases 行数限额拆出） */
function buildDissolveOtter(
  repos: Repositories,
  agentGateway: PiSessionFactory,
  manageSession: ManageSession,
  logger: Logger,
): DissolveOtter {
  return new DissolveOtter(repos.otter, agentGateway, manageSession, {
    // F20260908rlcp：旧台账退役——settle/abort 清账随 main #886 批次退役
    /** F20260912avlb：派工台账 dissolve 记账钩子 */
    markDispatchDissolved: async (otterId: string) => repos.dispatchRecord.markDissolved(otterId),
    /** F20261006mtlp §2 等待方消亡规则①：獭解散 → 名下 WAITING_OTTER 事项回 OPEN */
    reopenMattersForDissolvedOwner: async (otterId: string) => repos.matter.reopenForDissolvedOwner(otterId, new Date().toISOString()),
    logger,
  });
}

/** F20260924wast：web 助理开户工厂（initUseCases 行数限额拆出） */
function buildWebAssistantProvisioner(
  conversationRepo: Repositories["conversation"],
  createOtter: CreateOtter,
  appConfig: AppConfig,
  logger: Logger,
): WebAssistantProvisioner {
  return new WebAssistantProvisioner({
    conversationRepo,
    createOtter,
    ...(appConfig.im?.assistant?.modelAlias && { modelAlias: appConfig.im.assistant.modelAlias }),
    logger,
  });
}

/** 多模态 Phase 1：附件上传服务工厂（config.attachments 缺省值内置） */
function buildAttachmentUploadService(
  repos: Repositories,
  appConfig: UseCaseDeps["appConfig"],
  logger: Logger,
): AttachmentUploadService {
  return new AttachmentUploadService(
    repos.attachment,
    {
      storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
      maxImageBytes: appConfig.attachments?.maxImageBytes ?? 10 * 1024 * 1024,
      maxDocumentBytes: appConfig.attachments?.maxDocumentBytes ?? 20 * 1024 * 1024,
    },
    logger,
  );
}

/** 记忆域 use cases 构造（自 initUseCases 拆出，控语句数） */
function buildMemoryUseCases(
  repos: Repositories,
  embeddingService: UseCaseDeps["embeddingService"],
  appConfig: UseCaseDeps["appConfig"],
  logger: Logger,
) {
  const searchEngine = new SearchEngine(appConfig.memory);
  const manageMemory = new ManageMemory(repos.memoryReader, repos.memoryWriter);
  const manageTerminology = new ManageTerminology(repos.terminology);
  const scanDarkEntries = new ScanDarkEntries(repos.memoryReader, logger);
  const searchMemory = new SearchMemory(repos.memoryReader, repos.memoryWriter, embeddingService, searchEngine, logger, repos.terminology);
  // F20260813mren: 记忆关系层 use cases
  const createEdge = new CreateEdge(repos.memoryReader, repos.memoryWriter, logger);
  const getRelated = new GetRelated(repos.memoryReader);
  const deleteEdge = new DeleteEdge(repos.memoryWriter);
  const getDocProvenance = new GetDocProvenance(repos.memoryReader, repos.feature, repos.research);
  return { searchMemory, createEdge, getRelated, deleteEdge, getDocProvenance, manageMemory, manageTerminology, scanDarkEntries };
}

/** SendEntry 装配（拆出降 initUseCases 行数——max-lines-per-function 60） */
function buildSendEntry(opts: {
  entryRepo: EntryRepository;
  invokeRepo: InvokeRepository;
  repos: Repositories;
  logger: Logger;
  resolveDeps: ResolveTargetsDeps;
  memoryIndex?: MemoryIndexGateway;
}): SendEntry {
  return new SendEntry(opts.entryRepo, opts.invokeRepo, opts.repos.otter, opts.repos.conversation, {
    logger: opts.logger,
    resolveDeps: opts.resolveDeps,
    ...(opts.memoryIndex ? { memoryIndex: opts.memoryIndex } : {}),
    // F20261013csv3 T1：unfurl 预抓取钩子（非阻断——逐 URL 后台抓取，失败落 failed 记录）
    unfurlPrefetch: buildUnfurlPrefetch(opts.repos.unfurlCache, opts.logger),
  });
}

/**
 * F20261013csv3 T1：unfurl 预抓取回调装配（send-entry 钩子 → 后台抓取落库）。
 * 逐 URL 非阻断：已有缓存记录（另一并发请求抓过）跳过；失败落 failed 记录。
 * 直接调 gh/og 抓取逻辑而不复用 UnfurlController——避免 usecases → interface-adapters
 * 反向依赖；抓取主流程（分路/TTL/落库）在此内联最小实现。
 */
function buildUnfurlPrefetch(
  cache: SqliteUnfurlCacheRepository,
  logger: Logger,
): (urls: string[]) => void {
  return (urls) => {
    for (const url of urls) {
      if (cache.has(url)) continue;
      void prefetchOne(url, cache).catch((err: unknown) => {
        logger.warn(`[unfurl] prefetch failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  };
}

/** 单 URL 后台抓取（与 unfurl-controller.fetchAndCache 同分路：GitHub 走 gh，其余走 og） */
async function prefetchOne(url: string, cache: SqliteUnfurlCacheRepository): Promise<void> {
  const gh = parseGithubUrl(url);
  const now = new Date().toISOString();
  try {
    if (gh) {
      const meta = await fetchGithubMeta(gh);
      cache.put({
        url,
        title: meta.title,
        description: meta.description,
        image: null,
        siteName: "GitHub",
        host: "github.com",
        source: "github-api",
        state: meta.state,
        additions: meta.additions,
        deletions: meta.deletions,
        error: null,
        fetchedAt: now,
      });
      return;
    }
    // og 抓取（精简版——与 controller 同超时/体积预算）
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) {
      cache.put({ url, title: null, description: null, image: null, siteName: null, host: safeHostname(url), source: "failed", state: null, additions: null, deletions: null, error: `HTTP ${resp.status}`, fetchedAt: now });
      return;
    }
    const body = (await resp.text()).slice(0, 512 * 1024);
    const title = pickOg(body, "og:title");
    const description = pickOg(body, "og:description");
    const image = pickOg(body, "og:image");
    const siteName = pickOg(body, "og:site_name");
    if (!title && !description && !image) {
      cache.put({ url, title: null, description: null, image: null, siteName: null, host: safeHostname(url), source: "failed", state: null, additions: null, deletions: null, error: "no preview metadata", fetchedAt: now });
      return;
    }
    cache.put({ url, title, description, image, siteName, host: safeHostname(url), source: "og", state: null, additions: null, deletions: null, error: null, fetchedAt: now });
  } catch (err) {
    cache.put({
      url,
      title: null, description: null, image: null, siteName: null,
      host: safeHostname(url),
      source: "failed",
      state: null, additions: null, deletions: null,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      fetchedAt: now,
    });
  }
}

/** og meta 提取（与 unfurl-controller.pickMeta 同正则口径） */
function pickOg(html: string, key: string): string | null {
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const propMatch = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!propMatch || propMatch[1].toLowerCase() !== key) continue;
    const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!contentMatch) continue;
    const val = contentMatch[1].trim();
    return val.length > 0 ? val.slice(0, 500) : null;
  }
  return null;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
