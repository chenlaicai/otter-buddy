/**
 * Commit/PR 标题模块位词表契约（F20260924mseu，单一真相源）。
 *
 * 背景：模块位（`[F...][module][Type] 标题` 中的 module）长期只定格式（小写
 * 字母）不定语义，四处信息源（commit-convention.md / commit-msg hook / ci.yml /
 * CONTRIBUTING.md）各给一套示例清单且互不一致；海獭只能模仿见过的词，全历史
 * 词表碎裂（skill/skills、im/weixin/feishu、health/rhi/healing 并存），
 * `[agent]` 占全历史合规 commit 约 1/3 成为兜底垃圾桶——而本仓主体就是 agent
 * 运行时，「agent 项目的 agent 模块」信息量趋零。下游健康面板「模块热区」
 * （commit-parser.ts 提取 → moduleStats → cli-report 展示/快照）因此失真。
 *
 * 本文件收敛三件套（搭档决策 2026-09-24，对话「特性标题优化」）：
 * 1. 语义定义：module = 有边界的子系统名（回答「动了哪个子系统」），禁止
 *    「项目本体」自指词——MODULE_BANNED_TAGS 机械拦截，agent 除名是首案。
 * 2. 推荐词表（开放集，不是白名单）：MODULE_RECOMMENDED_TAGS 引导选择；
 *    清单外的词**允许**提交（不堵死新功能域），仅提示确认。开放集防漂移靠
 *    数据收口（健康面板统计清单外词频，高频词收编进表），不靠闸。
 * 3. 双标签废除：模块位唯一（一个 commit 一个主子系统），热区聚合不双重计数。
 *
 * 写入侧与读取侧不对称：写入侧（commit-msg hook / ci.yml）引导+拦黑名单；
 * 读取侧（commit-parser.ts）保持宽容正则——它要解析全部历史 commit，
 * 旧标签永远可解析，不回填。
 *
 * 维护纪律：hook / ci.yml 是 shell 无法 import TS，只能人工内联镜像；
 * tests/entities/document/module-tags.test.ts 的元测试从两侧源码提取清单
 * 与本文件导出字符级比对，任何一侧单独改动立即变红（#667/#670 同款先例）。
 */

/** 模块位合法形态：全小写字母，禁连字符（与历史 hook 正则一致） */
export const MODULE_TAG_PATTERN = "[a-z]+";

/** 推荐模块词表（开放集——清单外的合法词允许提交，仅提示确认）。
 *
 * 每个词一行「什么时候用它」，选词依据是行为归属不是文件位置：
 * 一个 commit 改哪个子系统的行为，就挂哪个词；跨子系统选行为变更最大的那个。
 *
 * 收编规则：新功能域的高频清单外词（热区统计 ≥3 次）由每日体检或搭档收编进表；
 * 删除词时同步从 MODULE_BANNED_TAGS 评估是否升级为黑名单（防回潮）。 */
export const MODULE_RECOMMENDED_TAGS: ReadonlyArray<readonly [tag: string, usage: string]> = [
  ["loop", "发言石/轮次推进/invoke/yield/重试 backoff——agent 的发动机"],
  ["session", "session 生命周期/锁/交接换世/复活/小獭管理"],
  ["guard", "bash 守卫/merge 闸/写保护等运行时安全拦截机制"],
  ["context", "喂给 LLM 的上下文窗口：注入/压缩/token 预算（獭的运行上下文归 session）"],
  ["web", "Web 前端 + SSE"],
  ["im", "IM 通道（飞书/微信等，历史 weixin/feishu 并入）"],
  ["conversation", "消息/对话/条目模型与存储（含 DB 层）"],
  ["memory", "记忆系统/文档同步/检索"],
  ["scheduler", "定时任务"],
  ["skill", "skill 定义与编排协议"],
  ["prompt", "prompts/ 下提示词工程"],
  ["health", "RHI 健康面板/信号/自愈台账"],
  ["ci", "工程基建：CI/钩子/lint 脚本/依赖（历史 toolchain/scripts/deps 并入）"],
  ["docs", "纯文档改动"],
  ["otterbar", "macOS 菜单栏应用"],
];

/** 黑名单词表：自指/无边界词，写入侧硬拒（commit-msg hook + ci.yml）。
 *
 * 入选判据：词义覆盖整个项目本体或无明确边界，作为模块标签信息量趋零，
 * 放任会成为「不知道填什么就填它」的垃圾桶（agent 以 83 条历史实证此模式）。
 * 注意 general 也在列——开放集下不需要兜底词：填不出模块的 commit 该停下来
 * 想一秒「我到底改了什么」，而不是伸手拿兜底（搭档原话 2026-09-24）。 */
export const MODULE_BANNED_TAGS: ReadonlyArray<readonly [tag: string, reason: string]> = [
  ["agent", "项目本体自指——本仓就是 agent 运行时，信息量趋零；按行为拆 loop/session/guard/context"],
  ["runtime", "同 agent，无边界自指词"],
  ["core", "无边界——什么都是 core 等于没有 core"],
  ["system", "无边界自指词"],
  ["general", "兜底词是下一个垃圾桶；开放集下填不出时该想清归属，不该拿兜底"],
  ["misc", "同 general"],
  ["other", "同 general"],
];

/** 推荐词名清单（供提示文案与测试遍历） */
export const MODULE_RECOMMENDED_TAG_NAMES: ReadonlyArray<string> = MODULE_RECOMMENDED_TAGS.map(
  ([tag]) => tag,
);

/** 黑名单词名清单 */
export const MODULE_BANNED_TAG_NAMES: ReadonlyArray<string> = MODULE_BANNED_TAGS.map(
  ([tag]) => tag,
);

/** 渲染推荐词表为「tag — 用法」多行文本（hook/CI 提示文案与文档共用格式） */
export function formatRecommendedTags(): string {
  return MODULE_RECOMMENDED_TAGS.map(([tag, usage]) => `${tag} — ${usage}`).join("\n");
}

/** 校验模块词形态是否合法（仅形态，不判断推荐/黑名单） */
export function isValidModuleTagFormat(tag: string): boolean {
  return new RegExp(`^${MODULE_TAG_PATTERN}$`).test(tag);
}
