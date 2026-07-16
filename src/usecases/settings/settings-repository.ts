/** Settings 持久化仓库接口 */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  update(key: string, value: string): Promise<void>;
  getAll(): Promise<Record<string, string>>;
}
