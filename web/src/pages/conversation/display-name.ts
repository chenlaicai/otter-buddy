/** 显示名统一解析（层 3）。'Otter' 字面量在此终结——fallback 终点是 senderId。
 *  F20260826fuid：user 消息优先用持久化快照名 sn（飞书群聊多人识别）；
 *  无快照时返回空串，由调用方走全局 userDisplayName fallback（单聊场景不变） */
export function resolveDisplayName(
  m: { sn?: string; si: string; st: string },
  otters: Array<{ id: string; name?: string }>,
): string {
  if (m.st === 'user' || m.st === 'system') {
    const sn = (m.sn || '').trim();
    return sn || '';
  }
  const sn = (m.sn || '').trim();
  if (sn) return sn;
  const cached = otters.find(o => o.id === m.si)?.name;
  return (cached && cached.trim()) ? cached : m.si;
}
