import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureRecruitingConversation } from '@usecases/recruiting/ensure-recruiting-conversation';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { ManageConversation } from '@usecases/conversation/manage-conversation';
import type { OtterRepository } from '@usecases/otter/otter-repository';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { CreateOtter } from '@usecases/otter/create-otter';
import type { Logger } from '@usecases/ports/logger';
import type { Otter } from '@entities/otter/otter';
import { createTestLogger } from "../../helpers/logger";

/** 大獭 mock */
function mockBigOtter(): Otter {
  return {
    id: 'otter-big-001',
    name: '大獭',
    type: 'big',
    status: 'active',
    role: null,
    parentOtterId: null,
    createdAt: '2026-01-01T00:00:00Z',
    dissolvedAt: null,
  };
}

describe('ensureRecruitingConversation', () => {
  let convRepo: ConversationRepository;
  let otterRepo: OtterRepository;
  let createOtter: CreateOtter;
  let manageConversation: ManageConversation;
  let settings: SettingsRepository;
  let sendMessage: SendMessage;
  let logger: Logger;

  beforeEach(() => {
    convRepo = {
      getById: vi.fn(),
      create: vi.fn(async () => 'conv-123'),
      createParticipants: vi.fn(),
      getActiveParticipants: vi.fn(async () => []),
    } as unknown as ConversationRepository;

    otterRepo = {
      getById: vi.fn(async () => mockBigOtter()),
    } as unknown as OtterRepository;

    createOtter = {
      execute: vi.fn(async () => mockBigOtter()),
    } as unknown as CreateOtter;

    manageConversation = {
      pin: vi.fn(),
    } as unknown as ManageConversation;

    settings = {
      get: vi.fn(async () => null),
      update: vi.fn(),
      getAll: vi.fn(async () => ({})),
      tryInsertIfAbsent: vi.fn(async () => true),
      tryDeleteIfValueMatches: vi.fn(async () => true),
    } as unknown as SettingsRepository;

    sendMessage = {
      sendSystem: vi.fn(),
    } as unknown as SendMessage;

    logger = createTestLogger();
  });

  it('CAS 模式：对方已抢先创建，复用已有对话', async () => {
    const otter = mockBigOtter();

    // tryInsertIfAbsent 返回 false，表示锁被其他进程持有
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);

    // settings.get 返回已有的对话 ID 和大獭 ID
    vi.mocked(settings.get)
      .mockResolvedValueOnce('conv-existing') // RECRUITING_CONVERSATION_KEY
      .mockResolvedValueOnce(otter.id); // RECRUITING_BIG_OTTER_ID_KEY

    // convRepo.getById 返回已存在的对话
    vi.mocked(convRepo.getById).mockResolvedValue({
      id: 'conv-existing',
      title: '💼 求职助手',
      status: 'active',
      summary: null,
      pinned: false,
      workspaceDir: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      archivedAt: null,
    });

    const result = await ensureRecruitingConversation({
      manageConversation,
      convRepo,
      otterRepo,
      createOtter,
      settings,
      sendMessage,
      logger,
    });

    // 应该复用已有对话，而不是创建新对话
    expect(result.conversationId).toBe('conv-existing');
    expect(result.bigOtterId).toBe(otter.id);
    expect(result.created).toBe(false);
    expect(createOtter.execute).not.toHaveBeenCalled();
    expect(manageConversation.pin).toHaveBeenCalledWith('conv-existing');
  });

  it('锁获取失败后 recheck 成功', async () => {
    const otter = mockBigOtter();

    // tryInsertIfAbsent 始终返回 false，表示锁被其他进程持有
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValue(false);

    // settings.get 返回已有的对话 ID 和大獭 ID
    vi.mocked(settings.get)
      .mockResolvedValueOnce(null) // 第一次 tryReuseExisting
      .mockResolvedValueOnce(null) // waitForLockRelease 中的 get
      .mockResolvedValueOnce('conv-existing') // recheck
      .mockResolvedValueOnce(otter.id); // recheck 中的 get

    // convRepo.getById 返回已存在的对话
    vi.mocked(convRepo.getById).mockResolvedValue({
      id: 'conv-existing',
      title: '💼 求职助手',
      status: 'active',
      summary: null,
      pinned: false,
      workspaceDir: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      archivedAt: null,
    });

    const result = await ensureRecruitingConversation({
      manageConversation,
      convRepo,
      otterRepo,
      createOtter,
      settings,
      sendMessage,
      logger,
    });

    // recheck 应该返回已有的对话
    expect(result.created).toBe(false);
    expect(result.bigOtterId).toBe(otter.id);
    expect(manageConversation.pin).toHaveBeenCalledWith('conv-existing');
  });
});
