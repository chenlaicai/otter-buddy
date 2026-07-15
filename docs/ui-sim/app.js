/* ============================================
   Otter Buddy UI Simulation - Shared JS
   Modern message structure: streaming + final,
   context window, timestamp, duration
   Session chain per otter (not per conversation)
   ============================================ */

// === Mock Data ===
const MOCK_DATA = {
  bigOtter: { id: 'otter-1', name: '大獭', type: 'big', status: 'active', createdAt: '2026-07-01' },
  smallOtters: [
    { id: 'otter-2', name: '分析獭', type: 'small', status: 'active', role: { name: '方案A视角', responsibilities: ['从用户体验角度分析', '关注易用性'] }, parentOtterId: 'otter-1', colorIndex: 1 },
    { id: 'otter-3', name: '测试獭', type: 'small', status: 'active', role: { name: '方案B视角', responsibilities: ['从技术架构角度分析', '关注可维护性'] }, parentOtterId: 'otter-1', colorIndex: 2 },
  ],
  // Session chains are PER OTTER, not per conversation
  otterSessions: {
    'otter-1': [
      { id: 'sess-1a', otterId: 'otter-1', status: 'active', startedAt: '2026-07-13 08:00', archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null },
      { id: 'sess-1b', otterId: 'otter-1', status: 'archived', startedAt: '2026-07-12 08:00', archivedAt: '2026-07-13 08:00', archiveReason: 'restart', isNegativeCase: true, summary: '之前方向偏差较大，重启换角度' },
    ],
    'otter-2': [
      { id: 'sess-2a', otterId: 'otter-2', status: 'active', startedAt: '2026-07-13 09:30', archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null },
    ],
    'otter-3': [
      { id: 'sess-3a', otterId: 'otter-3', status: 'active', startedAt: '2026-07-13 10:00', archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null },
    ],
  },
  conversations: [
    { id: 'conv-1', title: 'UI 设计讨论', status: 'active', parentId: null, treePath: '/conv-1/', otterIds: ['otter-1', 'otter-2', 'otter-3'] },
    { id: 'conv-2', title: '数据库选型', status: 'active', parentId: 'conv-1', treePath: '/conv-1/conv-2/', otterIds: ['otter-1'] },
    { id: 'conv-3', title: '前端框架对比', status: 'completed', parentId: null, treePath: '/conv-3/', otterIds: ['otter-1'] },
    { id: 'conv-4', title: 'API 设计规范', status: 'archived', parentId: null, treePath: '/conv-4/', otterIds: ['otter-1'] },
    { id: 'conv-5', title: '测试策略', status: 'active', parentId: 'conv-1', treePath: '/conv-1/conv-5/', otterIds: ['otter-1'] },
  ],
  // Message structure: streamingProcess (separate) + final response, context window, timestamp, duration
  messages: {
    'conv-1': [
      { id: 'msg-1', senderType: 'user', senderId: 'user', content: '我们来做 UI 设计吧', timestamp: '2026-07-13 09:00:12', duration: null, contextTokens: 120, contextMax: 128000 },
      { id: 'msg-2', senderType: 'otter', senderId: 'otter-1', streamingProcess: '> 检索记忆: "UI 设计"\n> 找到 3 条相关记忆\n> 分析 S1-S4 设计文档\n> 生成回复中...', content: '好的！我来分析一下现有的设计文档。\n\n基于 **S1-S4** 的设计，我们需要：\n\n1. 对话视图（三栏布局）\n2. 记忆搜索视图\n3. 能力库视图\n4. 设置视图\n\n```typescript\ninterface ChatView {\n  conversationId: string;\n  messages: Message[];\n}\n```\n\n你觉得这个方向如何？', timestamp: '2026-07-13 09:00:15', duration: '2.3s', contextTokens: 380, contextMax: 128000 },
      { id: 'msg-3', senderType: 'user', senderId: 'user', content: '方向没问题，先出 UI 清单', timestamp: '2026-07-13 09:02:30', duration: null, contextTokens: 420, contextMax: 128000 },
      { id: 'msg-4', senderType: 'otter', senderId: 'otter-1', streamingProcess: '> 整理 UI 清单\n> 4 个页面 + 10 个弹窗 + 15 种状态\n> 覆盖全部 8 个用例\n> 完成', content: '已经整理好了 UI 清单，包含 **4 个页面**、**10 个弹窗** 和 **15 种状态**。覆盖全部 8 个用例。', timestamp: '2026-07-13 09:03:08', duration: '1.8s', contextTokens: 520, contextMax: 128000 },
      { id: 'msg-5', senderType: 'otter', senderId: 'otter-2', streamingProcess: '> 从用户体验角度分析\n> 检查信息密度\n> 生成建议', content: '从用户体验角度，我建议三栏布局要注重信息密度控制，右栏不能太拥挤。', timestamp: '2026-07-13 09:05:22', duration: '3.1s', contextTokens: 680, contextMax: 128000 },
      { id: 'msg-6', senderType: 'otter', senderId: 'otter-3', streamingProcess: '> 从技术架构角度分析\n> 评估 SSE vs WebSocket\n> 建议六边形架构分层', content: '从技术架构角度，建议用 SSE 流式推送，前端用 EventSource 接收。组件可以按六边形架构分层。', timestamp: '2026-07-13 09:06:10', duration: '2.7s', contextTokens: 820, contextMax: 128000 },
    ],
    'conv-2': [
      { id: 'msg-7', senderType: 'user', senderId: 'user', content: '数据库选型用什么？', timestamp: '2026-07-13 10:00:00', duration: null, contextTokens: 50, contextMax: 128000 },
      { id: 'msg-8', senderType: 'otter', senderId: 'otter-1', streamingProcess: '> 检索记忆: "数据库"\n> 分析 S3 数据模型', content: '使用 **SQLite** + FTS5 + sqlite-vec。', timestamp: '2026-07-13 10:00:03', duration: '1.2s', contextTokens: 120, contextMax: 128000 },
    ],
    'conv-3': [
      { id: 'msg-9', senderType: 'user', senderId: 'user', content: '前端用什么框架？', timestamp: '2026-07-13 11:00:00', duration: null, contextTokens: 50, contextMax: 128000 },
      { id: 'msg-10', senderType: 'otter', senderId: 'otter-1', content: 'React 19 + Tailwind 4 + Hono', timestamp: '2026-07-13 11:00:02', duration: '0.9s', contextTokens: 90, contextMax: 128000 },
    ],
  },
  // Older messages for scroll-up loading
  olderMessages: {
    'conv-1': [
      { id: 'msg-0a', senderType: 'user', senderId: 'user', content: '之前那个项目进展怎么样了？', timestamp: '2026-07-12 14:00:00', duration: null, contextTokens: 50, contextMax: 128000 },
      { id: 'msg-0b', senderType: 'otter', senderId: 'otter-1', content: '项目进展顺利，S1-S3 设计文档已完成，S4 正在实现中。', timestamp: '2026-07-12 14:00:05', duration: '1.5s', contextTokens: 120, contextMax: 128000 },
    ],
  },
  keyFacts: {
    'conv-1': [
      { id: 'kf-1', content: 'UI 采用三栏布局', category: '决策', userFlagged: true },
      { id: 'kf-2', content: '消息格式为基础 Markdown', category: '决策', userFlagged: false },
    ],
    'conv-2': [
      { id: 'kf-3', content: '使用 SQLite + FTS5 + sqlite-vec', category: '技术选型', userFlagged: false },
    ],
  },
  linkedResources: {
    'conv-1': [
      { id: 'lr-1', resourceType: 'pr', url: 'https://github.com/chenlaicai/otter-buddy/pull/6', title: 'S1 产品形态定义 PR', autoLinked: false },
      { id: 'lr-2', resourceType: 'file', url: 'docs/features/2026/07/09/F20260709x7k3.md', title: 'S1 Feature 文档', autoLinked: true },
    ],
    'conv-2': [
      { id: 'lr-3', resourceType: 'url', url: 'https://www.sqlite.org/fts5.html', title: 'SQLite FTS5 文档', autoLinked: false },
    ],
  },
  skills: [
    { id: 'skill-1', name: 'code-review', description: '代码审查能力', type: 'tool', assignedTo: ['otter-2'] },
    { id: 'skill-2', name: 'deep-research', description: '深度研究能力', type: 'workflow', assignedTo: [] },
    { id: 'skill-3', name: 'summary-template', description: '摘要模板', type: 'prompt_template', assignedTo: ['otter-3'] },
  ],
  memoryEntries: [
    { id: 'me-1', contentType: 'message', content: 'UI 采用三栏布局，左导航+中内容+右上下文', conversationTitle: 'UI 设计讨论', score: 0.95, time: '2026-07-13 09:01', layer: 'historical', granularity: 'fine', userFlagged: true },
    { id: 'me-2', contentType: 'conversation_summary', content: '讨论了数据库选型，决定使用 SQLite + FTS5 + sqlite-vec', conversationTitle: '数据库选型', score: 0.88, time: '2026-07-13 10:00', layer: 'historical', granularity: 'coarse', userFlagged: false },
    { id: 'me-3', contentType: 'key_fact', content: '使用 SQLite + FTS5 + sqlite-vec', conversationTitle: '数据库选型', score: 0.82, time: '2026-07-13 10:05', layer: 'key_info', granularity: 'coarse', userFlagged: false },
    { id: 'me-4', contentType: 'message', content: '前端使用 React 19 + Tailwind 4 + Hono', conversationTitle: '前端框架对比', score: 0.76, time: '2026-07-13 11:00', layer: 'historical', granularity: 'fine', userFlagged: false },
    { id: 'me-5', contentType: 'linked_resource', content: 'S1 产品形态定义 PR - github.com', conversationTitle: 'UI 设计讨论', score: 0.65, time: '2026-07-13 09:05', layer: 'key_info', granularity: 'coarse', userFlagged: false },
  ],
  llmConfigured: true,
};

// === Page Navigation ===
function navigateTo(page) {
  const pages = { 'chat': 'index.html', 'memory': 'memory-search.html', 'skills': 'skills.html', 'settings': 'settings.html' };
  if (pages[page]) window.location.href = pages[page];
}

// === Modal Control ===
function openModal(id) { const m = document.getElementById(id); if (m) m.classList.add('modal-overlay--open'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('modal-overlay--open'); }
function closeAllModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('modal-overlay--open')); }

// === Toast ===
function showToast(message, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.className = `toast toast--${type} toast--show`;
  setTimeout(() => t.classList.remove('toast--show'), 2500);
}

// === Otter Helpers ===
function getOtterById(id) {
  if (id === MOCK_DATA.bigOtter.id) return MOCK_DATA.bigOtter;
  return MOCK_DATA.smallOtters.find(o => o.id === id);
}
function getOtterAvatarClass(otterId) {
  const otter = getOtterById(otterId);
  if (!otter || otter.type === 'big') return 'message-item__avatar--big-otter';
  return `message-item__avatar--small-otter-${otter.colorIndex || 1}`;
}
function getOtterSenderClass(otterId) {
  const otter = getOtterById(otterId);
  if (!otter || otter.type === 'big') return 'message-item__sender--big-otter';
  return `message-item__sender--small-otter-${otter.colorIndex || 1}`;
}
function getOtterColorVar(otterId) {
  const otter = getOtterById(otterId);
  if (!otter || otter.type === 'big') return '#6B5B4D';
  const colors = { 1: '#4A9B9B', 2: '#C9956B', 3: '#8B7AB8', 4: '#D77A61' };
  return colors[otter.colorIndex || 1] || colors[1];
}
function getOtterAvatarBgClass(otterId) {
  const otter = getOtterById(otterId);
  if (!otter || otter.type === 'big') return 'otter-card__avatar--big';
  return `otter-card__avatar--small-${otter.colorIndex || 1}`;
}

// === Session Helpers (PER OTTER) ===
function getOtterSessions(otterId) {
  return MOCK_DATA.otterSessions[otterId] || [];
}
function getOtterActiveSession(otterId) {
  return getOtterSessions(otterId).find(s => s.status === 'active');
}

// === Conversation List Rendering ===
function renderConversationList(containerId, activeId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = MOCK_DATA.conversations.map(conv => {
    const otters = conv.otterIds.map(id => {
      const otter = getOtterById(id);
      const bg = getOtterColorVar(id);
      const initial = otter?.name?.charAt(0) || '?';
      return `<div class="conversation-item__otter-avatar" style="background: ${bg}">${initial}</div>`;
    }).join('');
    return `
      <div class="conversation-item ${conv.id === activeId ? 'conversation-item--active' : ''}" onclick="selectConversation('${conv.id}')" oncontextmenu="showContextMenu(event, '${conv.id}')">
        <div class="conversation-item__title">${conv.title}</div>
        <div class="conversation-item__meta">
          <div class="conversation-item__status conversation-item__status--${conv.status}"></div>
          <div class="conversation-item__otters">${otters}</div>
        </div>
      </div>`;
  }).join('');
}

// === Conversation Tree ===
function renderConversationTree(containerId, activeId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const roots = MOCK_DATA.conversations.filter(c => !c.parentId);
  function renderNode(conv) {
    const children = MOCK_DATA.conversations.filter(c => c.parentId === conv.id);
    const color = conv.status === 'active' ? 'var(--status-active)' : conv.status === 'completed' ? 'var(--status-completed)' : 'var(--status-archived)';
    return `
      <div class="tree-node ${conv.id === activeId ? 'tree-node--active' : ''}" onclick="selectConversation('${conv.id}')">
        <div class="tree-node__indicator" style="background: ${color}"></div>
        <div class="tree-node__title">${conv.title}</div>
        <button class="tree-node__add-btn" onclick="event.stopPropagation(); openCreateChildModal('${conv.id}')">+</button>
      </div>
      ${children.length ? `<div class="tree-children">${children.map(renderNode).join('')}</div>` : ''}`;
  }
  container.innerHTML = roots.map(renderNode).join('');
}

// === Markdown Rendering ===
function renderMarkdown(content) {
  let html = content;
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const lines = html.split('\n');
  let inList = false, result = [];
  for (let line of lines) {
    if (line.match(/^\d+\.\s+/)) {
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(line.replace(/^\d+\.\s+/, '<li>') + '</li>');
    } else {
      if (inList) { result.push('</ol>'); inList = false; }
      result.push(line);
    }
  }
  if (inList) result.push('</ol>');
  html = result.join('\n').replace(/\n/g, '<br>');
  html = html.replace(/<br>(<pre>|<ol>|<\/ol>)/g, '$1').replace(/(<\/pre>|<\/ol>)<br>/g, '$1');
  return html;
}

// === Context Window Formatting ===
function formatTokens(tokens) {
  if (tokens < 1000) return tokens + ' tokens';
  return (tokens / 1000).toFixed(1) + 'k';
}
function getContextPercent(tokens, max) {
  return Math.min(100, (tokens / max) * 100);
}

// === Message Rendering (with streaming, context, timestamp, duration) ===
function renderMessages(containerId, conversationId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const messages = MOCK_DATA.messages[conversationId] || [];

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">💬</div>
        <div class="empty-state__text">开始对话</div>
        <div class="empty-state__hint">在下方输入消息开始与大獭对话</div>
      </div>`;
    return;
  }

  // Scroll-up indicator (hidden, shown when scrolling up)
  let html = `<div class="scroll-up-indicator" id="scroll-up-indicator" style="display: none;">
    <div class="scroll-up-indicator__spinner"></div>
    <span>加载历史消息...</span>
  </div>`;

  html += messages.map(msg => renderMessageItem(msg)).join('');
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;

  // Setup scroll listener for history loading
  setupScrollUpLoading(container, conversationId);
}

function renderMessageItem(msg) {
  const isUser = msg.senderType === 'user';
  const otter = isUser ? null : getOtterById(msg.senderId);
  const avatarClass = isUser ? 'message-item__avatar--user' : getOtterAvatarClass(msg.senderId);
  const senderClass = isUser ? '' : getOtterSenderClass(msg.senderId);
  const initial = isUser ? '我' : (otter?.name?.charAt(0) || 'O');
  const senderName = isUser ? '我' : (otter?.name || 'Otter');
  const bgColor = isUser ? '#8B7E72' : getOtterColorVar(msg.senderId);

  // Otter color class for bubble accent
  let itemColorClass = '';
  if (!isUser) {
    if (otter?.type === 'big') itemColorClass = 'message-item--big-otter';
    else itemColorClass = `message-item--small-${otter?.colorIndex || 1}`;
  }

  // Meta: timestamp + duration
  const timeStr = msg.timestamp || '';
  const durationStr = msg.duration ? ` · ${msg.duration}` : '';
  const metaHtml = `<div class="message-item__meta">${timeStr}<span class="message-item__meta-dot">·</span>${durationStr || '即时'}</div>`;

  // Streaming process section (inside bubble, only for otter messages)
  let streamingHtml = '';
  if (!isUser && msg.streamingProcess) {
    streamingHtml = `
      <div class="message-streaming message-streaming--collapsed" id="streaming-${msg.id}">
        <div class="message-streaming__header" onclick="toggleStreamingCollapse('${msg.id}')">
          <span class="message-streaming__icon">▼</span>
          <span class="message-streaming__label">流式过程</span>
          <span class="message-streaming__status">已完成 · ${msg.duration || ''}</span>
        </div>
        <div class="message-streaming__body">${msg.streamingProcess}</div>
      </div>`;
  }

  // Context window bar
  const contextTokens = msg.contextTokens || 0;
  const contextMax = msg.contextMax || 128000;
  const contextPercent = getContextPercent(contextTokens, contextMax);
  const contextHtml = `
    <div class="message-item__context">
      <span>${formatTokens(contextTokens)} / ${formatTokens(contextMax)}</span>
      <div class="message-item__context-bar"><div class="message-item__context-fill" style="width: ${contextPercent}%"></div></div>
    </div>`;

  return `
    <div class="message-item ${isUser ? 'message-item--user' : ''} ${itemColorClass}">
      <div class="message-item__avatar ${avatarClass}" style="background: ${bgColor}">${initial}</div>
      <div class="message-item__body">
        <div class="message-item__header">
          <span class="message-item__sender ${senderClass}">${senderName}</span>
          ${metaHtml}
        </div>
        <div class="message-bubble">
          ${streamingHtml}
          ${renderMarkdown(msg.content)}
        </div>
        ${contextHtml}
      </div>
    </div>`;
}

function toggleStreamingCollapse(msgId) {
  const el = document.getElementById('streaming-' + msgId);
  if (el) el.classList.toggle('message-streaming--collapsed');
}

// === Scroll-Up History Loading ===
function setupScrollUpLoading(container, conversationId) {
  let loading = false;
  container.onscroll = function() {
    if (container.scrollTop < 50 && !loading) {
      const older = MOCK_DATA.olderMessages[conversationId];
      if (older && older.length > 0) {
        loading = true;
        const indicator = document.getElementById('scroll-up-indicator');
        if (indicator) indicator.style.display = 'flex';

        // Save scroll position
        const prevHeight = container.scrollHeight;

        setTimeout(() => {
          // Prepend older messages
          const olderHtml = older.map(msg => renderMessageItem(msg)).join('');
          const currentHtml = container.innerHTML;
          container.innerHTML = olderHtml + currentHtml;

          // Restore scroll position
          const newHeight = container.scrollHeight;
          container.scrollTop = newHeight - prevHeight;

          // Clear older messages so it only loads once
          MOCK_DATA.olderMessages[conversationId] = [];

          const ind = document.getElementById('scroll-up-indicator');
          if (ind) ind.style.display = 'none';
          loading = false;
        }, 800);
      }
    }
  };
}

// === Streaming Simulation ===
let streamingInterval = null;
let isStreaming = false;

function simulateStreaming() {
  if (isStreaming) return;
  isStreaming = true;

  const messageList = document.getElementById('message-list');
  const input = document.getElementById('message-input-textarea');
  const sendBtn = document.getElementById('message-send-btn');

  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  const streamingText = '> 检索记忆: "用户需求"\n> 找到 3 条相关记忆\n> 分析上下文\n> 生成回复中...';
  const finalResponse = '好的，我来处理这个需求。\n\n**分析要点：**\n\n1. 需要覆盖所有页面\n2. 交互必须可演示\n3. 组件结构需对应 React\n\n```typescript\nconst result = await process(input);\n```\n\n这个方案如何？';

  // Create message with streaming process (live) + final response (empty initially)
  const streamMsg = document.createElement('div');
  streamMsg.className = 'message-item';
  streamMsg.id = 'streaming-message';
  streamMsg.innerHTML = `
    <div class="message-item__avatar message-item__avatar--big-otter" style="background: var(--otter-big)">獭</div>
    <div class="message-item__body">
      <div class="message-item__header">
        <span class="message-item__sender message-item__sender--big-otter">大獭</span>
        <div class="message-item__meta">正在回复...</div>
      </div>
      <div class="message-bubble">
        <div class="message-streaming" id="live-streaming-section">
          <div class="message-streaming__header">
            <span class="message-streaming__icon">▼</span>
            <span class="message-streaming__label">流式过程</span>
            <span class="message-streaming__status">
              <span class="message-streaming__dots">
                <span class="message-streaming__dot"></span>
                <span class="message-streaming__dot"></span>
                <span class="message-streaming__dot"></span>
              </span>
              生成中
            </span>
          </div>
          <div class="message-streaming__body" id="streaming-content"></div>
        </div>
        <div id="final-response" style="display: none;"></div>
      </div>
      <div id="streaming-stop-btn" style="margin-top: 6px;">
        <button class="stop-generation-btn" onclick="stopStreaming()">
          <div class="stop-generation-btn__icon"></div>
          停止生成
        </button>
      </div>
    </div>`;
  if (messageList) {
    messageList.appendChild(streamMsg);
    messageList.scrollTop = messageList.scrollHeight;
  }

  // Phase 1: Stream the streaming process text
  const contentEl = document.getElementById('streaming-content');
  let idx = 0;
  const startTime = Date.now();

  streamingInterval = setInterval(() => {
    if (idx >= streamingText.length) {
      // Phase 2: Show final response
      finishStreaming(streamingText, finalResponse, startTime);
      return;
    }
    idx += 3;
    if (contentEl) contentEl.textContent = streamingText.substring(0, idx) + (idx < streamingText.length ? '▋' : '');
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, 40);
}

function stopStreaming() {
  if (streamingInterval) { clearInterval(streamingInterval); streamingInterval = null; }
  const contentEl = document.getElementById('streaming-content');
  const partialText = contentEl?.textContent || '';
  finishStreaming(partialText, '', Date.now() - 2000);
}

function finishStreaming(streamingText, finalResponse, startTime) {
  if (streamingInterval) { clearInterval(streamingInterval); streamingInterval = null; }
  const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  const contentEl = document.getElementById('streaming-content');
  const stopBtn = document.getElementById('streaming-stop-btn');
  const streamMsg = document.getElementById('streaming-message');
  const messageList = document.getElementById('message-list');
  const input = document.getElementById('message-input-textarea');
  const sendBtn = document.getElementById('message-send-btn');
  const liveSection = document.getElementById('live-streaming-section');
  const finalEl = document.getElementById('final-response');

  // Finalize streaming process section
  if (contentEl) contentEl.textContent = streamingText;
  if (liveSection) {
    // Update status to "已完成"
    const statusEl = liveSection.querySelector('.message-streaming__status');
    if (statusEl) statusEl.innerHTML = `已完成 · ${duration}`;
    // Make it collapsible
    const header = liveSection.querySelector('.message-streaming__header');
    if (header) {
      header.style.cursor = 'pointer';
      header.onclick = function() { liveSection.classList.toggle('message-streaming--collapsed'); };
    }
    // Collapse by default
    liveSection.classList.add('message-streaming--collapsed');
  }
  if (stopBtn) stopBtn.remove();

  // Show final response
  if (finalEl && finalResponse) {
    finalEl.innerHTML = renderMarkdown(finalResponse);
    finalEl.style.display = 'block';
  }

  // Add context bar
  if (streamMsg && !streamMsg.querySelector('.message-item__context')) {
    const ctxDiv = document.createElement('div');
    ctxDiv.className = 'message-item__context';
    ctxDiv.innerHTML = `
      <span>${formatTokens(820)} / ${formatTokens(128000)}</span>
      <div class="message-item__context-bar"><div class="message-item__context-fill" style="width: ${getContextPercent(820, 128000)}%"></div></div>`;
    streamMsg.appendChild(ctxDiv);
  }

  // Update meta
  if (streamMsg) {
    const metaEl = streamMsg.querySelector('.message-item__meta');
    if (metaEl) metaEl.innerHTML = `${new Date().toLocaleString('zh-CN', { hour12: false })}<span class="message-item__meta-dot">·</span>${duration}`;
  }

  if (input) input.disabled = false;
  if (sendBtn) sendBtn.disabled = false;
  isStreaming = false;
  if (messageList) messageList.scrollTop = messageList.scrollHeight;
}

// === Send Message ===
function sendMessage() {
  const input = document.getElementById('message-input-textarea');
  if (!input || !input.value.trim()) return;
  const conversationId = document.body.dataset.conversationId || 'conv-1';
  if (!MOCK_DATA.messages[conversationId]) MOCK_DATA.messages[conversationId] = [];

  const userMsg = {
    id: 'msg-' + Date.now(),
    senderType: 'user',
    senderId: 'user',
    content: input.value,
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
    duration: null,
    contextTokens: 850,
    contextMax: 128000,
  };
  MOCK_DATA.messages[conversationId].push(userMsg);
  input.value = '';
  renderMessages('message-list', conversationId);
  setTimeout(simulateStreaming, 400);
}

// === Conversation Selection ===
function selectConversation(convId) {
  document.body.dataset.conversationId = convId;
  const conv = MOCK_DATA.conversations.find(c => c.id === convId);
  if (!conv) return;

  const titleEl = document.getElementById('chat-header-title');
  if (titleEl) titleEl.textContent = conv.title;

  const statusBadge = document.getElementById('chat-header-status');
  if (statusBadge) {
    statusBadge.className = `chat-header__status-badge chat-header__status-badge--${conv.status}`;
    statusBadge.textContent = conv.status === 'active' ? '活跃' : conv.status === 'completed' ? '已完成' : '已归档';
  }

  renderMessages('message-list', convId);
  renderRightPanel(convId);
  renderConversationList('conversation-list', convId);
  renderConversationTree('conversation-tree', convId);

  const input = document.getElementById('message-input-textarea');
  const sendBtn = document.getElementById('message-send-btn');
  if (input) input.disabled = conv.status === 'archived';
  if (sendBtn) sendBtn.disabled = conv.status === 'archived';
}

// === Right Panel Rendering (Session PER OTTER, not per conversation) ===
function renderRightPanel(convId) {
  const conv = MOCK_DATA.conversations.find(c => c.id === convId);
  if (!conv) return;

  // Otter participants - now with session info per otter
  const otterContainer = document.getElementById('otter-participants');
  if (otterContainer) {
    const otters = conv.otterIds.map(id => getOtterById(id)).filter(Boolean);
    otterContainer.innerHTML = otters.map(otter => {
      const isBig = otter.type === 'big';
      const avatarClass = getOtterAvatarBgClass(otter.id);
      const bgColor = getOtterColorVar(otter.id);
      const sessions = getOtterSessions(otter.id);
      const activeSession = getOtterActiveSession(otter.id);
      const sessionCount = sessions.length;
      const sessionInfo = activeSession
        ? `<div class="otter-card__session-mini">Session #${sessionCount} · ${activeSession.startedAt.split(' ')[1] || activeSession.startedAt}</div>`
        : '';

      return `
        <div class="otter-card" onclick="openOtterDetail('${otter.id}')">
          <div class="otter-card__avatar ${avatarClass}" style="background: ${bgColor}">${otter.name.charAt(0)}</div>
          <div class="otter-card__info">
            <div class="otter-card__name">${otter.name}</div>
            <div class="otter-card__role">${isBig ? '大獭 · 持久' : otter.role?.name || ''}</div>
            ${sessionInfo}
          </div>
          ${isBig ? '<span class="otter-card__tag">大獭</span>' : `<span class="otter-card__menu" onclick="event.stopPropagation(); openDissolveModal('${otter.id}')">⋯</span>`}
          <button class="otter-card__restart-btn" onclick="event.stopPropagation(); openRestartModal('${otter.id}')">重启獭生</button>
        </div>`;
    }).join('') + `
      <button class="btn btn--secondary" style="width: 100%; margin-top: 8px; font-size: 13px; padding: 7px;" onclick="openModal('modal-create-small-otter')">+ 创建小獭</button>`;
  }

  // Key facts
  const factsContainer = document.getElementById('key-facts-list');
  if (factsContainer) {
    const facts = MOCK_DATA.keyFacts[convId] || [];
    factsContainer.innerHTML = facts.map(f => `
      <div class="key-fact-item">
        <span class="key-fact-item__star ${f.userFlagged ? 'key-fact-item__star--active' : ''}" onclick="toggleFactStar('${f.id}')">${f.userFlagged ? '★' : '☆'}</span>
        <div class="key-fact-item__content">${f.content}<span class="key-fact-item__category">${f.category}</span></div>
        <span class="key-fact-item__delete" onclick="deleteFact('${f.id}')">✕</span>
      </div>`).join('');
  }

  // Linked resources
  const resourcesContainer = document.getElementById('linked-resources-list');
  if (resourcesContainer) {
    const resources = MOCK_DATA.linkedResources[convId] || [];
    const icons = { pr: '🔗', file: '📄', url: '🌐', branch: '🌿', worktree: '🗂' };
    resourcesContainer.innerHTML = resources.map(r => `
      <div class="linked-resource-item">
        <span class="linked-resource-item__icon">${icons[r.resourceType] || '📎'}</span>
        <a class="linked-resource-item__title" href="${r.url}" target="_blank">${r.title || r.url}</a>
        ${r.autoLinked ? '<span class="linked-resource-item__auto-tag">自动</span>' : ''}
        <span class="linked-resource-item__delete" onclick="deleteResource('${r.id}')">✕</span>
      </div>`).join('');
  }
}

// === Key Fact Operations ===
function toggleAddKeyFact() {
  const form = document.getElementById('key-fact-form');
  if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
}
function addKeyFact() {
  const contentInput = document.getElementById('key-fact-content');
  const categoryInput = document.getElementById('key-fact-category');
  if (!contentInput || !contentInput.value.trim()) return;
  const convId = document.body.dataset.conversationId || 'conv-1';
  if (!MOCK_DATA.keyFacts[convId]) MOCK_DATA.keyFacts[convId] = [];
  MOCK_DATA.keyFacts[convId].push({ id: 'kf-' + Date.now(), content: contentInput.value, category: categoryInput?.value || '', userFlagged: false });
  contentInput.value = ''; categoryInput.value = '';
  toggleAddKeyFact();
  renderRightPanel(convId);
  showToast('关键事实已添加', 'success');
}
function toggleFactStar(factId) {
  for (const convId in MOCK_DATA.keyFacts) {
    const fact = MOCK_DATA.keyFacts[convId].find(f => f.id === factId);
    if (fact) { fact.userFlagged = !fact.userFlagged; renderRightPanel(convId); break; }
  }
}
function deleteFact(factId) {
  for (const convId in MOCK_DATA.keyFacts) {
    MOCK_DATA.keyFacts[convId] = MOCK_DATA.keyFacts[convId].filter(f => f.id !== factId);
    renderRightPanel(convId);
  }
}

// === Linked Resource Operations ===
function addLinkedResource() {
  const typeInput = document.getElementById('lr-type');
  const urlInput = document.getElementById('lr-url');
  const titleInput = document.getElementById('lr-title');
  if (!urlInput || !urlInput.value.trim()) return;
  const convId = document.body.dataset.conversationId || 'conv-1';
  if (!MOCK_DATA.linkedResources[convId]) MOCK_DATA.linkedResources[convId] = [];
  MOCK_DATA.linkedResources[convId].push({ id: 'lr-' + Date.now(), resourceType: typeInput?.value || 'url', url: urlInput.value, title: titleInput?.value || urlInput.value, autoLinked: false });
  typeInput.value = ''; urlInput.value = ''; titleInput.value = '';
  closeModal('modal-link-resource');
  renderRightPanel(convId);
  showToast('资源已链接', 'success');
}
function deleteResource(resId) {
  for (const convId in MOCK_DATA.linkedResources) {
    MOCK_DATA.linkedResources[convId] = MOCK_DATA.linkedResources[convId].filter(r => r.id !== resId);
    renderRightPanel(convId);
  }
}

// === Context Menu ===
function showContextMenu(event, convId) {
  event.preventDefault();
  const menu = document.getElementById('context-menu');
  if (!menu) return;
  const conv = MOCK_DATA.conversations.find(c => c.id === convId);
  if (!conv) return;
  const canComplete = conv.status === 'active';
  const canArchive = conv.status !== 'archived';
  menu.innerHTML = `
    <div class="context-menu__item ${!canComplete ? 'context-menu__item--disabled' : ''}" onclick="closeContextMenu(); ${canComplete ? `openCompleteModal('${convId}')` : ''}">完成对话</div>
    <div class="context-menu__item ${!canArchive ? 'context-menu__item--disabled' : ''}" onclick="closeContextMenu(); ${canArchive ? `openArchiveModal('${convId}')` : ''}">归档对话</div>
    <div class="context-menu__item" onclick="closeContextMenu(); openCreateChildModal('${convId}')">创建子对话</div>`;
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.classList.add('context-menu--show');
}
function closeContextMenu() { const m = document.getElementById('context-menu'); if (m) m.classList.remove('context-menu--show'); }

// === Left Panel Mode ===
function toggleLeftPanelMode(mode) {
  const listEl = document.getElementById('conversation-list');
  const treeEl = document.getElementById('conversation-tree');
  const btnList = document.getElementById('mode-btn-list');
  const btnTree = document.getElementById('mode-btn-tree');
  if (mode === 'list') {
    if (listEl) listEl.style.display = 'block';
    if (treeEl) treeEl.style.display = 'none';
    if (btnList) btnList.classList.add('left-panel__mode-btn--active');
    if (btnTree) btnTree.classList.remove('left-panel__mode-btn--active');
  } else {
    if (listEl) listEl.style.display = 'none';
    if (treeEl) treeEl.style.display = 'block';
    if (btnList) btnList.classList.remove('left-panel__mode-btn--active');
    if (btnTree) btnTree.classList.add('left-panel__mode-btn--active');
  }
}

// === @Mention ===
function handleMention(input) {
  const cursorPos = input.selectionStart;
  const textBeforeCursor = input.value.substring(0, cursorPos);
  const atMatch = textBeforeCursor.match(/@(\w*)$/);
  const mentionList = document.getElementById('mention-list');
  if (!mentionList) return;
  if (atMatch) {
    const query = atMatch[1].toLowerCase();
    const otters = [MOCK_DATA.bigOtter, ...MOCK_DATA.smallOtters];
    const matches = otters.filter(o => o.name.toLowerCase().includes(query));
    if (matches.length > 0) {
      mentionList.innerHTML = matches.map(o => {
        const bg = getOtterColorVar(o.id);
        return `<div class="message-input__mention-item" onclick="insertMention('${o.name}')">
          <div style="width: 22px; height: 22px; border-radius: 50%; background: ${bg}; color: white; font-size: 11px; display: flex; align-items: center; justify-content: center; font-weight: 600;">${o.name.charAt(0)}</div>
          ${o.name}
        </div>`;
      }).join('');
      mentionList.style.display = 'block';
    } else { mentionList.style.display = 'none'; }
  } else { mentionList.style.display = 'none'; }
}
function insertMention(name) {
  const input = document.getElementById('message-input-textarea');
  const mentionList = document.getElementById('mention-list');
  if (!input) return;
  const cursorPos = input.selectionStart;
  const textBefore = input.value.substring(0, cursorPos);
  const textAfter = input.value.substring(cursorPos);
  const atMatch = textBefore.match(/@(\w*)$/);
  if (atMatch) {
    input.value = textBefore.substring(0, atMatch.index) + '@' + name + ' ' + textAfter;
    const newPos = atMatch.index + name.length + 2;
    input.focus(); input.setSelectionRange(newPos, newPos);
  }
  if (mentionList) mentionList.style.display = 'none';
}

// === Otter Detail (with session chain) ===
function openOtterDetail(otterId) {
  const otter = getOtterById(otterId);
  if (!otter) return;
  const nameEl = document.getElementById('otter-detail-name');
  const typeEl = document.getElementById('otter-detail-type');
  const roleEl = document.getElementById('otter-detail-role');
  const respEl = document.getElementById('otter-detail-responsibilities');
  const createdEl = document.getElementById('otter-detail-created');
  const sessionsEl = document.getElementById('otter-detail-sessions');
  const skillsEl = document.getElementById('otter-detail-skills');
  const actionsEl = document.getElementById('otter-detail-actions');

  if (nameEl) nameEl.textContent = otter.name;
  if (typeEl) typeEl.textContent = otter.type === 'big' ? '大獭' : '小獭';
  if (roleEl) roleEl.textContent = otter.role?.name || '-';
  if (respEl) respEl.innerHTML = (otter.role?.responsibilities || []).map(r => `<li>${r}</li>`).join('') || '-';
  if (createdEl) createdEl.textContent = otter.createdAt;

  // Sessions (PER OTTER)
  const sessions = getOtterSessions(otterId);
  if (sessionsEl) {
    sessionsEl.innerHTML = sessions.map(s => `
      <tr>
        <td style="padding: 6px 10px; font-size: 13px;">${s.status === 'active' ? '🟢 活跃' : '📦 归档'}</td>
        <td style="padding: 6px 10px; font-size: 13px;">${s.startedAt}</td>
        <td style="padding: 6px 10px; font-size: 13px;">${s.archivedAt || '-'}</td>
        <td style="padding: 6px 10px; font-size: 13px;">${s.archiveReason || '-'}</td>
        <td style="padding: 6px 10px; font-size: 13px;">${s.isNegativeCase ? '⚠️ 是' : '-'}</td>
        <td style="padding: 6px 10px; font-size: 13px;">${s.summary || '-'}</td>
      </tr>`).join('');
  }

  const skills = MOCK_DATA.skills.filter(s => s.assignedTo.includes(otterId));
  if (skillsEl) {
    skillsEl.innerHTML = skills.length > 0
      ? skills.map(s => `<span class="skill-detail__assignment-tag">${s.name}</span>`).join('')
      : '<span style="font-size: 13px; color: var(--text-muted);">无已加载能力</span>';
  }

  if (actionsEl) {
    if (otter.type === 'big') {
      actionsEl.innerHTML = `<button class="btn btn--danger" onclick="closeModal('modal-otter-detail'); openRestartModal('${otter.id}')">重启獭生</button>`;
    } else {
      actionsEl.innerHTML = `<button class="btn btn--danger" onclick="closeModal('modal-otter-detail'); openDissolveModal('${otter.id}')">解散小獭</button>`;
    }
  }
  openModal('modal-otter-detail');
}

// === Restart Otter Life (PER OTTER) ===
function openRestartModal(otterId) {
  const otter = getOtterById(otterId);
  if (!otter) return;
  document.body.dataset.restartOtterId = otterId;
  const nameEl = document.getElementById('restart-otter-name');
  if (nameEl) nameEl.textContent = otter.name;
  openModal('modal-restart-otter-life');
}
function confirmRestart() {
  const otterId = document.body.dataset.restartOtterId;
  if (otterId) {
    // Archive current session and create new one
    if (!MOCK_DATA.otterSessions[otterId]) MOCK_DATA.otterSessions[otterId] = [];
    const sessions = MOCK_DATA.otterSessions[otterId];
    const activeIdx = sessions.findIndex(s => s.status === 'active');
    if (activeIdx >= 0) {
      sessions[activeIdx].status = 'archived';
      sessions[activeIdx].archivedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      sessions[activeIdx].archiveReason = 'restart';
      sessions[activeIdx].isNegativeCase = true;
    }
    sessions.push({
      id: 'sess-' + Date.now(),
      otterId: otterId,
      status: 'active',
      startedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      archivedAt: null,
      archiveReason: null,
      isNegativeCase: false,
      summary: null,
    });
    const convId = document.body.dataset.conversationId || 'conv-1';
    renderRightPanel(convId);
  }
  closeModal('modal-restart-otter-life');
  showToast('Session 已封存，新 Session 已开始', 'success');
}

// === Dissolve Small Otter ===
function openDissolveModal(otterId) {
  const otter = getOtterById(otterId);
  if (!otter) return;
  const nameEl = document.getElementById('dissolve-otter-name');
  if (nameEl) nameEl.textContent = otter.name;
  document.body.dataset.dissolveOtterId = otterId;
  openModal('modal-dissolve-otter');
}
function confirmDissolve() {
  const otterId = document.body.dataset.dissolveOtterId;
  if (otterId) {
    MOCK_DATA.smallOtters = MOCK_DATA.smallOtters.filter(o => o.id !== otterId);
    MOCK_DATA.conversations.forEach(c => { c.otterIds = c.otterIds.filter(id => id !== otterId); });
    const convId = document.body.dataset.conversationId || 'conv-1';
    renderRightPanel(convId);
  }
  closeModal('modal-dissolve-otter');
  showToast('小獭已解散，Session 已归档', 'success');
}

// === Create Small Otter ===
function confirmCreateSmallOtter() {
  const name = document.getElementById('create-otter-name')?.value;
  const role = document.getElementById('create-otter-role')?.value;
  const responsibilities = document.getElementById('create-otter-responsibilities')?.value;
  if (!name) { showToast('请输入小獭名称', 'error'); return; }
  const colorIndex = (MOCK_DATA.smallOtters.length % 4) + 1;
  const newOtter = { id: 'otter-' + Date.now(), name, type: 'small', status: 'active', role: { name: role || '', responsibilities: responsibilities ? responsibilities.split('\n').filter(Boolean) : [] }, parentOtterId: MOCK_DATA.bigOtter.id, colorIndex };
  MOCK_DATA.smallOtters.push(newOtter);
  // Create initial session for the new otter
  MOCK_DATA.otterSessions[newOtter.id] = [{ id: 'sess-' + Date.now(), otterId: newOtter.id, status: 'active', startedAt: new Date().toLocaleString('zh-CN', { hour12: false }), archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null }];
  const convId = document.body.dataset.conversationId || 'conv-1';
  const conv = MOCK_DATA.conversations.find(c => c.id === convId);
  if (conv) conv.otterIds.push(newOtter.id);
  closeModal('modal-create-small-otter');
  renderRightPanel(convId);
  showToast(`小獭 ${name} 已创建`, 'success');
  ['create-otter-name', 'create-otter-role', 'create-otter-responsibilities'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

// === Create Child Conversation ===
function openCreateChildModal(parentId) { document.body.dataset.createChildParent = parentId; openModal('modal-create-child'); }
function confirmCreateChild() {
  const title = document.getElementById('child-title')?.value;
  if (!title) { showToast('请输入标题', 'error'); return; }
  const parentId = document.body.dataset.createChildParent;
  const parent = MOCK_DATA.conversations.find(c => c.id === parentId);
  if (parent) {
    const newConv = { id: 'conv-' + Date.now(), title, status: 'active', parentId, treePath: parent.treePath + 'conv-' + Date.now() + '/', otterIds: [MOCK_DATA.bigOtter.id] };
    MOCK_DATA.conversations.push(newConv);
    renderConversationList('conversation-list', newConv.id);
    renderConversationTree('conversation-tree', newConv.id);
    selectConversation(newConv.id);
  }
  closeModal('modal-create-child');
  document.getElementById('child-title').value = '';
  showToast('子对话已创建', 'success');
}

// === Complete / Archive ===
function openCompleteModal(convId) { document.body.dataset.completeConvId = convId; openModal('modal-complete-conversation'); }
function confirmComplete() {
  const convId = document.body.dataset.completeConvId;
  const conv = MOCK_DATA.conversations.find(c => c.id === convId);
  if (conv) conv.status = 'completed';
  closeModal('modal-complete-conversation');
  selectConversation(convId);
  showToast('对话已完成', 'success');
}
function openArchiveModal(convId) { document.body.dataset.archiveConvId = convId; openModal('modal-archive-conversation'); }
function confirmArchive() {
  const convId = document.body.dataset.archiveConvId;
  const conv = MOCK_DATA.conversations.find(c => c.id === convId);
  if (conv) conv.status = 'archived';
  closeModal('modal-archive-conversation');
  selectConversation(convId);
  showToast('对话已归档', 'success');
}

// === Create New Conversation ===
function confirmCreateConversation() {
  const title = document.getElementById('new-conv-title')?.value;
  if (!title) { showToast('请输入标题', 'error'); return; }
  const newConv = { id: 'conv-' + Date.now(), title, status: 'active', parentId: null, treePath: '/conv-' + Date.now() + '/', otterIds: [MOCK_DATA.bigOtter.id] };
  MOCK_DATA.conversations.unshift(newConv);
  MOCK_DATA.messages[newConv.id] = [];
  closeModal('modal-new-conversation');
  document.getElementById('new-conv-title').value = '';
  renderConversationList('conversation-list', newConv.id);
  renderConversationTree('conversation-tree', newConv.id);
  selectConversation(newConv.id);
  showToast('对话已创建', 'success');
}

// === State Toggles ===
function toggleState(stateName) {
  closeAllModals();
  const messageList = document.getElementById('message-list');
  const chatView = document.getElementById('chat-view-content');
  switch(stateName) {
    case 'empty':
      if (messageList) messageList.innerHTML = `<div class="empty-state"><div class="empty-state__icon">💬</div><div class="empty-state__text">开始对话</div><div class="empty-state__hint">在下方输入消息开始与大獭对话</div></div>`;
      break;
    case 'loading':
      if (messageList) messageList.innerHTML = `<div class="skeleton skeleton--message"></div><div class="skeleton skeleton--message"></div><div class="skeleton skeleton--message"></div>`;
      break;
    case 'error':
      if (messageList) messageList.innerHTML += `<div class="error-card"><span>⚠️ LLM 调用失败：API Key 无效</span><button class="error-card__retry" onclick="showToast('正在重试...', 'info')">重试</button></div>`;
      break;
    case 'sse-disconnect':
      const bar = document.getElementById('sse-status-bar');
      if (bar) bar.classList.add('sse-status-bar--show');
      setTimeout(() => { if (bar) bar.classList.remove('sse-status-bar--show'); }, 3000);
      break;
    case 'llm-not-configured':
      if (chatView) {
        chatView.innerHTML = `<div class="llm-setup-guide"><div class="llm-setup-guide__icon">⚙️</div><div class="llm-setup-guide__title">请先配置 LLM</div><div class="llm-setup-guide__desc">系统需要 LLM API Key 才能工作。<br>请前往设置页面配置。</div><button class="btn btn--primary" onclick="navigateTo('settings')">前往设置</button></div>`;
      }
      break;
  }
}

// === Init ===
document.addEventListener('DOMContentLoaded', function() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu') && !e.target.closest('.conversation-item')) closeContextMenu();
    const ml = document.getElementById('mention-list');
    if (ml && !e.target.closest('.message-input__mention-list') && !e.target.closest('.message-input__textarea')) ml.style.display = 'none';
  });
  document.querySelectorAll('.modal-overlay').forEach(o => { o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('modal-overlay--open'); }); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });
});
