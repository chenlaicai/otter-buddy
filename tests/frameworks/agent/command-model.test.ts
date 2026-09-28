/**
 * F20260928grv2 命令结构模型测试（D7 第②层：模型结构断言）。
 *
 * 锁死「token 流 → 结构模型」的正确性：分段/argv/赋值前缀/重定向/递归载荷/深度控制。
 * 判定层决策表在 bash-safety-guard.test.ts（第③层）。
 */
import { describe, expect, it } from "vitest";
import { parseOnce } from "@frameworks/agent/command-model";

describe("command-model 结构模型", () => {
  describe("分段与 argv", () => {
    it("简单命令：1 段，argv0+args", () => {
      const m = parseOnce("kill 42877");
      expect(m.segments).toHaveLength(1);
      expect(m.segments[0].argv0).toBe("kill");
      expect(m.segments[0].args).toEqual(["42877"]);
    });
    it("管道切段：joiner 标记", () => {
      const m = parseOnce("lsof -i :3100 | grep LISTEN | wc -l");
      expect(m.segments.map(s => s.argv0)).toEqual(["lsof", "grep", "wc"]);
      expect(m.segments[1].joiner).toBe("|");
      expect(m.segments[2].joiner).toBe("|");
    });
    it("&& 与 ; 切段", () => {
      const m = parseOnce("cd /wt && git commit; git status");
      expect(m.segments.map(s => s.argv0)).toEqual(["cd", "git", "git"]);
      expect(m.segments[1].joiner).toBe("&&");
      expect(m.segments[2].joiner).toBe(";");
    });
    it("引号内分号不切段（数据/执行分离枢纽）", () => {
      const m = parseOnce("echo 'sleep 1; pkill -f x' | grep p");
      expect(m.segments).toHaveLength(2);
      expect(m.segments[0].args[0]).toBe("sleep 1; pkill -f x");
    });
    it("换行切段", () => {
      const m = parseOnce("a\nb");
      expect(m.segments.map(s => s.argv0)).toEqual(["a", "b"]);
      expect(m.segments[1].joiner).toBe("\n");
    });
  });

  describe("赋值前缀（Ad1）", () => {
    it("W=/path; cd $W：赋值独立段表示，cd 参数不可求值", () => {
      const m = parseOnce("W=/path; cd $W && git commit -m x");
      expect(m.segments[0].assignments).toEqual([{ name: "W", value: "/path" }]);
      expect(m.segments[0].words).toHaveLength(0);
      expect(m.segments[1].argv0).toBe("cd");
      expect(m.segments[1].args[0]).toBeNull(); // $W 不可静态求值
    });
    it("VAR=1 cmd arg：赋值前缀 + 命令词共存", () => {
      const m = parseOnce("VAR=1 cmd arg");
      expect(m.segments[0].assignments).toEqual([{ name: "VAR", value: "1" }]);
      expect(m.segments[0].argv0).toBe("cmd");
      expect(m.segments[0].args).toEqual(["arg"]);
    });
  });

  describe("重定向", () => {
    it("> target 进 redirects 不进 args", () => {
      const m = parseOnce("echo hi > out.txt");
      expect(m.segments[0].args).toEqual(["hi"]);
      expect(m.segments[0].redirects).toEqual([{ op: ">", target: "out.txt" }]);
    });
    it("2>&1 fd 复制：target=null（无词目标）", () => {
      const m = parseOnce("cmd 2>&1 | head");
      expect(m.segments[0].redirects).toEqual([{ op: "2>&1", target: null }]);
      expect(m.segments[1].argv0).toBe("head");
    });
    it("&> 全重定向", () => {
      const m = parseOnce("cmd &> all.log");
      expect(m.segments[0].redirects).toEqual([{ op: "&>", target: "all.log" }]);
    });
    it(">| 强制覆盖（Ad3）", () => {
      const m = parseOnce("cmd >| f.txt");
      expect(m.segments[0].redirects[0].op).toBe(">|");
    });
    it("$VAR 目标不可求值 → target=null", () => {
      const m = parseOnce("cmd > $OUT");
      expect(m.segments[0].redirects).toEqual([{ op: ">", target: null }]);
    });
  });

  describe("子 shell（r1-S1）", () => {
    it("(kill 42877)：组内段展开且 subshell=true", () => {
      const m = parseOnce("(kill 42877)");
      expect(m.segments.length).toBeGreaterThanOrEqual(1);
      expect(m.segments[0].subshell).toBe(true);
      expect(m.segments[0].argv0).toBe("kill");
    });
    it("前置命令 + 子 shell 组合", () => {
      const m = parseOnce("echo hi && (kill 42877)");
      const sub = m.segments.find(s => s.subshell);
      expect(sub?.argv0).toBe("kill");
      expect(sub?.joiner).toBe("&&");
    });
  });

  describe("递归载荷（D2 深度控制）", () => {
    it("$( ) cmdsub 载荷递归解析", () => {
      const m = parseOnce("kill $(cat f.pid)");
      expect(m.segments[0].args[0]).toBeNull();
      const cs = m.payloads.find(p => p.kind === "cmdsub");
      expect(cs).toBeDefined();
      expect(cs!.model?.segments[0].argv0).toBe("cat");
    });
    it("反引号载荷递归", () => {
      const m = parseOnce("kill `cat f.pid`");
      expect(m.payloads.find(p => p.kind === "cmdsub" && p.model?.segments[0].argv0 === "cat")).toBeDefined();
    });
    it("bash -c '载荷'：递归模型可见段结构", () => {
      const m = parseOnce("bash -c 'nohup kill 42877'");
      const pl = m.payloads.find(p => p.kind === "bash-c");
      expect(pl).toBeDefined();
      expect(pl!.model?.segments[0].argv0).toBe("nohup");
      expect(pl!.model?.segments[0].args).toEqual(["kill", "42877"]);
    });
    it("嵌套深度上限 2：第三层不再解析（parseOk=false + 第三层 model=null）", () => {
      // 三层嵌套：echo $(a $(b $(c)))——l1(d1)/l2(d2) 可解析，最内层 cmdsub(d2 超限) 不再解析
      const m = parseOnce("echo $(echo $(echo $(kill 9)))");
      expect(m.parseOk).toBe(false);
      const l1 = m.payloads.find(p => p.kind === "cmdsub");
      const l2 = l1?.model?.payloads.find(p => p.kind === "cmdsub");
      expect(l2?.model).toBeDefined(); // d=2 仍解析
      const l3 = l2?.model?.payloads.find(p => p.kind === "cmdsub");
      expect(l3).toBeDefined();
      expect(l3!.model).toBeNull(); // 第三层不再解析（D2）
    });
    it("裸定界 heredoc 体含展开特征时递归（危险通道）；纯数据体不递归（r1-S2/V1 对齐）", () => {
      // 体含展开（$/反引号）→ 危险通道递归
      const m1 = parseOnce("bash <<EOF\nkill $((1+1))\nEOF");
      const pl1 = m1.payloads.find(p => p.kind === "heredoc-bare");
      expect(pl1?.model?.segments[0].argv0).toBe("kill");
      // 体无展开特征 = 纯数据（V1 stripHeredocPayloads 剥离放行语义）
      const m2 = parseOnce("bash <<EOF\nkill 42877\nEOF");
      const pl2 = m2.payloads.find(p => p.kind === "heredoc-bare");
      expect(pl2).toBeUndefined(); // 不再作为危险通道递归
      expect(m2.parseOk).toBe(true);
    });
    it("引号定界 heredoc 体=数据（不递归）", () => {
      const m = parseOnce("cat <<'EOF'\nsleep 1; pkill -f x\nEOF");
      const pl = m.payloads.find(p => p.kind === "heredoc-quoted");
      expect(pl).toBeDefined();
      expect(pl!.model).toBeNull();
      expect(m.parseOk).toBe(true); // 引号定界不破坏 parseOk
    });
  });

  describe("python -c / node -e 载荷", () => {
    it("python -c 载荷记录（判定层消费）", () => {
      const m = parseOnce("python3 -c 'import os; os.kill(42877)'");
      // 载荷存在（kind=cmdsub 由 matchInterpreterPayload 派发）
      expect(m.payloads.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("失败语义传播", () => {
    it("未闭合引号 → 模型 parseOk=false", () => {
      expect(parseOnce("echo 'unclosed").parseOk).toBe(false);
    });
    it("词法 ok 但载荷深度超限 → parseOk=false", () => {
      expect(parseOnce("echo $(echo $(echo $(x)))").parseOk).toBe(false);
    });
    it("全正常 → parseOk=true", () => {
      expect(parseOnce("cd /wt && git commit -m 'x' | tail -3").parseOk).toBe(true);
    });
  });
});
