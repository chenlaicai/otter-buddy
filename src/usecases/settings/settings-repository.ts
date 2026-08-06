/** Settings 持久化仓库接口 */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  update(key: string, value: string): Promise<void>;
  getAll(): Promise<Record<string, string>>;
  /**
   * 原子插入：仅当 key 不存在时写入 value。
   * @returns true 如果成功插入（当前进程获得锁），false 如果 key 已存在（另一个进程已抢先）
   */
  tryInsertIfAbsent(key: string, value: string): Promise<boolean>;
}
