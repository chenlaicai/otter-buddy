/**
 * 分布式锁工具
 *
 * 基于 SettingsRepository 的 CAS 操作实现分布式锁。
 * 用于 healing/recruiting 等对话的并发创建防护。
 */

import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { Logger } from '@usecases/ports/logger';

/** stale lock 阈值（毫秒） */
const STALE_LOCK_THRESHOLD_MS = 30_000;

/** 轮询配置 */
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 20;

export interface LockResult {
  acquired: boolean;
  /** 如果锁被其他进程持有，等待后可能获得的结果 */
  existingValue?: string | null;
}

/**
 * 尝试获取分布式锁
 * @param settings SettingsRepository 实例
 * @param key 锁的 key
 * @param logger 日志实例
 * @returns LockResult
 */
export async function acquireDistributedLock(
  settings: SettingsRepository,
  key: string,
  logger: Logger,
): Promise<LockResult> {
  // 1. 尝试直接获取锁
  const lockValue = `pending:${Date.now()}`;
  const acquired = await settings.tryInsertIfAbsent(key, lockValue);
  if (acquired) {
    return { acquired: true };
  }

  // 2. 锁被其他进程持有，等待对方完成
  logger.info('Lock held by another process, waiting', { key });
  const existingValue = await waitForLockRelease(settings, key, logger);
  if (existingValue !== null) {
    // 对方已完成，返回已有值
    return { acquired: false, existingValue };
  }

  // 3. waitForLockRelease 可能清理了 stale lock，重新尝试获取锁
  const retryLockValue = `pending:${Date.now()}`;
  const retryAcquired = await settings.tryInsertIfAbsent(key, retryLockValue);
  if (retryAcquired) {
    return { acquired: true };
  }

  // 4. 仍然无法获取锁
  return { acquired: false };
}

/**
 * 等待锁释放（轮询模式）
 * @returns 如果锁释放且有有效值，返回该值；如果 stale lock 被清理，返回 null
 */
async function waitForLockRelease(
  settings: SettingsRepository,
  key: string,
  logger: Logger,
): Promise<string | null> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const currentValue = await settings.get(key);

    // 值已不是 pending，说明对方已完成或失败
    if (!currentValue?.startsWith('pending:')) {
      return currentValue;
    }

    // 检测 stale lock：如果 pending 值超过阈值，尝试清理
    const pendingTimestamp = parseInt(currentValue.replace('pending:', ''), 10);
    if (!isNaN(pendingTimestamp) && Date.now() - pendingTimestamp > STALE_LOCK_THRESHOLD_MS) {
      logger.warn('Detected stale lock, attempting to clean', { key, value: currentValue });
      const deleted = await settings.tryDeleteIfValueMatches(key, currentValue);
      if (deleted) {
        logger.info('Stale lock cleaned successfully', { key });
        return null; // 返回 null，让调用方重新竞争锁
      } else {
        logger.debug('Stale lock already cleaned by another process', { key });
      }
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // 超时
  logger.warn('Lock wait timeout', { key, maxWaitMs: MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS });
  return null;
}
