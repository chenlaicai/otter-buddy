/**
 * F20260915cfgt：每日复盘常量定义（仿 recruiting/constants.ts 先例，集中避免散落）
 */

/** 专用对话 ID 在 settings 表的 key */
export const DAILY_REVIEW_CONVERSATION_KEY = '__daily_review_conversation_id__';

/** 专用对话 big otter ID 在 settings 表的 key */
export const DAILY_REVIEW_BIG_OTTER_ID_KEY = '__daily_review_big_otter_id__';

/** 专用对话标题 */
export const DAILY_REVIEW_CONVERSATION_TITLE = '📖 每日复盘';

/** 定时任务 name（唯一标识，用于幂等检测） */
export const DAILY_REVIEW_TASK_NAME = 'daily-review';

/** cron：每日 8:30（早于作者 9:00 健康检查，工作复盘先于系统体检，节奏清晰） */
export const DAILY_REVIEW_CRON = '30 8 * * *';

/** 时区 */
export const DAILY_REVIEW_TIMEZONE = 'Asia/Shanghai';

/** prompt 模板路径（git 真相源，seed 时读取存入任务 body；后续迭代走 update-scheduled-task-body.mjs 同步） */
export const DAILY_REVIEW_PROMPT_PATH = 'prompts/scheduled/daily-review.md';
