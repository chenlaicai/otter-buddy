import { spawnSync } from "node:child_process";

/**
 * 进程启动时间是 PID/PGID 复用的身份令牌。ps 的 lstart 只有秒级精度，
 * 但它在同一系统上可重复读取；强制 C locale 避免部署语言改变日期格式。
 */
export function readProcessStart(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) return null;
  return parseProcessStart(result.stdout);
}

function parseProcessStart(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
