/* eslint-disable no-undef -- Node.js 全局（setTimeout/clearTimeout）在 .mjs 中不被 ESLint 自动识别 */
/**
 * 复现 mimo 退化行为：直接调用 Pi SDK，观察流式输出。
 * 使用案发现场相同的 prompt 和配置。
 */
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";

const SESSION_DIR = "/tmp/pi-degenerate-test";
const TIMEOUT_MS = 120_000; // 2 分钟超时

// 配置（来自 config.yaml）
const API_KEY = "tp-cs8vohgx42vzr4h3krfsh2rh5fk0yzhk0ki9dygv5lvjexov";
const API_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";

// 案发现场 prompt（从日志提取，完整身份注入）
const SYSTEM_PROMPT = `你是大獭 🦦，海獭团队的头儿，也是搭档的工作+生活伙伴。

## 你的名号
你在署名时使用的名字：**大獭**。

你持续在场，什么都能聊：写代码、做 research、出方案、聊想法、处理生活杂事。简单的事你直接上手做；复杂的事你也有办法——小獭是你的延伸。

## 你怎么说话
- 像人一样说话：直接、有温度、有自己的语气和判断，不端着，不背八股
- 生动但不浮夸：偶尔的獭味幽默可以，满屏 emoji 和夸张表演不行
- 记住搭档说过的事，接住上下文，像老搭档一样协作

## 技术决策权
你是技术架构师：实现方案、技术选型、架构取舍这类技术问题，自行调研、自行拍板，不拿技术选择题去烦搭档。搭档管产品愿景和方向——真涉及产品取舍、资源投入或方向分歧时，才找搭档。`;

const USER_MESSAGE = `在对话《对话列表的状态图标》中，我发现大獭的上下文暴涨到400k多，这很夸张，如果是我直接用cc/codex，看了下对话内容，根本不可能达到这么高！你排查下根因是什么！为什么这么高`;

async function main() {
  console.log("[test] Creating ModelRuntime...");
  const modelRuntime = await ModelRuntime.create();

  // 注册 provider（与 pi-session-factory 的 _registerRuntimeModel 同构）
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

  console.log("[test] Creating session...");
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

  // 退化检测：滑窗重复（与 DegenerateDetector 机制 A 相同）
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

  // 超时保护
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
          if (ame.type === "text_delta") thinkingChars += d.length; // thinking_delta in SDK
          else if (ame.type === "thinking_delta") thinkingChars += d.length;
          else textChars += d.length;

          const preview = d.substring(0, 40).replace(/\n/g, "\\n");
          process.stdout.write(preview);
          if (d.length > 40) process.stdout.write(`...(+${d.length - 40})`);

          if (checkDegenerate(d)) {
            degenerateDetected = true;
            console.log(`\n\n[DEGENERATE DETECTED!] totalChars=${totalChars}, thinking=${thinkingChars}, text=${textChars}`);
            console.log(`[test] Last repeating text: ${tail.slice(-200)}`);
            session.abort().catch(() => {});
          }
        }
      } else if (event.type === "tool_execution_start") {
        process.stdout.write(`\n[TOOL: ${event.toolName}] `);
      }
    });

    const fullMessage = SYSTEM_PROMPT + "\n\n" + USER_MESSAGE;
    await session.prompt(fullMessage);
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
