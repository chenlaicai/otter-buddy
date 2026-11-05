import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 1024 * 1024;

export type IssueBindingCheck =
  | { ok: true }
  | { ok: false; reason: string };

export type CheckIssueBinding = (issueNumber: number) => Promise<IssueBindingCheck>;

/** F20261105bndst：归口的目标必须仍是可接工作的 OPEN issue；外部状态查不清时不写库。 */
export async function checkOpenIssue(issueNumber: number): Promise<IssueBindingCheck> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, reason: `目标 issue 编号无效：${issueNumber}` };
  }
  try {
    const { stdout } = await execFileAsync("gh", [
      "issue", "view", String(issueNumber), "--json", "state",
    ], {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      env: { ...process.env },
    });
    const parsed = JSON.parse(stdout) as { state?: unknown };
    if (parsed.state !== "OPEN") {
      const state = typeof parsed.state === "string" ? parsed.state : "状态不可核实";
      return { ok: false, reason: `目标 issue #${issueNumber} ${state === "状态不可核实" ? state : `状态为 ${state}`}，仅可归口到 OPEN issue` };
    }
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `无法核实目标 issue #${issueNumber} 状态，已阻止归口：${detail}` };
  }
}
