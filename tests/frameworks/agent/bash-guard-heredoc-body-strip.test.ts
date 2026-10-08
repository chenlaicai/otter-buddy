/**
 * F20261008h304（#1304）：cat 型 heredoc 体剥除——数据体对写检测通道不可见。
 *
 * 10/8 台账实证（healing 47c443e7/f80f7559，排查当日实拦）：
 * `cat > file <<'EOF' … EOF` 的体内容是纯文件数据，无 shell 执行语义；但 git 写族/
 * one-liner 通道吃原始 command——体内 `git stash push` 字样被当真写、`node -e \"…\"`
 * （转义引号）使载荷提取失败保守拦。重定向通道早已在剥体基座（syntaxBasis）判定，
 * 同函数两套基座不一致是根因。
 *
 * 本文件：误拦修复面（PASS）+ 反向洞防护（BLOCKED）组合。已知基线洞（修复前即放行，
 * 非 #1304 范围，另开 issue 跟踪）：`cd <主仓> && git stash push`（cd 豁免吃主仓 cd）、
 * 裸定界体含 $()。
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/repo";
const opts = { projectRoot };
const WT = "/wt/feature-x";

describe("F20261008h304：误拦修复面——cat 型 heredoc 体含写操作字样 → 放行", () => {
  it("体含 git stash push 字样（A3）", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/x.sh <<'EOF'\ncd ${WT} && git stash push -m y\nEOF\necho ok`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("体含转义引号 node -e 字样（A4，09:42 实拦形态）", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/x.mjs <<'EOF'\ncd ${WT} && node -e \\"console.log(1)\\"\nEOF\necho ok`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("体含 git commit/push 字样（A5）", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/notes.txt <<'EOF'\ngit commit -m "fake"\ngit push origin main\nEOF\necho done`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("heredoc 写对话工作区 + 体含守卫调用字样（A1/A2 合成，当日实拦）", () => {
    expect(checkBashCommandSafety(
      `cat > /repo/data/workspaces/abc/x.mjs <<'EOF'\nconst { checkBashCommandSafety } = await import('/repo/src/frameworks/agent/bash-safety-guard.ts');\nconst r = checkBashCommandSafety(c, 1);\nEOF\ncd ${WT} && npx tsx /repo/data/workspaces/abc/x.mjs`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("quoted 体含 kill 字样（运维笔记）→ 放行（delta r1 严重发现 1）", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/ops-notes.md <<'EOF'
# 运维笔记
kill 旧进程前先确认 PID
git stash push 保存现场
EOF
echo done`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("裸定界体含 kill 词元 → 不剥除保持拦截（判据⑤收窄后的保守面）", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/ops.sh <<EOF
kill $OLD_PID
git stash push
EOF
echo ok`,
      mainPid, undefined, opts,
    )).not.toBeNull();
  });

  it("体含 heredoc 字样的双层嵌套（体内 EOF 文本）→ 放行", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/x.md <<'EOF'\ncat > /tmp/y.md <<'INNER'\nsome content\nINNER\necho done\nEOF\necho ok`,
      mainPid, undefined, opts,
    )).toBeNull();
  });
});

describe("F20261008h304：反向洞防护——数据体剥除不得开新洞", () => {
  it("cat 落主仓（无 cd）→ 仍拦截（B1）", () => {
    expect(checkBashCommandSafety(
      `cat > ${projectRoot}/README.md <<'EOF'\nhi\nEOF\necho ok`,
      mainPid, undefined, opts,
    )).not.toBeNull();
  });

  it("体经管道真执行：cat <<EOF | bash 体含 kill → 仍拦截（B3）", () => {
    expect(checkBashCommandSafety(
      `cat <<'EOF' | bash\nkill -9 ${mainPid}\nEOF`,
      mainPid, undefined, opts,
    )).not.toBeNull();
  });

  it("python heredoc 体真写主仓（负门保留，B6）→ 仍拦截", () => {
    expect(checkBashCommandSafety(
      `cd /tmp && python3 - <<'PY'\nwith open('${projectRoot}/data/t.json','w') as f: f.write('{}')\nPY`,
      mainPid, undefined, opts,
    )).not.toBeNull();
  });

  it("数据体剥除的搭车绕过尝试：体写命令形态 + EOF 后接真 git 写 → 仍拦截", () => {
    expect(checkBashCommandSafety(
      `cat > /tmp/x.txt <<'EOF'\ngit stash push\nEOF\ncd ${projectRoot} && git stash push -m sneaky`,
      mainPid, undefined, opts,
    )).not.toBeNull();
  });

  it("解释器头不剥除：python heredoc 体含 python 写形态 → 走体级判定拦截", () => {
    expect(checkBashCommandSafety(
      `python3 - <<'PY'\nimport subprocess\nsubprocess.run(['ls'])\nPY`,
      mainPid, undefined, opts,
    )).not.toBeNull();
  });
});

describe("F20261008h304：原放行面不回归", () => {
  it("cd worktree && git 只读 → 放行（C1）", () => {
    expect(checkBashCommandSafety(
      `cd ${WT} && git stash list && git diff --stat`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("cd worktree && gh 只读 → 放行（C2）", () => {
    expect(checkBashCommandSafety(
      `cd ${WT} && gh pr list --state open --json number,title | head -5`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("python heredoc 只读（cd /tmp）→ 放行（C3）", () => {
    expect(checkBashCommandSafety(
      `cd /tmp && python3 - <<'PY'\nprint(open('/tmp/a.txt').read())\nPY`,
      mainPid, undefined, opts,
    )).toBeNull();
  });

  it("cat heredoc 写 worktree 内文件（正道形态）→ 放行", () => {
    expect(checkBashCommandSafety(
      `cat > ${WT}/notes.md <<'EOF'\nsome notes with git stash push words\nEOF`,
      mainPid, undefined, opts,
    )).toBeNull();
  });
});
