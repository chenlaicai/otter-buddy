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

  /**
   * F20261012cmmn：按 chat_id 拉取聊天成员 id→姓名 映射。
   *
   * 为什么不只用 getUserName：contact/v3/users 对「不在应用可用范围/通讯录
   * 授权范围」的用户返回脱敏对象（code 0 但无 name 字段，2026-10-12 实测
   * csg-feishu2 与 10-10 旧 app 均复现），而 im/v1/chats/{chat_id}/members
   * （im:chat.members:read）直接返回成员 name（实测返回真名）。
   * 发消息的人必然在会话成员里，故此为发言人姓名的主数据源。
   *
   * 实现方应做进程内缓存（chat_id → 成员映射）与在途合并，失败返回 null
   * 由调用方降级 getUserName / 可读兜底，永不阻塞消息主链路。
   *
   * @returns 成员映射（**只读契约**：可能为缓存内部 Map 引用，调用方不得增删改，
   *   需要可变副本自行 new Map(result)）；API 失败返回 null（空成员表返回空 Map，与失败可区分）
   */
  getChatMemberNames(chatId: string): Promise<Map<string, string> | null>;
}
