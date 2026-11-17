import type { Device } from "@entities/execution/device";
import type { OnlineSession, OnlineSessionDisconnectReason } from "@entities/execution/online-session";

/**
 * F20261117cnnct（#1868 阶段 4 C1）：connector 注册仓库（devices + online_sessions
 * + pairing_codes）。总闸唯一事实源的持久层——WSS 通道与 Registry 内存投影都以此为准。
 *
 * 语义要点：
 * - 配对码一次性（原子核销：过期/已核销/不存在都返回 null——fail-closed）
 * - 上线 = 新 online 行 + 顶替旧 online 行（同 device 旧行落 offline/device-offline）
 * - 下线/断线/中枢重启各带 reason；清扫幂等
 */
export interface ConnectorRegistryRepository {
  // ── 配对 ──
  /** 生成一次性配对码（8 位，调用方给定有效期） */
  createPairingCode(code: string, expiresAt: string): Promise<void>;
  /** 原子核销配对码：时效内且未核销 → 标记核销并返回 true；否则 false（fail-closed） */
  redeemPairingCode(code: string, now: string): Promise<boolean>;
  /** 核销成功后建立设备身份（写 devices 行，返长效 token 由调用方生成传入） */
  createDevice(device: Device): Promise<void>;
  /** 检视 s6：核销+建设备事务原子化——消除「码已烧但设备未建」的窗口（进程崩溃/并发）。
   *  事务内：核销 UPDATE 命中 1 → INSERT devices；命中 0 → 回滚返 false。 */
  redeemAndCreateDevice(code: string, device: Device, now: string): Promise<boolean>;
  /** 按 token 查设备（upgrade 鉴权用；无/撤销返回 null） */
  findDeviceByToken(token: string): Promise<Device | null>;
  /** 撤销配对：删 devices 行（token 即刻失效） */
  deleteDevice(deviceId: string): Promise<void>;
  touchDeviceLastSeen(deviceId: string, at: string): Promise<void>;

  // ── online sessions ──
  /** 上线：新 online 行；同 device 旧 online 行先落 offline/device-offline（顶替语义）。
   *  唯一事实源写入点——失败必须让调用方 fail-closed（关通道），不许只写内存投影。 */
  openOnlineSession(session: OnlineSession): Promise<void>;
  /** 按 id 查会话（总闸道次①直查唯一事实源） */
  getOnlineSession(sessionId: string): Promise<OnlineSession | null>;
  /** 心跳：last_seen_at 前移（sid 校验通过才调用） */
  touchOnlineSession(sessionId: string, at: string): Promise<void>;
  /** 下线/断线/清扫：落 offline + reason（幂等——已 offline 不改写原因） */
  closeOnlineSession(sessionId: string, reason: Exclude<OnlineSessionDisconnectReason, null>, at: string): Promise<void>;
  /** 中枢启动清扫：所有 online 行落 offline/hub-restart（返回清扫数，幂等） */
  sweepStaleOnlineSessions(at: string): Promise<number>;
}
