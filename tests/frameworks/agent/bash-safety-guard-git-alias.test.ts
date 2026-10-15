/**
 * F20261015gali（M-edd889c2，宪法 L4 bypass_guard）：git alias shell 展开（! 前缀）注入
 * ——真执行体载荷拆解（prod 文本路径侧）。
 *
 * 案情（检视獭1360 建议 4 + 探针实证）：`git -c alias.pwn='!git -C <主仓> reset --hard' pwn`
 * 双层全放（S2-S6 探针修前 prod 全 ALLOW：持久注入/kill 主 PID 载荷/动态载荷/嵌套 sh -c），
 * alias 展开=任意 shell 执行通道（git 原生语义），攻击成本一行命令。
 *
 * 修法（真执行体语义，#1513 F20261015gsub 取向）：载荷提取后递归过全量规则链
 * （checkBashCommandSafety 全量，与直接执行同待遇）；动态/提取不出 → fail-closed。
 * 放行侧钉死良性例（carve-out）：纯子命令别名/无害载荷/提及位/grep -c 参数位。
 */
import { describe, it, expect } from "vitest";
import {
  checkBashCommandSafety,
  GIT_ALIAS_SHELL_OPAQUE_REASON,
} from "@frameworks/agent/bash-safety-guard";

const projectRoot = "/repo";
const WT = "/repo/.otter/worktrees/wt";
const sessionCwd = "/repo/data/workspaces/conv-1";
const mainPid = 42877;
const check = (cmd: string) => checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });

describe("F20261015gali git alias shell 注入拦截（负门）", () => {
  it("审视样本：-c alias! 载荷 git -C 主仓 reset --hard → 拦（载荷命中文案）", () => {
    const r = check(`git -C ${WT} -c alias.pwn='!git -C /repo reset --hard' pwn`);
    expect(r).toContain("git alias shell 展开（! 前缀）执行任意载荷");
    expect(r).toContain("写命令落点解析到主仓"); // 子文案第二行携带（载荷命中主仓写）
  });

  it("持久注入：git config alias '!载荷' → 拦", () => {
    const r = check(`git config alias.pwn '!git -C /repo reset --hard'`);
    expect(r).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });

  it("--global 持久注入 → 拦", () => {
    expect(check(`git config --global alias.pwn '!rm -rf /repo/data'`)).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });

  it("双引号载荷 kill 主 PID → 拦（载荷递归过 kill 族）", () => {
    expect(check(`git -c alias.pwn="!kill 42877" pwn`)).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });

  it("单引号动态载荷 !$P → 拦（载荷内动态 fail-closed）", () => {
    expect(check(`git -c alias.pwn='!$P' pwn`)).toBeTruthy();
  });

  it("双引号动态载荷 \"!$P\"（键+! 可见证、载荷动态）→ 拦（opaque fail-closed）", () => {
    expect(check(`git -c alias.pwn="!$P" pwn`)).toBe(GIT_ALIAS_SHELL_OPAQUE_REASON);
  });

  it("config k=v 单词形（shell 拼接归一）→ 拦", () => {
    expect(check(`git config alias.pwn='!git -C /repo commit'`)).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });

  it("config --file 取值旗标 + alias → 拦", () => {
    expect(check(`git config --file /tmp/gc alias.pwn '!git -C /repo commit'`)).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });
});

describe("F20261015gali 放行侧（carve-out：良性例不误伤）", () => {
  it("无害载荷 !git status → 放（载荷可证安全，#1513 内容判定语义）", () => {
    expect(check(`git -c alias.s='!git status' s`)).toBeNull();
  });

  it("纯子命令别名（非 ! 前缀）→ 放", () => {
    expect(check(`git -c alias.co=checkout co main`)).toBeNull();
  });

  it("git config 普通配置 → 放", () => {
    expect(check(`git config user.name "守卫修复獭"`)).toBeNull();
  });

  it("git config --unset alias（无值词，非定义位）→ 放", () => {
    expect(check(`git config --unset alias.pwn`)).toBeNull();
  });

  it("echo/grep 提及（非 git 段）→ 放", () => {
    expect(check(`grep -n "alias.x=!foo" vitest.config.ts`)).toBeNull();
  });

  it("git grep -c 参数位提及（-c 是 grep 参数非全局旗标）→ 放（FP 陷阱钉死）", () => {
    expect(check(`git grep -c "alias.pwn=!reset"`)).toBeNull();
  });

  it("git log --grep 提及（非定义位）→ 放", () => {
    expect(check(`git log --grep="alias.pwn=!reset" --oneline`)).toBeNull();
  });
});

describe("F20261015gali 一致性不变量：alias 通道不得强于直接执行", () => {
  // 设计承诺：载荷判词 === 同载荷直接执行判词（载荷递归走 checkBashCommandSafety 全量）。
  // rm -rf 主仓根的 prod 既有洞（X1/X2 探针：直接执行也放，wv 侧正判）是独立工单面，
  // 本规则不得比直接执行更宽——等价性钉死比单点期望更稳。
  // X1（检视獭1518）：wrapper 旗标形态（--no-pager 等静态全局旗标）入环——旧版走查
  // 折断使 4/7 等价性破坏，修后双形态（裸/wrapper）都要与直接执行同判。
  const payloads = [
    `git -C /repo reset --hard`,
    `kill 42877`,
    `git status`,
    `rm -rf /repo`,
    `sh -c "rm -rf /repo"`,
    `git -C ${WT} commit`,
    `git -C ${WT}/../../.. commit`,
  ];
  const wrappers = ["", "--no-pager ", "--no-optional-locks --bare "];
  for (const p of payloads) {
    for (const w of wrappers) {
      it(`载荷等价${w ? `（wrapper: ${w.trim()}）` : ""}：${p.slice(0, 50)}`, () => {
        const wrapped = check(`git ${w}-c alias.pwn='!${p.replace(/'/g, `'\\''`)}' pwn`);
        const direct = check(p);
        expect(wrapped === null).toBe(direct === null);
      });
    }
  }
});

describe("F20261015gali X1 wrapper 旗标洞回归（检视獭1518 severe 修法钉死）", () => {
  it("wrapper + -c alias 注入 → 拦（旧版走查折断双层全放）", () => {
    expect(check(`git --no-pager -c alias.pwn='!git -C /repo reset --hard' pwn`)).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });

  it("wrapper + config 形持久注入 → 拦", () => {
    expect(check(`git --no-pager config alias.pwn '!kill 42877'`)).toContain("git alias shell 展开（! 前缀）执行任意载荷");
  });

  it("wrapper + 引号动态载荷 → 拦（opaque）", () => {
    expect(check(`git --no-pager -c alias.pwn="!$P" pwn`)).toBe(GIT_ALIAS_SHELL_OPAQUE_REASON);
  });

  it("X5：heredoc 体内提及（写复盘/文档场景）→ 放（承诺口径：文本体不检出）", () => {
    expect(check(`cat > retro.md << 'EOF'\ngit -c alias.pwn='!evil' pwn\nEOF`)).toBeNull();
  });

  it("X4：引号截断伪影（'\\'' 转义形态）→ 不得带病过递归（opaque 或完整判读）", () => {
    const r = check(`git -c alias.pwn='!echo it'\\''s' pwn`);
    // 伪影方向全 FP 无 bypass——判定要么 opaque fail-closed，要么完整载荷判读；
    // 不得静默放行截断载荷（引号平衡校验兜底）
    if (r === null) {
      // 若词法层拼出完整字面量（echo it's 无害）→ 放行合理，断言直接执行同判（等价性）
      expect(check(`echo it's`)).toBeNull();
    } else {
      expect(r === GIT_ALIAS_SHELL_OPAQUE_REASON || r.includes("git alias shell 展开")).toBe(true);
    }
  });
});
