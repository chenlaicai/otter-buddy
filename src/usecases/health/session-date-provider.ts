/**
 * F20261027hwl1：session 采集的日期/provider 解析工具（从 cost-output-collector 拆出，守 max-lines）。
 */

/** UTC ISO 时间戳 → Asia/Shanghai 日期键（YYYY-MM-DD）。
 *  禁止裸 slice(0,10)（UTC 日界）——生产时区为 Asia/Shanghai，UTC 16:00 后算错日。 */
export function shanghaiDateKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp.slice(0, 10);
  // sv-SE locale 的格式化输出 YYYY-MM-DD（en-CA 同效；不用 toLocaleDateString('zh-CN')——斜杠分隔）
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/** provider 解析——原生字段优先；缺失时从 model 串前缀推断（glm/kimi/mimo/claude 前缀）。
 *  推不出返回 null（归 unknown 桶，不伪造 provider）。 */
export function resolveProvider(providerField: string | null | undefined, model: string): string | null {
  if (providerField && providerField.trim()) return providerField.trim();
  const m = model.toLowerCase();
  if (m.startsWith("glm")) return "zhipu";
  if (m.startsWith("kimi")) return "moonshot";
  if (m.startsWith("mimo")) return "xiaomimimo";
  if (m.startsWith("claude")) return "anthropic";
  return null;
}
