/** Otter Buddy entry point - will be implemented in subsequent features. */

// 伪代码（待后续 feature 完成完整装配）：
// const db = initDatabase();                          // infra/db ✅
// const llm = initLLMGateway();                       // infra/llm-gateway ✅
// const { agentRegistry } = initAgentCore({ llm });   // infra/agent-core ✅
// const embedding = initEmbedding();                  // infra/embedding ✅
//
// const otterPort = initOtter({ db, agentRegistry }); // domain/otter ✅
// const memoryPort = initMemory({ db, embedding });   // domain/memory ✅
//
// 待实现
// const conversationPort = initConversation({ db });
// const capabilityPort = initCapability({ db });
// const externalPort = initExternal({ db });
