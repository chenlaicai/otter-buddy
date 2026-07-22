/** Otter 上下文仓库接口（usecases 层定义，frameworks/db 实现） */
export interface OtterContextRepository {
  get(otterId: string, key?: string): Promise<Record<string, string>>;
  set(otterId: string, key: string, value: string): Promise<void>;
  delete(otterId: string, key: string): Promise<void>;
}
