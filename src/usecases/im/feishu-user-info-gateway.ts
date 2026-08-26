/**
 * 飞书用户身份解析端口（F20260826fuid）。
 *
 * 群聊场景：飞书事件仅携带 sender 的 open_id，不带姓名。
 * 本端口负责把 open_id 换成人类可读姓名（如「张三」），供消息入库时
 * 快照进 senderName（层 1，对齐 sender name 单一真相源架构 PR #392）。
 *
 * 实现方应做进程内缓存（open_id → name），并容忍 API 失败——
 * 失败时返回 null，消息照常入库（senderName 空串走层 3 前端 fallback），
 * 绝不阻塞消息主链路。
 */
export interface FeishuUserInfoGateway {
  /**
   * 按 open_id 查询用户姓名。
   * @returns 姓名；查不到（权限未开 / 用户不存在 / API 失败）返回 null
   */
  getUserName(openId: string): Promise<string | null>;
}
