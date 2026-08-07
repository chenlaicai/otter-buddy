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
        /** vitest 4 TestCase：声明期 skip 看 task.mode；运行期 ctx.skip() 看 result().state。
         *  注意 result 是原型方法，必须通过 testCase 调用（摘出来会丢 this） */
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
