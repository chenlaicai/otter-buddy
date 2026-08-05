/**
 * F20260805rbrg 招聘桥接：常量定义
 *
 * settings 表 key + 任务定义集中在这里，避免散落。
 */

/** 专用对话 ID 在 settings 表的 key */
export const RECRUITING_CONVERSATION_KEY = '__recruiting_conversation_id__';

/** 专用对话 big otter ID 在 settings 表的 key */
export const RECRUITING_BIG_OTTER_ID_KEY = '__recruiting_big_otter_id__';

/** 扩展最后活动时间戳（ISO string），用于诊断"扩展是否在跑" */
export const RECRUITING_LAST_BRIDGE_EVENT_AT_KEY = '__recruiting_last_bridge_event_at__';

/** 专用对话标题 */
export const RECRUITING_CONVERSATION_TITLE = '💼 求职助手';

/** 定时摘要任务 name（唯一标识，用于幂等检测） */
export const RECRUITING_SUMMARY_TASK_NAME = 'recruiting-daily-summary';

/** 定时摘要 cron：每日 9:07（off-minute，避开 :00 减少并发） */
export const RECRUITING_SUMMARY_CRON = '7 9 * * *';

/** 定时摘要时区 */
export const RECRUITING_SUMMARY_TIMEZONE = 'Asia/Shanghai';

/**
 * 定时摘要任务 body：固定 prompt 文本，让大獭主动 search_memory。
 * 用 today 变量替换占位符（在 ensure 时计算）。
 */
export function buildRecruitingSummaryBody(todayIso: string): string {
  return `请汇总今日（${todayIso}）新收到的招聘消息：哪些公司/HR、哪些是面试邀请（高优）、哪些待你回复。用 search_memory 工具加 created_after 参数（设为今日 0 点的 ISO 时间，即 ${todayIso}T00:00:00Z）查今日新接触记录，然后整理输出。`;
}

/**
 * 求职助手角色 systemPrompt 路径（boot 时读取注入）。
 * 文件位于 prompts/contexts/RECRUITING_INTAKE.md（注意拼写：RECRUITING）。
 */
export const RECRUITING_SYSTEM_PROMPT_PATH = 'prompts/contexts/RECRUITING_INTAKE.md';
