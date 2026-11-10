import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { EmbeddingLaneName } from "@usecases/memory/embedding-gateway";

/** Why: Node 只暴露逻辑 CPU；物理核推导在 macOS/Linux 走平台真相源，失败才保守退化。 */
export function detectPhysicalCores(platform: NodeJS.Platform = process.platform): number {
  try {
    if (platform === "darwin") return detectDarwinPhysicalCores() ?? fallbackLogicalCores();
    if (platform === "linux") return detectLinuxPhysicalCores() ?? fallbackLogicalCores();
  } catch {
    // fallback below
  }
  return fallbackLogicalCores();
}

function fallbackLogicalCores(): number {
  return Math.max(1, os.cpus().length);
}

function detectDarwinPhysicalCores(): number | null {
  const output = execFileSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8" });
  const value = Number.parseInt(output, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function detectLinuxPhysicalCores(): number | null {
  const pairs = new Set<string>();
  let physicalId = "0";
  for (const line of readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
    if (line.startsWith("physical id")) physicalId = line.split(":")[1]?.trim() ?? "0";
    if (line.startsWith("core id")) pairs.add(`${physicalId}:${line.split(":")[1]?.trim()}`);
  }
  return pairs.size > 0 ? pairs.size : null;
}

export function deriveIntraOpThreads(
  lane: EmbeddingLaneName,
  physicalCores: number,
  override?: string,
): number {
  if (override !== undefined && override !== "") {
    const value = Number.parseInt(override, 10);
    if (Number.isFinite(value) && value >= 1) return value;
  }
  if (lane === "live" || lane === "query") return 2;
  const derived = Math.min(8, Math.max(2, Math.round(physicalCores * 0.5)));
  // live 占 2；双 lane 总预算不超过 physicalCores - 2。
  const available = Math.max(1, physicalCores - 4);
  return Math.max(1, Math.min(derived, available));
}
