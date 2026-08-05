import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeSessionFile } from "@frameworks/agent/session-sanitizer";

/** 构造 session jsonl 夹具：header + model_change + 消息链 */
function buildSessionFile(entries: Array<Record<string, unknown>>): string {
  const header = { type: "session", version: 3, id: "sess-1", timestamp: "2026-08-04T00:00:00Z", cwd: "/tmp" };
  return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function msgEntry(id: string, parentId: string | null, content: Array<Record<string, unknown>>, role = "assistant") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-04T08:00:00Z",
    message: { role, content, stopReason: "stop" },
  };
}

const DEGENERATE_TEXT = "Good, the first commit is done. Now let me speak to the user with the progress update. ".repeat(500);

/** 每字符伪随机的正常文本（阴性夹具，任何 100 字符窗口都唯一） */
function makeNormalText(length: number, seed = 42): string {
  let a = seed;
  const rand = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "的一是在不了有人和国中大到为上个年我以时要说abcdefghijklmnop0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}
const NORMAL_TEXT = makeNormalText(8000);

describe("session-sanitizer", () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sanitizer-test-"));
    file = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("退化 text 块原位替换，entry 树结构不变", () => {
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("a1", null, [{ type: "text", text: NORMAL_TEXT }]),
      msgEntry("a2", "a1", [{ type: "text", text: DEGENERATE_TEXT }]),
      msgEntry("a3", "a2", [{ type: "text", text: "后续正常消息" }]),
    ]));

    const result = sanitizeSessionFile(file);
    expect(result.replacedBlocks).toBe(1);
    expect(result.fileRewritten).toBe(true);
    expect(result.hits[0].entryId).toBe("a2");
    expect(result.hits[0].mechanism).toBe("repeat_window");

    // 树结构校验：id/parentId 链不变
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));
    const a2 = entries.find((e) => e.id === "a2");
    const a3 = entries.find((e) => e.id === "a3");
    expect(a2.parentId).toBe("a1");
    expect(a3.parentId).toBe("a2");
    expect(a2.message.content[0].text).toContain("输出异常重复，已截断");
    expect(a2.message.content[0].text).toContain(String(DEGENERATE_TEXT.length));
    // 正常块不动
    expect(entries.find((e) => e.id === "a1").message.content[0].text).toBe(NORMAL_TEXT);
  });

  it("thinking 块带 thinkingSignature 时连带清除", () => {
    const degenerateThinking = "Let me reconsider the plan once more and rethink it again. ".repeat(300);
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("t1", null, [{ type: "thinking", thinking: degenerateThinking, thinkingSignature: "sig-abc" }]),
    ]));

    const result = sanitizeSessionFile(file);
    expect(result.replacedBlocks).toBe(1);

    const entry = JSON.parse(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)[1]);
    const block = entry.message.content[0];
    expect(block.thinking).toContain("输出异常重复，已截断");
    expect("thinkingSignature" in block).toBe(false);
  });

  it("非活跃分支不清洗（buildContextEntries 只走叶路径）", () => {
    // 分支：a1 -> a2(退化，非活跃) ；a1 -> b1(活跃叶)
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("a1", null, [{ type: "text", text: "root" }]),
      msgEntry("a2", "a1", [{ type: "text", text: DEGENERATE_TEXT }]),
      msgEntry("b1", "a1", [{ type: "text", text: "活跃分支叶节点" }]),
    ]));

    const result = sanitizeSessionFile(file);
    // 叶是最后的 b1，活跃路径 = b1 -> a1；a2 不在路径上，不清洗
    expect(result.replacedBlocks).toBe(0);
    expect(result.fileRewritten).toBe(false);
  });

  it("无退化时幂等：不写盘、无 .bak", () => {
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("n1", null, [{ type: "text", text: NORMAL_TEXT }]),
    ]));
    const before = fs.readFileSync(file, "utf8");

    const result = sanitizeSessionFile(file);
    expect(result.replacedBlocks).toBe(0);
    expect(result.fileRewritten).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(file + ".bak")).toBe(false);
  });

  it("二次运行幂等（占位符本身不触发检测）", () => {
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("a1", null, [{ type: "text", text: DEGENERATE_TEXT }]),
    ]));
    sanitizeSessionFile(file);
    const afterFirst = fs.readFileSync(file, "utf8");
    const second = sanitizeSessionFile(file);
    expect(second.replacedBlocks).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
  });

  it(".bak 同名覆盖（只留最近一份）", () => {
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("a1", null, [{ type: "text", text: DEGENERATE_TEXT }]),
    ]));
    sanitizeSessionFile(file);
    expect(fs.existsSync(file + ".bak")).toBe(true);
    // .bak 里是原始（未清洗）内容
    expect(fs.readFileSync(file + ".bak", "utf8")).toContain("Good, the first commit is done");
  });

  it("文件不存在时返回空结果", () => {
    const result = sanitizeSessionFile(path.join(tmpDir, "nonexistent.jsonl"));
    expect(result.replacedBlocks).toBe(0);
    expect(result.fileRewritten).toBe(false);
  });

  it("近似重复 thinking 块也能被抓（distinct-ratio 机制）", () => {
    // 10 个变体随机拼 20KB（4e8c3ff3 型）
    const variants = Array.from({ length: 10 }, (_, i) => `思考变体${i}：` + "内容各不相同但模式重复的表述。".repeat(3) + String.fromCharCode(65 + i));
    let nearDup = "";
    let i = 0;
    while (nearDup.length < 20_000) { nearDup += variants[i % 10]; i++; }
    fs.writeFileSync(file, buildSessionFile([
      msgEntry("v1", null, [{ type: "thinking", thinking: nearDup }]),
    ]));

    const result = sanitizeSessionFile(file);
    expect(result.replacedBlocks).toBe(1);
    expect(["distinct_ratio", "repeat_window"]).toContain(result.hits[0].mechanism);
  });
});
