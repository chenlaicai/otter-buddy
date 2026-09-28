/**
 * 能力测试 skip 报告器：运行结束时显式报告 LLM 依赖用例的 skip 情况。
 * 原则：skip 必须显式可见、可操作，绝不允许"静默全绿"。
 *
 * 注意：reporter 跑在 vitest 主进程，boot 的 LLM 探测在 fork 子进程，
 * 因此这里独立探测配置存在性（与 boot.ts 的规则保持一致）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface TestTaskLike {
  name: string;
  mode?: string;
  result?: { state?: string } | (() => { state?: string } | undefined);
  /**
   * vitest 5 运行时兼容层：TestCase 实例上存在 `.task` 属性（收集期 skip 模式的真实载体），
   * 但它不在 vitest 5 公开类型定义（TaskBase）内，属运行时私有表面。
   * 这里保留运行时探查但防御性可选访问——上游收掉该属性时退回公开字段 mode/result，
   * 配合 skip 不计数时无输出（全绿幻觉）风险的足印注释。实验锚点（v5.0.1 实测）：
   * 声明期 skip 与 ctx.skip() 两路都能被 task?.mode ?? mode + result().state 正确捕获。
   */
  task?: { mode?: string; result?: { state?: string } };
}

interface TestModuleLike {
  children: {
    allTests(): Iterable<TestTaskLike>;
  };
}

function llmConfigured(): boolean {
  if (process.env.OTTER_TEST_LLM_API_KEY) return true;
  const localPath = path.join(process.cwd(), "config/config.test.local.yaml");
  if (!fs.existsSync(localPath)) return false;
  /** 文件存在但 apiKey 为空也算未配置（否则 skip 原因文案误导） */
  const content = fs.readFileSync(localPath, "utf8");
  return /apiKey:\s*["']?\S/.test(content);
}

export default class CapabilitySkipReporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModuleLike>): void {
    let skipped = 0;
    for (const mod of testModules) {
      for (const testCase of mod.children.allTests()) {
        /** vitest 4/5 TestCase：声明期 skip 看 task.mode（运行时属性，公开类型未暴露）；
         *  运行期 ctx.skip() 看 result().state。两路探查都保留——v5 实测均有效，
         *  探针锚点：tests/capability/probe.capability.test.ts 验证方式（2026-09-28） */
        const mode = testCase.task?.mode ?? testCase.mode;
        const rawResult = testCase.result;
        const state = typeof rawResult === "function"
          ? (rawResult as () => { state?: string }).call(testCase)?.state
          : (rawResult?.state ?? testCase.task?.result?.state);
        if (mode === "skip" || state === "skip") skipped++;
      }
    }

    if (skipped > 0) {
      const reason = llmConfigured()
        ? "LLM 已配置但仍有 skip（请检查具体用例的 skip 条件）"
        : "未配置 LLM 端点：创建 config/config.test.local.yaml 或设置 OTTER_TEST_LLM_API_KEY 后重跑";
      console.log(`\n[capability] SKIP REPORT: ${skipped} 个用例被跳过\n[capability] 原因: ${reason}\n`);
    } else {
      console.log(`\n[capability] 全部用例真实执行，无跳过\n`);
    }
  }
}
