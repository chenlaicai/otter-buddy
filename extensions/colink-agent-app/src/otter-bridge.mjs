import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'aborted']);
export const EXTERNAL_TOKEN_BUDGET_ERROR_CODE = 'EXTERNAL_TOKEN_BUDGET_EXCEEDED';
const EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX = `${EXTERNAL_TOKEN_BUDGET_ERROR_CODE}:`;

export class ExternalTokenBudgetError extends Error {
  constructor(userMessage) {
    super(`${EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX}${userMessage}`);
    this.userMessage = userMessage;
  }
}

/** 兼容 HTTP 文本与持久化系统条目的错误形状；正常路径优先使用 Error.userMessage。 */
export function externalTokenBudgetMessage(error) {
  if (typeof error?.userMessage === 'string') return error.userMessage;
  const match = String(error?.message ?? error).match(/EXTERNAL_TOKEN_BUDGET_EXCEEDED:([^\n"]+)/);
  return match?.[1] ?? null;
}

function publicText(body) {
  return String(body ?? '')
    .replace(/```html-card[^\n]*\n[\s\S]*?```/gi, '')
    .replace(/<healing>[\s\S]*?<\/healing>/gi, '')
    .trim();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ConversationStore {
  constructor(file) {
    this.file = file;
    this.bindings = new Map();
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === 'string' && value) this.bindings.set(key, value);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  get(key) { return this.bindings.get(key); }

  set(key, conversationId) {
    this.bindings.set(key, conversationId);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.bindings), null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export class OtterBridge {
  constructor({ baseUrl, store, fetcher = fetch, timeoutMs = 180_000, pollMs = 1_000, toolBridge }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.store = store;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.toolBridge = toolBridge;
    this.lanes = new Map();
  }

  async request(path, options = {}, signal) {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'X-Otter-User-Id': 'colink-agent-app',
        'X-Otter-User-Role': 'admin',
        ...options.headers,
      },
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      try {
        const payload = JSON.parse(detail);
        if (payload.code === EXTERNAL_TOKEN_BUDGET_ERROR_CODE && typeof payload.error === 'string') {
          throw new ExternalTokenBudgetError(payload.error.slice(EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX.length));
        }
      } catch (error) {
        if (error instanceof ExternalTokenBudgetError) throw error;
      }
      throw new Error(`OTTER_HTTP_${response.status}: ${detail}`);
    }
    return response;
  }

  async ensureConversation(externalKey, title) {
    const existing = this.store.get(externalKey);
    if (existing) return existing;
    const response = await this.request('/api/conversations', {
      method: 'POST',
      // Why（F20261119extsg）：声明 kind=external——中枢据此把**该对话的一切 invoke**（含搭档本人
      // 从 web UI 的发言、后续所有 hop）钉在受限档，不再只依赖单条消息的 source。
      body: JSON.stringify({ title, kind: 'external' }),
    });
    const conversation = await response.json();
    if (!conversation.id || !Array.isArray(conversation.otterIds) || conversation.otterIds.length !== 1) {
      throw new Error('OTTER_SINGLE_OTTER_REQUIRED');
    }
    this.store.set(externalKey, conversation.id);
    return conversation.id;
  }

  async reply({ kind = 'dm', deploymentId, installationId, conversationId, actorId, text, images = [], failedImageIds = [], ctx, signal }) {
    if (!['dm', 'channel'].includes(kind)) throw new Error('OTTER_EXTERNAL_KIND_INVALID');
    // Why: 保留既有 DM 映射键；频道加命名空间，避免同 UUID 的 DM 与频道串会话。
    const externalId = kind === 'channel' ? `channel:${conversationId}` : conversationId;
    const key = JSON.stringify([deploymentId, installationId, externalId]);
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const label = kind === 'channel' ? '频道' : '私聊';
      const otterConversationId = await this.ensureConversation(key, `CoLink ${label} ${conversationId.slice(0, 8)}`);
      // Why: 常驻 MCP bearer 指向当前 active turn；旧 Agent 未终态时重绑会借用新事件授权。
      await this.assertConversationIdle(otterConversationId, signal);
      // 图片预下载后先上传到海獭系统附件库，再随消息带 attachmentIds 注入（多模态 链路）。
      // 上传失败逐张降级：图片缺席但不阻断文本消息，并把失败 id 记入提示避免模型误以为收到图。
      const attachmentIds = [];
      const failedUploadIds = [];
      for (const image of images) {
        try {
          attachmentIds.push(await this.uploadAttachment(otterConversationId, image, signal));
        } catch {
          failedUploadIds.push(image.fileId ?? '未知');
        }
      }
      const imageNote = [
        failedImageIds.length
          ? `\n[附带图片] ${failedImageIds.length} 张图片未能读取（可能未授权 files:read）：${failedImageIds.join('、')}`
          : '',
        failedUploadIds.length
          ? `\n[附带图片] ${failedUploadIds.length} 张图片注入附件库失败：${failedUploadIds.join('、')}`
          : '',
      ].filter(Boolean).join('');
      const execute = prompt => this.runTurn({
        otterConversationId, actorId, signal,
        text: `${prompt || '[图片]'}${imageNote}`,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      if (!this.toolBridge) return execute(text);
      if (!ctx) throw new Error('COLINK_EVENT_CONTEXT_REQUIRED_FOR_TOOLS');
      return this.toolBridge.run({
        otterConversationId,
        ctx,
        register: config => this.request(`/api/conversations/${otterConversationId}/workspace/mcp-external`, {
          method: 'PUT', body: JSON.stringify(config),
        }, signal),
      }, execute);
    });
    this.lanes.set(key, current);
    try { return await current; } finally {
      if (this.lanes.get(key) === current) this.lanes.delete(key);
    }
  }

  /** 上传一张图片到海獭系统附件库（multipart/form-data），返回 attachmentId。 */
  async uploadAttachment(otterConversationId, { bytes, mimeType, fileName }, signal) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), fileName);
    const response = await this.fetcher(
      `${this.baseUrl}/api/conversations/${otterConversationId}/attachments?uploaderId=colink-agent-app`,
      {
        method: 'POST',
        body: form,
        headers: {
          'X-Otter-User-Id': 'colink-agent-app',
          'X-Otter-User-Role': 'admin',
        },
        signal,
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`OTTER_HTTP_${response.status}: ${detail}`);
    }
    const payload = await response.json();
    const id = payload?.attachments?.[0]?.id;
    if (typeof id !== 'string' || !id) throw new Error('OTTER_ATTACHMENT_MISSING_ID');
    return id;
  }

  async listInvokes(otterConversationId, signal) {
    const response = await this.request(`/api/conversations/${otterConversationId}/invokes?limit=200`, {}, signal);
    return (await response.json()).invokes;
  }

  async abortRunningInvokes(otterConversationId) {
    const invokes = await this.listInvokes(otterConversationId);
    const running = invokes.filter(invoke => !TERMINAL.has(invoke.status));
    await Promise.all(running.map(invoke => this.request(`/api/invokes/${invoke.id}/abort`, { method: 'POST', body: '{}' })
      .catch(error => { if (!String(error.message).includes('OTTER_HTTP_409')) throw error; })));
    if (!running.length) return;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = await this.listInvokes(otterConversationId);
      if (current.every(invoke => TERMINAL.has(invoke.status))) return;
      await sleep(this.pollMs);
    }
    throw new Error('OTTER_CONVERSATION_NOT_IDLE');
  }

  async assertConversationIdle(otterConversationId, signal) {
    const invokes = await this.listInvokes(otterConversationId, signal);
    if (invokes.some(invoke => !TERMINAL.has(invoke.status))) {
      await this.abortRunningInvokes(otterConversationId);
      // Why: 被清理的是上一事件；当前事件不接着执行，调用方可在下一轮安全重试。
      throw new Error('OTTER_PREVIOUS_TURN_ABORTED');
    }
    const waiting = invokes[0]?.talkingStonePassedTo?.some(target => target && target !== 'user');
    if (waiting) throw new Error('OTTER_CONVERSATION_NOT_IDLE');
  }

  async runTurn(input) {
    try {
      return await this.runTurnObserved(input);
    } catch (error) {
      try {
        await this.abortRunningInvokes(input.otterConversationId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'OTTER_TURN_CLEANUP_FAILED');
      }
      throw error;
    }
  }

  async runTurnObserved({ otterConversationId, actorId, text, attachmentIds, signal }) {
    const startedAt = Date.now();
    const payload = { senderId: `external:${actorId}`, body: text, source: 'external' };
    if (Array.isArray(attachmentIds) && attachmentIds.length) payload.attachmentIds = attachmentIds;
    const response = await this.request(`/api/conversations/${otterConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, signal);
    // Why: POST SSE 只是通知且 30 秒会关闭；断开不会中止后台 Agent。
    // 主动取消通知流，最终答案只以持久 entries/invokes 为准，避免终态后仍白等 SSE。
    await response.body?.cancel().catch(() => {});
    const triggerEntryId = response.headers.get('x-otter-trigger-entry-id');
    if (!triggerEntryId) throw new Error('OTTER_TRIGGER_ENTRY_MISSING');

    const deadline = startedAt + this.timeoutMs;
    let previousFingerprint = '';
    let stablePolls = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const [entriesResponse, invokesResponse] = await Promise.all([
        this.request(`/api/conversations/${otterConversationId}/entries?limit=200`, {}, signal),
        this.request(`/api/conversations/${otterConversationId}/invokes?limit=200`, {}, signal),
      ]);
      const [{ entries }, { invokes }] = await Promise.all([entriesResponse.json(), invokesResponse.json()]);
      const trigger = entries.find(entry => entry.id === triggerEntryId && entry.entryType === 'user');
      if (trigger && (trigger.senderId !== `external:${actorId}` || trigger.body !== text)) {
        throw new Error('OTTER_TRIGGER_ENTRY_MISMATCH');
      }
      if (trigger) {
        // 额度闸在 invoke 创建前拒绝，因此没有 failed invoke 可轮询；只认本轮之后由 core 写入的系统错误条目。
        const budgetEntry = entries.find(entry => entry.entryType === 'system'
          && entry.sequenceNum > trigger.sequenceNum
          && typeof entry.body === 'string'
          && entry.body.startsWith(EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX));
        if (budgetEntry) throw new ExternalTokenBudgetError(budgetEntry.body.slice(EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX.length));
        // 轮次身份只认 POST 返回的 entry id 与持久化 invoke.triggerEntryId；相同正文/相近时间不构成身份。
        const chainInvokes = invokes.filter(invoke => invoke.triggerEntryId === trigger.id);
        const chainInvokeIds = new Set(chainInvokes.map(invoke => invoke.id));
        const running = chainInvokes.some(invoke => !TERMINAL.has(invoke.status));
        const failed = chainInvokes.some(invoke => invoke.status === 'failed' || invoke.status === 'aborted');
        const latestInvoke = chainInvokes[0];
        const waitingForOtter = latestInvoke?.talkingStonePassedTo?.some(target => target && target !== 'user');
        const speaks = entries.filter(entry => entry.entryType === 'speak' && entry.body && chainInvokeIds.has(entry.invokeId));
        const fingerprint = JSON.stringify({
          running, waitingForOtter,
          invokes: chainInvokes.map(invoke => [invoke.id, invoke.status]),
          entries: speaks.map(entry => [entry.id, entry.invokeId]),
        });
        stablePolls = fingerprint === previousFingerprint ? stablePolls + 1 : 0;
        previousFingerprint = fingerprint;
        if (failed) throw new Error('OTTER_TURN_FAILED');
        if (chainInvokes.length > 0 && !running && !waitingForOtter && stablePolls >= 1) {
          const answer = speaks.length ? publicText(speaks.at(-1).body) : '';
          if (!answer) throw new Error('OTTER_FINAL_SPEAK_MISSING');
          if (answer.length > 60_000) throw new Error('OTTER_REPLY_TOO_LARGE');
          return answer;
        }
      }
      await sleep(this.pollMs, signal);
    }
    throw new Error('OTTER_TURN_TIMEOUT');
  }
}
