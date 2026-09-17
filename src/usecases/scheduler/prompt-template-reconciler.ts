import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { Logger } from '@usecases/ports/logger';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRepoRoot } from '@frameworks/repo-root';

/** #784：定时任务 prompt 启动对账。
 *
 * 背景：定时任务 body 已 git 化（PR #428）——prompts/scheduled/*.md 是真相源，
 * DB 是运行时副本。但同步纯手动（scripts/update-scheduled-task-body.mjs），
 * 实证：daily-health-check.md 四次 PR 更新后脚本从未运行，9/3-9/4 健康检查跑旧版
 * prompt（issue #784）。本模块在 scheduler 启动时逐模板比对 DB body，漂移即同步——
 * 重启即自愈，与 #739 backfill 墓碑守卫、#814 调度完整性对账同模式。
 *
 * 对账方向为正向遍历（模板 → DB），git 真相源语义：无模板的任务（生日提醒、
 * backlog digest 等运行时创建）天然豁免，不会被误伤。
 *
 * 匹配规则（与 scripts/update-scheduled-task-body.mjs 的 loadTemplate 保持一致）：
 * - frontmatter task_name 字段精确匹配任务名（跨语言命名唯一可靠键）
 * - 无 task_name 时：kebab(任务名) === 文件名去 .md（kebab = 空格转连字符）
 * - frontmatter dynamic: true 的模板跳过（body 由调度器运行时填充占位符，issue #416）
 *
 * JSON 包装兼容（paper-trading-daily-trading 形态）：任务 body 解析为 JSON 对象
 * 且含 prompt 字符串字段 → 只对账/替换内层 prompt，watchlist 等运行时字段保留
 * （#610 watchlist-only patch 语义的对偶面）。
 *
 * 覆盖范围：getAll() 全量（含 disabled）——disabled 任务的 body 漂移同样要治，
 * 重新启用时该跑新 prompt（实证：每日 issue 处理 disabled 且 body 落后模板 2000+ 字符）。
 */

export interface PromptReconcileResult {
  /** 参与对账的模板数（dynamic 跳过的不计） */
  checked: number;
  /** 更新 body 的任务数 */
  updated: number;
  /** dynamic 跳过的模板数 */
  skippedDynamic: number;
  /** 无对应 DB 任务的模板文件名（日志观察用，不视为错误） */
  unmatched: string[];
  /** 每条变更的一句话描述 */
  changes: string[];
  /** 同步失败明细（#1030：降级不得哑——失败以 error 级暴露，不静默跳过） */
  failed: string[];
}

export interface PromptReconcileOptions {
  taskRepo: Pick<ScheduledTaskRepository, 'getAll' | 'update'>;
  logger: Logger;
  /** 模板目录（默认仓内 prompts/scheduled，测试注入用） */
  templateDir?: string;
}

/** frontmatter 里的 task_name 字段（无则 null） */
function extractTaskName(fileContent: string): string | null {
  const m = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const tm = m[1].match(/^task_name:\s*['"]?(.+?)['"]?\s*$/m);
  return tm ? tm[1].trim() : null;
}

/** dynamic 模板判定——与 scripts/update-scheduled-task-body.mjs 的 isDynamicTemplate
 *  值形态兼容（裸 true 含大小写变体 / 带引号 / 行尾注释），保守侧：宁误跳不覆盖。 */
function isDynamicTemplate(fileContent: string): boolean {
  const m = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? /^dynamic:\s*['"]?(?:true|True|TRUE)['"]?\s*(?:#.*)?$/m.test(m[1]) : false;
}

/** 去掉 frontmatter，取模板 body */
function stripFrontmatter(fileContent: string): string {
  const m = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? fileContent.slice(m[0].length) : fileContent;
}

/** 任务名 kebab 化（空格转连字符），与脚本正向规则一致 */
function kebab(name: string): string {
  return name.replace(/\s+/g, '-').toLowerCase();
}

/** 判定任务是否匹配模板文件。fileName 为去 .md 的文件名。 */
function taskMatchesTemplate(task: ScheduledTask, fileName: string, taskName: string | null): boolean {
  if (taskName) return task.name === taskName;
  return kebab(task.name) === fileName.toLowerCase();
}

/** 包装形态替换：JSON body 的 prompt 字段换成新模板内容，其余字段原样保留。
 *  返回 null 表示不是包装形态（调用方走裸 body 路径）。 */
function replaceWrappedPrompt(taskBody: string, newPrompt: string): string | null {
  if (!taskBody.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(taskBody) as Record<string, unknown>;
    if (typeof parsed.prompt !== 'string') return null;
    return JSON.stringify({ ...parsed, prompt: newPrompt });
  } catch {
    return null;
  }
}

export async function reconcilePromptTemplates(opts: PromptReconcileOptions): Promise<PromptReconcileResult> {
  const { taskRepo, logger } = opts;
  // Why: 默认目录基于代码位置解析（#429）；显式传入的 templateDir override 优先
  const templateDir = opts.templateDir ?? resolve(getRepoRoot(), 'prompts', 'scheduled');
  const result: PromptReconcileResult = { checked: 0, updated: 0, skippedDynamic: 0, unmatched: [], changes: [], failed: [] };

  let files: string[];
  try {
    files = readdirSync(templateDir).filter(f => f.endsWith('.md'));
  } catch {
    // 模板目录缺失（异常部署/cwd 非项目根）：warn 不抛——对账失败不阻塞启动
    logger.warn(`prompt 模板目录不可读，跳过对账（dir=${templateDir}）`);
    return result;
  }

  const tasks = await taskRepo.getAll();
  const now = new Date().toISOString();

  for (const file of files) {
    await reconcileSingleTemplate({ file, templateDir, tasks, taskRepo, logger, now, result });
  }

  if (result.updated > 0) {
    logger.info(`prompt 启动对账：${result.updated}/${result.checked} 个任务 body 已同步（模板真相源）`, {
      updated: result.updated,
      checked: result.checked,
      skippedDynamic: result.skippedDynamic,
      unmatched: result.unmatched,
    });
  }
  // #1030：同步失败以 error 级显式暴露（非静默降级）——git 真相源与 DB 副本脱钩必须可见
  if (result.failed.length > 0) {
    logger.error(`prompt 启动对账：${result.failed.length} 个任务 body 同步失败，DB 将跑旧版 prompt（需人工处置）`, undefined, {
      failed: result.failed,
    });
  }
  return result;
}

/** 处理单个模板：读取 → 匹配任务 → 比对 → 漂移即更新。异常均降级为 warn 后跳过。 */
async function reconcileSingleTemplate(args: {
  file: string;
  templateDir: string;
  tasks: ScheduledTask[];
  taskRepo: PromptReconcileOptions['taskRepo'];
  logger: Logger;
  now: string;
  result: PromptReconcileResult;
}): Promise<void> {
  const { file, templateDir, tasks, taskRepo, logger, now, result } = args;
  const fileName = file.replace(/\.md$/, '');
  let content: string;
  try {
    content = readFileSync(resolve(templateDir, file), 'utf8');
  } catch {
    logger.warn(`prompt 模板读取失败，跳过（file=${file}）`);
    return;
  }

  if (isDynamicTemplate(content)) {
    result.skippedDynamic += 1;
    return;
  }

  const taskName = extractTaskName(content);
  const task = tasks.find(t => taskMatchesTemplate(t, fileName, taskName));
  if (!task) {
    result.unmatched.push(fileName);
    return;
  }

  result.checked += 1;
  const tplBody = stripFrontmatter(content);
  await applyTemplateBody({ task, tplBody, file, taskRepo, now, result }).catch(err => {
    // 逐项降级：单任务 DB 写入失败不阻塞其余模板的对账（与 #814 dedup 失败降级同模式）。
    // 但降级不得哑（#1030 事故：超体积模板同步失败只 warn，无人察觉，DB 跑三周旧版）——
    // 失败明细累计进 result.failed，调用方（scheduler 启动日志）以 error 级显式暴露
    result.failed.push(`${file} → 任务「${task.name}」body 同步失败：${err instanceof Error ? err.message : String(err)}`);
    logger.warn(`prompt 对账写入失败，跳过该任务（task=${task.name}）`, {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** 比对任务 body 与模板体，漂移即更新（包装形态对账内层，裸 body 全量比对）。 */
async function applyTemplateBody(args: {
  task: ScheduledTask;
  tplBody: string;
  file: string;
  taskRepo: PromptReconcileOptions['taskRepo'];
  now: string;
  result: PromptReconcileResult;
}): Promise<void> {
  const { task, tplBody, file, taskRepo, now, result } = args;
  // 包装形态（JSON body 含 prompt 字段）：对账内层，watchlist 等运行时字段保留
  const wrapped = replaceWrappedPrompt(task.body, tplBody);
  if (wrapped !== null) {
    const currentInner = (JSON.parse(task.body) as { prompt: string }).prompt;
    if (currentInner.trim() === tplBody.trim()) return; // 内层已同步
    await taskRepo.update({ ...task, body: wrapped, updatedAt: now });
    result.updated += 1;
    result.changes.push(`任务「${task.name}」body 为 JSON 包装形态，内层 prompt 已更新 ← ${file}（watchlist 等运行时字段保留）`);
    return;
  }

  if (task.body.trim() === tplBody.trim()) return; // 已同步

  await taskRepo.update({ ...task, body: tplBody, updatedAt: now });
  result.updated += 1;
  result.changes.push(`任务「${task.name}」body 已更新 ← ${file}（status=${task.status}）`);
}
