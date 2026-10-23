/**
 * #1540（F20261019kbpc）：kill 族拦截文案唯一文案源。
 *
 * 背景：同文案此前有 4+2 处拷贝（V1 bash-safety-guard.ts checkKillSegment 与
 * V2 guard-model-judge.ts judgeKillSegment/INDIRECT_BLOCK_MSG/不可知载荷兜底各自
 * 持有 nonliteral 文案，pkill 文案 2 处），靠注释「V1 同文案」人肉同步——
 * kill-by-pid 出口（F20261008hcpa）落地后文案补出口指引的同步成本高到无人做，
 * 出口存在却走不到（#1540 案发根因之一）。
 *
 * 沿 sleep-command-guard.ts 的「唯一文案源」先例（S5 去重）抽出零依赖共享常量，
 * V1/V2 同文案契约由 import 强制；guard-model-judge 不得反向 import bash-safety-guard
 * （后者依赖前者 checkWithModel，反向即循环依赖），故本模块独立。
 *
 * ⚠️ 分类锚片段（guard-intercept-classify.ts 指纹依赖，改动需同步 classifier）：
 * - 「终止进程的目标为变量或命令替换」→ self_kill_nonliteral
 * - 「按名匹配的批量终止命令」→ self_kill_byname
 *
 * F20261023ktru（#1069）：kill-by-pid 正道指引的脚本路径改仓根绝对路径——相对形态
 * `node scripts/restart-service.mjs` 仅在仓根 cwd 成立，外部项目对话（colink/
 * guangdongdianlitest 等）的獭 cwd 不在仓内，照做即 Cannot find module（2026-10-22
 * colink 獭 09:45Z 二拦 bounce 实证，healing_events self_kill_nonliteral）。repo-root
 * 是无框架依赖的叶子工具（仅 node:fs/node:path），不破坏本模块无环约束（#1540）。
 * alpha.sh 指引保持 worktree 相对形态：alpha 实例只存在于 otter-buddy worktree，
 * 「在 worktree 内跑 scripts/alpha.sh」在该语义域内可解析（非目标，见 F20261023ktru）。
 */
import { join } from "node:path";
import { getRepoRoot } from "../repo-root";

/** F20261023ktru（#1069）：受控出口脚本的仓根绝对路径——任意 cwd 可执行的唯一形态。 */
export const RESTART_SERVICE_SCRIPT = join(getRepoRoot(), "scripts", "restart-service.mjs");
const KILL_BY_PID_EXAMPLE = `node ${RESTART_SERVICE_SCRIPT} kill-by-pid <pid> --project /abs/path`;

/**
 * self_kill_nonliteral：非字面量 PID kill（变量/命令替换目标）拦截文案。
 * 含误拦退出引导 + #1540 kill-by-pid 受控出口指引（含 --project 归属声明示例）。
 */
export const INDIRECT_KILL_BLOCK_MSG =
  "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——" +
  `若需清理自己起的 dev server/测试进程，用受控出口按 PID 终止：${KILL_BY_PID_EXAMPLE}` +
  "（#1540：--project 声明进程归属目录，脚本内部做 PID/cwd 归属校验后才终止、主进程恒拒；起进程时请记下 PID 与归属目录，清理即可走这条正道）；" +
  "若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；" +
  "若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；" +
  "若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；" +
  "无法规避时告知搭档人工执行。";

/**
 * self_kill_byname：pkill/killall 按名批量终止拦截文案。
 * #1540：补 kill-by-pid 受控出口指引（案发现场 `pkill -f "vite …"` 形态的正道）。
 */
export const PKILL_BYNAME_BLOCK_MSG =
  "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。" +
  `若需清理自己起的 dev server/测试进程，用受控出口按 PID 终止：${KILL_BY_PID_EXAMPLE}` +
  "（#1540：--project 声明进程归属目录，脚本内部做 PID/cwd 归属校验后才终止、主进程恒拒；起进程时请记下 PID 与归属目录，清理即可走这条正道）；" +
  "若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
