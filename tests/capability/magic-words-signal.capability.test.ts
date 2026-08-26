/**
 * 能力测试骨架：Magic Words 本地化重审 + 獭间信号协议（F20260826mwrd）。
 *
 * 场景已定义（见 docs/features/2026/08/26/F20260826mwrd.md「验证」节），
 * 实现分期 C1-C4 落地后逐个激活。当前以 test.todo 占位——不伪造通过，
 * 声明「什么算实现完成」的验收锚点。
 *
 * 判别标准：全部为 LLM 参与行为（B 类）——halt 合规响应、objection 程序义务、
 * 安全词语境判断，均需真系统 + 真 LLM 验证。
 */
import { describe, it } from "vitest";

describe("Magic Words 重审 + 獭间信号协议（真系统 + 真 LLM）", () => {
  // 依赖 C3：用户消息 L2 扫描 + LLM 语境确认
  it.todo("用户消息讨论「停下」一词（如「这个词叫停下」）不触发急停");

  // 依赖 C3：用户词 halt 合流
  it.todo("用户独立成词的「停下」触发全场急停（含对运行中小獭 halt 打标）");

  // 依赖 C1：halt 边界注入
  it.todo("大獭对运行中小獭 halt，小獭下一工具边界收尾停手，进度快照 yield 回发起者（上下文保留）");

  // 依赖 C2：objection 程序义务
  it.todo("小獭对错误派工发含锚点的 objection，大獭下轮收到 reminder 并显式裁决（resolved/dismissed 带理由）");

  // 依赖 C2：blocked 一等状态
  it.todo("小獭 blocked 信号附已试清单，落 signal_events 为一等状态");

  // 依赖 C4：词表改版生效
  it.todo("「星星罐子」「就这样」「严肃点」不再作为 Magic Words 被识别，行为由语义层自然覆盖");
});
