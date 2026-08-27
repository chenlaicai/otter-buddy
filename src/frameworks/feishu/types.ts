export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  /** 搭档（本实例主人）的飞书 open_id（F20260826fpbd）——搭档身份静态锚定 */
  partnerOpenId?: string;
}
