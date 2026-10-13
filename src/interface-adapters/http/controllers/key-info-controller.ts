import type { Context } from "hono";
import type { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { LinkedResourceInput } from "@usecases/conversation/manage-key-info";
import type { Logger } from "@usecases/ports/logger";
import type { LinkedResource } from "@entities/conversation/conversation";
import type { SqliteUnfurlCacheRepository, UnfurlCacheRow } from "@frameworks/db/conversation/sqlite-unfurl-cache-repository";
import { handleError, param } from "../http-error";
import { safeJsonBody } from "../parse-json-body";
import { toKeyInfoDTO, toLinkedResourceDTO } from "../dto/key-info-dto";
import type { LinkResourceRequestDTO } from "../dto/key-info-dto";

/**
 * F20261013csv3 T2：产物卡数据源增密。
 * 读侧：getLinkedResources 返回时 join unfurl_cache 投影（join 键 resource.url ↔
 * unfurl_cache.url）——PR 卡 diff stat + 状态徽章数据源（前端不直读 DB）。
 * 写侧：登记带 url 的产物时触发 unfurl 预抓取（与 T1 共用钩子），历史产物/漏抓的
 * fallback 由渲染侧 join 落空显示「未抓取」态并懒抓取补位。
 */
export class KeyInfoController {
  constructor(
    private readonly manageKeyInfo: ManageKeyInfo,
    private readonly logger: Logger,
    /** F20261013csv3 T2：unfurl 缓存读写（join 投影 + 登记侧预抓取触发） */
    private readonly unfurlCache?: SqliteUnfurlCacheRepository,
  ) {}

  async getKeyResources(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const resources = await this.manageKeyInfo.getLinkedResources(conversationId);
      return c.json(toKeyInfoDTO(this.withUnfurlProjection(resources)));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async linkResource(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await safeJsonBody<LinkResourceRequestDTO>(c);
      const input: LinkedResourceInput = {
        conversationId,
        resourceType: body.resourceType,
        url: body.url,
        title: body.title,
        content: body.content,
        category: body.category,
        metadata: body.metadata,
        linkedBy: body.linkedBy,
        otterId: body.otterId,
        autoLinked: body.autoLinked,
        groupId: body.groupId,
      };
      const resource = await this.manageKeyInfo.linkResource(input);
      // T2 登记侧预抓取：PR 产物登记即触发 unfurl 抓取（gh CLI 结构化取数落库），
      // 渲染当下 join 投影已有数据。非阻断——抓取失败由 unfurl 控制器落 failed 记录。
      this.triggerUnfurlPrefetch(resource);
      return c.json(this.projectOne(resource), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async flagResource(c: Context): Promise<Response> {
    try {
      const resourceId = param(c, "resourceId");
      const body = await safeJsonBody<{ flagged: boolean }>(c);
      await this.manageKeyInfo.flagResource(resourceId, body.flagged);
      return c.json({ status: "ok" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async deleteLinkedResource(c: Context): Promise<Response> {
    try {
      const resourceId = param(c, "resourceId");
      await this.manageKeyInfo.deleteLinkedResource(resourceId);
      return c.body(null, 204);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** 读侧 join 投影：resource.url ↔ unfurl_cache.url（join 键单一真相源）。
   *  落空的资源不携带 unfurl 字段（undefined——JSON 序列化后缺失，前端判 null/undefined 均为未抓取）。 */
  private withUnfurlProjection(resources: LinkedResource[]): LinkedResource[] {
    if (!this.unfurlCache) return resources;
    const urls = resources.map(r => r.url).filter((u): u is string => !!u);
    const cache = this.unfurlCache.getByUrls(urls);
    return resources.map(r => this.projectOne(r, cache));
  }

  /** 单条投影（内部复用——linkResource 返回单条也带投影） */
  private projectOne(resource: LinkedResource, cache?: Map<string, UnfurlCacheRow>) {
    const dto = toLinkedResourceDTO(resource);
    if (!this.unfurlCache || !resource.url) return dto;
    const row = cache ? cache.get(resource.url) : this.unfurlCache.getByUrls([resource.url]).get(resource.url);
    if (!row) {
      // join 落空：渲染侧显示「未抓取」态并懒抓取补位（T2 fallback）
      return { ...dto, unfurl: null };
    }
    return {
      ...dto,
      unfurl: {
        source: row.source,
        title: row.title,
        description: row.description,
        error: row.error,
        state: row.state,
        additions: row.additions,
        deletions: row.deletions,
      },
    };
  }

  /** 登记侧预抓取触发（非阻断）。仅 url 类型且未抓取过（含 failed 过期）的资源触发。 */
  private triggerUnfurlPrefetch(resource: LinkedResource): void {
    if (!this.unfurlCache || !resource.url) return;
    if (this.unfurlCache.has(resource.url)) return;
    // 懒注入 unfurl 控制器（避免循环依赖）——直接走 fetchAndCache 需 controller 实例；
    // 此处只标记「待抓取」由下一次读侧懒抓取补位？——不。方案 T2 要求登记即触发。
    // 由路由层在装配时注入 fetcher 回调（见 bootstrap/controllers.ts）。
    this.onPrefetch?.(resource.url);
  }

  /** 装配时注入的抓取回调（bootstrap 把 UnfurlController.fetchAndCache 包一层非阻断捕获） */
  onPrefetch: ((url: string) => void) | undefined;
}
