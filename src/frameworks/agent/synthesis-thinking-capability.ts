/**
 * F20261111synth（#1850）：叙事合成 thinking 能力解析 + 选档 + 传输失败兜底准入。
 *
 * 事故背景（2026-11-11 换世合成 100% 降级）：合成影子通道固定 thinkingLevel:'off'，
 * pi-ai openai-responses 构造器对无能力表的模型把 off 翻译成 reasoning.effort:"none"
 * 下发，api.kimi.com 实测拒收 none/minimal/off（收 low/medium/high）→ 400 → 机械档案。
 * kimi/kimi-lty 6/6 全败，glm / apig-*（不产生该参数）3/3 全成。
 *
 * 根因：自定义模型（provider: openai + apiBaseUrl）不在 openai 目录 → thinkingLevelMap
 * 被置空 → 系统在「不知道端点无法表达关思考」的情况下发了 none。而 pi-ai 自带的
 * kimi-coding 目录对 k3 全系声明了真值：{off:null, low:"low", high:"high", max:"max"}
 * （off:null = 该端点无法关思考）。
 *
 * 修法（F1）：合成专用模型副本按 (baseUrl host + modelId) 继承 SDK provider 目录的
 * 能力表；off 不可表达（off:null）时由 pickSynthesisThinkingLevel 显式选最低可表达档
 * （kimi → low，端点实测可用）。
 *
 * 为什么必须显式选档、不能依赖省略参数：pi-durable 运行时对 off 的翻译是「不发
 * reasoning 参数」（harness/generation.js: thinkingLevel === "off" ? {} : {reasoning}），
 * 而端点对「无参数」的默认行为是开思考（实测 k3.1-pro 对 "hi" 也烧 48 reasoning
 * tokens，档位不可控）——省略 = 把档位交给服务端默认，预算不可预测。
 *
 * 为什么只挂合成路径、不挂聊天路径：能力表是目录为 completions 协议写的；实测端点
 * responses 收 medium 而目录 medium:null——全量挂表会把 kimi-highspeed（无显式档位，
 * 默认 medium）静默抬到 high（计费档翻倍）。聊天路径零改动是刻意的（known issue
 * 见特性文档）。
 */

import type { Model, Api } from "@earendil-works/pi-ai";

/** SDK 模型 thinkingLevelMap 形状（值 = 协议参数字符串；null = 该档不可表达） */
export type ThinkingLevelMap = Record<string, string | null>;

/** 档位从低到高的全序（与 pi-ai models.js EXTENDED_THINKING_LEVELS 一致） */
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 能力目录注册表：host → SDK provider 目录加载器（自定义模型按 baseUrl host 归属）。
 *  新端点接入时在此登记（host 必须与 provider.baseUrl 的 host 完全一致）。 */
const SYNTHESIS_CAPABILITY_CATALOGS: ReadonlyArray<{
  host: string;
  load: () => Promise<Record<string, unknown>>;
}> = [
  {
    host: "api.kimi.com",
    load: async () => {
      const mod = await import("@earendil-works/pi-ai/providers/kimi-coding.models");
      return mod.KIMI_CODING_MODELS as unknown as Record<string, unknown>;
    },
  },
];

/** F20261111synth F1：解析合成模型的真实 thinkingLevelMap。
 *  - 模型已带非空能力表 → undefined（不覆盖既有声明）；
 *  - baseUrl host 命中注册表且目录存在同 id 模型 → 返回目录能力表副本；
 *  - 其余（未知 host / 目录无此 id / baseUrl 不可解析）→ undefined（不猜能力，
 *    传输兼容性由 F3 兜底层接住）。
 *  幂等纯函数（目录动态 import 有模块缓存，无重复 IO）。 */
export async function resolveSynthesisThinkingLevelMap(
  model: Model<Api> | undefined | null,
): Promise<ThinkingLevelMap | undefined> {
  if (!model) return undefined;
  const existing = (model as { thinkingLevelMap?: ThinkingLevelMap }).thinkingLevelMap;
  if (existing && Object.keys(existing).length > 0) return undefined;
  const baseUrl = (model as { baseUrl?: string }).baseUrl;
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return undefined;
  }
  const catalog = SYNTHESIS_CAPABILITY_CATALOGS.find(c => c.host === host);
  if (!catalog) return undefined;
  const dict = await catalog.load();
  const hit = Object.values(dict).find(
    m => (m as { id?: string }).id === model.id,
  ) as { thinkingLevelMap?: ThinkingLevelMap } | undefined;
  if (!hit?.thinkingLevelMap) return undefined;
  return { ...hit.thinkingLevelMap };
}

/** F20261111synth F1：按能力表选合成请求档位。
 *  - 无能力表 / off 可表达（map.off 为字符串）→ 'off'（原语义，端点自己表达关思考）；
 *  - off 不可表达（off:null）→ 全序上第一个可表达档（kimi 真值 → 'low'——最低成本
 *    且端点实测可用）；
 *  - 退化了没有任何可表达档的表 → 'off'（省略参数语义交端点默认，F3 兜底接住异常）。
 *  不能依赖「off→省略参数」：端点默认行为是开思考且档位不可控（见文件头）。 */
export function pickSynthesisThinkingLevel(map: ThinkingLevelMap | undefined): string {
  if (!map || Object.keys(map).length === 0) return "off";
  if (typeof map.off === "string") return "off";
  for (const level of THINKING_LEVEL_ORDER) {
    if (typeof map[level] === "string") return level;
  }
  return "off";
}

/** F20261111synth F3：合成传输类失败判定——兜底重试的准入谓词。
 *  只重试「换一个模型可能就好」的失败（API 4xx/5xx、网络层）；逻辑错误
 *  （如 fail-closed 校验、编程错误）重试无意义，原样上抛由调用方降级。 */
export function isSynthesisTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /API error \(\d{3}\)|HTTP \d{3}|ECONN|ETIMEDOUT|fetch failed|network error/i.test(msg);
}
