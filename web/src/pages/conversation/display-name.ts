/** 显示名统一解析（层 3）。'Otter' 字面量在此终结——fallback 终点是 senderId。 */
export function resolveDisplayName(
  m: { sn?: string; si: string; st: string },
  otters: Array<{ id: string; name?: string }>,
): string {
  if (m.st === 'user') return '';
  if (m.st === 'system') return '';
  const sn = (m.sn || '').trim();
  if (sn) return sn;
  const cached = otters.find(o => o.id === m.si)?.name;
  return (cached && cached.trim()) ? cached : m.si;
}
