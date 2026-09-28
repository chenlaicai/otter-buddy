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
  /** 公开 API（vitest 5 d.ts）：TestCase.options.mode */
  options?: { mode?: string };
  result?: { state?: string } | (() => { state?: string } | undefined);
  /**
   * 运行时私有表面：TestCase 实例的 .task 属性不在公开类型定义内。
   * v5.0.1 实测（检视獭 2026-09-28 全域探针，5 类用例）：
   * - ctx.skip() 置 task.mode="skip" 但 options.mode 仍为 "run"——单靠公开字段会漏计运行期 skip
   * - state 值域是 "skipped"/"passed"/"failed"（plugin.d.CN87HSxv.d.ts:350），无 "skip"
   * 语义固化测试：tests/capability/skip-reporter.capability.test.ts（含 v6 收掉 .task 后的回退行为验证）
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
        /** 计数语义（全域探针实测固化，见 skip-reporter.capability.test.ts）：
         *  - 声明期 skip（it.skip/describe.skip）：task.mode=options.mode="skip"
         *  - 运行期 ctx.skip()：task.mode="skip"，options.mode 仍 "run"，state="skipped"
         *  - it.todo：mode="todo"，state 也是 "skipped"——须排除，否则 todo 被误计为 skip
         *  - state 无 "skip" 值（只有 "skipped"），旧 === "skip" 分支是死代码（delta-2 已修）
         *  v6 安全网：若 .task 被收掉，声明期 skip 由 options.mode 兑住、运行期由 state="skipped" 兑住 */
        const mode = testCase.task?.mode ?? testCase.options?.mode;
        const rawResult = testCase.result;
        const state = typeof rawResult === "function"
          ? (rawResult as () => { state?: string }).call(testCase)?.state
          : (rawResult?.state ?? testCase.task?.result?.state);
        if (mode === "skip" || (state === "skipped" && mode !== "todo")) skipped++;
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
