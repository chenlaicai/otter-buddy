import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "@usecases/ports/logger";

const execFileAsync = promisify(execFile);
export type RestartServiceResult = { isError: boolean; text: string };

/** 只把结构化端口/目录变成既有受控脚本的固定 argv；不接受 shell 字符串。 */
export async function runRestartService(
  script: string,
  input: { port: number; projectDir?: string; caller: string },
  logger?: Pick<Logger, "warn">,
): Promise<RestartServiceResult> {
  const args = [script, String(input.port), ...(input.projectDir ? ["--project", input.projectDir] : [])];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, OTTER_TOOL_CALLER: input.caller },
    });
    return { isError: false, text: [stdout, stderr].filter(Boolean).join("\n") || "受控重启完成。" };
  } catch (error) {
    const output = error && typeof error === "object"
      ? [Reflect.get(error, "stdout"), Reflect.get(error, "stderr")].filter(value => typeof value === "string").join("\n")
      : "";
    logger?.warn("restart-service controlled execution failed", {
      port: input.port,
      projectDir: input.projectDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return { isError: true, text: output || (error instanceof Error ? error.message : String(error)) };
  }
}
