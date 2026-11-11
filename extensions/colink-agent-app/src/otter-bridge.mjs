import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'aborted']);

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
  constructor({ baseUrl, store, fetcher = fetch, timeoutMs = 180_000, pollMs = 1_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.store = store;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
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
      throw new Error(`OTTER_HTTP_${response.status}: ${detail}`);
    }
    return response;
  }

  async ensureConversation(externalKey, title) {
    const existing = this.store.get(externalKey);
    if (existing) return existing;
    const response = await this.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    const conversation = await response.json();
    if (!conversation.id || !Array.isArray(conversation.otterIds) || conversation.otterIds.length !== 1) {
      throw new Error('OTTER_SINGLE_OTTER_REQUIRED');
    }
    this.store.set(externalKey, conversation.id);
    return conversation.id;
  }

  async reply({ deploymentId, installationId, conversationId, actorId, text, signal }) {
    const key = JSON.stringify([deploymentId, installationId, conversationId]);
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const otterConversationId = await this.ensureConversation(key, `CoLink 私聊 ${conversationId.slice(0, 8)}`);
      return this.runTurn({ otterConversationId, actorId, text, signal });
    });
    this.lanes.set(key, current);
    try { return await current; } finally {
      if (this.lanes.get(key) === current) this.lanes.delete(key);
    }
  }

  async runTurn({ otterConversationId, actorId, text, signal }) {
    const startedAt = Date.now();
    const response = await this.request(`/api/conversations/${otterConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ senderId: `colink:${actorId}`, body: text }),
    }, signal);
    // Why: POST SSE 只是通知且 30 秒会关闭；断开不会中止后台 Agent。
    // 主动取消通知流，最终答案只以持久 entries/invokes 为准，避免终态后仍白等 SSE。
    await response.body?.cancel().catch(() => {});

    const deadline = startedAt + this.timeoutMs;
    let trigger;
    let previousFingerprint = '';
    let stablePolls = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const [entriesResponse, invokesResponse] = await Promise.all([
        this.request(`/api/conversations/${otterConversationId}/entries?limit=200`, {}, signal),
        this.request(`/api/conversations/${otterConversationId}/invokes?limit=200`, {}, signal),
      ]);
      const [{ entries }, { invokes }] = await Promise.all([entriesResponse.json(), invokesResponse.json()]);
      trigger ??= entries.find(entry => entry.entryType === 'user' && entry.senderId === `colink:${actorId}`
        && entry.body === text && Date.parse(entry.createdAt) >= startedAt - 1_000);
      if (trigger) {
        const chainEntries = entries.filter(entry => entry.sequenceNum > trigger.sequenceNum);
        const chainInvokes = invokes.filter(invoke => Date.parse(invoke.startedAt) >= Date.parse(trigger.createdAt) - 1_000);
        const running = chainInvokes.some(invoke => !TERMINAL.has(invoke.status));
        const failed = chainInvokes.some(invoke => invoke.status === 'failed' || invoke.status === 'aborted');
        const latestInvoke = chainInvokes[0];
        const waitingForOtter = latestInvoke?.talkingStonePassedTo?.some(target => target && target !== 'user');
        const speaks = chainEntries.filter(entry => entry.entryType === 'speak' && entry.body);
        const fingerprint = JSON.stringify({
          running, waitingForOtter,
          invokes: chainInvokes.map(invoke => [invoke.id, invoke.status]),
          entries: chainEntries.map(entry => [entry.id, entry.entryType]),
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
