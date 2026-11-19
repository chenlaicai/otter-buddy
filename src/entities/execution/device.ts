/**
 * 配对设备身份——devices 表实体。
 * 配对只建立稳定身份（+长效 token 仅认证），不代表执行授权——每次上线必须新
 * onlineSession（模块 C 红线：配对 ≠ 授权）。撤销 = 删行（token 即刻失效）。
 */

export interface Device {
  id: string;
  name: string;
  /** 配对换发的长效认证 token（仅身份认证；执行授权看 online_sessions） */
  pairToken: string;
  createdAt: string;
  lastSeenAt: string | null;
}
