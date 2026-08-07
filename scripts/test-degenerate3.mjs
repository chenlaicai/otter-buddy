/* eslint-disable no-undef -- Node.js 全局（setTimeout/clearTimeout）在 .mjs 中不被 ESLint 自动识别 */
/**
 * 复现 mimo 退化行为（第三轮）：直接用案发现场 session 文件。
 * 从 session 文件截取退化前的部分，作为新 session 的起点。
 */
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "fs";

const SCENE_SESSION = "/tmp/pi-degenerate-cleaned-memory.jsonl";
const TIMEOUT_MS = 120_000;

const API_KEY = "tp-cs8vohgx42vzr4h3krfsh2rh5fk0yzhk0ki9dygv5lvjexov";
const API_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";

// 案发现场退化前的最后一条用户消息
const TRIGGER_MESSAGE = `## 会话摘要
重新来

## 在场成员
- 大獭
- 搭档（传 'user' 即交还发言权）

## 对话历史（你上次发言后的消息）
[搭档] 在对话《对话列表的状态图标》中，我发现大獭的上下文暴涨到400k多，这很夸张，如果是我直接用cc/codex，看了下对话内容，根本不可能达到这么高！你排查下根因是什么！为什么这么高

## 当前任务
在对话《对话列表的状态图标》中，我发现大獭的上下文暴涨到400k多，这很夸张，如果是我直接用cc/codex，看了下对话内容，根本不可能达到这么高！你排查下根因是什么！为什么这么高`;

async function main() {
  // 从案发现场 session 文件截取退化前的内容（line 0-57）
  const allLines = readFileSync(SCENE_SESSION, "utf-8").trim().split("\n");
  const contextLines = allLines.slice(0, 58); // 退化发生在 line 58
  const sessionFile = "/tmp/pi-degenerate-scene.jsonl";
  writeFileSync(sessionFile, contextLines.join("\n") + "\n");
  console.log(`[test] Created session file with ${contextLines.length} lines`);

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

  // 用 SessionManager.open() 打开案发现场 session 文件
  console.log("[test] Opening scene session file...");
  const sessionManager = SessionManager.open(sessionFile);
  console.log("[test] Session ID:", sessionManager.getSessionId());

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

  console.log("[test] Starting prompt with trigger message...");
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

    await session.prompt(TRIGGER_MESSAGE);
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
