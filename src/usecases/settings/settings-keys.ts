/** settingsRepo 持久化 key 集中定义 */

/** 用户显示名（海獭称呼搭档用的名字，空值回退到"搭档"） */
export const USER_DISPLAY_NAME_KEY = "user.displayName";

/** F20261022mjls：默认陪打獭配置（JSON 数组：[{otterId, name}, {otterId, name}]，两个 otter 座位）。
 *  建房未显式传 otter 座位时回填；显式传 otterId 覆盖。存 settings 表，设置面 PUT 可改。 */
export const MAHJONG_DEFAULT_OTTERS_KEY = "mahjong.defaultOtters";

/** 默认陪打獭条目（mahjong.defaultOtters 的 JSON 元素形状） */
export interface MahjongDefaultOtter {
  otterId: string;
  name: string;
}

/** 解析默认陪打獭配置；缺失/非法返回 null（调用方自行决定回退或报错） */
export function parseMahjongDefaultOtters(raw: string | null): MahjongDefaultOtter[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const out: MahjongDefaultOtter[] = [];
    for (const item of parsed) {
      const rec = item as Partial<MahjongDefaultOtter>;
      if (typeof rec?.otterId !== "string" || !rec.otterId) return null;
      if (typeof rec?.name !== "string" || !rec.name) return null;
      out.push({ otterId: rec.otterId, name: rec.name });
    }
    return out;
  } catch {
    return null;
  }
}
