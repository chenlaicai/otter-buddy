/** Otter 默认渐变（大獭主色）——大獭视觉恒定 token（弹窗/设置页装饰性渐变共用） */
export const OTTER_GRADIENT = 'linear-gradient(135deg,#A88260,#6B5638)'

/**
 * F20260921otcl：动态色池与 BIG_OTTER_IDS 兜底已删除——取色唯一入口收敛到
 * otter-visual.ts 的 resolveOtterVisual（identity 完整走库值 / 缺失走 fnv1a 展示回退）。
 * 本文件仅保留无身份依赖的装饰性常量（OTTER_GRADIENT）。
 */
