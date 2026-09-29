/**
 * F20260928fsqr：飞书建线键统一派生。
 *
 * Why 独立模块：入站路由锚（FeishuClient 的 botKey，#663 掩码形态）与扫码建线键
 * （provision/DELETE）必须同源——F20260921wxba 教训：建线键与路由锚分裂则扫码建
 * 的线一条消息都收不到。三处消费（provision / DELETE / 入站 ensureConnection）
 * 全部走本函数，杜绝再次漂移。
 *
 * 掩码键兼任身份键有理论碰撞面（首5尾4）——个位数 app 量级可接受；
 * 若未来 app 数量级增长，升级派生规则（本文件单点改）。
 */
import { maskAppId } from "./long-connection-client";

/** bot 锚键：provision / 入站路由 / 出站通道归属 三处共用 */
export function botKey(appId: string): string {
  return `feishu-bot:${maskAppId(appId)}`;
}
