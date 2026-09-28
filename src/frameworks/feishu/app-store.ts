import fs from "node:fs";
import path from "node:path";
import { maskAppId } from "./long-connection-client";

/**
 * F20260928fsqr：飞书扫码应用凭据持久化（frameworks 层文件实现）。
 *
 * 存储布局：`<stateDir>/feishu-apps.json` — `{ appId → { appSecret, ownerOpenId, name, addedAt } }`
 *
 * Why 文件而非 DB（D4）：connections 表是路由锚（externalId=bot 键），凭据是运行时
 * 密钥（含 secret）——混入 DB 无消费方且扩大暴露面。对齐微信 accounts.json 先例
 * （#565），stateDir 本地权限保护，不上 git。
 *
 * ownerOpenId 双层可选：registerApp 的 user_info/open_id 均可缺席（SDK types
 * 321888-321896）——缺失时建线 metadata 留空，首条 p2p 消息 sender 回填（与
 * noteChatId 同位，D7 降级路径）。
 */
export interface FeishuAppRecord {
  appId: string;
  appSecret: string;
  /** 扫码建 app 的人（一般即线 owner）；可缺席（SDK 双层可选） */
  ownerOpenId?: string;
  /** 助理线名（扫码页起名） */
  name?: string;
  addedAt: string;
}

export class FeishuAppStore {
  private readonly stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? "./data/feishu";
  }

  private appsPath(): string {
    return path.join(this.stateDir, "feishu-apps.json");
  }

  listApps(): FeishuAppRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.appsPath(), "utf-8")) as Record<string, FeishuAppRecord>;
      return Object.values(raw);
    } catch {
      return [];
    }
  }

  getApp(appId: string): FeishuAppRecord | undefined {
    return this.listApps().find((a) => a.appId === appId);
  }

  /** F20260928fsqr（检视严重 3）：按掩码 appId 查找——前端只有掩码（listApps 出网脱敏），
   *  DELETE/provision 端点拿掩码回查。maskAppId 单射（前5尾4），掩码唯一命中才返回
   *  （理论碰撞面见 bot-key.ts 注记；碰撞时返回 undefined 走 404，宁拒勿错删） */
  getAppByMaskedId(maskedId: string): FeishuAppRecord | undefined {
    const hits = this.listApps().filter((a) => maskAppId(a.appId) === maskedId);
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** upsert（扫码 onSuccess 调用）。?? {}：首次落盘文件不存在，safeRead 返回 null */
  saveApp(record: FeishuAppRecord): void {
    const raw = (this.safeRead(this.appsPath()) as Record<string, FeishuAppRecord> | null) ?? {};
    raw[record.appId] = record;
    this.safeWrite(this.appsPath(), raw);
  }

  removeApp(appId: string): void {
    const raw = (this.safeRead(this.appsPath()) as Record<string, FeishuAppRecord> | null) ?? {};
    delete raw[appId];
    this.safeWrite(this.appsPath(), raw);
  }

  private safeRead(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }

  private safeWrite(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
}
