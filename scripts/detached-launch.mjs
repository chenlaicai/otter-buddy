#!/usr/bin/env node
/**
 * detached-launch.mjs — 全分离启动器（F20260917alph，移植自 tutu-vessel 同名脚本）。
 *
 * Usage: node scripts/detached-launch.mjs <logFile> <cmd> [args...]
 *
 * 以 { detached: true } spawn <cmd>，stdout+stderr 重定向到 <logFile>，向 stdout
 * 打印子进程 PID 后立即退出。子进程存活于父进程退出之后（agent shell 生命周期、
 * nohup 替代品）——alpha.sh 用它保证验证实例不随獭的 shell 会话消亡。
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const [logFile, cmd, ...args] = process.argv.slice(2);
if (!logFile || !cmd) {
  console.error('Usage: detached-launch.mjs <logFile> <cmd> [args...]');
  process.exit(1);
}

const fd = openSync(logFile, 'a');
const child = spawn(cmd, args, {
  detached: true,
  stdio: ['ignore', fd, fd],
  env: process.env,
});
child.unref();

if (child.pid === undefined) {
  console.error(`detached-launch.mjs: could not spawn ${cmd}`);
  process.exit(1);
}

// 机器通道纪律（tutu 血泪教训）：stdout 只写裸 PID 数字，不走 console.log——
// FORCE_COLOR 环境下 console.log 会给数字包 ANSI 颜色码，调用方后续所有
// `kill -0` / `kill` 全部打偏 → 误报「进程已死」→ 孤儿占端口且无锁文件可停。
process.stdout.write(`${child.pid}\n`);
process.exit(0);
