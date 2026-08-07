/* eslint-disable no-undef -- Node.js 全局（setTimeout/clearTimeout）在 .mjs 中不被 ESLint 自动识别 */
/**
 * 复现 mimo 退化行为（第二轮）：用案发现场的对话历史作为上下文。
 * 关键差异：案发现场的退化发生在模型已经有大量工具调用历史之后。
 * 模拟：先注入一段工具调用历史，再让模型继续分析。
 */
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";

const SESSION_DIR = "/tmp/pi-degenerate-test2";
const TIMEOUT_MS = 120_000;

const API_KEY = "tp-cs8vohgx42vzr4h3krfsh2rh5fk0yzhk0ki9dygv5lvjexov";
const API_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";

// 模拟案发现场：模型已经做了一些分析工作，现在需要继续
const USER_MESSAGE = `我需要你分析一个代码库的上下文管理机制。这个代码库使用 Pi SDK 的 createAgentSession 来创建 agent session，session 会持久化到 JSONL 文件。每次 invoke 时通过 SessionManager.open() 恢复已有 session。

问题是：为什么某个对话的上下文会暴涨到 400k+ tokens？

已知信息：
1. 对话有 61 次 read 工具调用和大量 bash、edit、write 操作
2. 每次工具调用的结果都作为 tool_result 消息进入上下文
3. Pi SDK 有 compaction 功能（compact(), shouldCompact(), prepareCompaction()）
4. Session 复用机制：首次 invoke 创建 session，后续 invoke 恢复已有 session
5. 没有上下文压缩、截断或摘要机制

请分析：
1. Pi SDK 的 compaction 机制是否默认启用？
2. 如果 compaction 未启用，工具调用结果如何累积？
3. 为什么 cc/codex 直接用不会达到 400k，而通过 otter-buddy 会？

你需要查看代码来确认你的分析。`;

async function main() {
  console.log("[test] Creating ModelRuntime...");
  const modelRuntime = await ModelRuntime.create();

  modelRuntime.registerProvider("mimo", {
    baseUrl: API_BASE_URL,
    apiKey: API_KEY,
    api: "anthropic-messages",
    models: [{
      id: "mimo-v2.5-pro",
      name: "mimo-v2.5-pro",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    }],
  });
  await modelRuntime.setRuntimeApiKey("mimo", API_KEY);

  const model = modelRuntime.getModel("mimo", "mimo-v2.5-pro");
  console.log("[test] Model:", model?.id, "provider:", model?.provider);

  const sessionManager = SessionManager.create(process.cwd(), SESSION_DIR);

  const { session } = await createAgentSession({
    model,
    sessionManager,
    tools: ["read", "bash"],
    modelRuntime,
  });

  let totalChars = 0;
  let thinkingChars = 0;
  let textChars = 0;
  let degenerateDetected = false;

  const windowLen = 100;
  const maxRepeats = 50;
  const windowCounts = new Map();
  let tail = "";

  function checkDegenerate(delta) {
    totalChars += delta.length;
    for (let i = 0; i < delta.length; i++) {
      tail += delta[i];
      if (tail.length < windowLen) continue;
      if (tail.length > windowLen) tail = tail.slice(-windowLen);
      let h = 5381;
      for (let j = 0; j < tail.length; j++) {
        h = ((h << 5) + h + tail.charCodeAt(j)) | 0;
      }
      h = h >>> 0;
      const count = (windowCounts.get(h) ?? 0) + 1;
      windowCounts.set(h, count);
      if (count >= maxRepeats) return true;
    }
    return false;
  }

  const timeout = setTimeout(() => {
    console.log(`\n[test] TIMEOUT after ${TIMEOUT_MS}ms`);
    console.log(`[test] Total chars: ${totalChars}, thinking: ${thinkingChars}, text: ${textChars}`);
    console.log(`[test] Max window count: ${Math.max(...windowCounts.values(), 0)}`);
    session.abort().catch(() => {});
  }, TIMEOUT_MS);

  console.log("[test] Starting prompt...");
  const startTime = Date.now();

  try {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (!ame) return;
        if (ame.type === "text_start") {
          process.stdout.write("\n[TEXT] ");
          windowCounts.clear();
          tail = "";
        } else if (ame.type === "thinking_start") {
          process.stdout.write("\n[THINKING] ");
          windowCounts.clear();
          tail = "";
        }
        if (ame.delta) {
          const d = ame.delta;
          if (ame.type === "thinking_delta") thinkingChars += d.length;
          else textChars += d.length;

          const preview = d.substring(0, 40).replace(/\n/g, "\\n");
          process.stdout.write(preview);
          if (d.length > 40) process.stdout.write(`...(+${d.length - 40})`);

          if (checkDegenerate(d)) {
            degenerateDetected = true;
            console.log(`\n\n[DEGENERATE DETECTED!] totalChars=${totalChars}, thinking=${thinkingChars}, text=${textChars}`);
            console.log(`[test] Repeating text: ${tail.slice(-300)}`);
            session.abort().catch(() => {});
          }
        }
      } else if (event.type === "tool_execution_start") {
        process.stdout.write(`\n[TOOL: ${event.toolName}] `);
      }
    });

    await session.prompt(USER_MESSAGE);
    unsubscribe();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n[test] Completed in ${elapsed}s`);
    console.log(`[test] Total chars: ${totalChars}, thinking: ${thinkingChars}, text: ${textChars}`);
    console.log(`[test] Degenerate detected: ${degenerateDetected}`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n[test] Error after ${elapsed}s: ${err.message}`);
    console.log(`[test] Total chars: ${totalChars}, thinking: ${thinkingChars}, text: ${textChars}`);
    console.log(`[test] Degenerate detected: ${degenerateDetected}`);
    console.log(`[test] Max window count: ${Math.max(...windowCounts.values(), 0)}`);
  } finally {
    clearTimeout(timeout);
    session.dispose();
  }
}

main().catch(console.error);
