/**
 * F20261027hwl1：工作账本 + 模型效率 HTTP 控制器（只读）。
 *
 * - GET /api/health/work-ledger          → 列表 + 覆盖率 + 未归属 + usageGap
 * - GET /api/health/work-ledger/:id      → 详情（404 不返回演示对象）
 * - GET /api/health/model-efficiency     → provider+model × 日/周/月
 */
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { WorkLedgerReportBuilder } from "@usecases/health/work-ledger-report";
import type { WorkDetailReportBuilder } from "@usecases/health/work-detail-report";
import type { ModelEfficiencyReportBuilder } from "@usecases/health/model-efficiency-report";
import { handleError } from "../http-error";

export class WorkLedgerController {
  constructor(
    private readonly reportBuilder: WorkLedgerReportBuilder,
    private readonly detailBuilder: WorkDetailReportBuilder,
    private readonly efficiencyBuilder: ModelEfficiencyReportBuilder,
    private readonly logger: Logger,
  ) {}

  /** GET /api/health/work-ledger — period 参数本期仅透传（日/周/月窗口过滤在工作列表全量展示） */
  async workLedger(c: Context): Promise<Response> {
    try {
      const report = await this.reportBuilder.build();
      return c.json({
        works: report.works,
        attributionCoverage: report.attributionCoverage,
        unassigned: report.unassigned,
        usageGapInvokeCount: report.usageGapInvokeCount,
        pricingAvailable: report.pricingAvailable,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** GET /api/health/work-ledger/:id — 不存在返回 404（空态是真实覆盖率，不是演示对象） */
  async workDetail(c: Context): Promise<Response> {
    try {
      const id = c.req.param("id");
      if (!id) {
        return c.json({ error: { code: "bad_request", message: "work id required" } }, 400);
      }
      const report = await this.detailBuilder.build(id);
      if (!report) {
        return c.json({ error: { code: "not_found", message: `work item not found: ${id}` } }, 404);
      }
      return c.json(report);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** GET /api/health/model-efficiency — period 参数本期透传（日/周/月并列展示，不用 tab 隐藏） */
  async modelEfficiency(c: Context): Promise<Response> {
    try {
      const report = await this.efficiencyBuilder.build();
      return c.json(report);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
