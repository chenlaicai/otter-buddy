/**
 * F20260928grv2 词法层 golden token 流测试（方案 D7 三层测试之第①层）。
 *
 * 锁死「shell 理解对不对」：输入命令 → 期望 token 结构（词的求值结果/操作符序列/
 * heredoc 元数据/parseOk）。判定层决策表在 bash-safety-guard.test.ts（第③层）。
 *
 * 写法纪律（方案 D7）：结构断言与判定断言分离——本文件只断言词法结构，
 * 不 import 判定层；防「决策对但理解错」的巧合正确。
 */
import { describe, expect, it } from "vitest";
import { lex } from "@frameworks/agent/command-lexer";

/** 快照辅助：token 流 → 紧凑串（word 用 evaluated 或 part 类型串；op/heredoc/comment 摘要） */
function toSnapshot(cmd: string): string {
  const r = lex(cmd);
  const parts = r.tokens.map(t => {
    if (t.type === "word") {
      const w = t.word!;
      if (w.evaluated !== null) return `w:${w.evaluated}`;
      return `w?(${w.parts.map(p => p.type).join("+")})`;
    }
    if (t.type === "op") return `op:${t.op}`;
    if (t.type === "comment") return "cmt";
    if (t.type === "heredoc") return `hd:${t.heredoc!.delim}${t.heredoc!.delimQuoted ? ":q" : ""}`;
    return "?";
  });
  return `[${parts.join(" ")}] ok=${r.parseOk}`;
}

describe("command-lexer golden token 流", () => {
  describe("基础词与操作符", () => {
    it("简单命令", () => {
      expect(toSnapshot("kill 42877")).toBe("[w:kill w:42877] ok=true");
    });
    it("链式操作符切段", () => {
      expect(toSnapshot("cd /wt && git commit -m x | tail -3")).toBe(
        "[w:cd w:/wt op:&& w:git w:commit w:-m w:x op:| w:tail w:-3] ok=true",
      );
    });
    it("顺序分隔与换行", () => {
      // 快照串里 op:\\n 表示字面「op: + 反斜杠 + n」？不——快照函数输出的 op 值是真实换行符，
      // 期望串写作 "\\n" 转义形式与实际换行符不等。改用显性断言避开转义歧义：
      const r = lex("a;b\nc & d");
      const ops = r.tokens.filter(t => t.type === "op").map(t => t.op);
      expect(ops).toEqual([";", "\n", "&"]);
      expect(r.parseOk).toBe(true);
    });
    it("fd 前缀重定向并入 op", () => {
      expect(toSnapshot("cmd 2>&1 | head")).toBe("[w:cmd op:2>&1 op:| w:head] ok=true");
      expect(toSnapshot("grep pat 2>err.txt")).toBe("[w:grep w:pat op:2> w:err.txt] ok=true");
    });
    it("重定向操作符全集（Ad3：>| &>）", () => {
      expect(toSnapshot("a >|f &>g && b >>h <i <>j").startsWith("[w:a op:>|")).toBe(true);
    });
  });

  describe("引号与转义（D5 矩阵 #1/#2）", () => {
    it("空引号对拼接归一：ki''ll → kill", () => {
      const r = lex("ki''ll 42877");
      expect(r.tokens[0].word!.evaluated).toBe("kill");
    });
    it("词中转义拼接：k\\ill → kill", () => {
      const r = lex("k\\ill 42877");
      expect(r.tokens[0].word!.evaluated).toBe("kill");
    });
    it("连续转义：k\\i\\ll → kill", () => {
      const r = lex("k\\i\\ll 42877");
      expect(r.tokens[0].word!.evaluated).toBe("kill");
    });
    it("全词引号：'kill' → kill（quoted=single 标注保留）", () => {
      const r = lex("'kill' 42877");
      expect(r.tokens[0].word!.evaluated).toBe("kill");
      expect(r.tokens[0].word!.parts[0].quoted).toBe("single");
    });
    it("双引号内 $VAR 展开 → 不可求值（数据/执行分离的枢纽）", () => {
      const r = lex('echo "hi $USER"');
      const w = r.tokens[1].word!;
      expect(w.evaluated).toBeNull();
      expect(w.parts.some(p => p.type === "var")).toBe(true);
      expect(w.parts.some(p => p.type === "lit" && p.text === "hi ")).toBe(true);
    });
    it("单引号内 $ 不展开 → 纯字面量", () => {
      const r = lex("echo '$USER'");
      expect(r.tokens[1].word!.evaluated).toBe("$USER");
    });
    it("双引号内转义 \\\" 求值为引号字符", () => {
      const r = lex('echo "a\\"b"');
      expect(r.tokens[1].word!.evaluated).toBe('a"b');
    });
    it("hex 转义：引号外 hex part 不求值；单引号内字面量", () => {
      // 引号外（bash 词内 \x 字面双字符）：hex part，不可静态求值（D5 矩阵 #2）
      const r1 = lex("printf \\x6b\\x69");
      expect(r1.tokens[1].word!.evaluated).toBeNull();
      expect(r1.tokens[1].word!.parts.every(p => p.type === "hex")).toBe(true);
      // 单引号内：\ 是字面量 → lit part（可求值）——printf 自己解释 \x6b
      const r2 = lex("printf '\\x6b'");
      expect(r2.tokens[1].word!.evaluated).toBe("\\x6b");
    });
  });

  describe("展开识别（D5 矩阵 #3/#4/#13）", () => {
    it("$VAR / ${VAR} / $0-$9 / $@ / $* / $$ → var part", () => {
      const r = lex("echo $A ${B} $0 $1 $@ $* $$ $?");
      const w = r.tokens.slice(1).map(t => t.word!.parts[0].type);
      expect(w).toEqual(["var", "var", "var", "var", "var", "var", "var", "var"]);
    });
    it("$( ) 命令替换：载荷文本入 part（递归消费归模型层）", () => {
      const r = lex("kill $(cat f.pid)");
      const w = r.tokens[1].word!;
      expect(w.evaluated).toBeNull();
      const cs = w.parts.find(p => p.type === "cmdsub");
      expect(cs?.text).toBe("cat f.pid");
    });
    it("反引号命令替换", () => {
      const r = lex("kill `cat f.pid`");
      const w = r.tokens[1].word!;
      expect(w.parts.find(p => p.type === "cmdsub")?.text).toBe("cat f.pid");
    });
    it("嵌套 cmdsub：$(echo $(kill 9)) 外层载荷含内层原文", () => {
      const r = lex("echo $(echo $(kill 9))");
      const w = r.tokens[1].word!;
      const cs = w.parts.find(p => p.type === "cmdsub");
      expect(cs?.text).toContain("$(kill 9)");
    });
    it("$(( )) 算术展开 → arith part", () => {
      const r = lex("kill $((42877))");
      expect(r.tokens[1].word!.parts[0].type).toBe("arith");
      expect(r.tokens[1].word!.evaluated).toBeNull();
    });
    it("$'...' ANSI-C / $\"...\" locale → unknown（不可求值）", () => {
      expect(toSnapshot("echo $'\\n'")).toContain("w?(unknown)");
      expect(toSnapshot('echo $"x"')).toContain("w?(unknown)");
    });
  });

  describe("子 shell 与函数定义（r1-S1）", () => {
    it("裸子 shell (kill 42877) → ( ) 操作符 + 词法成功（#777 攻击面）", () => {
      expect(toSnapshot("(kill 42877)")).toBe("[op:( w:kill w:42877 op:)] ok=true");
    });
    it("函数定义 name() { … } → parseOk=false 落排除区（fail-closed）", () => {
      const r = lex("name() { echo hi; }");
      expect(r.parseOk).toBe(false);
      expect(r.issues[0]).toContain("function-definition");
    });
  });

  describe("heredoc（D5 矩阵 #6）", () => {
    it("引号定界符：体=数据，词法层跳过体内容", () => {
      const r = lex("python3 - <<'EOF'\nprint('k'+'ill 42877')\nEOF");
      expect(r.parseOk).toBe(true);
      const hd = r.tokens.find(t => t.type === "heredoc")!.heredoc!;
      expect(hd.delimQuoted).toBe(true);
      expect(hd.bodySpan).not.toBeNull();
      // 体内容不进 word 流
      const ws = r.tokens.filter(t => t.type === "word").map(t => t.word!.evaluated);
      expect(ws).toEqual(["python3", "-"]);
    });
    it("裸定界符：体可展开（危险性由模型层判），体 span 记录", () => {
      const r = lex("cat <<EOF\nline $(date)\nEOF");
      const hd = r.tokens.find(t => t.type === "heredoc")!.heredoc!;
      expect(hd.delimQuoted).toBe(false);
      expect(r.parseOk).toBe(true);
    });
    it("<<- 左 tab 定界", () => {
      const r = lex("cat <<-TAB\n\tdata\n\tTAB");
      expect(r.parseOk).toBe(true);
      expect(r.tokens.find(t => t.type === "heredoc")!.heredoc!.op).toBe("<<-");
    });
    it("未闭合 heredoc → parseOk=false", () => {
      const r = lex("cat <<EOF\nnever closed");
      expect(r.parseOk).toBe(false);
    });
    it("体后命令继续切词", () => {
      const r = lex("cat <<'E'\nbody\nE\necho after");
      const ws = r.tokens.filter(t => t.type === "word").map(t => t.word!.evaluated);
      expect(ws).toEqual(["cat", "echo", "after"]);
    });
  });

  describe("注释与词内 #", () => {
    it("词首 # → comment token（不进 argv）", () => {
      const r = lex("ls -la # comment");
      expect(r.tokens.some(t => t.type === "comment")).toBe(true);
      const ws = r.tokens.filter(t => t.type === "word").map(t => t.word!.evaluated);
      expect(ws).toEqual(["ls", "-la"]);
    });
    it("词内 # 不构成注释（echo a#b）", () => {
      const r = lex("echo a#b");
      expect(r.tokens.filter(t => t.type === "word").map(t => t.word!.evaluated)).toEqual(["echo", "a#b"]);
    });
  });

  describe("失败语义（D3）", () => {
    it("未闭合单引号 → parseOk=false", () => {
      expect(lex("echo 'unclosed").parseOk).toBe(false);
    });
    it("未闭合双引号 → parseOk=false", () => {
      expect(lex('echo "unclosed').parseOk).toBe(false);
    });
    it("未闭合 $( → parseOk=false", () => {
      expect(lex("echo $(unclosed").parseOk).toBe(false);
    });
    it("未闭合反引号 → parseOk=false", () => {
      expect(lex("echo `unclosed").parseOk).toBe(false);
    });
    it("issues 非空 ⇔ parseOk=false（一致性强断言）", () => {
      for (const s of ["kill 1", "echo 'a", "echo $(x", "f() {}", "cat <<E", "echo `x", "echo ${x"]) {
        const r = lex(s);
        expect(r.parseOk === (r.issues.length === 0)).toBe(true);
      }
    });
  });

  describe("超长输入防御（D6）", () => {
    it("1MB 内正常解析", () => {
      const cmd = "echo " + "a".repeat(500_000);
      const r = lex(cmd);
      expect(r.parseOk).toBe(true);
    });
  });

  describe("性能基准（D6：528KB 病态输入 <60ms 对照线由判定层集成测试承载）", () => {
    it("528KB 深引号嵌套词法 <30ms（词法层份额预算）", () => {
      const pathological = "echo '" + "x".repeat(528 * 1024) + "' | " + "y".repeat(100);
      const t0 = performance.now();
      const r = lex(pathological);
      const dt = performance.now() - t0;
      expect(r.parseOk).toBe(true);
      expect(dt).toBeLessThan(30);
    });
  });
});

describe("#1374（F20261009qdlq）：双引号内 $ 紧邻闭引号的 raw-quote 回退", () => {
  // $" 歧义：① locale 引用 $\"...\"（词首，有配对闭引号）；② $ 正则锚定 + 词闭引号
  // （grep \"^npm|^$\"——$ 是字面量，" 是外层双引号的闭合）。greedy indexOf 把②误判
  // 为①的未闭合 → 连带外层引号 fail → parseOk=false → cd 豁免退化 4 连拦。回退仅在
  // 外层引号上下文（quoted="double"）生效：此时 $" 中的 " 定是外层闭合（真 locale
  // 引用不会出现在双引号内），$ 按字面量入 parts，" 留给外层引号扫描消费，不 fail。
  // 词首 $"（quoted=null）维持 locale 处理不变。
  it("issue 复现：grep -vE \"^npm|^$\" → parseOk=true（cd 豁免不退化）", () => {
    const r = lex('grep -vE "^npm|^$" | head -5');
    expect(r.parseOk).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
  it("$ 锚定行尾：grep \"x$\" → parseOk=true", () => {
    expect(lex('grep "x$"').parseOk).toBe(true);
  });
  it("无管道同形态：grep -vE \"^a|^$\" → parseOk=true", () => {
    expect(lex('grep -vE "^a|^$"').parseOk).toBe(true);
  });
  it("真 locale 引用不受影响：echo $\"hello world\" → unknown 且 parseOk=true", () => {
    const r = lex('echo $"hello world"');
    expect(r.parseOk).toBe(true);
    expect(r.tokens[1].word!.parts[0].type).toBe("unknown");
  });
  it("locale 未闭合维持 fail（保守）：echo $\"abc → parseOk=false", () => {
    expect(lex('echo $"abc').parseOk).toBe(false);
  });
  it("词首残缺配对维持 fail（保守）：echo $\"a\"b\"c → parseOk=false", () => {
    expect(lex('echo $"a"b"c').parseOk).toBe(false);
  });
  it("引号内 $\" 复合形态：echo \"a$\"b\" → parseOk=false（残余 b\" 未闭合，保守 fail 锁定现状）", () => {
    // $" 在双引号内 → raw-quote 回退（$ 字面量，" 闭外层）；残余 b" 为未闭合双引号 →
    // 外层扫描 fail。bash 实际语义是引号拼接（"a$" + b"...），词法层不追嵌套语义——
    // 保守 fail 与本修复目标形态（$ 紧邻词尾闭引号）无交集，锁定现状。
    expect(lex('echo "a$"b"').parseOk).toBe(false);
  });
  it("$VAR 不受影响：echo \"$HOME\" → var part 正常展开标注", () => {
    const r = lex('echo "$HOME"');
    expect(r.parseOk).toBe(true);
    expect(r.tokens[1].word!.parts.some(p => p.type === "var")).toBe(true);
  });
});
