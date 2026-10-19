/**
 * F20261019syml（M-ed285d7c）：symlink 穿透归一（realpath 归一化）。
 *
 * 逃逸链形态（#1515 delta 建议 2 立档）：ln -s <主仓内容> <worktrees 区>/link 之后，
 * `git -C <link> 写族` / `cd <link> && …` / `echo x > <link>/f` 的**字符串**落点在
 * worktrees 区（豁免命中）而**真实**落点在主仓内容树——两步全放。判定基元在路径比较
 * 前经本模块做 symlink 穿透归一，字符串形态与真实落点的偏差在此收口（两侧同口径：
 * wv pathWithinMain / prod isInsideMainCheckout、classifyDestructiveTarget、
 * git -C 落点累积均引本模块）。
 *
 * 失败语义=身份（fail-soft→现状）：realpath 不可解析（ELOOP/EACCES）时同一 uid 的
 * 真实写删同样会失败（ELOOP 链上写不进、EACCES 组件下写不动），无穿链风险；按 fail-closed
 * 强判主仓反而给怪路径造新误拦面。纯虚构路径（测试 /repo 等，全程不存在）恒等返回——
 * 既有语义与语料判定零漂移。
 */
import fs from "node:fs";
import path from "node:path";

/** 全分量穿链归一（写穿链语义：echo > <link>/f 的最终分量是链时写进真实目标）。
 *  最深存在祖先 realpath + 尾段回拼；全程不可解析时返回 normalize 前值（身份）。 */
export function safeRealpath(p: string): string {
  const norm = path.normalize(p);
  const tail: string[] = [];
  let cur = norm;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return norm;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** 末分量不穿链归一（unlink/rename 语义：rm <link> 删链本体无害；目录分量照常穿链
 *  ——rm <link>/sub 的 link 是父目录，由 dirname 侧 realpath 收口）。 */
export function safeRealpathParent(p: string): string {
  const norm = path.normalize(p);
  return path.join(safeRealpath(path.dirname(norm)), path.basename(norm));
}
