/**
 * 回环判定：监听地址与连接来源两处共用的一小撮解析。
 *
 * 为什么单独成文件：监听侧（bootstrap 起服务的地址告警）与鉴权侧（声明式身份通道的
 * 来源闸）判的是同一件事——「这条链路是否只可能来自本机」。两边各写一份，早晚会出现
 * `::1` 认得出、`::ffff:127.0.0.1` 认不出的分叉，而这层分叉的后果是鉴权旁路。
 */

/** 主机名/监听地址是否回环：localhost / 127.0.0.0-8 / ::1 / ::ffff:127.x */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const value = host.trim().toLowerCase();
  if (value === "" ) return false;
  // [::1] 形态（IPv6 字面量带方括号）
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (bare === "localhost" || bare === "::1") return true;
  return isLoopbackIPv4(bare);
}

/** 连接来源地址是否回环（socket.remoteAddress 形态，可能带 IPv4-mapped 前缀） */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return isLoopbackHost(address);
}

function isLoopbackIPv4(value: string): boolean {
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  const plain = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  const parts = plain.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((p) => p === "" || !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  return Number(parts[0]) === 127;
}
