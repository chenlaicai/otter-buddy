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
 * 二轮（检视 r1 严重 1，`..`-after-symlink）：`..` 必须按内核逐分量语义解析——
 * 先解 symlink 再弹栈。path.normalize 与 JS 版 realpathSync 都在 symlink 解析前
 * **词法**折叠 `..`（`<wt>/link/../x` 折成 `<wt>/x`，内核真实落点 `<root>/x`），
 * 守卫口径与内核落点分歧即逃逸面。故：不前置 normalize，存在段解析用
 * `fs.realpathSync.native`（realpath(3) 逐分量口径）。
 *
 * 失败语义=身份：全程不可解析时原样返回（纯虚构路径全程不存在，归一无效果，
 * 测试 /repo 等假想路径按恒等语义钉死）；对不存在尾段走「最深存在祖先 + 尾段回拼」
 * ——realpath(3) 对不存在尾段恒 ENOENT，尾段回拼结构必须保留。回拼尾段含 `..` 时
 *（仅祖先不可解析才会入尾段）对已解析真实基座词法折叠——此时内核本就 ENOENT
 *（写落空），守卫偏保守方向，无逃逸面。
 */
import fs from "node:fs";
import path from "node:path";

/** 路径拼接但不折叠 `..`/`.`（path.join/resolve 会词法折叠——symlink 解析前
 *  折叠即二轮严重 1 逃逸面）。rel 须为相对路径；折叠留给 safeRealpath 逐分量做。 */
export function joinNoFold(base: string, rel: string): string {
  const b = base.replace(/\/+$/, "");
  return b === "" ? rel : `${b}/${rel}`;
}

/** 剥尾部斜杠（仅防御 basename/dirname 尾斜杠边角，不折叠 `..`）。 */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

/** 穿透归一：返回路径的真实落点（逐分量解析 symlink + 内核语义 `..`）。
 *  末段可不存在（最深存在祖先 + 尾段回拼）。 */
export function safeRealpath(p: string): string {
  const input = stripTrailingSlash(p);
  const tail: string[] = [];
  let cur = input;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return input; // 全程不可解析 → 恒等返回（失败语义=身份）
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** 末分量不穿链的解析：真实落点=父目录 realpath + 末分量名（rm <link> 只删链接
 *  自身不穿目标）。父目录含 `..`/symlink 时逐分量收口（safeRealpath）；末分量不解析。 */
export function safeRealpathParent(p: string): string {
  const input = stripTrailingSlash(p);
  return path.join(safeRealpath(path.dirname(input)), path.basename(input));
}
