export type ParsedCommand =
  | { command: 'list' }
  | { command: 'in'; conversationId: string }
  | { command: 'history' }
  | { command: 'help' }
  | { command: 'unknown'; raw: string };

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (trimmed === '/list') return { command: 'list' };
  if (trimmed === '/history') return { command: 'history' };
  if (trimmed === '/help') return { command: 'help' };
  const inMatch = trimmed.match(/^\/in\s+(\S+)$/);
  if (inMatch) return { command: 'in', conversationId: inMatch[1] };
  return { command: 'unknown', raw: trimmed };
}

export function formatConversationList(conversations: Array<{ id: string; title: string; occupiedBy?: string }>): string {
  if (conversations.length === 0) {
    return '当前没有活跃的对话';
  }

  const lines = conversations.map((conv, index) => {
    const occupied = conv.occupiedBy ? ` [占用: ${conv.occupiedBy}]` : '';
    return `${index + 1}. ${conv.title} (${conv.id})${occupied}`;
  });

  return `活跃对话列表:\n${lines.join('\n')}`;
}

export function formatMessageHistory(messages: Array<{ senderType: string; body: string | null; createdAt: string }>): string {
  if (messages.length === 0) {
    return '暂无历史消息';
  }

  const lines = messages.map(msg => {
    const sender = msg.senderType === 'user' ? '用户' : msg.senderType === 'otter' ? '水獭' : '系统';
    const body = msg.body || '(空消息)';
    const time = new Date(msg.createdAt).toLocaleString('zh-CN');
    return `[${time}] ${sender}: ${body}`;
  });

  return `最近消息:\n${lines.join('\n')}`;
}

export const HELP_TEXT = `可用命令:
/list - 查看所有活跃对话
/in <对话ID> - 进入指定对话
/history - 查看当前对话历史消息
/help - 显示此帮助信息`;
