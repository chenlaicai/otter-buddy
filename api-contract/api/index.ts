export type * from "./conversation";
export type * from "./message";
export type * from "./invoke";
export type * from "./entry";
export type * from "./otter";
export type * from "./memory";
export type * from "./skill";
export type * from "./key-info";
export type * from "./settings";
export type * from "./activity";
export type * from "./rhi";
// F20261023cnct：IM 连接管理存活端点契约迁入（issue #1063 死端点下线后的契约同步）
export type * from "./connection";
// F20261013csv3 T5：foldInvokeEvents 迁入 contract 层（前后端共用——后端批量投影 +
// 前端 SessionModal 展开同源，消除双端漂移面）
export { foldInvokeEvents } from "./invoke-event-fold";
export type { FoldedStep } from "./invoke-event-fold";
// Why: value 导出（非 type）——CARD_MAX_PER_MESSAGE 是前后端共享常量而非 DTO（Issue #360）
export { CARD_MAX_PER_MESSAGE } from "./html-card";
// F20260921otcl：海獭色板 value 导出（后端挑色/回填 + 前端样式映射双端消费）
export { OTTER_PALETTE_KEYS, OTTER_PALETTE_HEX, BIG_OTTER_HEX, isOtterPaletteKey } from "./otter-palette";
export type { OtterPaletteKey } from "./otter-palette";
