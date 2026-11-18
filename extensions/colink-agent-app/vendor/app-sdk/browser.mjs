// src/shared/data.mts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var record = (value) => isRecord(value) ? value : {};
function errorCode(value) {
  const code = record(value).code;
  return typeof code === "string" ? code : void 0;
}
function isIterable(value) {
  return typeof value === "string" || value !== null && typeof value === "object" && (typeof Reflect.get(value, Symbol.asyncIterator) === "function" || typeof Reflect.get(value, Symbol.iterator) === "function");
}

// src/shared/error-details.mts
var projectUsage = () => void 0;
function installUsageProjection(project) {
  projectUsage = project;
}
function safeMethodUsage(input, secrets = []) {
  return projectUsage(input, secrets);
}
var WRITE_RECOVERY_MS = 36e5;
function safeWriteRecovery(input, secrets = []) {
  const value = record(input), { outcome, action, remainingMs } = value;
  if (outcome !== "not_sent" && outcome !== "unknown" && outcome !== "confirmed" || action !== "fix_request" && action !== "same_key" && action !== "inspect" && action !== "stop") return void 0;
  const operationId = value.operationId;
  return {
    outcome,
    action,
    ...typeof operationId === "string" && /^[a-f0-9]{64}$/.test(operationId) && !secrets.some((s) => s && operationId.includes(s)) ? { operationId } : {},
    ...typeof remainingMs === "number" && Number.isSafeInteger(remainingMs) && remainingMs >= 0 && remainingMs <= WRITE_RECOVERY_MS ? { remainingMs } : {}
  };
}

// src/diagnostics/method-guides.mts
var METHOD_GUIDES = {
  "projects.list": {
    "method": "projects.list",
    "route": "GET /app-projects",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "CursorQuery | undefined",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.projects.list({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#projectslist--projectsiterate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.projects.list({});",
      "app": "await colink.app.projects.list({});"
    }
  },
  "projects.iterate": {
    "method": "projects.iterate",
    "route": "GET /app-projects",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "CursorQuery | undefined",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      },
      {
        "name": "options",
        "optional": true,
        "type": "IterationOptions | undefined",
        "parameters": [
          {
            "name": "maxPages",
            "type": "number",
            "required": false,
            "description": "\u6700\u591A\u904D\u5386\u9875\u6570\uFF0C\u6B63\u6574\u6570\uFF0C\u9ED8\u8BA4 100\uFF1B\u8FBE\u5230\u4E0A\u9650\u4ECD\u6709\u6570\u636E\u5219\u5931\u8D25\u3002"
          },
          {
            "name": "signal",
            "type": "AbortSignal",
            "required": false,
            "description": "\u8C03\u7528\u65B9\u7684 AbortSignal\uFF0C\u7528\u4E8E\u53D6\u6D88\u904D\u5386\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "for await (const item of colink.user.projects.iterate({})) { /* \u5904\u7406 item */ }",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#projectslist--projectsiterate",
    "note": "\u8FED\u4EE3\u65F6 next() \u62D2\u7EDD\uFF1B\u521B\u5EFA\u8FED\u4EE3\u5668\u4E0D\u5F00\u59CB\u8BF7\u6C42\uFF1B\u5DF2\u7ECF\u4EA7\u51FA\u7684\u6761\u76EE\u4ECD\u6709\u6548\uFF0C\u5931\u8D25\u4E0D\u662F\u6B63\u5E38\u672B\u9875\u3002\u53EF\u7528 for await \u6355\u83B7\uFF1B\u63D0\u524D return() \u7ED3\u675F\u6D88\u8D39\u3002\u670D\u52A1\u7AEF\u7ED1\u5B9A\u5305\u88C5\u4F1A\u91CA\u653E\u6267\u884C\u5E76\u541E\u6389\u5185\u90E8\u8FED\u4EE3\u5668\u5F02\u6B65\u6E05\u7406\u5931\u8D25\uFF0C\u4E0D\u636E\u6B64\u63A8\u65AD\u6240\u6709\u6761\u76EE\u5DF2\u8BFB\u53D6\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "for await (const item of colink.user.projects.iterate({})) { /* \u5904\u7406 item */ }",
      "app": "for await (const item of colink.app.projects.iterate({})) { /* \u5904\u7406 item */ }"
    }
  },
  "channels.list": {
    "method": "channels.list",
    "route": "GET /app-channels",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "(CursorQuery & { projectId?: string; }) | undefined",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "projectId",
            "type": "string",
            "required": false,
            "description": "\u9879\u76EE ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 projects.list \u7ED3\u679C\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.channels.list({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#channelslist--channelsiterate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.channels.list({});",
      "app": "await colink.app.channels.list({});"
    }
  },
  "channels.iterate": {
    "method": "channels.iterate",
    "route": "GET /app-channels",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "(CursorQuery & { projectId?: string; }) | undefined",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "projectId",
            "type": "string",
            "required": false,
            "description": "\u9879\u76EE ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 projects.list \u7ED3\u679C\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      },
      {
        "name": "options",
        "optional": true,
        "type": "IterationOptions | undefined",
        "parameters": [
          {
            "name": "maxPages",
            "type": "number",
            "required": false,
            "description": "\u6700\u591A\u904D\u5386\u9875\u6570\uFF0C\u6B63\u6574\u6570\uFF0C\u9ED8\u8BA4 100\uFF1B\u8FBE\u5230\u4E0A\u9650\u4ECD\u6709\u6570\u636E\u5219\u5931\u8D25\u3002"
          },
          {
            "name": "signal",
            "type": "AbortSignal",
            "required": false,
            "description": "\u8C03\u7528\u65B9\u7684 AbortSignal\uFF0C\u7528\u4E8E\u53D6\u6D88\u904D\u5386\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "for await (const item of colink.user.channels.iterate({})) { /* \u5904\u7406 item */ }",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#channelslist--channelsiterate",
    "note": "\u8FED\u4EE3\u65F6 next() \u62D2\u7EDD\uFF1B\u521B\u5EFA\u8FED\u4EE3\u5668\u4E0D\u5F00\u59CB\u8BF7\u6C42\uFF1B\u5DF2\u7ECF\u4EA7\u51FA\u7684\u6761\u76EE\u4ECD\u6709\u6548\uFF0C\u5931\u8D25\u4E0D\u662F\u6B63\u5E38\u672B\u9875\u3002\u53EF\u7528 for await \u6355\u83B7\uFF1B\u63D0\u524D return() \u7ED3\u675F\u6D88\u8D39\u3002\u670D\u52A1\u7AEF\u7ED1\u5B9A\u5305\u88C5\u4F1A\u91CA\u653E\u6267\u884C\u5E76\u541E\u6389\u5185\u90E8\u8FED\u4EE3\u5668\u5F02\u6B65\u6E05\u7406\u5931\u8D25\uFF0C\u4E0D\u636E\u6B64\u63A8\u65AD\u6240\u6709\u6761\u76EE\u5DF2\u8BFB\u53D6\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "for await (const item of colink.user.channels.iterate({})) { /* \u5904\u7406 item */ }",
      "app": "for await (const item of colink.app.channels.iterate({})) { /* \u5904\u7406 item */ }"
    }
  },
  "channels.listMembers": {
    "method": "channels.listMembers",
    "route": "GET /app-channels/:id/members",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "CursorQuery & { channelId: string; topicId?: string; }",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "topicId",
            "type": "string",
            "required": false,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.channels.listMembers({"channelId":"<channelId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#channelslistmembers",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.channels.listMembers({"channelId":"<channelId>"});'
    }
  },
  "channels.listMessages": {
    "method": "channels.listMessages",
    "route": "GET /app-channels/:id/messages",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "CursorQuery & { channelId: string; beforeMessageId?: string; afterMessageId?: string; }",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "beforeMessageId",
            "type": "string",
            "required": false,
            "description": "\u8BFB\u53D6\u8BE5\u6D88\u606F\u4E4B\u524D\u7684\u6D88\u606F\u3002"
          },
          {
            "name": "afterMessageId",
            "type": "string",
            "required": false,
            "description": "\u8BFB\u53D6\u8BE5\u6D88\u606F\u4E4B\u540E\u7684\u6D88\u606F\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.channels.listMessages({"channelId":"<channelId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#channelslistmessages",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.channels.listMessages({"channelId":"<channelId>"});',
      "app": 'await colink.app.channels.listMessages({"channelId":"<channelId>"});'
    }
  },
  "channels.listUnreadMessages": {
    "method": "channels.listUnreadMessages",
    "route": "GET /channels/:id/unread-messages",
    "arguments": [
      {
        "name": "options",
        "optional": false,
        "type": "{ channelId: string; limit?: number; cursor?: string; }",
        "parameters": [
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.channels.listUnreadMessages({"channelId":"<channelId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#channelslistunreadmessages",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.channels.listUnreadMessages({"channelId":"<channelId>"});'
    }
  },
  "messages.get": {
    "method": "messages.get",
    "route": "GET /messages/:id",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ messageId: string; }",
        "parameters": [
          {
            "name": "messageId",
            "type": "string",
            "required": true,
            "description": "\u6D88\u606F ID\uFF1B\u4ECE\u8BFB\u53D6\u7ED3\u679C\u6216\u53D1\u9001\u56DE\u6267\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.messages.get({"messageId":"<messageId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#messagesget",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.messages.get({"messageId":"<messageId>"});',
      "app": 'await colink.app.messages.get({"messageId":"<messageId>"});'
    }
  },
  "messages.replace": {
    "method": "messages.replace",
    "route": "PUT /messages/:id",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ messageId: string; expectedRevision: number; text: string; fileIds?: string[]; }",
        "parameters": [
          {
            "name": "messageId",
            "type": "string",
            "required": true,
            "description": "\u6D88\u606F ID\uFF1B\u4ECE\u8BFB\u53D6\u7ED3\u679C\u6216\u53D1\u9001\u56DE\u6267\u53D6\u5F97\u3002"
          },
          {
            "name": "expectedRevision",
            "type": "number",
            "required": true,
            "description": "\u539F\u6D88\u606F\u7684\u6B63\u6587\u7248\u672C\uFF1B\u66F4\u65B0\u6210\u529F\u540E\u9012\u589E\uFF0C\u7248\u672C\u51B2\u7A81\u65F6\u5148\u8BFB\u53D6\u6700\u65B0\u6D88\u606F\u3002"
          },
          {
            "name": "text",
            "type": "string",
            "required": true,
            "description": "\u6D88\u606F\u6216\u8349\u7A3F\u6B63\u6587\u3002"
          },
          {
            "name": "fileIds",
            "type": "string[]",
            "required": false,
            "description": "\u968F\u6D88\u606F\u53D1\u9001\u7684\u5DF2\u4E0A\u4F20\u6587\u4EF6 ID \u5217\u8868\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.messages.replace({"messageId":"<messageId>","expectedRevision":1,"text":"\u5904\u7406\u5B8C\u6210"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#messagesreplace",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u4EC5\u66F4\u65B0\u672C\u5B89\u88C5\u81EA\u5DF1\u7684\u6D88\u606F\u3002expectedRevision \u5FC5\u987B\u6765\u81EA\u8BFB\u53D6\u6216\u70B9\u51FB\u4E8B\u4EF6\uFF1B\u51B2\u7A81\u65F6\u91CD\u65B0\u786E\u8BA4\u4E1A\u52A1\uFF0C\u4E0D\u81EA\u52A8\u8986\u76D6\u3002\u7701\u7565 fileIds \u4F1A\u79FB\u9664\u539F\u9644\u4EF6\u5F15\u7528\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.messages.replace({"messageId":"<messageId>","expectedRevision":1,"text":"\u5904\u7406\u5B8C\u6210"});'
    }
  },
  "messages.recall": {
    "method": "messages.recall",
    "route": "POST /messages/:id/recall",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ messageId: string; channelId?: string; idempotencyKey: string; }",
        "parameters": [
          {
            "name": "messageId",
            "type": "string",
            "required": true,
            "description": "\u6D88\u606F ID\uFF1B\u4ECE\u8BFB\u53D6\u7ED3\u679C\u6216\u53D1\u9001\u56DE\u6267\u53D6\u5F97\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": false,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.messages.recall({"messageId":"<messageId>","idempotencyKey":"<persistent-operation-id>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#messagesrecall",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.messages.recall({"messageId":"<messageId>","idempotencyKey":"<persistent-operation-id>"});'
    }
  },
  "messages.send": {
    "method": "messages.send",
    "route": "POST /messages",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ idempotencyKey: string; text: string; fileIds?: string[]; } & ({ channelId: string; topicId?: string; conversationId?: never; sourceMessageId?: never; sourceEventId?: string; mentions?: MessageMentions; } | { conversationId: string; sourceMessageId: string; channelId?: never; topicId?: string | null; sourceEventId?: never; mentions?: never; })",
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "text",
            "type": "string",
            "required": true,
            "description": "\u6D88\u606F\u6216\u8349\u7A3F\u6B63\u6587\u3002"
          },
          {
            "name": "fileIds",
            "type": "string[]",
            "required": false,
            "description": "\u968F\u6D88\u606F\u53D1\u9001\u7684\u5DF2\u4E0A\u4F20\u6587\u4EF6 ID \u5217\u8868\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": false,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "topicId",
            "type": "null | string",
            "required": false,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "sourceEventId",
            "type": "string",
            "required": false,
            "description": "\u672C\u5B89\u88C5\u6536\u5230\u7684\u6765\u6E90\u4E8B\u4EF6 ID\uFF0C\u7ED1\u5B9A\u9879\u76EE\u516C\u5171\u8BDD\u9898\u53CA Agent \u534F\u4F5C\u9884\u7B97\u3002"
          },
          {
            "name": "mentions",
            "type": "MessageMentions",
            "required": false,
            "description": "\u9010\u9879\u8EAB\u4EFD\u63D0\u53CA\uFF1Aversion:1\u3001items \u6700\u591A100\u9879\uFF1B\u6BCF\u9879\u4E3A\u539F\u59CB\u6B63\u6587 UTF-16 start/end\u3001\u516C\u5F00\u540D label\uFF0C\u4EE5\u53CA user/userId \u6216 app/installationId\u3002\u7A7A items \u8868\u793A\u4E0D\u89E3\u6790\u6587\u672C\u3002"
          },
          {
            "name": "conversationId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5524\u9192\u6240\u5C5E\u7684\u79C1\u804A ID\uFF1B\u5FC5\u987B\u6709\u7528\u6237\u6388\u6743\u548C\u672C\u5B89\u88C5\u5BF9\u5E94\u6295\u9012\uFF0C\u4E0D\u80FD\u9009\u62E9\u5176\u4ED6\u4F1A\u8BDD\u3002"
          },
          {
            "name": "sourceMessageId",
            "type": "string",
            "required": false,
            "description": "\u672C\u5B89\u88C5\u5DF2\u6536\u5230\u7684\u79C1\u804A\u5524\u9192\u6765\u6E90\u6D88\u606F ID\uFF1B\u56DE\u8BDD\u6388\u6743\u7531\u5E73\u53F0\u6309\u6301\u4E45\u6295\u9012\u590D\u6838\u3002"
          }
        ],
        "variants": [
          {
            "type": "{ idempotencyKey: string; text: string; fileIds?: string[]; } & { channelId: string; topicId?: string; conversationId?: never; sourceMessageId?: never; sourceEventId?: string; mentions?: MessageMentions; }",
            "parameters": [
              {
                "name": "idempotencyKey",
                "type": "string",
                "required": true,
                "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
              },
              {
                "name": "text",
                "type": "string",
                "required": true,
                "description": "\u6D88\u606F\u6216\u8349\u7A3F\u6B63\u6587\u3002"
              },
              {
                "name": "fileIds",
                "type": "string[]",
                "required": false,
                "description": "\u968F\u6D88\u606F\u53D1\u9001\u7684\u5DF2\u4E0A\u4F20\u6587\u4EF6 ID \u5217\u8868\u3002"
              },
              {
                "name": "channelId",
                "type": "string",
                "required": true,
                "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
              },
              {
                "name": "topicId",
                "type": "string",
                "required": false,
                "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
              },
              {
                "name": "sourceEventId",
                "type": "string",
                "required": false,
                "description": "\u672C\u5B89\u88C5\u6536\u5230\u7684\u6765\u6E90\u4E8B\u4EF6 ID\uFF0C\u7ED1\u5B9A\u9879\u76EE\u516C\u5171\u8BDD\u9898\u53CA Agent \u534F\u4F5C\u9884\u7B97\u3002"
              },
              {
                "name": "mentions",
                "type": "MessageMentions",
                "required": false,
                "description": "\u9010\u9879\u8EAB\u4EFD\u63D0\u53CA\uFF1Aversion:1\u3001items \u6700\u591A100\u9879\uFF1B\u6BCF\u9879\u4E3A\u539F\u59CB\u6B63\u6587 UTF-16 start/end\u3001\u516C\u5F00\u540D label\uFF0C\u4EE5\u53CA user/userId \u6216 app/installationId\u3002\u7A7A items \u8868\u793A\u4E0D\u89E3\u6790\u6587\u672C\u3002"
              }
            ],
            "forbidden": [
              "conversationId",
              "sourceMessageId"
            ],
            "open": false
          },
          {
            "type": "{ idempotencyKey: string; text: string; fileIds?: string[]; } & { conversationId: string; sourceMessageId: string; channelId?: never; topicId?: string | null; sourceEventId?: never; mentions?: never; }",
            "parameters": [
              {
                "name": "idempotencyKey",
                "type": "string",
                "required": true,
                "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
              },
              {
                "name": "text",
                "type": "string",
                "required": true,
                "description": "\u6D88\u606F\u6216\u8349\u7A3F\u6B63\u6587\u3002"
              },
              {
                "name": "fileIds",
                "type": "string[]",
                "required": false,
                "description": "\u968F\u6D88\u606F\u53D1\u9001\u7684\u5DF2\u4E0A\u4F20\u6587\u4EF6 ID \u5217\u8868\u3002"
              },
              {
                "name": "conversationId",
                "type": "string",
                "required": true,
                "description": "\u5F53\u524D\u5524\u9192\u6240\u5C5E\u7684\u79C1\u804A ID\uFF1B\u5FC5\u987B\u6709\u7528\u6237\u6388\u6743\u548C\u672C\u5B89\u88C5\u5BF9\u5E94\u6295\u9012\uFF0C\u4E0D\u80FD\u9009\u62E9\u5176\u4ED6\u4F1A\u8BDD\u3002"
              },
              {
                "name": "sourceMessageId",
                "type": "string",
                "required": true,
                "description": "\u672C\u5B89\u88C5\u5DF2\u6536\u5230\u7684\u79C1\u804A\u5524\u9192\u6765\u6E90\u6D88\u606F ID\uFF1B\u56DE\u8BDD\u6388\u6743\u7531\u5E73\u53F0\u6309\u6301\u4E45\u6295\u9012\u590D\u6838\u3002"
              },
              {
                "name": "topicId",
                "type": "null | string",
                "required": false,
                "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
              }
            ],
            "forbidden": [
              "channelId",
              "sourceEventId",
              "mentions"
            ],
            "open": false
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.messages.send({"idempotencyKey":"<persistent-operation-id>","channelId":"<channelId>","text":"\u5DF2\u5904\u7406"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#messagessend",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u6587\u672C\u6700\u591A64000\u7801\u5143\uFF0CSDK\u63094000\u7801\u5143\u81EA\u52A8\u5206\u7247\uFF1Bmessages\u8FD4\u56DE\u5168\u90E8\u56DE\u6267\uFF0C\u9876\u5C42\u5B57\u6BB5\u6307\u7B2C\u4E00\u6761\u3002\u9644\u4EF6\u53EA\u5728\u9996\u7247\uFF0C\u65B0\u5EFA\u9891\u9053\u8BDD\u9898\u540E\u7EED\u7247\u56DE\u540C\u4E00\u8BDD\u9898\u3002\u539F\u952E\u4E0E\u5B8C\u6574\u539F\u53C2\u6570\u91CD\u8BD5\uFF0C\u5206\u7247\u975E\u539F\u5B50\u63D0\u4EA4\u3002mentions \u9010\u9879\u7ED1\u5B9A\u516C\u5F00\u540D\u548C\u7A33\u5B9A\u76EE\u6807\uFF0C\u6309\u539F\u59CB\u6B63\u6587 UTF-16 \u8303\u56F4\u8BA1\u6570\uFF1B\u663E\u5F0F\u7A7A items \u4E0D\u89E3\u6790\u6587\u672C\uFF0C\u975E\u6CD5\u5143\u6570\u636E\u62D2\u7EDD\uFF1B\u540D\u518C\u987B\u58F0\u660E mentionProtocol:1\u3002\u9891\u9053\u4EC5 channelId \u521B\u5EFA\u65B0\u8BDD\u9898\uFF0CtopicId \u56DE\u590D\u5DF2\u6709\u8BDD\u9898\u3002\u79C1\u804A\u56DE\u8BDD\u65F6\u53EF\u9009\uFF1A\u4F20\u503C\u56DE\u672C\u4F1A\u8BDD\u8BE5\u8BDD\u9898\uFF0Cnull \u56DE\u4E3B\u65F6\u95F4\u7EBF\uFF0C\u7701\u7565\u56DE\u5524\u9192\u6765\u6E90\u3002App \u5361\u7247\u652F\u6301\u9891\u9053\u65B0\u8BDD\u9898\u548C\u8BDD\u9898\u56DE\u590D\uFF0C\u65B0\u8BDD\u9898\u56DE\u6267 topicId \u7B49\u4E8E messageId\uFF1BsendEvent \u53E6\u9700 app.colink_ui_action_invoked \u8BA2\u9605\u53CA messages:receive \u58F0\u660E/\u6279\u51C6\uFF0C\u6838\u5BF9 error.card \u7684\u5177\u4F53\u539F\u56E0\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.messages.send({"idempotencyKey":"<persistent-operation-id>","channelId":"<channelId>","text":"\u5DF2\u5904\u7406"});'
    }
  },
  "topics.list": {
    "method": "topics.list",
    "route": "GET /topics",
    "arguments": [
      {
        "name": "options",
        "optional": true,
        "type": "TopicListOptions | undefined",
        "parameters": [
          {
            "name": "projectId",
            "type": "string",
            "required": false,
            "description": "\u9879\u76EE ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 projects.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": false,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "topicIds",
            "type": "string[]",
            "required": false,
            "description": "\u6309\u8BDD\u9898 ID \u5217\u8868\u7B5B\u9009\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.topics.list({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#topicslist",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.topics.list({});"
    }
  },
  "topics.listMessages": {
    "method": "topics.listMessages",
    "route": "GET /topics/:id/messages",
    "arguments": [
      {
        "name": "options",
        "optional": false,
        "type": "{ topicId: string; limit?: number; cursor?: string; }",
        "parameters": [
          {
            "name": "topicId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.topics.listMessages({"topicId":"<topicId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#topicslistmessages",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.topics.listMessages({"topicId":"<topicId>"});',
      "app": 'await colink.app.topics.listMessages({"topicId":"<topicId>"});'
    }
  },
  "topics.listParticipants": {
    "method": "topics.listParticipants",
    "route": "GET /topics/:id/participants",
    "arguments": [
      {
        "name": "options",
        "optional": false,
        "type": "{ topicId: string; limit?: number; cursor?: string; }",
        "parameters": [
          {
            "name": "topicId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.topics.listParticipants({"topicId":"<topicId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#topicslistparticipants",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.topics.listParticipants({"topicId":"<topicId>"});',
      "app": 'await colink.app.topics.listParticipants({"topicId":"<topicId>"});'
    }
  },
  "topics.readImage": {
    "method": "topics.readImage",
    "route": "GET /topics/:id/images/:artifactId",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ topicId: string; artifactId: string; }",
        "parameters": [
          {
            "name": "topicId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "artifactId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898\u56FE\u7247\u9644\u4EF6\u6807\u8BC6\uFF1B\u4ECE\u6D88\u606F\u56FE\u7247\u5143\u6570\u636E\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.topics.readImage({"topicId":"<topicId>","artifactId":"<artifactId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#topicsreadimage",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.topics.readImage({"topicId":"<topicId>","artifactId":"<artifactId>"});'
    }
  },
  "directMessages.list": {
    "method": "directMessages.list",
    "route": "GET /app-direct-messages/:conversationId/messages",
    "arguments": [
      {
        "name": "options",
        "optional": false,
        "type": "{ conversationId: string; limit?: number; beforeId?: string; afterId?: string; }",
        "parameters": [
          {
            "name": "conversationId",
            "type": "string",
            "required": true,
            "description": "\u5F53\u524D\u5524\u9192\u6240\u5C5E\u7684\u79C1\u804A ID\uFF1B\u5FC5\u987B\u6709\u7528\u6237\u6388\u6743\u548C\u672C\u5B89\u88C5\u5BF9\u5E94\u6295\u9012\uFF0C\u4E0D\u80FD\u9009\u62E9\u5176\u4ED6\u4F1A\u8BDD\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "beforeId",
            "type": "string",
            "required": false,
            "description": "\u8BFB\u53D6\u8BE5\u79C1\u804A\u6D88\u606F\u4E4B\u524D\u7684\u6D88\u606F\uFF0C\u5FC5\u987B\u4E0E\u5F53\u524D\u4F1A\u8BDD\u5339\u914D\u3002"
          },
          {
            "name": "afterId",
            "type": "string",
            "required": false,
            "description": "\u8BFB\u53D6\u8BE5\u79C1\u804A\u6D88\u606F\u4E4B\u540E\u7684\u6D88\u606F\uFF0C\u5FC5\u987B\u4E0E\u5F53\u524D\u4F1A\u8BDD\u5339\u914D\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.directMessages.list({"conversationId":"<conversationId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#directmessageslist",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.directMessages.list({"conversationId":"<conversationId>"});'
    }
  },
  "directMessages.downloadAttachment": {
    "method": "directMessages.downloadAttachment",
    "route": "GET /app-direct-messages/:conversationId/attachments/:artifactId/download",
    "arguments": [
      {
        "name": "options",
        "optional": false,
        "type": "{ conversationId: string; artifactId: string; }",
        "parameters": [
          {
            "name": "conversationId",
            "type": "string",
            "required": true,
            "description": "\u5F53\u524D\u5524\u9192\u6240\u5C5E\u7684\u79C1\u804A ID\uFF1B\u5FC5\u987B\u6709\u7528\u6237\u6388\u6743\u548C\u672C\u5B89\u88C5\u5BF9\u5E94\u6295\u9012\uFF0C\u4E0D\u80FD\u9009\u62E9\u5176\u4ED6\u4F1A\u8BDD\u3002"
          },
          {
            "name": "artifactId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898\u56FE\u7247\u9644\u4EF6\u6807\u8BC6\uFF1B\u4ECE\u6D88\u606F\u56FE\u7247\u5143\u6570\u636E\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.directMessages.downloadAttachment({"conversationId":"<conversationId>","artifactId":"<artifactId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#directmessagesdownloadattachment",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.directMessages.downloadAttachment({"conversationId":"<conversationId>","artifactId":"<artifactId>"});'
    }
  },
  "drafts.create": {
    "method": "drafts.create",
    "route": "POST /message-drafts",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ idempotencyKey: string; topicId: string; text: string; }",
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "topicId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "text",
            "type": "string",
            "required": true,
            "description": "\u6D88\u606F\u6216\u8349\u7A3F\u6B63\u6587\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.drafts.create({"idempotencyKey":"<persistent-operation-id>","topicId":"<topicId>","text":"<text>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#draftscreate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.drafts.create({"idempotencyKey":"<persistent-operation-id>","topicId":"<topicId>","text":"<text>"});'
    }
  },
  "events.reportStatus": {
    "method": "events.reportStatus",
    "route": "POST /agent-sessions/status",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": '{ idempotencyKey: string; eventId?: string; channelId: string; topicId: string; sequence: number; status: "processing" | "suspended" | "finished"; }',
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "eventId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5E73\u53F0\u6295\u9012\u7684\u4E8B\u4EF6 ID\uFF1B\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u53EF\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u4E0D\u6784\u9020\u4E8B\u4EF6\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "topicId",
            "type": "string",
            "required": true,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "sequence",
            "type": "number",
            "required": true,
            "description": "\u5F53\u524D\u6267\u884C\u7684\u9012\u589E\u5E8F\u53F7\uFF0C\u6574\u6570 1\u20132147483647\uFF1B\u540C\u4E00\u6B21\u91CD\u8BD5\u6CBF\u7528\u539F\u503C\u3002"
          },
          {
            "name": "status",
            "type": '"finished" | "processing" | "suspended"',
            "required": true,
            "description": "\u672C\u5165\u53E3\u5B9A\u4E49\u7684\u72B6\u6001\uFF0C\u4E0D\u80FD\u6DF7\u7528\u5176\u4ED6\u63A5\u53E3\u7684\u72B6\u6001\u679A\u4E3E\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.events.reportStatus({"idempotencyKey":"<persistent-operation-id>","eventId":"<eventId>","channelId":"<channelId>","topicId":"<topicId>","sequence":1,"status":"processing"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-events.md#eventsreportstatus",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u4EC5\u624B\u52A8\u72B6\u6001\u6D41\u7A0B\u4F7F\u7528\uFF1B\u81EA\u52A8\u72B6\u6001\u7BA1\u7406\u5F00\u542F\u65F6\u8C03\u7528 turn.setDisplayStatus\u3002eventId \u5728\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u4E2D\u81EA\u52A8\u7ED1\u5B9A\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.events.reportStatus({"idempotencyKey":"<persistent-operation-id>","eventId":"<eventId>","channelId":"<channelId>","topicId":"<topicId>","sequence":1,"status":"processing"});'
    }
  },
  "events.reportUndelivered": {
    "method": "events.reportUndelivered",
    "route": "POST /extensions/agent-apps/receipts",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": '{ eventId?: string; reason: "agent_backend_unavailable" | "channel_denied" | "app_failed"; requestId: string; threadId: string; channelId: string; errorCode?: string; errorMessage?: string; }',
        "parameters": [
          {
            "name": "eventId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5E73\u53F0\u6295\u9012\u7684\u4E8B\u4EF6 ID\uFF1B\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u53EF\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u4E0D\u6784\u9020\u4E8B\u4EF6\u3002"
          },
          {
            "name": "reason",
            "type": '"agent_backend_unavailable" | "app_failed" | "channel_denied"',
            "required": true,
            "description": "\u72B6\u6001\u6216\u5206\u6D3E\u8C03\u6574\u539F\u56E0\u3002"
          },
          {
            "name": "requestId",
            "type": "string",
            "required": true,
            "description": "\u6301\u4E45\u4FDD\u5B58\u7684\u672A\u9001\u8FBE\u62A5\u544A\u53BB\u91CD\u6807\u8BC6\uFF0C\u6700\u957F64\uFF1B\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\u3002"
          },
          {
            "name": "threadId",
            "type": "string",
            "required": true,
            "description": "\u539F\u4E8B\u4EF6\u7ED1\u5B9A\u7684\u8BDD\u9898 ID\uFF0C\u6700\u957F36\uFF1B\u4E0D\u662F\u4EFB\u52A1 ID\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "errorCode",
            "type": "string",
            "required": false,
            "description": "\u4F9B\u6392\u67E5\u7684\u5B89\u5168\u9519\u8BEF\u7801\uFF0C\u6700\u957F64\uFF0C\u4E0D\u542B\u51ED\u636E\u3002"
          },
          {
            "name": "errorMessage",
            "type": "string",
            "required": false,
            "description": "\u4F9B\u6392\u67E5\u7684\u5B89\u5168\u63CF\u8FF0\uFF0C\u6700\u957F512\uFF0C\u4E0D\u542B\u5806\u6808\u6216\u51ED\u636E\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.events.reportUndelivered({"reason":"app_failed","eventId":"<eventId>","requestId":"<persistent-request-id>","channelId":"<channelId>","threadId":"<topicId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-events.md#eventsreportundelivered",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u53EA\u4E0A\u62A5\u539F\u4E8B\u4EF6\u672A\u9001\u8FBE\uFF1BrequestId \u4E3A\u4E1A\u52A1\u6301\u4E45\u53BB\u91CD\u6807\u8BC6\uFF0C\u4E0D\u6362\u6807\u8BC6\u91CD\u8BD5\u3002threadId/channelId \u5FC5\u987B\u5339\u914D\u539F\u4E8B\u4EF6\uFF0C\u4E0D\u542B\u51ED\u636E\u6216\u5B8C\u6574\u65E5\u5FD7\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.events.reportUndelivered({"reason":"app_failed","eventId":"<eventId>","requestId":"<persistent-request-id>","channelId":"<channelId>","threadId":"<topicId>"});'
    }
  },
  "actions.complete": {
    "method": "actions.complete",
    "route": "POST /extensions/ui-requests",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": '{ idempotencyKey: string; eventId?: string; status: "succeeded" | "failed"; message?: string; replacement?: { messageId: string; revision: number; }; }',
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "eventId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5E73\u53F0\u6295\u9012\u7684\u4E8B\u4EF6 ID\uFF1B\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u53EF\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u4E0D\u6784\u9020\u4E8B\u4EF6\u3002"
          },
          {
            "name": "status",
            "type": '"failed" | "succeeded"',
            "required": true,
            "description": "\u672C\u5165\u53E3\u5B9A\u4E49\u7684\u72B6\u6001\uFF0C\u4E0D\u80FD\u6DF7\u7528\u5176\u4ED6\u63A5\u53E3\u7684\u72B6\u6001\u679A\u4E3E\u3002"
          },
          {
            "name": "message",
            "type": "string",
            "required": false,
            "description": "\u79C1\u4EBA\u4EA4\u4E92\u63D0\u793A\uFF1Btoast \u4E3A 1\u2013200 UTF-16 \u7801\u5143\u7684\u7EAF\u6587\u672C\u3002"
          },
          {
            "name": "replacement",
            "type": "{ messageId: string; revision: number; }",
            "required": false,
            "description": "\u5DF2\u63D0\u4EA4\u7684\u6765\u6E90\u6D88\u606F\u66F4\u65B0\u56DE\u6267\uFF0C\u5305\u542B messageId \u548C revision\uFF1B\u4EC5\u6210\u529F\u7ED3\u679C\u53EF\u9644\u5E26\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.actions.complete({"idempotencyKey":"<persistent-operation-id>","status":"succeeded","message":"\u5DF2\u5B8C\u6210"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-events.md#actionscomplete",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u4E1A\u52A1\u6301\u4E45\u63D0\u4EA4\u540E\u4E0A\u62A5\u539F\u4E8B\u4EF6\u7ED3\u679C\uFF1BACK \u4E0D\u4EE3\u8868\u5B8C\u6210\u3002replacement \u5FC5\u987B\u5F15\u7528\u5DF2\u63D0\u4EA4\u7684\u6765\u6E90\u6D88\u606F\u7248\u672C\uFF1B\u7EC8\u6001\u4E0D\u53EF\u6539\u5199\uFF0C\u91CD\u8BD5\u4FDD\u7559\u539F idempotencyKey \u548C\u6B63\u6587\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.actions.complete({"idempotencyKey":"<persistent-operation-id>","status":"succeeded","message":"\u5DF2\u5B8C\u6210"});'
    }
  },
  "interactions.openDialog": {
    "method": "interactions.openDialog",
    "route": "POST /extensions/ui-requests",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ idempotencyKey: string; eventId?: string; viewId: string; title?: string; message?: string; }",
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "eventId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5E73\u53F0\u6295\u9012\u7684\u4E8B\u4EF6 ID\uFF1B\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u53EF\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u4E0D\u6784\u9020\u4E8B\u4EF6\u3002"
          },
          {
            "name": "viewId",
            "type": "string",
            "required": true,
            "description": "\u672C App Manifest \u58F0\u660E\u7684 renderer=app View ID\u3002"
          },
          {
            "name": "title",
            "type": "string",
            "required": false,
            "description": "\u5C55\u793A\u6807\u9898\u3002"
          },
          {
            "name": "message",
            "type": "string",
            "required": false,
            "description": "\u79C1\u4EBA\u4EA4\u4E92\u63D0\u793A\uFF1Btoast \u4E3A 1\u2013200 UTF-16 \u7801\u5143\u7684\u7EAF\u6587\u672C\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.interactions.openDialog({"idempotencyKey":"<persistent-operation-id>","viewId":"<viewId>","message":"\u8BF7\u786E\u8BA4"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-browser.md#interactionsopendialog",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002dialog \u9700\u8981 viewId\uFF1Btoast \u9700\u8981 message\uFF0C\u4E0D\u63A5\u53D7 viewId/title\u3002eventId \u5728\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u4E2D\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u5176\u4ED6\u4E0A\u4E0B\u6587\u663E\u5F0F\u63D0\u4F9B\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.interactions.openDialog({"idempotencyKey":"<persistent-operation-id>","viewId":"<viewId>","message":"\u8BF7\u786E\u8BA4"});'
    }
  },
  "interactions.get": {
    "method": "interactions.get",
    "route": "GET /extensions/ui-requests/:id",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ interactionId: string; eventId?: string; }",
        "parameters": [
          {
            "name": "interactionId",
            "type": "string",
            "required": true,
            "description": "\u5E73\u53F0\u4EA4\u4E92\u56DE\u6267\u4E2D\u7684 ID\uFF0C\u4ECD\u987B\u5F53\u524D\u9875\u9762/\u4E8B\u4EF6\u6765\u6E90\u6388\u6743\u3002"
          },
          {
            "name": "eventId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5E73\u53F0\u6295\u9012\u7684\u4E8B\u4EF6 ID\uFF1B\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u53EF\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u4E0D\u6784\u9020\u4E8B\u4EF6\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.interactions.get({"interactionId":"<interactionId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-browser.md#interactionsget--interactionscomplete",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.interactions.get({"interactionId":"<interactionId>"});'
    }
  },
  "interactions.complete": {
    "method": "interactions.complete",
    "route": "POST /extensions/ui-requests/:id/complete",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ interactionId: string; }",
        "parameters": [
          {
            "name": "interactionId",
            "type": "string",
            "required": true,
            "description": "\u5E73\u53F0\u4EA4\u4E92\u56DE\u6267\u4E2D\u7684 ID\uFF0C\u4ECD\u987B\u5F53\u524D\u9875\u9762/\u4E8B\u4EF6\u6765\u6E90\u6388\u6743\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.interactions.complete({"interactionId":"<interactionId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-browser.md#interactionsget--interactionscomplete",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.interactions.complete({"interactionId":"<interactionId>"});'
    }
  },
  "interactions.showToast": {
    "method": "interactions.showToast",
    "route": "POST /extensions/ui-requests",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": '{ idempotencyKey: string; eventId?: string; message: string; severity?: "success" | "error" | "info"; durationMs?: number; }',
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "eventId",
            "type": "string",
            "required": false,
            "description": "\u5F53\u524D\u5E73\u53F0\u6295\u9012\u7684\u4E8B\u4EF6 ID\uFF1B\u4E8B\u4EF6\u5BA2\u6237\u7AEF\u53EF\u81EA\u52A8\u7ED1\u5B9A\uFF0C\u4E0D\u6784\u9020\u4E8B\u4EF6\u3002"
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\u79C1\u4EBA\u4EA4\u4E92\u63D0\u793A\uFF1Btoast \u4E3A 1\u2013200 UTF-16 \u7801\u5143\u7684\u7EAF\u6587\u672C\u3002"
          },
          {
            "name": "severity",
            "type": '"error" | "info" | "success"',
            "required": false,
            "description": "\u63D0\u793A\u7EA7\u522B\uFF0C\u9ED8\u8BA4 success\u3002"
          },
          {
            "name": "durationMs",
            "type": "number",
            "required": false,
            "description": "\u63D0\u793A\u5C55\u793A\u6BEB\u79D2\u6570\uFF0C\u6574\u6570 1000\u201310000\uFF0C\u9ED8\u8BA4 3000\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.interactions.showToast({"idempotencyKey":"<persistent-operation-id>","message":"\u64CD\u4F5C\u5DF2\u4FDD\u5B58"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-browser.md#interactionsshowtoast",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.interactions.showToast({"idempotencyKey":"<persistent-operation-id>","message":"\u64CD\u4F5C\u5DF2\u4FDD\u5B58"});'
    }
  },
  "files.list": {
    "method": "files.list",
    "route": "GET /app-files",
    "arguments": [
      {
        "name": "query",
        "optional": false,
        "type": "CursorQuery & { channelId: string; query?: string; }",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.files.list({"channelId":"<channelId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#fileslist--filesiterate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u663E\u5F0F\u6307\u5B9A channelId \u540E\u67E5\u8BE2\u8BE5\u9891\u9053\u7684\u5DF2\u53D1\u5E03\u6587\u4EF6\uFF1B\u4ECE\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u9009\u62E9\u9891\u9053\u3002\u9879\u76EE\u4E3B\u9875\u4E0D\u5305\u542B\u9ED8\u8BA4\u9891\u9053\uFF1B\u8DE8\u9891\u9053\u67E5\u8BE2\u987B\u5206\u522B\u5904\u7406\u6388\u6743\u4E0E\u5206\u9875\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.files.list({"channelId":"<channelId>"});'
    }
  },
  "files.iterate": {
    "method": "files.iterate",
    "route": "GET /app-files",
    "arguments": [
      {
        "name": "query",
        "optional": false,
        "type": "CursorQuery & { channelId: string; query?: string; }",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          }
        ],
        "open": false
      },
      {
        "name": "options",
        "optional": true,
        "type": "IterationOptions | undefined",
        "parameters": [
          {
            "name": "maxPages",
            "type": "number",
            "required": false,
            "description": "\u6700\u591A\u904D\u5386\u9875\u6570\uFF0C\u6B63\u6574\u6570\uFF0C\u9ED8\u8BA4 100\uFF1B\u8FBE\u5230\u4E0A\u9650\u4ECD\u6709\u6570\u636E\u5219\u5931\u8D25\u3002"
          },
          {
            "name": "signal",
            "type": "AbortSignal",
            "required": false,
            "description": "\u8C03\u7528\u65B9\u7684 AbortSignal\uFF0C\u7528\u4E8E\u53D6\u6D88\u904D\u5386\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'for await (const item of colink.user.files.iterate({"channelId":"<channelId>"})) { /* \u5904\u7406 item */ }',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#fileslist--filesiterate",
    "note": "\u8FED\u4EE3\u65F6 next() \u62D2\u7EDD\uFF1B\u521B\u5EFA\u8FED\u4EE3\u5668\u4E0D\u5F00\u59CB\u8BF7\u6C42\uFF1B\u5DF2\u7ECF\u4EA7\u51FA\u7684\u6761\u76EE\u4ECD\u6709\u6548\uFF0C\u5931\u8D25\u4E0D\u662F\u6B63\u5E38\u672B\u9875\u3002\u53EF\u7528 for await \u6355\u83B7\uFF1B\u63D0\u524D return() \u7ED3\u675F\u6D88\u8D39\u3002\u670D\u52A1\u7AEF\u7ED1\u5B9A\u5305\u88C5\u4F1A\u91CA\u653E\u6267\u884C\u5E76\u541E\u6389\u5185\u90E8\u8FED\u4EE3\u5668\u5F02\u6B65\u6E05\u7406\u5931\u8D25\uFF0C\u4E0D\u636E\u6B64\u63A8\u65AD\u6240\u6709\u6761\u76EE\u5DF2\u8BFB\u53D6\u3002\u663E\u5F0F\u6307\u5B9A channelId \u540E\u67E5\u8BE2\u8BE5\u9891\u9053\u7684\u5DF2\u53D1\u5E03\u6587\u4EF6\uFF1B\u4ECE\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u9009\u62E9\u9891\u9053\u3002\u9879\u76EE\u4E3B\u9875\u4E0D\u5305\u542B\u9ED8\u8BA4\u9891\u9053\uFF1B\u8DE8\u9891\u9053\u67E5\u8BE2\u987B\u5206\u522B\u5904\u7406\u6388\u6743\u4E0E\u5206\u9875\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'for await (const item of colink.user.files.iterate({"channelId":"<channelId>"})) { /* \u5904\u7406 item */ }'
    }
  },
  "files.readContent": {
    "method": "files.readContent",
    "route": "GET /app-files/:id",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ fileId: string; offset?: number; limit?: number; }",
        "parameters": [
          {
            "name": "fileId",
            "type": "string",
            "required": true,
            "description": "\u5E73\u53F0\u6587\u4EF6 ID\uFF1B\u4ECE\u6587\u4EF6\u76EE\u5F55\u6216\u4E0A\u4F20\u51C6\u5907\u56DE\u6267\u53D6\u5F97\u3002"
          },
          {
            "name": "offset",
            "type": "number",
            "required": false,
            "description": "\u6587\u672C\u8BFB\u53D6\u8D77\u70B9\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.files.readContent({"fileId":"<fileId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#filesreadcontent",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.files.readContent({"fileId":"<fileId>"});'
    }
  },
  "files.createText": {
    "method": "files.createText",
    "route": "POST /app-files",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "FileCreateTextInput",
        "parameters": [
          {
            "name": "content",
            "type": "string",
            "required": true,
            "description": "\u6587\u672C\u6587\u4EF6\u6B63\u6587\u3002"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "fileName",
            "type": "string",
            "required": true,
            "description": "\u5E26\u6269\u5C55\u540D\u7684\u6587\u4EF6\u540D\u3002"
          },
          {
            "name": "title",
            "type": "string",
            "required": false,
            "description": "\u5C55\u793A\u6807\u9898\u3002"
          },
          {
            "name": "asArtifact",
            "type": "boolean",
            "required": false,
            "description": "\u662F\u5426\u4F5C\u4E3A\u7ED3\u679C\u9644\u4EF6\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.files.createText({"idempotencyKey":"<persistent-operation-id>","channelId":"<channelId>","fileName":"note.txt","content":"\u793A\u4F8B"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#filescreatetext",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002mode=text \u5FC5\u987B\u63D0\u4F9B content\uFF1Bmode=upload \u5FC5\u987B\u63D0\u4F9B sizeBytes \u548C sha256\uFF0C\u518D\u6309\u56DE\u6267\u4E0A\u4F20\u5B8C\u6574\u5B57\u8282\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.files.createText({"idempotencyKey":"<persistent-operation-id>","channelId":"<channelId>","fileName":"note.txt","content":"\u793A\u4F8B"});'
    }
  },
  "files.download": {
    "method": "files.download",
    "route": "GET /app-files/:fileId/content",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ fileId: string; }",
        "parameters": [
          {
            "name": "fileId",
            "type": "string",
            "required": true,
            "description": "\u5E73\u53F0\u6587\u4EF6 ID\uFF1B\u4ECE\u6587\u4EF6\u76EE\u5F55\u6216\u4E0A\u4F20\u51C6\u5907\u56DE\u6267\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.files.download({"fileId":"<fileId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#filesdownload",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.files.download({"fileId":"<fileId>"});'
    }
  },
  "files.upload": {
    "method": "files.upload",
    "route": "PUT /app-files/:fileId/content",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "FileUploadInput",
        "parameters": [
          {
            "name": "bytes",
            "type": "Uint8Array<ArrayBufferLike>",
            "required": true,
            "description": "\u6587\u4EF6\u4E8C\u8FDB\u5236\u5B57\u8282\uFF0C\u4E0D\u662F Base64 \u5B57\u7B26\u4E32\u3002"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "fileName",
            "type": "string",
            "required": true,
            "description": "\u5E26\u6269\u5C55\u540D\u7684\u6587\u4EF6\u540D\u3002"
          },
          {
            "name": "title",
            "type": "string",
            "required": false,
            "description": "\u5C55\u793A\u6807\u9898\u3002"
          },
          {
            "name": "asArtifact",
            "type": "boolean",
            "required": false,
            "description": "\u662F\u5426\u4F5C\u4E3A\u7ED3\u679C\u9644\u4EF6\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.files.upload({"bytes":new Uint8Array([1, 2, 3]),"idempotencyKey":"<persistent-operation-id>","channelId":"<channelId>","fileName":"<fileName>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#filesupload",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.files.upload({"bytes":new Uint8Array([1, 2, 3]),"idempotencyKey":"<persistent-operation-id>","channelId":"<channelId>","fileName":"<fileName>"});'
    }
  },
  "tasks.list": {
    "method": "tasks.list",
    "route": "GET /tasks",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "TaskListQuery | undefined",
        "parameters": [
          {
            "name": "topicId",
            "type": "string",
            "required": false,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": false,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "executionStatus",
            "type": "TaskExecutionStatus[]",
            "required": false,
            "description": "\u4EFB\u52A1\u6267\u884C\u72B6\u6001\u7B5B\u9009\uFF1B\u4E0D\u540C\u4E8E\u9A8C\u6536\u72B6\u6001\u3002"
          },
          {
            "name": "relatedTo",
            "type": '"me"',
            "required": false,
            "description": "\u53EA\u7B5B\u9009\u4E0E\u5F53\u524D\u7528\u6237\u76F8\u5173\u7684\u4EFB\u52A1\u3002"
          },
          {
            "name": "assignee",
            "type": '"self"',
            "required": false,
            "description": "\u8D1F\u8D23\u4EBA\u9009\u62E9\uFF1Bself \u8868\u793A\u5F53\u524D\u5DF2\u6388\u6743\u7528\u6237\u3002"
          },
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.tasks.list({"channelId":"<channelId>","limit":20});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#taskslist--tasksiterate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u6CA1\u6709\u7ED1\u5B9A\u6765\u6E90\u8303\u56F4\u65F6\u987B\u63D0\u4F9B channelId \u6216 topicId\uFF1B\u4E0D\u652F\u6301 projectId\u3002\u9879\u76EE\u7EDF\u8BA1\u5148 channels.list({projectId})\uFF0C\u518D\u9010\u9891\u9053\u8BFB\u53D6\u3002limit \u9ED8\u8BA4 20\uFF0C\u8303\u56F4 1\u2013100\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.tasks.list({"channelId":"<channelId>","limit":20});'
    }
  },
  "tasks.iterate": {
    "method": "tasks.iterate",
    "route": "GET /tasks",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "TaskListQuery | undefined",
        "parameters": [
          {
            "name": "topicId",
            "type": "string",
            "required": false,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": false,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "executionStatus",
            "type": "TaskExecutionStatus[]",
            "required": false,
            "description": "\u4EFB\u52A1\u6267\u884C\u72B6\u6001\u7B5B\u9009\uFF1B\u4E0D\u540C\u4E8E\u9A8C\u6536\u72B6\u6001\u3002"
          },
          {
            "name": "relatedTo",
            "type": '"me"',
            "required": false,
            "description": "\u53EA\u7B5B\u9009\u4E0E\u5F53\u524D\u7528\u6237\u76F8\u5173\u7684\u4EFB\u52A1\u3002"
          },
          {
            "name": "assignee",
            "type": '"self"',
            "required": false,
            "description": "\u8D1F\u8D23\u4EBA\u9009\u62E9\uFF1Bself \u8868\u793A\u5F53\u524D\u5DF2\u6388\u6743\u7528\u6237\u3002"
          },
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      },
      {
        "name": "options",
        "optional": true,
        "type": "IterationOptions | undefined",
        "parameters": [
          {
            "name": "maxPages",
            "type": "number",
            "required": false,
            "description": "\u6700\u591A\u904D\u5386\u9875\u6570\uFF0C\u6B63\u6574\u6570\uFF0C\u9ED8\u8BA4 100\uFF1B\u8FBE\u5230\u4E0A\u9650\u4ECD\u6709\u6570\u636E\u5219\u5931\u8D25\u3002"
          },
          {
            "name": "signal",
            "type": "AbortSignal",
            "required": false,
            "description": "\u8C03\u7528\u65B9\u7684 AbortSignal\uFF0C\u7528\u4E8E\u53D6\u6D88\u904D\u5386\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'for await (const item of colink.user.tasks.iterate({"channelId":"<channelId>","limit":20})) { /* \u5904\u7406 item */ }',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#taskslist--tasksiterate",
    "note": "\u8FED\u4EE3\u65F6 next() \u62D2\u7EDD\uFF1B\u521B\u5EFA\u8FED\u4EE3\u5668\u4E0D\u5F00\u59CB\u8BF7\u6C42\uFF1B\u5DF2\u7ECF\u4EA7\u51FA\u7684\u6761\u76EE\u4ECD\u6709\u6548\uFF0C\u5931\u8D25\u4E0D\u662F\u6B63\u5E38\u672B\u9875\u3002\u53EF\u7528 for await \u6355\u83B7\uFF1B\u63D0\u524D return() \u7ED3\u675F\u6D88\u8D39\u3002\u670D\u52A1\u7AEF\u7ED1\u5B9A\u5305\u88C5\u4F1A\u91CA\u653E\u6267\u884C\u5E76\u541E\u6389\u5185\u90E8\u8FED\u4EE3\u5668\u5F02\u6B65\u6E05\u7406\u5931\u8D25\uFF0C\u4E0D\u636E\u6B64\u63A8\u65AD\u6240\u6709\u6761\u76EE\u5DF2\u8BFB\u53D6\u3002\u6CA1\u6709\u7ED1\u5B9A\u6765\u6E90\u8303\u56F4\u65F6\u987B\u63D0\u4F9B channelId \u6216 topicId\uFF1B\u4E0D\u652F\u6301 projectId\u3002\u9879\u76EE\u7EDF\u8BA1\u5148 channels.list({projectId})\uFF0C\u518D\u9010\u9891\u9053\u8BFB\u53D6\u3002limit \u9ED8\u8BA4 20\uFF0C\u8303\u56F4 1\u2013100\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'for await (const item of colink.user.tasks.iterate({"channelId":"<channelId>","limit":20})) { /* \u5904\u7406 item */ }'
    }
  },
  "tasks.get": {
    "method": "tasks.get",
    "route": "GET /tasks/:id",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ taskId: string; }",
        "parameters": [
          {
            "name": "taskId",
            "type": "string",
            "required": true,
            "description": "\u4EFB\u52A1 ID\uFF1B\u4ECE tasks.list \u6216\u521B\u5EFA\u56DE\u6267\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.tasks.get({"taskId":"<taskId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#tasksget",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.tasks.get({"taskId":"<taskId>"});'
    }
  },
  "tasks.listPersonal": {
    "method": "tasks.listPersonal",
    "route": "GET /personal-tasks",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "PersonalTaskQuery | undefined",
        "parameters": [
          {
            "name": "status",
            "type": '"cancelled" | "complete" | "failed" | "running" | "todo"',
            "required": false,
            "description": "\u672C\u5165\u53E3\u5B9A\u4E49\u7684\u72B6\u6001\uFF0C\u4E0D\u80FD\u6DF7\u7528\u5176\u4ED6\u63A5\u53E3\u7684\u72B6\u6001\u679A\u4E3E\u3002"
          },
          {
            "name": "view",
            "type": '"actionable" | "assigned" | "created" | "requested" | "review"',
            "required": false,
            "description": "\u8BFB\u53D6\u89C6\u56FE\u3002"
          },
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "page",
            "type": "number",
            "required": false,
            "description": "\u9875\u7801\uFF0C\u9996\u8BF7\u6C42\u53EF\u7701\u7565\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.tasks.listPersonal({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#taskslistpersonal",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.tasks.listPersonal({});"
    }
  },
  "tasks.create": {
    "method": "tasks.create",
    "route": "POST /tasks",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "TaskCreateInput",
        "parameters": [
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "title",
            "type": "string",
            "required": true,
            "description": "\u5C55\u793A\u6807\u9898\u3002"
          },
          {
            "name": "goal",
            "type": "string",
            "required": true,
            "description": "\u4EFB\u52A1\u76EE\u6807\u53CA\u9A8C\u6536\u8981\u6C42\u3002"
          },
          {
            "name": "taskKey",
            "type": "string",
            "required": false,
            "description": "\u8C03\u7528\u65B9\u7684\u4EFB\u52A1\u4E1A\u52A1\u6807\u8BC6\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": false,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          },
          {
            "name": "topicId",
            "type": "string",
            "required": false,
            "description": "\u8BDD\u9898 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 topics.list \u7ED3\u679C\u53D6\u5F97\uFF0C\u4E0D\u662F\u9891\u9053 ID\u3002"
          },
          {
            "name": "assignee",
            "type": '"self" | { type: "user" | "agent" | "app"; id: string; }',
            "required": false,
            "description": "\u8D1F\u8D23\u4EBA\u9009\u62E9\uFF1Bself \u8868\u793A\u5F53\u524D\u5DF2\u6388\u6743\u7528\u6237\u3002"
          },
          {
            "name": "dueAt",
            "type": "null | string",
            "required": false,
            "description": "\u622A\u6B62\u65F6\u95F4\uFF0C\u4F7F\u7528\u63A5\u53E3\u89C4\u5B9A\u7684\u65F6\u95F4\u683C\u5F0F\u3002"
          },
          {
            "name": "attachments",
            "type": "string[]",
            "required": false,
            "description": "\u5DF2\u4E0A\u4F20\u7684\u5E73\u53F0\u6587\u4EF6 ID \u5217\u8868\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.tasks.create({"idempotencyKey":"<persistent-operation-id>","title":"\u793A\u4F8B\u4EFB\u52A1","goal":"\u5B8C\u6210\u9A8C\u6536","channelId":"<channelId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#taskscreate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u6CA1\u6709\u7ED1\u5B9A\u6765\u6E90\u8303\u56F4\u65F6\u987B\u63D0\u4F9B channelId \u6216 topicId\uFF1Btitle/goal \u4E3A\u5FC5\u586B\u975E\u7A7A\u6587\u672C\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.tasks.create({"idempotencyKey":"<persistent-operation-id>","title":"\u793A\u4F8B\u4EFB\u52A1","goal":"\u5B8C\u6210\u9A8C\u6536","channelId":"<channelId>"});'
    }
  },
  "tasks.update": {
    "method": "tasks.update",
    "route": "POST /tasks/:id",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": '{ taskId: string; idempotencyKey: string; expectedVersion: number; } & ({ action?: never; title?: string; goal?: string; dueAt?: string | null; attachments?: string[]; assignee?: never; reason?: never; } | { action: "reassign"; reason: string; assignee: TaskAssigneeInput; title?: never; goal?: never; dueAt?: never; attachments?: never; } | { action: "cancel" | "restart"; reason: string; assignee?: never; title?: never; goal?: never; dueAt?: never; attachments?: never; })',
        "parameters": [
          {
            "name": "taskId",
            "type": "string",
            "required": true,
            "description": "\u4EFB\u52A1 ID\uFF1B\u4ECE tasks.list \u6216\u521B\u5EFA\u56DE\u6267\u53D6\u5F97\u3002"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "expectedVersion",
            "type": "number",
            "required": true,
            "description": "\u6700\u8FD1\u8BFB\u53D6\u56DE\u6267\u4E2D\u7684\u7248\u672C\uFF0C\u7528\u4E8E\u5E76\u53D1\u63A7\u5236\uFF1B\u51B2\u7A81\u540E\u5148\u91CD\u65B0\u8BFB\u53D6\u3002"
          },
          {
            "name": "title",
            "type": "string",
            "required": false,
            "description": "\u5C55\u793A\u6807\u9898\u3002"
          },
          {
            "name": "goal",
            "type": "string",
            "required": false,
            "description": "\u4EFB\u52A1\u76EE\u6807\u53CA\u9A8C\u6536\u8981\u6C42\u3002"
          },
          {
            "name": "dueAt",
            "type": "null | string",
            "required": false,
            "description": "\u622A\u6B62\u65F6\u95F4\uFF0C\u4F7F\u7528\u63A5\u53E3\u89C4\u5B9A\u7684\u65F6\u95F4\u683C\u5F0F\u3002"
          },
          {
            "name": "attachments",
            "type": "string[]",
            "required": false,
            "description": "\u5DF2\u4E0A\u4F20\u7684\u5E73\u53F0\u6587\u4EF6 ID \u5217\u8868\u3002"
          },
          {
            "name": "action",
            "type": '"cancel" | "reassign" | "restart"',
            "required": false,
            "description": "\u4EFB\u52A1\u72B6\u6001\u6216\u5206\u6D3E\u64CD\u4F5C\uFF1B\u6309\u7C7B\u578B\u4E2D\u7684\u8054\u5408\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\u3002"
          },
          {
            "name": "reason",
            "type": "string",
            "required": false,
            "description": "\u72B6\u6001\u6216\u5206\u6D3E\u8C03\u6574\u539F\u56E0\u3002"
          },
          {
            "name": "assignee",
            "type": '"self" | { type: "user" | "agent" | "app"; id: string; }',
            "required": false,
            "description": "\u8D1F\u8D23\u4EBA\u9009\u62E9\uFF1Bself \u8868\u793A\u5F53\u524D\u5DF2\u6388\u6743\u7528\u6237\u3002"
          }
        ],
        "variants": [
          {
            "type": "{ taskId: string; idempotencyKey: string; expectedVersion: number; } & { action?: never; title?: string; goal?: string; dueAt?: string | null; attachments?: string[]; assignee?: never; reason?: never; }",
            "parameters": [
              {
                "name": "taskId",
                "type": "string",
                "required": true,
                "description": "\u4EFB\u52A1 ID\uFF1B\u4ECE tasks.list \u6216\u521B\u5EFA\u56DE\u6267\u53D6\u5F97\u3002"
              },
              {
                "name": "idempotencyKey",
                "type": "string",
                "required": true,
                "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
              },
              {
                "name": "expectedVersion",
                "type": "number",
                "required": true,
                "description": "\u6700\u8FD1\u8BFB\u53D6\u56DE\u6267\u4E2D\u7684\u7248\u672C\uFF0C\u7528\u4E8E\u5E76\u53D1\u63A7\u5236\uFF1B\u51B2\u7A81\u540E\u5148\u91CD\u65B0\u8BFB\u53D6\u3002"
              },
              {
                "name": "title",
                "type": "string",
                "required": false,
                "description": "\u5C55\u793A\u6807\u9898\u3002"
              },
              {
                "name": "goal",
                "type": "string",
                "required": false,
                "description": "\u4EFB\u52A1\u76EE\u6807\u53CA\u9A8C\u6536\u8981\u6C42\u3002"
              },
              {
                "name": "dueAt",
                "type": "null | string",
                "required": false,
                "description": "\u622A\u6B62\u65F6\u95F4\uFF0C\u4F7F\u7528\u63A5\u53E3\u89C4\u5B9A\u7684\u65F6\u95F4\u683C\u5F0F\u3002"
              },
              {
                "name": "attachments",
                "type": "string[]",
                "required": false,
                "description": "\u5DF2\u4E0A\u4F20\u7684\u5E73\u53F0\u6587\u4EF6 ID \u5217\u8868\u3002"
              }
            ],
            "forbidden": [
              "action",
              "assignee",
              "reason"
            ],
            "open": false
          },
          {
            "type": '{ taskId: string; idempotencyKey: string; expectedVersion: number; } & { action: "reassign"; reason: string; assignee: TaskAssigneeInput; title?: never; goal?: never; dueAt?: never; attachments?: never; }',
            "parameters": [
              {
                "name": "taskId",
                "type": "string",
                "required": true,
                "description": "\u4EFB\u52A1 ID\uFF1B\u4ECE tasks.list \u6216\u521B\u5EFA\u56DE\u6267\u53D6\u5F97\u3002"
              },
              {
                "name": "idempotencyKey",
                "type": "string",
                "required": true,
                "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
              },
              {
                "name": "expectedVersion",
                "type": "number",
                "required": true,
                "description": "\u6700\u8FD1\u8BFB\u53D6\u56DE\u6267\u4E2D\u7684\u7248\u672C\uFF0C\u7528\u4E8E\u5E76\u53D1\u63A7\u5236\uFF1B\u51B2\u7A81\u540E\u5148\u91CD\u65B0\u8BFB\u53D6\u3002"
              },
              {
                "name": "action",
                "type": '"reassign"',
                "required": true,
                "description": "\u4EFB\u52A1\u72B6\u6001\u6216\u5206\u6D3E\u64CD\u4F5C\uFF1B\u6309\u7C7B\u578B\u4E2D\u7684\u8054\u5408\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\u3002"
              },
              {
                "name": "reason",
                "type": "string",
                "required": true,
                "description": "\u72B6\u6001\u6216\u5206\u6D3E\u8C03\u6574\u539F\u56E0\u3002"
              },
              {
                "name": "assignee",
                "type": '"self" | { type: "user" | "agent" | "app"; id: string; }',
                "required": true,
                "description": "\u8D1F\u8D23\u4EBA\u9009\u62E9\uFF1Bself \u8868\u793A\u5F53\u524D\u5DF2\u6388\u6743\u7528\u6237\u3002"
              }
            ],
            "forbidden": [
              "title",
              "goal",
              "dueAt",
              "attachments"
            ],
            "open": false
          },
          {
            "type": '{ taskId: string; idempotencyKey: string; expectedVersion: number; } & { action: "cancel" | "restart"; reason: string; assignee?: never; title?: never; goal?: never; dueAt?: never; attachments?: never; }',
            "parameters": [
              {
                "name": "taskId",
                "type": "string",
                "required": true,
                "description": "\u4EFB\u52A1 ID\uFF1B\u4ECE tasks.list \u6216\u521B\u5EFA\u56DE\u6267\u53D6\u5F97\u3002"
              },
              {
                "name": "idempotencyKey",
                "type": "string",
                "required": true,
                "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
              },
              {
                "name": "expectedVersion",
                "type": "number",
                "required": true,
                "description": "\u6700\u8FD1\u8BFB\u53D6\u56DE\u6267\u4E2D\u7684\u7248\u672C\uFF0C\u7528\u4E8E\u5E76\u53D1\u63A7\u5236\uFF1B\u51B2\u7A81\u540E\u5148\u91CD\u65B0\u8BFB\u53D6\u3002"
              },
              {
                "name": "action",
                "type": '"cancel" | "restart"',
                "required": true,
                "description": "\u4EFB\u52A1\u72B6\u6001\u6216\u5206\u6D3E\u64CD\u4F5C\uFF1B\u6309\u7C7B\u578B\u4E2D\u7684\u8054\u5408\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\u3002"
              },
              {
                "name": "reason",
                "type": "string",
                "required": true,
                "description": "\u72B6\u6001\u6216\u5206\u6D3E\u8C03\u6574\u539F\u56E0\u3002"
              }
            ],
            "forbidden": [
              "assignee",
              "title",
              "goal",
              "dueAt",
              "attachments"
            ],
            "open": false
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.tasks.update({"taskId":"<taskId>","idempotencyKey":"<persistent-operation-id>","expectedVersion":1,"title":"\u4FEE\u6B63\u6807\u9898"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#tasksupdate",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002\u666E\u901A\u5B57\u6BB5\u4FEE\u6539\u4E0E reassign/cancel/restart \u4E92\u65A5\uFF1B\u63A7\u5236\u64CD\u4F5C\u5FC5\u586B reason\uFF0Creassign \u53E6\u9700 assignee\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.tasks.update({"taskId":"<taskId>","idempotencyKey":"<persistent-operation-id>","expectedVersion":1,"title":"\u4FEE\u6B63\u6807\u9898"});'
    }
  },
  "tasks.reportExecution": {
    "method": "tasks.reportExecution",
    "route": "POST /tasks/:id/execution-reports",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "TaskReportInput",
        "parameters": [
          {
            "name": "taskId",
            "type": "string",
            "required": true,
            "description": "\u4EFB\u52A1 ID\uFF1B\u4ECE tasks.list \u6216\u521B\u5EFA\u56DE\u6267\u53D6\u5F97\u3002"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          },
          {
            "name": "expectedVersion",
            "type": "number",
            "required": true,
            "description": "\u6700\u8FD1\u8BFB\u53D6\u56DE\u6267\u4E2D\u7684\u7248\u672C\uFF0C\u7528\u4E8E\u5E76\u53D1\u63A7\u5236\uFF1B\u51B2\u7A81\u540E\u5148\u91CD\u65B0\u8BFB\u53D6\u3002"
          },
          {
            "name": "executionEpoch",
            "type": "number",
            "required": true,
            "description": "\u5F53\u524D\u4EFB\u52A1\u6267\u884C\u8F6E\u6B21\uFF0C\u4ECE\u4EFB\u52A1\u8BE6\u60C5\u53D6\u5F97\u3002"
          },
          {
            "name": "executionStatus",
            "type": '"completed" | "failed" | "running"',
            "required": false,
            "description": "\u4EFB\u52A1\u6267\u884C\u72B6\u6001\u7B5B\u9009\uFF1B\u4E0D\u540C\u4E8E\u9A8C\u6536\u72B6\u6001\u3002"
          },
          {
            "name": "progress",
            "type": "string",
            "required": false,
            "description": "\u6267\u884C\u8FDB\u5C55\u3002"
          },
          {
            "name": "conclusion",
            "type": "string",
            "required": false,
            "description": "\u6267\u884C\u7ED3\u8BBA\u3002"
          },
          {
            "name": "resultArtifacts",
            "type": "TaskResultArtifactInput[]",
            "required": false,
            "description": "\u7ED3\u679C\u9644\u4EF6\uFF1B\u6309\u7C7B\u578B\u4E2D\u7684\u6587\u4EF6\u5F15\u7528\u5206\u652F\u586B\u5199\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.app.tasks.reportExecution({"taskId":"<taskId>","idempotencyKey":"<persistent-operation-id>","expectedVersion":1,"executionEpoch":1,"executionStatus":"running","progress":"\u5F00\u59CB\u5904\u7406"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#tasksreportexecution",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002completed \u5FC5\u987B\u540C\u6B21\u63D0\u4F9B conclusion \u6216 resultArtifacts\uFF1BexpectedVersion \u548C executionEpoch \u6765\u81EA\u5F53\u524D\u4EFB\u52A1\u56DE\u6267\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "app": 'await colink.app.tasks.reportExecution({"taskId":"<taskId>","idempotencyKey":"<persistent-operation-id>","expectedVersion":1,"executionEpoch":1,"executionStatus":"running","progress":"\u5F00\u59CB\u5904\u7406"});'
    }
  },
  "contacts.list": {
    "method": "contacts.list",
    "route": "GET /extensions/contacts",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "ContactQuery | undefined",
        "parameters": [
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "view",
            "type": '"picker"',
            "required": false,
            "description": "\u8BFB\u53D6\u89C6\u56FE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.contacts.list({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#contactslist",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002q \u63D0\u4F9B\u65F6\u4E3A 2\u201380 \u5B57\u7B26\u4E14\u4E0D\u80FD\u540C\u65F6\u4F7F\u7528 cursor\uFF1B\u7701\u7565 q \u65F6\u6309\u6BCF\u9875 30 \u6761\u8BFB\u53D6\u672C\u4EBA\u53EF\u89C1\u8054\u7CFB\u4EBA\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.contacts.list({});"
    }
  },
  "contacts.listChannels": {
    "method": "contacts.listChannels",
    "route": "GET /extensions/contact-channels",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "{ query?: string; cursor?: string; } | undefined",
        "parameters": [
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.contacts.listChannels({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#contactslistchannels--contactslistprojects",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002q \u63D0\u4F9B\u65F6\u4E3A 1\u201380 \u5B57\u7B26\uFF1B\u56FA\u5B9A\u6BCF\u9875 30 \u6761\uFF0C\u4E0D\u63A5\u6536 limit\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.contacts.listChannels({});"
    }
  },
  "contacts.listProjects": {
    "method": "contacts.listProjects",
    "route": "GET /extensions/contact-projects",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "{ query?: string; cursor?: string; } | undefined",
        "parameters": [
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.contacts.listProjects({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#contactslistchannels--contactslistprojects",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002q \u63D0\u4F9B\u65F6\u4E3A 1\u201380 \u5B57\u7B26\uFF1B\u56FA\u5B9A\u6BCF\u9875 30 \u6761\uFF0C\u4E0D\u63A5\u6536 limit\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.contacts.listProjects({});"
    }
  },
  "contacts.resolve": {
    "method": "contacts.resolve",
    "route": "POST /extensions/participant-selections",
    "arguments": [
      {
        "name": "body",
        "optional": false,
        "type": "{ participantIds?: string[]; channelIds?: string[]; projectIds?: string[]; }",
        "parameters": [
          {
            "name": "participantIds",
            "type": "string[]",
            "required": false,
            "description": "\u9009\u62E9\u7684\u7528\u6237 ID\uFF0C\u6700\u591A 100 \u4E2A\uFF0C\u4E0D\u91CD\u590D\u3002"
          },
          {
            "name": "channelIds",
            "type": "string[]",
            "required": false,
            "description": "\u9009\u62E9\u7684\u9891\u9053 ID\uFF0C\u6700\u591A 20 \u4E2A\uFF0C\u4E0D\u91CD\u590D\u3002"
          },
          {
            "name": "projectIds",
            "type": "string[]",
            "required": false,
            "description": "\u9009\u62E9\u7684\u9879\u76EE ID\uFF0C\u6700\u591A 20 \u4E2A\uFF0C\u4E0D\u91CD\u590D\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.contacts.resolve({"projectIds":["<projectId>"]});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-business.md#contactsresolve",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u9879\u76EE ID \u53D6\u81EA\u5DF2\u6838\u9A8C\u7684\u9875\u9762\u4E0A\u4E0B\u6587\uFF1B\u6700\u591A\u89E3\u6790 100 \u540D\u771F\u4EBA\uFF0C\u7ED3\u679C\u6392\u9664\u5F53\u524D\u4F7F\u7528\u8005\u3002\u6B64\u8C03\u7528\u53EA\u8BFB\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.contacts.resolve({"projectIds":["<projectId>"]});'
    }
  },
  "apps.list": {
    "method": "apps.list",
    "route": "GET /app-capabilities",
    "arguments": [
      {
        "name": "query",
        "optional": true,
        "type": "AppDiscoveryQuery | undefined",
        "parameters": [
          {
            "name": "query",
            "type": "string",
            "required": false,
            "description": "\u68C0\u7D22\u6587\u672C\u6216\u8BE5\u5165\u53E3\u5B9A\u4E49\u7684\u67E5\u8BE2\u5BF9\u8C61\uFF0C\u8BE6\u89C1\u7C7B\u578B\u3002"
          },
          {
            "name": "providerInstallationId",
            "type": "string",
            "required": false,
            "description": "\u80FD\u529B\u63D0\u4F9B App \u7684\u5B89\u88C5 ID\uFF1B\u4ECE apps.list \u53D6\u5F97\u3002"
          },
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await colink.user.apps.list({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-integrations.md#appslist",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": "await colink.user.apps.list({});",
      "app": "await colink.app.apps.list({});"
    }
  },
  "apps.listOperations": {
    "method": "apps.listOperations",
    "route": "GET /app-capabilities/:id/operations",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "CursorQuery & { providerInstallationId: string; operationId?: string; }",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "providerInstallationId",
            "type": "string",
            "required": true,
            "description": "\u80FD\u529B\u63D0\u4F9B App \u7684\u5B89\u88C5 ID\uFF1B\u4ECE apps.list \u53D6\u5F97\u3002"
          },
          {
            "name": "operationId",
            "type": "string",
            "required": false,
            "description": "\u63D0\u4F9B\u65B9\u64CD\u4F5C ID\uFF1B\u4ECE apps.listOperations \u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.apps.listOperations({"providerInstallationId":"<providerInstallationId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-integrations.md#appslistoperations",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.apps.listOperations({"providerInstallationId":"<providerInstallationId>"});',
      "app": 'await colink.app.apps.listOperations({"providerInstallationId":"<providerInstallationId>"});'
    }
  },
  "apps.callOperation": {
    "method": "apps.callOperation",
    "route": "POST /app-capabilities/:id/calls",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "{ providerInstallationId: string; operationId: string; input: Record<string, unknown>; expectedSpecRevision?: string; idempotencyKey: string; }",
        "parameters": [
          {
            "name": "providerInstallationId",
            "type": "string",
            "required": true,
            "description": "\u80FD\u529B\u63D0\u4F9B App \u7684\u5B89\u88C5 ID\uFF1B\u4ECE apps.list \u53D6\u5F97\u3002"
          },
          {
            "name": "operationId",
            "type": "string",
            "required": true,
            "description": "\u63D0\u4F9B\u65B9\u64CD\u4F5C ID\uFF1B\u4ECE apps.listOperations \u53D6\u5F97\u3002"
          },
          {
            "name": "input",
            "type": "Record<string, unknown>",
            "required": true,
            "description": "\u6EE1\u8DB3\u63D0\u4F9B\u65B9 inputSchema \u7684\u4E1A\u52A1\u53C2\u6570\u3002"
          },
          {
            "name": "expectedSpecRevision",
            "type": "string",
            "required": false,
            "description": "apps.listOperations \u8FD4\u56DE\u7684\u63A5\u53E3\u58F0\u660E\u7248\u672C\u3002"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": true,
            "description": "\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6\uFF0C\u4E0D\u662F API Key\u3002\u4F7F\u7528\u5DF2\u6301\u4E45\u4FDD\u5B58\u7684\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF1B\u540C\u4E00\u64CD\u4F5C\u8DE8\u91CD\u8BD5\u4FDD\u6301\u4E0D\u53D8\uFF0C\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u540C\u6587\u4E5F\u4E0D\u540C\u30021\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u672A\u77E5\u7ED3\u679C\u540E\u4E0D\u80FD\u6362\u952E\u91CD\u505A\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await colink.user.apps.callOperation({"providerInstallationId":"<providerInstallationId>","operationId":"<operationId>","input":{},"idempotencyKey":"<persistent-operation-id>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-integrations.md#appscalloperation",
    "note": "Promise \u62D2\u7EDD\uFF1B\u5148\u68C0\u67E5\u56DE\u6267\u53CA error.write.outcome/action\uFF1B\u53EA\u6709\u6307\u793A same_key \u65F6\u624D\u6309\u539F\u952E\u539F\u53C2\u6570\u6062\u590D\u3002unknown \u5148\u67E5\u8BE2\u7ED3\u679C\uFF0C\u4E0D\u6362\u952E\u91CD\u653E\uFF1B\u53D6\u6D88\u4E0D\u64A4\u9500\u5DF2\u53D1\u51FA\u7684\u5199\u5165\u3002input \u5FC5\u987B\u6EE1\u8DB3 apps.listOperations \u5F53\u524D\u8FD4\u56DE\u7684 inputSchema\uFF1B\u7A7A\u5BF9\u8C61\u53EA\u662F\u7ED3\u6784\u793A\u610F\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002",
    "identityExamples": {
      "user": 'await colink.user.apps.callOperation({"providerInstallationId":"<providerInstallationId>","operationId":"<operationId>","input":{},"idempotencyKey":"<persistent-operation-id>"});',
      "app": 'await colink.app.apps.callOperation({"providerInstallationId":"<providerInstallationId>","operationId":"<operationId>","input":{},"idempotencyKey":"<persistent-operation-id>"});'
    }
  },
  "directory.listChannels": {
    "method": "directory.listChannels",
    "route": "POST /extensions/capability-calls/:id/reads",
    "operation": "channels.list",
    "arguments": [
      {
        "name": "input",
        "optional": true,
        "type": "CursorQuery | undefined",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": "await call.directory.listChannels({});",
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-integrations.md#calldirectorylistchannels",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002"
  },
  "directory.listChannelMembers": {
    "method": "directory.listChannelMembers",
    "route": "POST /extensions/capability-calls/:id/reads",
    "operation": "channels.members.list",
    "arguments": [
      {
        "name": "input",
        "optional": false,
        "type": "CursorQuery & { channelId: string; }",
        "parameters": [
          {
            "name": "limit",
            "type": "number",
            "required": false,
            "description": "\u5355\u6B21\u8BFB\u53D6\u6570\u91CF\uFF1B\u5177\u4F53\u8303\u56F4\u4E0E\u9ED8\u8BA4\u503C\u89C1\u8BE5\u63A5\u53E3\u5B57\u6BB5\u8868\uFF08\u6587\u4EF6\u6587\u672C\u8BFB\u53D6\u4E0D\u540C\u4E8E\u5217\u8868\u5206\u9875\uFF09\u3002"
          },
          {
            "name": "cursor",
            "type": "string",
            "required": false,
            "description": "\u4E0A\u4E00\u9875\u7684 nextCursor\uFF1B\u9996\u8BF7\u6C42\u7701\u7565\uFF0C\u540E\u7EED\u539F\u6837\u4F20\u56DE\u3002"
          },
          {
            "name": "channelId",
            "type": "string",
            "required": true,
            "description": "\u9891\u9053 ID\uFF1B\u4ECE\u5F53\u524D\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u7ED3\u679C\u53D6\u5F97\u3002"
          }
        ],
        "open": false
      }
    ],
    "example": 'await call.directory.listChannelMembers({"channelId":"<channelId>"});',
    "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    "reference": "for-ai-sdk-integrations.md#calldirectorylistchannelmembers",
    "note": "Promise \u62D2\u7EDD\uFF1B\u68C0\u67E5 error.usage\u3001details \u548C\u6388\u6743\u6765\u6E90\uFF1B\u4FEE\u6B63\u540E\u91CD\u65B0\u8BFB\u53D6\u3002\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002\u539F\u751F\u5F02\u5E38\u53CA\u672A\u8BC6\u522B\u7684\u4E0A\u6E38\u9519\u8BEF\u4ECD\u53EF\u80FD\u4F20\u64AD\uFF0C\u9519\u8BEF\u7801\u5217\u8868\u4E0D\u662F\u7A77\u4E3E\u3002\u793A\u4F8B\u4E2D\u7684 <...> \u5FC5\u987B\u66FF\u6362\u4E3A\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216\u5E73\u53F0\u56DE\u6267\u4E2D\u7684\u503C\uFF1B\u793A\u4F8B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u4E5F\u4E0D\u6388\u4E88\u6743\u9650\u3002\u8054\u5408\u7C7B\u578B\u6309\u540C\u4E00\u5206\u652F\u7EC4\u5408\u5B57\u6BB5\uFF1B\u5F00\u653E\u53C2\u6570\u6309\u63A5\u53E3\u5B57\u6BB5\u8868\u586B\u5199\u3002"
  }
};

// src/shared/public-contract.mts
var HTTP_ROUTES = {
  "POST /extensions/capability-calls/:id/reads": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": []
    },
    "readOnly": true,
    "readPolicies": {
      "channels.list": {
        "tokens": [
          "app"
        ],
        "permissions": [
          "channels:list"
        ]
      },
      "channels.members.list": {
        "tokens": [
          "app"
        ],
        "permissions": [
          "channels:read-public-members"
        ]
      }
    }
  },
  "GET /app-projects": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "projects:list"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "app"
        ],
        "permissions": [
          "projects:list"
        ]
      }
    ]
  },
  "GET /app-channels": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "channels:list"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "app"
        ],
        "permissions": [
          "channels:list"
        ]
      }
    ]
  },
  "GET /app-channels/:id/messages": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:read-public"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "user"
        ],
        "permissions": [
          "messages:read-private"
        ]
      }
    ]
  },
  "GET /app-channels/:id/members": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "channels:read-public-members"
      ]
    }
  },
  "POST /messages/:id/recall": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:write"
      ]
    }
  },
  "GET /tasks": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "tasks:read"
      ]
    }
  },
  "GET /tasks/:id": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "tasks:read"
      ]
    }
  },
  "GET /personal-tasks": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "tasks:read"
      ]
    }
  },
  "GET /app-files": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "files:read"
      ]
    }
  },
  "GET /app-files/:id": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "files:read"
      ]
    }
  },
  "POST /app-files": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "files:upload"
      ]
    }
  },
  "GET /app-capabilities": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "apps:read"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "app"
        ],
        "permissions": [
          "apps:read"
        ]
      }
    ]
  },
  "GET /app-capabilities/:id/operations": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "apps:read"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "app"
        ],
        "permissions": [
          "apps:read"
        ]
      }
    ]
  },
  "POST /app-capabilities/:id/calls": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "apps:call"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "app"
        ],
        "permissions": [
          "apps:call"
        ]
      }
    ]
  },
  "GET /topics": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "topics:list"
      ]
    }
  },
  "GET /topics/:id/messages": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:read-public"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "user"
        ],
        "permissions": [
          "messages:read-private"
        ]
      }
    ]
  },
  "GET /messages/:id": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:read-public"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "user"
        ],
        "permissions": [
          "messages:read-private"
        ]
      }
    ]
  },
  "GET /app-direct-messages/:conversationId/messages": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "messages:read-private"
      ]
    }
  },
  "GET /app-direct-messages/:conversationId/attachments/:artifactId/download": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "files:read"
      ]
    }
  },
  "GET /topics/:id/images/:artifactId": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "files:read"
      ]
    }
  },
  "GET /topics/:id/participants": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:read-public"
      ]
    },
    "alternatives": [
      {
        "tokens": [
          "user"
        ],
        "permissions": [
          "messages:read-private"
        ]
      }
    ]
  },
  "PUT /messages/:id": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:write"
      ]
    }
  },
  "POST /messages": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:write"
      ]
    }
  },
  "POST /message-drafts": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "messages:draft"
      ]
    }
  },
  "POST /agent-sessions/status": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:write"
      ]
    }
  },
  "GET /channels/:id/unread-messages": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "channels:read-unread"
      ]
    }
  },
  "GET /extensions/contacts": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "contacts:select"
      ]
    }
  },
  "GET /extensions/contact-channels": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "contacts:select"
      ]
    }
  },
  "GET /extensions/contact-projects": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "contacts:select"
      ]
    }
  },
  "POST /extensions/participant-selections": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "contacts:select"
      ]
    },
    "readOnly": true
  },
  "PUT /app-files/:fileId/content": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "files:upload"
      ]
    }
  },
  "GET /app-files/:fileId/content": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "files:read"
      ]
    }
  },
  "POST /tasks": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "tasks:manage"
      ]
    }
  },
  "POST /tasks/:id": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": [
        "tasks:manage"
      ]
    }
  },
  "POST /tasks/:id/execution-reports": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "tasks:execute"
      ]
    }
  },
  "POST /extensions/ui-requests": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:receive"
      ]
    }
  },
  "GET /extensions/ui-requests/:id": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:receive"
      ]
    }
  },
  "POST /extensions/ui-requests/:id/complete": {
    "policy": {
      "tokens": [
        "user"
      ],
      "permissions": []
    }
  },
  "POST /extensions/agent-apps/receipts": {
    "policy": {
      "tokens": [
        "app"
      ],
      "permissions": [
        "messages:receive"
      ]
    }
  }
};
var MCP_OPERATIONS = {
  "colink_read_platform": "platform.read",
  "colink_list_user_projects": "projects.list",
  "colink_list_app_projects": "projects.list",
  "colink_list_user_channels": "channels.list",
  "colink_list_app_channels": "channels.list",
  "colink_list_user_topics": "topics.list",
  "colink_list_my_tasks": "tasks.personal.list",
  "colink_read_private_topic": "messages.topic.read",
  "colink_read_public_topic": "messages.topic.read",
  "colink_read_private_channel": "messages.channel.read",
  "colink_read_public_channel": "messages.channel.read",
  "colink_read_channel_unread": "channels.unread.read",
  "colink_list_members": "channels.members.list",
  "colink_send_message": "messages.send",
  "colink_send_draft": "messages.draft",
  "colink_recall_message": "messages.recall",
  "colink_upload_file": "files.upload",
  "colink_list_files": "files.list",
  "colink_read_file": "files.read",
  "colink_create_task": "tasks.create",
  "colink_get_task": "tasks.get",
  "colink_list_tasks": "tasks.list",
  "colink_update_task": "tasks.update",
  "colink_report_task": "tasks.report",
  "colink_app_find_as_user": "apps.find",
  "colink_app_find_as_app": "apps.find",
  "colink_app_guide_as_user": "apps.guide",
  "colink_app_guide_as_app": "apps.guide",
  "colink_app_call_as_user": "apps.call",
  "colink_app_call_as_app": "apps.call",
  "colink_app_prepare": "apps.deploy",
  "colink_app_finalize": "apps.deploy",
  "colink_app_install": "apps.deploy",
  "colink_app_status": "apps.deploy",
  "colink_app_update_preview": "apps.deploy",
  "colink_app_update": "apps.deploy",
  "colink_app_delete_preview": "apps.deploy",
  "colink_app_delete": "apps.deploy"
};
var MCP_POLICIES = {
  "colink_read_platform": {
    "tokens": [
      "app",
      "user"
    ],
    "permissions": []
  },
  "colink_list_user_projects": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "projects:list"
    ]
  },
  "colink_list_app_projects": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "projects:list"
    ]
  },
  "colink_list_user_channels": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "channels:list"
    ]
  },
  "colink_list_user_topics": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "topics:list"
    ]
  },
  "colink_list_app_channels": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "channels:list"
    ]
  },
  "colink_list_my_tasks": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "tasks:read"
    ]
  },
  "colink_read_private_topic": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "messages:read-private"
    ]
  },
  "colink_read_public_topic": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "messages:read-public"
    ]
  },
  "colink_read_private_channel": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "messages:read-private"
    ]
  },
  "colink_read_public_channel": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "messages:read-public"
    ]
  },
  "colink_read_channel_unread": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "channels:read-unread"
    ]
  },
  "colink_list_members": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "channels:read-public-members"
    ]
  },
  "colink_send_message": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "messages:write"
    ]
  },
  "colink_send_draft": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "messages:draft"
    ]
  },
  "colink_recall_message": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "messages:write"
    ]
  },
  "colink_upload_file": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "files:upload"
    ]
  },
  "colink_list_files": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "files:read"
    ]
  },
  "colink_read_file": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "files:read"
    ]
  },
  "colink_create_task": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "tasks:manage"
    ]
  },
  "colink_get_task": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "tasks:read"
    ]
  },
  "colink_list_tasks": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "tasks:read"
    ]
  },
  "colink_update_task": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "tasks:manage"
    ]
  },
  "colink_report_task": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "tasks:execute"
    ]
  },
  "colink_app_find_as_user": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "apps:read"
    ]
  },
  "colink_app_find_as_app": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "apps:read"
    ]
  },
  "colink_app_guide_as_user": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "apps:read"
    ]
  },
  "colink_app_guide_as_app": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "apps:read"
    ]
  },
  "colink_app_call_as_user": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "apps:call"
    ]
  },
  "colink_app_call_as_app": {
    "tokens": [
      "app"
    ],
    "permissions": [
      "apps:call"
    ]
  },
  "colink_app_prepare": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_finalize": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_install": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_status": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_update_preview": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_update": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_delete_preview": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  },
  "colink_app_delete": {
    "tokens": [
      "user"
    ],
    "permissions": [
      "app:manage"
    ]
  }
};
var USER_SCOPES = ["messages:read-private", "messages:draft", "channels:read-unread", "files:read", "tasks:read", "tasks:manage", "contacts:select", "projects:list", "channels:list", "topics:list", "apps:read", "apps:call", "app:manage", "openid", "profile"];
var BACKGROUND_SCOPES = ["messages:read-private", "messages:draft", "channels:read-unread", "files:read", "tasks:read", "tasks:manage", "projects:list", "channels:list", "topics:list", "apps:read", "apps:call", "app:manage"];

// src/diagnostics/write-contract.mts
var journal = Object.freeze(["required", "journal"]);
var optional = Object.freeze(["required", "single_attempt"]);
var single = Object.freeze(["none", "single_attempt"]);
var WRITE_CONTRACTS = Object.freeze({
  "POST /messages": journal,
  "PUT /messages/:id": single,
  "POST /message-drafts": journal,
  "POST /agent-sessions/status": journal,
  "POST /extensions/ui-requests": journal,
  "POST /tasks": journal,
  "POST /tasks/:id": journal,
  "POST /tasks/:id/execution-reports": journal,
  "POST /messages/:id/recall": optional,
  "POST /app-files": journal,
  "POST /app-capabilities/:id/calls": optional,
  "PUT /app-files/:fileId/content": single,
  "POST /extensions/ui-requests/:id/complete": single,
  "POST /extensions/agent-apps/receipts": single
});
function writeUsage(route) {
  const entry = route !== void 0 && Object.hasOwn(WRITE_CONTRACTS, route) && WRITE_CONTRACTS[route];
  if (!entry) return void 0;
  return describeWrite(route ?? "", entry);
}
function mcpWriteUsage(tool, isMessageSend = false) {
  if (tool.annotations?.readOnlyHint === true) return void 0;
  const keyParameter = ["requestKey", "operationId"].find((p) => tool.inputSchema?.properties?.[p]);
  return { ...describeWrite(isMessageSend ? "POST /messages" : "", keyParameter ? journal : single), ...keyParameter ? { keyParameter } : {} };
}
function describeWrite(route, entry) {
  const [key, mode] = entry;
  const inspect = route === "POST /tasks/:id" || route === "POST /tasks/:id/execution-reports" ? "\u53EF\u7528 tasks.get \u6838\u5BF9\u5DF2\u77E5\u4EFB\u52A1\uFF0C\u4F46\u5F53\u524D\u72B6\u6001\u4E0D\u80FD\u5355\u72EC\u8BC1\u660E\u67D0\u6B21\u5199\u5165\u6210\u529F\u3002" : route === "POST /extensions/ui-requests" || route === "POST /extensions/ui-requests/:id/complete" ? "\u5DF2\u77E5\u8BF7\u6C42 ID \u65F6\u7528 interactions.get \u6838\u5BF9\u72B6\u6001\u3002" : route.includes("/app-files") ? "\u5DF2\u77E5 fileId \u65F6\u7528 files.readContent \u6838\u5BF9\u6587\u4EF6\u72B6\u6001\u3002" : "\u6CA1\u6709\u6309\u4EFB\u610F key \u67E5\u8BE2\u7ED3\u679C\u7684\u901A\u7528\u63A5\u53E3\uFF1B\u4FDD\u7559\u64CD\u4F5C\u6807\u8BC6\u548C requestId\uFF0C\u7531\u4E1A\u52A1\u56DE\u6267\u6216\u64CD\u4F5C\u8005\u6838\u5BF9\u3002\u4E0D\u80FD\u53EA\u6309\u76F8\u540C\u5185\u5BB9\u5224\u65AD\u6210\u529F\u3002";
  return {
    mode,
    key,
    ...mode === "journal" ? { recoveryWindowMs: WRITE_RECOVERY_MS } : {},
    scope: "idempotencyKey \u4E0D\u662F API Key\u3002\u76F8\u540C\u53EF\u4FE1\u4E0A\u4E0B\u6587\u5185\uFF0C\u4E00\u6B21\u4E1A\u52A1\u64CD\u4F5C\u4F7F\u7528\u4E00\u4E2A\u7A33\u5B9A idempotencyKey\uFF1B\u4E1A\u52A1\u91CD\u65B0\u8C03\u7528\u3001\u4E8B\u4EF6\u91CD\u6295\u548C\u91CD\u542F\u6062\u590D\u4FDD\u6301\u539F\u503C\u3002\u4E0D\u540C\u64CD\u4F5C\u5373\u4F7F\u5185\u5BB9\u76F8\u540C\u4E5F\u4F7F\u7528\u4E0D\u540C key\u3002",
    onUnknown: (mode === "journal" ? "SDK \u4E0D\u81EA\u52A8\u91CD\u8DD1\u4E1A\u52A1\u3002\u4EC5\u5728\u539F\u4E0A\u4E0B\u6587\u4ECD\u6709\u6548\u4E14\u6062\u590D\u7A97\u53E3\u5185\uFF0C\u7528\u539F\u53C2\u6570\u548C\u539F idempotencyKey \u663E\u5F0F\u6062\u590D\uFF1B\u4E0D\u8981\u6362 idempotencyKey \u6216\u6539\u8D70 HTTP/MCP \u91CD\u505A\u3002" : "SDK \u53EA\u5C1D\u8BD5\u4E00\u6B21\uFF1B\u4F20 key \u4E0D\u4EE3\u8868\u5DF2\u8FDB\u5165\u6301\u4E45\u6062\u590D\u961F\u5217\u3002\u7ED3\u679C\u672A\u77E5\u65F6\u5148\u6838\u5BF9\u72B6\u6001\uFF0C\u4E0D\u81EA\u52A8\u91CD\u505A\u6216\u6539\u8D70 HTTP/MCP\u3002") + inspect,
    ...route === "POST /messages" ? { managedAlternative: "\u56DE\u590D\u5F53\u524D @ \u7684\u6700\u7EC8\u6587\u672C\uFF0C\u5728 runtime.onEvent(EventType.UserMessageReceived, handler) \u7684 handler \u4E2D\u6682\u5B58 ctx.reply({text}) \u540E\u6210\u529F\u8FD4\u56DE\uFF1BAgent.runTurn \u4E5F\u53EF\u8FD4\u56DE\u6700\u7EC8\u6587\u672C\uFF1BSDK \u7BA1\u7406\u6301\u4E45\u53D1\u9001\u6807\u8BC6\uFF0C\u65E0\u987B key\u3002\u4E3B\u52A8\u53D1\u9001\u4ECD\u7528 messages.send\u3002" } : {}
  };
}
function explainWriteFailure(error2, usage) {
  if (!usage?.write) return error2;
  if (!error2.write) {
    const beforeSend = [
      "INVALID_ARGUMENT",
      "INVALID_RESOURCE",
      "IDEMPOTENCY_KEY_REQUIRED",
      "SCOPE_MISSING",
      "CLIENT_IDENTITY_UNAVAILABLE",
      "WRITE_POLICY_DENIED",
      "WRITE_CONTEXT_REQUIRED",
      "RESOURCE_POLICY_DENIED",
      "INTERACTION_STATUS_MANAGED",
      "INVALID_HTTP_REQUEST",
      "INVALID_HTTP_BODY",
      "INVALID_CONTENT_TYPE",
      "INVALID_HTTP_QUERY",
      "SIMULATOR_NOT_IMPLEMENTED"
    ].includes(error2.code);
    error2.write = { outcome: beforeSend ? "not_sent" : "unknown", action: ["WRITE_RECOVERY_EXPIRED", "IDEMPOTENCY_EXPIRED"].includes(error2.code) ? "stop" : beforeSend ? "fix_request" : "inspect" };
  }
  if (error2.write.outcome === "unknown" && error2.write.action !== "stop" && !["WRITE_KEY_CONFLICT", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(error2.code))
    error2.hint = usage.write.onUnknown;
  return error2;
}

// src/diagnostics/method-guidance.mts
var guides = METHOD_GUIDES;
var routes = HTTP_ROUTES;
var policies = MCP_POLICIES;
var operations = MCP_OPERATIONS;
var isIdentity = (value) => value === "user" || value === "app";
var publicText = (value, secrets = []) => {
  if (typeof value !== "string") return "";
  let text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]");
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[redacted]");
  return text.slice(0, 400);
};
function toolUsage(rawTool, secrets = [], identity) {
  const tool = record(rawTool);
  if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) return void 0;
  const schema = record(tool.inputSchema), annotations = record(tool.annotations), policy = Object.hasOwn(policies, tool.name) ? policies[tool.name] : void 0;
  const properties = record(schema.properties);
  const parameters = Object.entries(properties).filter(([name]) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)).slice(0, 40).map(([name, value]) => {
    const field = record(value);
    return {
      name,
      type: typeof field.type === "string" && ["string", "integer", "number", "boolean", "object", "array"].includes(field.type) ? field.type : "\u89C1 tools/list inputSchema",
      required: Array.isArray(schema.required) && schema.required.includes(name),
      description: publicText(field.description, secrets) || "\u6309\u5F53\u524D\u6388\u6743 tools/list \u4E2D\u6B64\u5B57\u6BB5\u7684\u5B9A\u4E49\u586B\u5199\u3002"
    };
  });
  const input = Object.fromEntries(parameters.filter((p) => p.required).map((p) => [p.name, p.type === "integer" || p.type === "number" ? 1 : p.type === "boolean" ? true : p.type === "array" ? [] : p.type === "object" ? {} : "<" + p.name + ">"]));
  const write = mcpWriteUsage({ annotations: { readOnlyHint: annotations.readOnlyHint === true }, inputSchema: { properties } }, operations[tool.name] === "messages.send");
  return {
    method: "tools.call",
    ...identity ? { toolIdentity: identity } : {},
    tool: tool.name,
    toolReadOnly: annotations.readOnlyHint === true,
    ...write ? { write } : {},
    arguments: [{ name: "args", type: "object", optional: false, open: schema.additionalProperties !== false, parameters }],
    example: `await turn.tools.call(${JSON.stringify(tool.name)}, ${JSON.stringify(input)});`,
    docs: "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    reference: "for-ai-sdk-agent.md#\u52A8\u6001-mcp",
    note: "\u4EE5\u672C\u6B21\u6388\u6743\u76EE\u5F55\u4E2D\u7684 inputSchema \u4E3A\u51C6\uFF1B\u793A\u4F8B\u662F\u5F85\u66FF\u6362\u7684\u7ED3\u6784\uFF0C\u4E0D\u4FDD\u8BC1\u6EE1\u8DB3 oneOf \u7B49\u7EC4\u5408\u9650\u5236\u3002\u666E\u901A App \u4F18\u5148\u4F7F\u7528\u5177\u540D HTTP \u65B9\u6CD5\u3002",
    authorization: {
      alternatives: policy ? policy.tokens.filter(isIdentity).filter((name) => !identity || name === identity).map((identity2) => ({ identity: identity2, requiredScopes: [...policy.permissions] })) : [],
      note: policy ? "scope \u4E0D\u7B49\u4E8E\u8D44\u6E90\u53EF\u89C1\u6027\uFF1B\u4E0D\u5F97\u5207\u6362\u8EAB\u4EFD\u7ED5\u8FC7\u62D2\u7EDD\u3002" : "\u6B64\u52A8\u6001\u5DE5\u5177\u7684 scope \u672A\u767B\u8BB0\u5728\u5F53\u524D SDK \u4E2D\uFF1B\u8BFB\u53D6\u5F53\u524D\u6388\u6743\u76EE\u5F55\uFF0C\u4E0D\u63A8\u65AD\u65E0\u987B\u6388\u6743\u3002",
      recovery: "\u91CD\u65B0\u8BFB\u53D6\u5F53\u524D\u6388\u6743 tools/list\uFF1B\u6838\u5BF9 Manifest\u3001\u5B89\u88C5\u6279\u51C6\u3001\u7528\u6237\u540C\u610F\u53CA\u6709\u6548\u4E0A\u4E0B\u6587\u3002\u5DE5\u5177\u4E0D\u5728\u76EE\u5F55\u65F6\u505C\u6B62\uFF0C\u4E0D\u7ED5\u8FC7\u76EE\u5F55\u76F4\u63A5\u8C03\u7528\u3002"
    }
  };
}
function methodUsage(inputName, identities, identityHint) {
  if (typeof inputName !== "string") return void 0;
  let name = inputName;
  const explicit = /^(user|app)\.(.+)$/.exec(name || "");
  if (explicit && isIdentity(explicit[1])) identityHint = explicit[1];
  const publicName = name;
  if (explicit) name = explicit[2];
  const turnRead = name === "source.listMessages";
  if (turnRead && (explicit || identityHint)) return void 0;
  const lookup = turnRead ? "topics.listMessages" : name;
  const guide = Object.hasOwn(guides, lookup || "") && guides[lookup];
  if (!guide) return void 0;
  const entry = routes[guide.route];
  const branch = guide.operation && entry?.readPolicies?.[guide.operation];
  const alternatives = entry ? (branch ? [branch] : [entry.policy, ...entry.alternatives || []]).flatMap((p) => p.tokens.filter(isIdentity).filter((identity) => !identityHint || identityHint === identity).map((identity) => ({
    identity,
    requiredScopes: [...p.permissions],
    ...identities ? { identityAvailable: Array.isArray(identities[identity]), missingScopes: p.permissions.filter((s) => !identities[identity]?.includes(s)) } : {}
  }))) : [];
  const write = writeUsage(guide.route === "PUT /app-files/:fileId/content" ? "POST /app-files" : guide.route);
  const metadata = structuredClone(guide);
  if (turnRead) {
    const dm = guides["directMessages.list"];
    metadata.arguments = [{
      name: "options",
      type: "TopicReadOptions | DirectMessageReadOptions",
      optional: true,
      open: false,
      parameters: [
        ...metadata.arguments[0].parameters.filter((p) => ["limit", "cursor"].includes(p.name)),
        ...dm.arguments[0].parameters.filter((p) => ["beforeId", "afterId"].includes(p.name))
      ]
    }];
    metadata.reference = "for-ai-sdk-events.md#\u8BFB\u53D6\u5F53\u524D\u6765\u6E90";
  }
  return {
    ...metadata,
    ...write ? { write } : {},
    method: publicName,
    example: turnRead ? `await turn.${name}({ limit: 20 });` : identityHint && guide.identityExamples?.[identityHint] || guide.example,
    authorization: {
      alternatives,
      note: turnRead ? "SDK \u6839\u636E\u5DF2\u9A8C\u7B7E\u7684\u539F\u6765\u6E90\u56FA\u5B9A\u8EAB\u4EFD\uFF1A\u516C\u5171\u8BDD\u9898\u7528 A\uFF0C\u79C1\u5BC6\u8BDD\u9898\u53CA\u79C1\u804A\u7528\u672C\u8F6E U\uFF1B\u6743\u9650\u6309\u6765\u6E90\u5206\u522B\u8981\u6C42\uFF0C\u4E0D\u662F\u540C\u65F6\u7533\u8BF7\u4E24\u79CD\u6743\u9650\u3002\u65E7\u8BDD\u9898\u4E8B\u4EF6\u7F3A\u5C11\u53EF\u89C1\u6027\u65F6\u660E\u786E\u62D2\u7EDD\uFF0C\u4E0D\u63A8\u6D4B\u8EAB\u4EFD\u3002" : "\u8C03\u7528\u8DEF\u5F84\u56FA\u5B9A\u8EAB\u4EFD\uFF0C\u6240\u9700 scope \u5FC5\u987B\u5168\u90E8\u5177\u5907\u3002\u516C\u5F00\u8981\u6C42\u4E0D\u8BC1\u660E\u5F53\u524D\u5DF2\u83B7\u6388\u6743\u6216\u8D44\u6E90\u53EF\u89C1\uFF1B\u5931\u8D25\u4E0D\u5207\u6362\u8EAB\u4EFD\u3002",
      recovery: "\u5E94\u7528\u6743\u9650\u9700 Manifest \u58F0\u660E\u5E76\u7531\u5B89\u88C5\u6279\u51C6\uFF1B\u7528\u6237\u6743\u9650\u8FD8\u9700\u5F53\u524D\u7528\u6237\u540C\u610F\u53CA\u6709\u6548\u7528\u6237\u6267\u884C/\u9875\u9762/\u540E\u53F0\u4E0A\u4E0B\u6587\u3002\u8865\u6743\u540E\u91CD\u65B0\u5EFA\u7ACB\u6709\u6548\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u91CD\u653E\u65E7\u51ED\u636E\u3002"
    }
  };
}
function safeMethodUsage2(input, secrets = []) {
  const value = record(input), mcp = value.method === "tools.call";
  if (mcp) {
    const arg = record(Array.isArray(value.arguments) ? value.arguments[0] : void 0);
    const fields = (Array.isArray(arg.parameters) ? arg.parameters.slice(0, 40) : []).map(record);
    return toolUsage({ name: value.tool, annotations: { readOnlyHint: value.toolReadOnly === true }, inputSchema: {
      additionalProperties: arg?.open !== false,
      properties: Object.fromEntries(fields.filter((p) => p && typeof p.name === "string").map((p) => [p.name, { type: p.type, description: p.description }])),
      required: fields.filter((p) => p.required === true).map((p) => p.name)
    } }, secrets, isIdentity(value.toolIdentity) ? value.toolIdentity : void 0);
  }
  const safe = methodUsage(value?.method);
  if (!safe) return void 0;
  for (const branch of safe.authorization.alternatives) {
    const authorization = record(value.authorization);
    const supplied = (Array.isArray(authorization.alternatives) ? authorization.alternatives : []).map(record).find((p) => p.identity === branch.identity && Array.isArray(p.requiredScopes) && p.requiredScopes.length === branch.requiredScopes.length && p.requiredScopes.every((s) => typeof s === "string" && branch.requiredScopes.includes(s)));
    if (supplied && typeof supplied.identityAvailable === "boolean") branch.identityAvailable = supplied.identityAvailable;
    const missing = supplied?.missingScopes;
    if (Array.isArray(missing)) branch.missingScopes = branch.requiredScopes.filter((s) => missing.includes(s));
  }
  return safe;
}

// src/diagnostics/error-projection.mts
installUsageProjection(safeMethodUsage2);

// src/shared/permissions.mts
var Permission = Object.freeze({
  "MessagesReadPrivate": "messages:read-private",
  "MessagesReadPublic": "messages:read-public",
  "MessagesWrite": "messages:write",
  "MessagesDraft": "messages:draft",
  "MessagesReceive": "messages:receive",
  "ChannelsReadPublicMembers": "channels:read-public-members",
  "ChannelsReadUnread": "channels:read-unread",
  "FilesRead": "files:read",
  "FilesUpload": "files:upload",
  "TasksRead": "tasks:read",
  "TasksManage": "tasks:manage",
  "TasksExecute": "tasks:execute",
  "ContactsSelect": "contacts:select",
  "ProjectsList": "projects:list",
  "ChannelsList": "channels:list",
  "TopicsList": "topics:list",
  "AppsRead": "apps:read",
  "AppsCall": "apps:call",
  "AppManage": "app:manage"
});

// src/shared/manifest-values.mts
var AppTag = Object.freeze({
  "App": "App",
  "Agent": "Agent"
});
var InstallationScope = Object.freeze({
  "Personal": "personal",
  "Project": "project"
});
var ViewContainer = Object.freeze({
  "PageContent": "page_content",
  "SidePanel": "side_panel",
  "ModalDialog": "modal_dialog",
  "EmbeddedCard": "embedded_card",
  "EmojiPanel": "emoji_panel"
});
var NavigationParent = Object.freeze({
  "Primary": "nav.primary",
  "Home": "nav.home",
  "Project": "nav.project"
});
var ViewRenderer = Object.freeze({
  "App": "app"
});
var ProtocolVersion = Object.freeze({
  "ManifestV2_0_0": "2.0.0",
  "EventsV2_0_0": "2.0.0",
  "UiV1_0_0": "1.0.0",
  "ExtensionPointV1_0_0": "1.0.0",
  "BridgeV1_0_0": "1.0.0"
});
var ExtensionPoint = Object.freeze({
  "AppHome": "colink.app.home",
  "NavigationModules": "colink.navigation.modules",
  "MessageActions": "colink.message.actions",
  "DmActions": "colink.dm.actions",
  "TopicActions": "colink.topic.actions",
  "TaskActions": "colink.task.actions",
  "ProjectSpaceCards": "colink.project.space.cards",
  "MarketProviders": "colink.market.providers",
  "EmojiTabs": "colink.emoji.tabs"
});
var ApiContextVersion = Object.freeze({
  "V1": 1,
  "V2": 2
});

// src/shared/errors.mts
var guidance = {
  PAGE_CONFIG_UNAVAILABLE: ["\u65E0\u6CD5\u8BFB\u53D6\u9875\u9762\u516C\u5F00\u8FDE\u63A5\u914D\u7F6E\u3002", "\u68C0\u67E5 App \u662F\u5426\u63D0\u4F9B /page-config.json\uFF1B\u81EA\u5B9A\u4E49\u90E8\u7F72\u53EF\u663E\u5F0F\u4F20\u5165 hostOrigin \u548C issuer\u3002"],
  PAGE_CONFIG_INVALID: ["\u9875\u9762\u516C\u5F00\u8FDE\u63A5\u914D\u7F6E\u6216\u914D\u7F6E\u8DEF\u5F84\u65E0\u6548\u3002", "\u914D\u7F6E\u987B\u5305\u542B hostOrigin \u548C issuer\uFF1BconfigUrl \u4F7F\u7528\u540C\u6E90\u6839\u8DEF\u5F84\uFF0C\u4F8B\u5982 /settings/page.json\u3002"],
  PAGE_INVALID_OPTIONS: ["\u9875\u9762\u5BA2\u6237\u7AEF\u521D\u59CB\u5316\u9009\u9879\u65E0\u6548\u3002", "\u9009\u62E9\u9ED8\u8BA4\u914D\u7F6E\u3001\u663E\u5F0F hostOrigin/issuer \u6216 connection/issuer \u4E2D\u4E00\u79CD\u65B9\u5F0F\uFF0C\u4E0D\u6DF7\u7528\u8FDE\u63A5\u6765\u6E90\u3002"],
  authorization_required: ["\u7F3A\u5C11\u672C\u64CD\u4F5C\u6240\u9700\u7684\u6388\u6743\u3002", "\u6838\u5BF9\u5DE5\u5177\u76EE\u5F55\u3001\u58F0\u660E\u4E0E\u5B9E\u9645\u6279\u51C6\u7684 scope\uFF1B\u6309\u6B63\u5E38\u6388\u6743\u6D41\u7A0B\u83B7\u53D6\u540C\u610F\uFF0C\u4E0D\u6362\u8EAB\u4EFD\u7ED5\u8FC7\u3002"],
  authorization_expired: ["\u5F53\u524D\u8EAB\u4EFD\u6216\u9875\u9762\u51ED\u636E\u5DF2\u5931\u6548\u3002", "\u505C\u6B62\u65E7\u6267\u884C\uFF1B\u5728\u6709\u6548\u9875\u9762\u91CD\u65B0\u767B\u5F55\u6216\u7531\u5E73\u53F0\u91CD\u65B0\u89E6\u53D1\uFF0C\u4E0D\u91CD\u653E\u65E7\u51ED\u636E\u3002"],
  authorization_inactive: ["\u5F53\u524D\u7528\u6237\u6267\u884C\u6216\u6388\u6743\u5DF2\u7ED3\u675F\u3001\u64A4\u9500\u6216\u5931\u6548\u3002", "\u505C\u6B62\u672C\u8F6E\u53D7\u4FDD\u62A4\u64CD\u4F5C\uFF0C\u91CD\u65B0\u53D6\u5F97\u6709\u6548\u6388\u6743\uFF1B\u4E0D\u8981\u56DE\u9000\u5230\u5E94\u7528\u8EAB\u4EFD\u3002"],
  installation_unavailable: ["\u5E94\u7528\u5B89\u88C5\u5F53\u524D\u4E0D\u53EF\u7528\u6216\u6388\u6743\u7248\u672C\u5DF2\u53D8\u5316\u3002", "\u68C0\u67E5\u76EE\u6807\u5B89\u88C5\u3001\u6279\u51C6\u6743\u9650\u4E0E ready \u72B6\u6001\uFF1B\u4F7F\u7528\u5F53\u524D\u7248\u672C\u91CD\u65B0\u8FDE\u63A5\u3002"],
  access_denied: ["\u5F53\u524D\u8EAB\u4EFD\u4E0D\u80FD\u8BBF\u95EE\u8BE5\u8D44\u6E90\u6216\u6267\u884C\u6B64\u64CD\u4F5C\u3002", "\u6838\u5BF9\u8D44\u6E90 ID\u3001\u5B89\u88C5\u8303\u56F4\u3001\u5DE5\u5177\u652F\u6301\u7684\u8EAB\u4EFD\u4E0E\u8D44\u6E90\u53EF\u89C1\u6027\uFF1B\u62D2\u7EDD\u4E0D\u8868\u660E\u8D44\u6E90\u662F\u5426\u5B58\u5728\uFF0C\u4E0D\u76F2\u76EE\u539F\u6837\u91CD\u8BD5\u3002"],
  unavailable: ["\u672C\u6B21\u8C03\u7528\u672A\u53D6\u5F97\u53EF\u7528\u7ED3\u679C\u3002", "\u68C0\u67E5\u670D\u52A1\u72B6\u6001\u4E0E requestId\u3002\u5199\u5165\u53EF\u80FD\u5DF2\u53D1\u751F\uFF0C\u5148\u67E5\u8BE2\u56DE\u6267\u6216\u6309\u5DF2\u58F0\u660E\u7684\u5E42\u7B49\u534F\u8BAE\u6062\u590D\uFF0C\u4E0D\u76F2\u76EE\u91CD\u505A\u3002"],
  invalid_request: ["\u8BF7\u6C42\u53C2\u6570\u6216\u5F53\u524D\u8C03\u7528\u72B6\u6001\u4E0D\u7B26\u5408\u63A5\u53E3\u8981\u6C42\u3002", "\u6839\u636E\u5DE5\u5177\u53C2\u6570\u5B9A\u4E49\u4E0E\u8FD4\u56DE\u7684\u5B57\u6BB5\u8BF4\u660E\u4FEE\u6B63\u8BF7\u6C42\u540E\u518D\u8C03\u7528\u3002"]
};
var specific = {
  SOURCE_READ_IDENTITY_UNAVAILABLE: ["\u539F\u8BDD\u9898\u7F3A\u5C11\u53EF\u4FE1\u7684\u9891\u9053\u53EF\u89C1\u6027\uFF0C\u65E0\u6CD5\u786E\u5B9A\u8BFB\u53D6\u8EAB\u4EFD\u3002", "\u7B49\u5F85\u5E26\u5B8C\u6574\u6765\u6E90\u7684\u65B0\u4E8B\u4EF6\uFF1B\u4E0D\u8981\u731C\u6D4B\u8EAB\u4EFD\u3001\u5207\u6362\u5BA2\u6237\u7AEF\u6216\u8FFD\u52A0\u76EE\u5F55\u6743\u9650\u3002\u5F53\u524D\u4E8B\u4EF6\u4ECD\u53EF\u6309\u539F\u6388\u6743\u56DE\u590D\u3002"],
  INVALID_BACKGROUND_QUERY: ["\u540E\u53F0\u59D4\u6258\u67E5\u8BE2\u53C2\u6570\u65E0\u6548\u3002", "findActive \u9700\u8981 installationId \u548C userId\uFF1Blist \u9700\u8981 installationId\uFF0C\u53EF\u9009 limit \u4E3A 1\u2013100\u3001cursor \u4E3A\u4E0A\u9875 nextCursor\u3002\u4E0D\u8981\u4F20\u5165\u5176\u4ED6\u5B57\u6BB5\u3002"],
  BACKGROUND_PLATFORM_UNAVAILABLE: ["\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\u5E73\u53F0\u540E\u53F0\u59D4\u6258\u670D\u52A1\u3002", "\u4FDD\u7559\u5F53\u524D grantId \u548C\u6301\u4E45\u72B6\u6001\uFF0C\u8FDE\u63A5\u6062\u590D\u540E\u91CD\u8BD5\uFF1B\u4E0D\u8981\u91CD\u5EFA\u6388\u6743\u6216\u5207\u6362\u8EAB\u4EFD\u3002"],
  BACKGROUND_AUTHORIZATION_REQUIRED: ["\u540E\u53F0\u59D4\u6258\u6216\u51ED\u636E\u5DF2\u5931\u6548\u3002", "\u67E5\u8BE2\u5B89\u88C5\u7684\u540E\u53F0\u59D4\u6258\u5E76\u6838\u5BF9\u72B6\u6001\uFF1B\u64A4\u9500\u540E\u987B\u7531\u7528\u6237\u91CD\u65B0\u6279\u51C6\u5E76\u660E\u786E\u7ED1\u5B9A\u65B0 grantId\uFF0C\u4E0D\u56DE\u9000\u5E94\u7528\u8EAB\u4EFD\u3002"],
  INVALID_EVENT_RESULT: ["onEvent \u5904\u7406\u5668\u8FD4\u56DE\u4E86\u975E void \u7684\u7ED3\u679C\u3002", "\u5B8C\u6210\u4E1A\u52A1\u540E\u8FD4\u56DE void\uFF1Bapp.user_message_received \u4F7F\u7528 await reply({text}) \u6682\u5B58\u56DE\u590D\uFF0C\u5176\u4ED6\u4E8B\u4EF6\u901A\u8FC7\u5BF9\u5E94\u4E1A\u52A1\u65B9\u6CD5\u63D0\u4EA4\u7ED3\u679C\u3002\u8FD4\u56DE\u6587\u672C\u4EC5\u9002\u7528\u4E8E Agent.runTurn\u3002"],
  CLIENT_IDENTITY_UNAVAILABLE: ["\u5F53\u524D\u4E0A\u4E0B\u6587\u6CA1\u6709\u6240\u9009\u8EAB\u4EFD\u7684\u6388\u6743\u3002", "\u4F7F\u7528\u5339\u914D\u7684\u53EF\u4FE1\u9875\u9762\u3001\u540E\u53F0\u6388\u6743\u3001\u5B89\u88C5\u6216\u4E8B\u4EF6\u4E0A\u4E0B\u6587\uFF1B\u7F3A\u5C11\u7528\u6237\u6388\u6743\u65F6\u91CD\u65B0\u6388\u6743\uFF0C\u4E0D\u56DE\u9000\u5E94\u7528\u8EAB\u4EFD\u3002"],
  CLIENT_EXECUTION_INACTIVE: ["\u6B64 Client \u6240\u5C5E\u7684\u6267\u884C\u5DF2\u7ED3\u675F\u6216\u53D6\u6D88\u3002", "\u68C0\u67E5\u53D6\u6D88\u4FE1\u53F7\u3001\u8C03\u7528\u671F\u9650\u548C\u8FD0\u884C\u65F6\u72B6\u6001\uFF1B\u4E8B\u4EF6\u6216 Provider \u7684 Client \u53EA\u80FD\u5728\u539F\u56DE\u8C03\u5185\u4F7F\u7528\u3002"],
  INVALID_CLIENT_BINDING: ["Client \u7ED1\u5B9A\u53C2\u6570\u4E0D\u5408\u6CD5\u3002", "\u53EA\u63D0\u4F9B request\u3001installationId \u6216 grantId \u4E2D\u7684\u4E00\u9879\uFF1B\u4E0D\u8981\u4F20\u5165 userId \u6216 Token\u3002"],
  INVALID_CLIENT_OPTIONS: ["Client \u6267\u884C\u9009\u9879\u4E0D\u5408\u6CD5\u3002", "signal \u5FC5\u987B\u662F AbortSignal\uFF1BtimeoutMs \u5FC5\u987B\u4E3A 1\u20131800000 \u7684\u6574\u6570\u3002"],
  PLATFORM_RESPONSE_INVALID: ["\u5E73\u53F0\u6210\u529F\u54CD\u5E94\u4E0D\u7B26\u5408\u63A5\u53E3\u7684\u6570\u636E\u7ED3\u6784\u3002", "\u4FDD\u7559 requestId \u5E76\u6838\u5BF9\u5E73\u53F0\u4E0E SDK \u7248\u672C\uFF1B\u4E0D\u8981\u628A\u683C\u5F0F\u9519\u8BEF\u5F53\u4F5C\u7A7A\u6570\u636E\u6216\u6539\u7528 MCP \u731C\u6D4B\u89E3\u6790\u3002"],
  PAGINATION_CURSOR_REPEATED: ["\u5E73\u53F0\u5206\u9875\u8FD4\u56DE\u4E86\u91CD\u590D\u6E38\u6807\uFF0C\u8BFB\u53D6\u672A\u5B8C\u6210\u3002", "\u505C\u6B62\u7FFB\u9875\u5E76\u8BB0\u5F55\u8BCA\u65AD\uFF1B\u4E0D\u8981\u628A\u5DF2\u8BFB\u53D6\u7684\u90E8\u5206\u6570\u636E\u5F53\u4F5C\u5B8C\u6574\u7ED3\u679C\u3002"],
  PAGINATION_INCOMPLETE: ["\u5DF2\u8FBE\u5230\u672C\u6B21\u8BFB\u53D6\u7684\u9875\u6570\u4E0A\u9650\uFF0C\u4ECD\u6709\u66F4\u591A\u6570\u636E\u3002", "\u7F29\u5C0F\u67E5\u8BE2\u8303\u56F4\uFF0C\u6216\u663E\u5F0F\u589E\u52A0 maxPages\uFF1B\u4EC5\u5728\u904D\u5386\u6B63\u5E38\u7ED3\u675F\u540E\u58F0\u660E\u8BFB\u53D6\u5B8C\u6210\u3002"],
  INVALID_PAGINATION: ["\u5206\u9875\u4E0A\u9650\u683C\u5F0F\u4E0D\u6B63\u786E\u3002", "maxPages \u5FC5\u987B\u4E3A\u6B63\u6574\u6570\uFF1B\u9700\u8981\u53D6\u6D88\u7FFB\u9875\u65F6\u4F20\u5165 AbortSignal\u3002"],
  STEER_RECEIPT_INVALID: ["Agent \u672A\u786E\u8BA4\u8865\u5145\u8F93\u5165\u7684\u6295\u9012\u7ED3\u679C\u3002", "steer \u4EC5\u8FD4\u56DE true\uFF08\u5DF2\u63A5\u6536\uFF09\u6216 false\uFF08\u786E\u5B9A\u672A\u63D0\u4EA4\uFF09\uFF1B\u7ED3\u679C\u4E0D\u786E\u5B9A\u5E94\u629B\u9519\u5E76\u505C\u6B62\u672C\u8F6E\uFF0C\u4E0D\u81EA\u52A8\u91CD\u653E\u3002"],
  INTERACTION_STATUS_MANAGED: ["\u672C\u8F6E\u72B6\u6001\u7531 SDK \u81EA\u52A8\u7BA1\u7406\uFF0C\u4E0D\u80FD\u6DF7\u7528\u624B\u52A8\u5E8F\u53F7\u3002", '\u7B49\u5F85\u786E\u8BA4\u65F6\u8C03\u7528 turn.setDisplayStatus("suspended")\uFF0C\u7EE7\u7EED\u65F6\u4F20 "processing"\uFF1B\u9700\u8981\u81EA\u884C\u7BA1\u7406\u5B8C\u6574\u751F\u547D\u5468\u671F\u65F6\u8BBE\u7F6E config.interactionStatus=false\u3002'],
  INVALID_INTERACTION_STATUS: ["\u4E1A\u52A1\u53EA\u80FD\u5C06\u672C\u8F6E\u5207\u6362\u4E3A processing \u6216 suspended\u3002", "\u4F20\u5165 processing \u6216 suspended\uFF1B\u56DE\u8C03\u7ED3\u675F\u3001\u5931\u8D25\u548C\u53D6\u6D88\u7531 SDK \u6536\u5C3E\uFF0C\u4E0D\u81EA\u884C\u8BBE\u7F6E finished\u3002"],
  INTERACTION_STATUS_RESPONSE_INVALID: ["\u5E73\u53F0\u672A\u8FD4\u56DE\u4E0E\u672C\u6B21\u72B6\u6001\u4E0A\u62A5\u5339\u914D\u7684\u56DE\u6267\u3002", "\u68C0\u67E5\u5E73\u53F0\u7248\u672C\u53CA\u54CD\u5E94\uFF1BSDK \u4EE5\u539F\u5E8F\u53F7\u548C\u5E42\u7B49\u952E\u6709\u9650\u91CD\u8BD5\uFF0C\u4E0D\u628A\u6B64\u54CD\u5E94\u89C6\u4E3A\u5DF2\u663E\u793A\u72B6\u6001\u3002"],
  INTERACTION_STATUS_EXPIRED: ["\u72B6\u6001\u4E0A\u62A5\u6062\u590D\u7A97\u53E3\u5DF2\u7ED3\u675F\u3002", "\u505C\u6B62\u91CD\u8BD5\u65E7\u56DE\u5408\uFF1B\u8FD9\u4E0D\u4F1A\u91CD\u65B0\u6267\u884C\u6A21\u578B\u6216\u5EF6\u957F\u5E73\u53F0\u6388\u6743\uFF0C\u754C\u9762\u6700\u7EC8\u6309\u5E73\u53F0\u671F\u9650\u6E05\u7406\u3002"],
  RESOURCE_UNAVAILABLE: ["\u8BE5\u8D44\u6E90\u5728\u5F53\u524D\u8EAB\u4EFD\u548C\u5DE5\u5177\u8303\u56F4\u5185\u4E0D\u53EF\u7528\u3002", "\u6838\u5BF9\u76EE\u6807 topicId/channelId \u4E0E\u5B89\u88C5\u8303\u56F4\u3002\u516C\u5171\u8BFB\u53D6\u4E0E\u79C1\u5BC6\u8BFB\u53D6\u662F\u4E0D\u540C\u8D44\u6E90\u8FB9\u754C\uFF1B\u4E0D\u8981\u628A\u66F4\u591A\u6743\u9650\u5F53\u4F5C\u53EF\u8BFB\u5168\u90E8\u8D44\u6E90\uFF0C\u4E5F\u4E0D\u8981\u731C\u6D4B\u5176\u4ED6 ID\u3002"],
  INVALID_EXTERNAL_URL: ["\u5F53\u524D\u5916\u94FE\u5730\u5740\u4E0D\u53D7\u652F\u6301\u3002", "\u8BF7\u4F7F\u7528\u7EDD\u5BF9 HTTPS URL\u3002\u4EC5\u5728\u672C\u5730\u56DE\u73AF HTTP \u5BBF\u4E3B\u4E2D\uFF0C\u53EF\u4EE5\u6253\u5F00\u5F53\u524D\u56DE\u73AF App \u7684\u540C\u6E90 HTTP URL\u3002"],
  INVALID_HOST_ORIGIN: ["\u53EF\u4FE1\u5BBF\u4E3B\u5730\u5740\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u6216\u672C\u5730 HTTP \u5F00\u5173\u672A\u542F\u7528\u3002", "\u4F7F\u7528\u90E8\u7F72\u63D0\u4F9B\u7684\u7CBE\u786E HTTPS origin\uFF1B\u4EC5\u672C\u5730\u56DE\u73AF\u6D4B\u8BD5\u6309\u53EF\u4FE1\u914D\u7F6E\u542F\u7528 allowInsecureLocal\uFF0C\u4E0D\u4ECE URL \u53C2\u6570\u731C\u6D4B\u5BBF\u4E3B\u3002"],
  BRIDGE_TIMEOUT: ["\u5BBF\u4E3B\u63E1\u624B\u6216\u521D\u59CB\u5316\u672A\u5728\u65F6\u9650\u5185\u5B8C\u6210\u3002", "\u68C0\u67E5\u5BBF\u4E3B\u4E0E App \u7684 origin\u3001iframe \u52A0\u8F7D\u53CA\u6D4F\u89C8\u5668\u9519\u8BEF\uFF1B\u91CD\u65B0\u6253\u5F00\u9875\u9762\uFF0C\u4E0D\u628A\u72EC\u7ACB\u9875\u6216\u9690\u85CF DOM \u5F53\u4F5C\u63A5\u5165\u6210\u529F\u3002"],
  EVENT_CANCELLED: ["\u539F\u4E8B\u4EF6\u5BF9\u5E94\u7684\u6267\u884C\u8F6E\u6B21\u5DF2\u7ECF\u505C\u6B62\u3002", "\u505C\u6B62\u540E\u7EED\u5DE5\u4F5C\uFF0C\u4E0D\u53D1\u9001\u8FDF\u5230\u7ED3\u679C\uFF1B\u5DF2\u53D1\u51FA\u7684\u5916\u90E8\u526F\u4F5C\u7528\u987B\u7531 App \u6838\u5BF9\u3002\u65B0\u4EFB\u52A1\u8F6E\u6B21\u4F7F\u7528\u65B0\u7684 executionEpoch\u3002"],
  PAGE_INVALID_VIEW_DATA: ["View \u6570\u636E\u5FC5\u987B\u662F\u53D7\u9650\u7684 JSON \u5BF9\u8C61\u3002", "\u4F7F\u7528\u666E\u901A JSON \u5BF9\u8C61\uFF0C\u6DF1\u5EA6\u4E0D\u8D85\u8FC7 8\u3001UTF-8 \u4E0D\u8D85\u8FC7 16 KiB\uFF1B\u4E0D\u4F20\u539F\u578B\u952E\u3001\u5FAA\u73AF\u5F15\u7528\u6216\u975E JSON \u503C\u3002"],
  PAGE_BRIDGE_TIMEOUT: ["\u5BBF\u4E3B\u672A\u5728\u7B49\u5F85\u65F6\u95F4\u5185\u8FD4\u56DE\u64CD\u4F5C\u56DE\u6267\uFF0C\u7ED3\u679C\u53EF\u80FD\u672A\u77E5\u3002", "\u6838\u5BF9\u5B9E\u9645\u754C\u9762\u4E0E\u4E1A\u52A1\u7ED3\u679C\uFF1Bcomposer.send \u91CD\u8BD5\u4FDD\u7559\u539F operationId \u548C\u5185\u5BB9\uFF0C\u4E0D\u80FD\u6362\u6807\u8BC6\u518D\u6B21\u53D1\u9001\u3002"],
  PAGE_INVALID_COMPOSER_CONTENT: ["\u8F93\u5165\u6846\u5185\u5BB9\u6216\u64CD\u4F5C\u6807\u8BC6\u4E0D\u7B26\u5408\u8981\u6C42\u3002", "\u4F7F\u7528\u6301\u4E45 operationId\uFF0C\u6B63\u6587\u4E0D\u8D85\u8FC7 4000 \u5B57\u7B26\u3001\u56FE\u7247\u6700\u591A 4 \u5F20\u4E14\u5408\u8BA1\u4E0D\u8D85\u8FC7 10 MiB\uFF1B\u56FE\u7247\u4F7F\u7528\u652F\u6301\u7684 Blob\uFF0C\u4E0D\u6307\u5B9A\u53D1\u9001\u4EBA\u6216\u76EE\u6807\u3002"],
  PAGE_LOGIN_REQUIRED: ["\u5C1A\u672A\u5EFA\u7ACB\u5F53\u524D\u9875\u9762\u7684\u7528\u6237\u8EAB\u4EFD\u3002", "\u53EA\u9700\u8EAB\u4EFD\u65F6\u8C03\u7528 page.login\uFF0C\u9700\u8981\u4E1A\u52A1\u6743\u9650\u65F6\u8C03\u7528 page.authorize \u81EA\u52A8\u767B\u5F55\u5E76\u6388\u6743\uFF1B\u5171\u4EAB\u6570\u636E\u64CD\u4F5C\u7531\u540E\u7AEF pages.authenticate \u6838\u9A8C\u3002"],
  IDEMPOTENCY_KEY_REQUIRED: ["\u6B64\u5199\u64CD\u4F5C\u9700\u8981\u6709\u6548\u7684\u7A33\u5B9A\u4E1A\u52A1\u64CD\u4F5C\u6807\u8BC6 key\uFF0C\u4E0D\u662F API Key\u3002", "\u4F7F\u7528\u6301\u4E45\u4E1A\u52A1\u8BF7\u6C42 ID \u52A0\u64CD\u4F5C\u7528\u9014\uFF0C\u5982 request-42:create-task\uFF081\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF09\uFF1B\u540C\u4E00\u64CD\u4F5C\u59CB\u7EC8\u590D\u7528\uFF0C\u4E0D\u5728\u6BCF\u6B21\u91CD\u8BD5\u751F\u6210 UUID/\u65F6\u95F4\u6233\u3002\u4E0D\u540C\u64CD\u4F5C\u4F7F\u7528\u4E0D\u540C key\u3002"],
  WRITE_KEY_CONFLICT: ["\u6B64 key \u5DF2\u7528\u4E8E\u53C2\u6570\u4E0D\u540C\u7684\u5199\u5165\u3002", "\u6062\u590D\u539F\u64CD\u4F5C\u65F6\u4F7F\u7528\u539F\u53C2\u6570\u548C\u539F idempotencyKey\uFF1B\u53EA\u6709\u660E\u786E\u7684\u65B0\u4E1A\u52A1\u64CD\u4F5C\u624D\u80FD\u4F7F\u7528\u65B0 idempotencyKey\u3002\u539F\u64CD\u4F5C\u7ED3\u679C\u672A\u77E5\u65F6\u4E0D\u8981\u901A\u8FC7\u6362 idempotencyKey \u6216 HTTP/MCP \u91CD\u505A\u3002"],
  IDEMPOTENCY_KEY_CONFLICT: ["\u5E73\u53F0\u5E42\u7B49\u6807\u8BC6\u5DF2\u7528\u4E8E\u53C2\u6570\u4E0D\u540C\u7684\u5199\u5165\u3002", "\u6838\u5BF9\u539F\u64CD\u4F5C\u548C\u53C2\u6570\uFF1B\u4E0D\u8981\u901A\u8FC7\u6362 idempotencyKey \u6216 HTTP/MCP \u91CD\u505A\u7ED3\u679C\u672A\u77E5\u7684\u64CD\u4F5C\u3002"],
  IDEMPOTENCY_CONFLICT: ["\u5E73\u53F0\u5E42\u7B49\u6807\u8BC6\u5DF2\u7528\u4E8E\u53C2\u6570\u4E0D\u540C\u7684\u5199\u5165\u3002", "\u6838\u5BF9\u539F\u64CD\u4F5C\u548C\u53C2\u6570\uFF1B\u4E0D\u8981\u901A\u8FC7\u6362 idempotencyKey \u6216 HTTP/MCP \u91CD\u505A\u7ED3\u679C\u672A\u77E5\u7684\u64CD\u4F5C\u3002"],
  IDEMPOTENCY_EXPIRED: ["\u5E73\u53F0\u5199\u5165\u6062\u590D\u7A97\u53E3\u5DF2\u7ED3\u675F\uFF0C\u4E0D\u662F\u767B\u5F55\u8FC7\u671F\u3002", "\u505C\u6B62\u65E7\u64CD\u4F5C\u7684\u91CD\u8BD5\uFF0C\u6838\u5BF9\u4E1A\u52A1\u7ED3\u679C\uFF1B\u4E0D\u8981\u6362 idempotencyKey \u6216 HTTP/MCP \u91CD\u505A\u3002"],
  WRITE_RECOVERY_EXPIRED: ["\u8FD9\u7B14\u5199\u5165\u5DF2\u8D85\u8FC7 SDK \u7684\u5B89\u5168\u6062\u590D\u7A97\u53E3\uFF0C\u4E0D\u662F\u767B\u5F55\u8FC7\u671F\u3002", "\u505C\u6B62\u91CD\u8BD5\u65E7\u64CD\u4F5C\u5E76\u6838\u5BF9\u4E1A\u52A1\u7ED3\u679C\uFF1B\u91CD\u65B0\u767B\u5F55\u4E0D\u4F1A\u5EF6\u957F\u6062\u590D\u7A97\u53E3\u3002\u4E0D\u8981\u6362 idempotencyKey \u6216 HTTP/MCP \u91CD\u505A\uFF1B\u6CA1\u6709\u67E5\u8BE2\u63A5\u53E3\u65F6\u4FDD\u7559\u64CD\u4F5C\u6807\u8BC6\u4EA4\u7531\u64CD\u4F5C\u8005\u6838\u5BF9\u3002"],
  WRITE_PERSISTENCE_FAILED: ["SDK \u672A\u80FD\u6301\u4E45\u4FDD\u5B58\u5199\u5165\u72B6\u6001\u3002", "\u6839\u636E write.outcome \u533A\u5206\u5C1A\u672A\u53D1\u9001\u548C\u5DF2\u786E\u8BA4\u5199\u5165\uFF1B\u4FEE\u590D\u5B58\u50A8\u540E\u4FDD\u6301\u539F idempotencyKey\u3001\u539F\u53C2\u6570\uFF0C\u4E0D\u7528\u65B0 idempotencyKey \u91CD\u505A\u3002"],
  OUTPUT_KEY_CONFLICT: ["\u6B64\u9636\u6BB5\u8F93\u51FA key \u5DF2\u7528\u4E8E\u4E0D\u540C\u6B63\u6587\u3002", "\u6062\u590D\u539F\u9636\u6BB5\u65F6\u4FDD\u7559\u539F\u6B63\u6587\u548C\u539F idempotencyKey\uFF1B\u53EA\u6709\u65B0\u7684\u4E1A\u52A1\u9636\u6BB5\u4F7F\u7528\u65B0\u7684\u7A33\u5B9A idempotencyKey\uFF0C\u4E0D\u4EE5\u8C03\u7528\u987A\u5E8F\u6216\u6BCF\u6B21\u65B0\u5EFA UUID \u6807\u8BC6\u9636\u6BB5\u3002"],
  REPLY_RECOVERY_EXPIRED: ["\u5DF2\u6301\u4E45\u5316\u8F93\u51FA\u8D85\u8FC7\u5B89\u5168\u53D1\u9001\u6062\u590D\u7A97\u53E3\u3002", "\u505C\u6B62\u65E7\u8F93\u51FA\u7684\u53D1\u9001\u6062\u590D\u5E76\u6838\u5BF9\u8BDD\u9898\u4E2D\u7684\u5B9E\u9645\u7ED3\u679C\uFF1B\u91CD\u65B0\u767B\u5F55\u4E0D\u5EF6\u957F\u7A97\u53E3\uFF0C\u4E0D\u6362 idempotencyKey \u91CD\u505A\u7ED3\u679C\u672A\u77E5\u7684\u8F93\u51FA\u3002"],
  TOOL_UNAVAILABLE: ["\u5F53\u524D\u6388\u6743\u5DE5\u5177\u76EE\u5F55\u4E2D\u6CA1\u6709\u8FD9\u4E2A\u5DE5\u5177\u3002", "\u91CD\u65B0\u8BFB\u53D6\u5F53\u524D\u76EE\u5F55\u5E76\u6838\u5BF9\u5DE5\u5177\u540D\u3001\u8EAB\u4EFD\u4E0E\u6279\u51C6\u6743\u9650\uFF1B\u4E0D\u8981\u7ED5\u8FC7\u76EE\u5F55\u76F4\u63A5\u8C03\u7528\u3002"],
  PLATFORM_NETWORK_UNAVAILABLE: ["\u672A\u80FD\u53D6\u5F97\u5E73\u53F0\u54CD\u5E94\uFF0C\u6267\u884C\u7ED3\u679C\u53EF\u80FD\u672A\u77E5\u3002", "\u68C0\u67E5\u5E73\u53F0\u8FDE\u63A5\uFF1B\u8BFB\u53D6\u53EF\u4EE5\u5728\u6062\u590D\u540E\u91CD\u8BD5\uFF0C\u5199\u5165\u5148\u6838\u5BF9\u56DE\u6267\u548C\u5E42\u7B49\u7A97\u53E3\u3002"]
};
function safeText(value, max, secrets = []) {
  if (typeof value !== "string" || !value.trim() || value.length > max) return void 0;
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[redacted]");
  return text.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]");
}
function safeCardDiagnostic(input, secrets = []) {
  const value = record(input);
  if (typeof value.reason !== "string" || !["CARD_TARGET_UNSUPPORTED", "CARD_JSON_INVALID", "CARD_SCHEMA_INVALID", "CARD_VERSION_UNSUPPORTED", "CARD_EVENT_NOT_SUBSCRIBED", "CARD_PERMISSION_NOT_DECLARED", "CARD_PERMISSION_NOT_GRANTED", "CARD_IMAGE_UNAVAILABLE"].includes(value.reason)) return void 0;
  const field = safeText(value.field, 160, secrets);
  if (!field || !/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,159}$/.test(field)) return void 0;
  return {
    reason: value.reason,
    field,
    requiredEvents: (Array.isArray(value.requiredEvents) ? value.requiredEvents : []).filter((x) => x === "app.colink_ui_action_invoked").slice(0, 1),
    requiredScopes: (Array.isArray(value.requiredScopes) ? value.requiredScopes : []).filter((x) => x === "messages:write" || x === "messages:receive").slice(0, 2),
    docsUrl: "https://colink.link/docs/app-extensions/colink-for-ai.zip",
    example: safeText(value.example, 2e3, secrets)
  };
}
var CoLinkError = class extends Error {
  code;
  status;
  kind;
  hint;
  retryable;
  requestId;
  callId;
  card;
  usage;
  write;
  retryAfterSeconds;
  details;
  /** Safe diagnostic projection for a tool or page; excludes stack and transport options. */
  toJSON() {
    return errorBody(this);
  }
  constructor(code, status = 503, requestId, diagnostic = {}) {
    super(code);
    this.name = "CoLinkError";
    this.code = code;
    this.status = status;
    this.kind = /AUTHORIZATION_REQUIRED|SCOPE_MISSING|PERMISSION_MISSING/.test(code) ? "authorization_required" : ["WRITE_RECOVERY_EXPIRED", "IDEMPOTENCY_EXPIRED", "REPLY_RECOVERY_EXPIRED"].includes(code) ? "invalid_request" : /EXPIRED|UNAUTHORIZED/.test(code) || status === 401 ? "authorization_expired" : /REVOKED|EXECUTION_INACTIVE/.test(code) ? "authorization_inactive" : /INSTALLATION/.test(code) ? "installation_unavailable" : status === 403 || status === 404 ? "access_denied" : status === 429 || status >= 500 ? "unavailable" : "invalid_request";
    if (typeof requestId === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(requestId)) this.requestId = requestId;
    if (typeof diagnostic.callId === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(diagnostic.callId)) this.callId = diagnostic.callId;
    const defaults = Object.hasOwn(specific, code) ? specific[code] : guidance[this.kind];
    const message = safeText(diagnostic.message, 2e3) || defaults[0];
    this.message = message.startsWith(code + ": ") ? message : code + ": " + message;
    this.hint = safeText(diagnostic.hint, 2e3) || defaults[1];
    this.retryable = typeof diagnostic.retryable === "boolean" ? diagnostic.retryable : false;
    const card = safeCardDiagnostic(diagnostic.card);
    if (card) this.card = card;
    const usage = safeMethodUsage(diagnostic.usage);
    if (usage) this.usage = usage;
    const write = safeWriteRecovery(diagnostic.write);
    if (write) this.write = write;
    if (typeof diagnostic.retryAfterSeconds === "number" && Number.isSafeInteger(diagnostic.retryAfterSeconds) && diagnostic.retryAfterSeconds >= 0) this.retryAfterSeconds = diagnostic.retryAfterSeconds;
    if (Array.isArray(diagnostic.details)) {
      const fields = diagnostic.details.slice(0, 20).flatMap((input) => {
        const d = record(input), message2 = safeText(d.message, 500);
        return typeof d.field === "string" && /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,159}$/.test(d.field) && typeof d.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(d.code) && message2 ? [{ field: d.field, code: d.code, message: message2 }] : [];
      });
      if (fields.length) this.details = fields;
    }
  }
};
var fail = (code, status = 503) => new CoLinkError(code, status);
function responseError(input, status, { fallback = "PLATFORM_ERROR", secrets: rawSecrets = [] } = {}) {
  const value = record(input), secrets = rawSecrets.filter((value2) => typeof value2 === "string");
  const candidate = safeText(value.code, 80, secrets), code = candidate && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) ? candidate : fallback;
  return new CoLinkError(code, status, safeText(value?.requestId, 100, secrets), {
    message: safeText(value?.message, 2e3, secrets),
    hint: safeText(value?.hint, 2e3, secrets),
    callId: safeText(value?.callId, 100, secrets),
    card: safeCardDiagnostic(value?.card, secrets),
    retryable: value?.retryable,
    retryAfterSeconds: value?.retryAfterSeconds,
    usage: safeMethodUsage(value?.usage, secrets),
    write: safeWriteRecovery(value?.write, secrets),
    details: Array.isArray(value.details) ? value.details.slice(0, 20).map((input2) => {
      const d = record(input2);
      return { field: safeText(d.field, 160, secrets), code: safeText(d.code, 80, secrets), message: safeText(d.message, 500, secrets) };
    }) : void 0
  });
}
function errorBody(error2, fallback = "AGENT_UNAVAILABLE") {
  const safe = error2 instanceof CoLinkError ? error2 : fail(fallback);
  return {
    code: safe.code,
    message: safe.message,
    hint: safe.hint,
    retryable: safe.retryable,
    ...safe.card ? { card: safeCardDiagnostic(safe.card) } : {},
    ...safe.usage ? { usage: safeMethodUsage(safe.usage) } : {},
    ...safe.write ? { write: safeWriteRecovery(safe.write) } : {},
    ...safe.callId ? { callId: safe.callId } : {},
    ...safe.requestId ? { requestId: safe.requestId } : {},
    ...safe.details ? { details: safe.details } : {},
    ...safe.retryAfterSeconds === void 0 ? {} : { retryAfterSeconds: safe.retryAfterSeconds }
  };
}

// src/shared/message-mention-schema.mts
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
var id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,36}$/.test(value);
function parseMessageMentions(value) {
  if (!object(value) || !keys(value, ["version", "items"]) || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 100) return;
  const items = [];
  for (const item of value.items) {
    if (!object(item) || !keys(item, ["start", "end", "label", "target"]) || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || Number(item.start) < (items.at(-1)?.end ?? 0) || Number(item.end) <= Number(item.start) || typeof item.label !== "string" || !item.label.trim() || item.label.length > 255 || /[\r\n\u0000-\u001f]/.test(item.label) || !object(item.target)) return;
    const target = item.target;
    if (target.type === "user" && keys(target, ["type", "userId"]) && id(target.userId)) {
      items.push({ start: Number(item.start), end: Number(item.end), label: item.label, target: { type: "user", userId: target.userId } });
    } else if (target.type === "app" && keys(target, ["type", "installationId"]) && id(target.installationId)) {
      items.push({ start: Number(item.start), end: Number(item.end), label: item.label, target: { type: "app", installationId: target.installationId } });
    } else return;
  }
  return { version: 1, items };
}

// src/diagnostics/method-diagnostics.mts
function explainMethodError(error2, name, identities, identityHint, args) {
  const usage = methodUsage(name, identities, identityHint);
  if (!usage) return error2;
  if (!(error2 instanceof CoLinkError)) return error2;
  const safe = error2;
  const previous = safe.usage;
  safe.usage = usage;
  if (!identities && previous && previous.route === usage.route) safe.usage.authorization = previous.authorization;
  if (safe.code === "INVALID_RESOURCE" && !safe.details && args) {
    const field = usage.arguments[0]?.parameters.find((p) => (p.name === "id" || p.name.endsWith("Id")) && p.required && (() => {
      const value = record(args[0])[p.name];
      return typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value);
    })());
    if (field) safe.details = [{
      field: usage.arguments[0].name + "." + field.name,
      code: "INVALID_RESOURCE",
      message: field.description + " SDK \u8DEF\u5F84 ID \u8981\u6C42 1\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u6216\u8FDE\u5B57\u7B26\uFF1B\u63A5\u53E3\u53EF\u80FD\u6709\u66F4\u4E25\u683C\u7EA6\u675F\u3002"
    }];
  }
  return explainWriteFailure(safe, usage);
}
function validateArguments(guide, args) {
  for (const [index, argument] of guide.arguments.entries()) {
    const input = args[index];
    if (input === void 0 && argument.optional) continue;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new CoLinkError("INVALID_ARGUMENT", 400, void 0, { details: [{ field: argument.name, code: "OBJECT_REQUIRED", message: "\u6B64\u53C2\u6570\u5FC5\u987B\u4E3A\u5BF9\u8C61\uFF1B\u6309 usage.arguments \u548C usage.example \u586B\u5199\u3002" }] });
    }
    if (!argument.open) {
      const allowed = new Set(argument.parameters.map((parameter) => parameter.name));
      const field = Object.keys(input).find((name) => !allowed.has(name));
      if (field) throw new CoLinkError("INVALID_ARGUMENT", 400, void 0, { details: [{
        field: argument.name + "." + field,
        code: "UNKNOWN_FIELD",
        message: "\u6B64\u65B9\u6CD5\u4E0D\u63A5\u53D7\u8BE5\u5B57\u6BB5\uFF1B\u6309\u5F53\u524D\u65B9\u6CD5\u7B7E\u540D\u586B\u5199\uFF0C\u4E0D\u4F7F\u7528\u65E7\u7248\u53C2\u6570\u6216\u4F20\u8F93\u534F\u8BAE\u5B57\u6BB5\u3002"
      }] });
    }
  }
}
function withMethodDiagnostics(methods, prefix = "") {
  return Object.freeze(Object.fromEntries(Object.entries(methods).map(([key, entry]) => {
    const value = entry;
    const name = prefix + key;
    if (typeof value !== "function") {
      if (value === null || typeof value !== "object") throw new TypeError("Invalid internal method tree");
      return [key, withMethodDiagnostics(value, name + ".")];
    }
    const guide = methodUsage(name);
    if (!guide) return [key, value];
    if (name.endsWith(".iterate")) return [key, async function* (...args) {
      try {
        validateArguments(guide, args);
        const values = Reflect.apply(value, void 0, args);
        if (!isIterable(values)) throw new TypeError("Invalid internal iterator");
        yield* values;
      } catch (error2) {
        throw explainMethodError(error2, name, void 0, void 0, args);
      }
    }];
    return [key, async (...args) => {
      try {
        validateArguments(guide, args);
        return await Reflect.apply(value, void 0, args);
      } catch (error2) {
        throw explainMethodError(error2, name, void 0, void 0, args);
      }
    }];
  })));
}

// src/shared/wire-schemas.mts
var resultSchemas = [
  { "kind": "object", "fields": { "items": { "schema": 1, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 2 },
  { "kind": "object", "fields": { "projectId": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false } } },
  { "kind": "string" },
  { "kind": "union", "members": [5, 6] },
  { "kind": "literal", "value": false },
  { "kind": "literal", "value": true },
  { "kind": "union", "members": [8, 3] },
  { "kind": "literal", "value": null },
  { "kind": "object", "fields": { "items": { "schema": 10, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 11 },
  { "kind": "object", "fields": { "channelId": { "schema": 3, "optional": false }, "projectId": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false }, "visibility": { "schema": 12, "optional": false } } },
  { "kind": "union", "members": [13, 14] },
  { "kind": "literal", "value": "public" },
  { "kind": "literal", "value": "private" },
  { "kind": "object", "fields": { "mentionProtocol": { "schema": 16, "optional": true }, "items": { "schema": 19, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [17, 18] },
  { "kind": "undefined" },
  { "kind": "literal", "value": 1 },
  { "kind": "array", "item": 20 },
  { "kind": "object", "fields": { "type": { "schema": 21, "optional": false }, "id": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false }, "publicName": { "schema": 25, "optional": true }, "mention": { "schema": 3, "optional": false }, "isYou": { "schema": 4, "optional": false }, "participant": { "schema": 26, "optional": true }, "description": { "schema": 27, "optional": true }, "canReceiveAgentMention": { "schema": 26, "optional": true } } },
  { "kind": "union", "members": [22, 23, 24] },
  { "kind": "literal", "value": "user" },
  { "kind": "literal", "value": "agent" },
  { "kind": "literal", "value": "app" },
  { "kind": "union", "members": [17, 3] },
  { "kind": "union", "members": [17, 5, 6] },
  { "kind": "union", "members": [17, 8, 3] },
  { "kind": "object", "fields": { "channel": { "schema": 29, "optional": false }, "items": { "schema": 30, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "object", "fields": { "channelId": { "schema": 3, "optional": false }, "channelName": { "schema": 3, "optional": false } } },
  { "kind": "array", "item": 31 },
  { "kind": "object", "fields": { "mentions": { "schema": 32, "optional": true }, "messageId": { "schema": 3, "optional": false }, "revision": { "schema": 36, "optional": false }, "channelId": { "schema": 3, "optional": false }, "topicId": { "schema": 7, "optional": false }, "author": { "schema": 40, "optional": false }, "text": { "schema": 3, "optional": false }, "createdAt": { "schema": 3, "optional": false }, "recalled": { "schema": 4, "optional": false }, "sentToChannel": { "schema": 4, "optional": false }, "files": { "schema": 41, "optional": false }, "apps": { "schema": 44, "optional": false }, "quote": { "schema": 46, "optional": false }, "event": { "schema": 48, "optional": false }, "taskId": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [17, 33] },
  { "kind": "object", "fields": { "version": { "schema": 18, "optional": false }, "items": { "schema": 34, "optional": false } } },
  { "kind": "array", "item": 35 },
  { "kind": "object", "fields": { "start": { "schema": 36, "optional": false }, "end": { "schema": 36, "optional": false }, "label": { "schema": 3, "optional": false }, "target": { "schema": 37, "optional": false } } },
  { "kind": "number" },
  { "kind": "union", "members": [38, 39] },
  { "kind": "object", "fields": { "type": { "schema": 22, "optional": false }, "userId": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "type": { "schema": 24, "optional": false }, "installationId": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "type": { "schema": 21, "optional": false }, "id": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false } } },
  { "kind": "array", "item": 42 },
  { "kind": "object", "fields": { "fileId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false }, "sizeBytes": { "schema": 43, "optional": false } } },
  { "kind": "union", "members": [8, 36] },
  { "kind": "array", "item": 45 },
  { "kind": "object", "fields": { "appKey": { "schema": 3, "optional": false }, "resourceId": { "schema": 3, "optional": false }, "title": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [8, 47] },
  { "kind": "object", "fields": { "messageId": { "schema": 3, "optional": false }, "authorName": { "schema": 3, "optional": false }, "text": { "schema": 3, "optional": false }, "recalled": { "schema": 26, "optional": true } } },
  { "kind": "union", "members": [8, 49] },
  { "kind": "object", "fields": { "kind": { "schema": 3, "optional": false }, "taskId": { "schema": 7, "optional": false }, "summary": { "schema": 7, "optional": false } } },
  { "kind": "object", "fields": { "channel": { "schema": 29, "optional": false }, "unreadSnapshot": { "schema": 51, "optional": false }, "items": { "schema": 53, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "object", "fields": { "scope": { "schema": 52, "optional": false }, "readerUserId": { "schema": 3, "optional": false }, "readStateAvailable": { "schema": 4, "optional": false }, "readAt": { "schema": 7, "optional": false }, "capturedAt": { "schema": 3, "optional": false }, "unreadCount": { "schema": 43, "optional": false } } },
  { "kind": "literal", "value": "channel" },
  { "kind": "array", "item": 54 },
  { "kind": "object", "fields": { "messageId": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "topicId": { "schema": 3, "optional": false }, "createdAt": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "source": { "schema": 56, "optional": false }, "content": { "schema": 57, "optional": false } } },
  { "kind": "object", "fields": { "projectId": { "schema": 25, "optional": true }, "channelId": { "schema": 3, "optional": false }, "topicId": { "schema": 3, "optional": false }, "messageId": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "mentions": { "schema": 32, "optional": true }, "author": { "schema": 40, "optional": false }, "text": { "schema": 3, "optional": false }, "createdAt": { "schema": 3, "optional": false }, "recalled": { "schema": 4, "optional": false }, "files": { "schema": 58, "optional": false } } },
  { "kind": "array", "item": 59 },
  { "kind": "object", "fields": { "fileId": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "messageId": { "schema": 3, "optional": false }, "revision": { "schema": 36, "optional": false }, "channelId": { "schema": 3, "optional": false }, "topicId": { "schema": 7, "optional": false } } },
  { "kind": "object", "fields": { "messageId": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "recalledAt": { "schema": 3, "optional": false } } },
  { "kind": "intersection", "members": [63, 67] },
  { "kind": "object", "fields": { "topicId": { "schema": 25, "optional": true }, "channelId": { "schema": 25, "optional": true }, "fileIds": { "schema": 64, "optional": true }, "messageId": { "schema": 3, "optional": false } }, "values": 66 },
  { "kind": "union", "members": [17, 65] },
  { "kind": "array", "item": 3 },
  { "kind": "unknown" },
  { "kind": "object", "fields": { "messages": { "schema": 68, "optional": false } } },
  { "kind": "array", "item": 63 },
  { "kind": "object", "fields": { "items": { "schema": 70, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 71 },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "projectId": { "schema": 3, "optional": false }, "title": { "schema": 7, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 73, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 74 },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "revision": { "schema": 36, "optional": false }, "senderName": { "schema": 3, "optional": false }, "senderKind": { "schema": 3, "optional": false }, "text": { "schema": 3, "optional": false }, "mentions": { "schema": 32, "optional": true }, "truncated": { "schema": 4, "optional": false }, "attachments": { "schema": 75, "optional": false }, "createdAt": { "schema": 3, "optional": false } } },
  { "kind": "array", "item": 76 },
  { "kind": "object", "fields": { "artifactId": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 78, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 79 },
  { "kind": "object", "fields": { "userId": { "schema": 3, "optional": false }, "displayName": { "schema": 3, "optional": false }, "username": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "artifactId": { "schema": 3, "optional": false }, "mimeType": { "schema": 3, "optional": false }, "data": { "schema": 3, "optional": false } }, "values": 66 },
  { "kind": "object", "fields": { "items": { "schema": 82, "optional": false } } },
  { "kind": "array", "item": 83 },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "conversationId": { "schema": 3, "optional": false }, "senderId": { "schema": 3, "optional": false }, "senderKind": { "schema": 84, "optional": false }, "text": { "schema": 3, "optional": false }, "attachments": { "schema": 86, "optional": false }, "createdAt": { "schema": 3, "optional": false }, "recalledAt": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [23, 85] },
  { "kind": "literal", "value": "human" },
  { "kind": "array", "item": 87 },
  { "kind": "object", "fields": { "artifactId": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false }, "sizeBytes": { "schema": 88, "optional": true } } },
  { "kind": "union", "members": [17, 36] },
  { "kind": "object", "fields": { "bytes": { "schema": 90, "optional": false }, "contentType": { "schema": 3, "optional": false } } },
  { "kind": "bytes" },
  { "kind": "object", "fields": { "topicId": { "schema": 3, "optional": false }, "draftId": { "schema": 3, "optional": false }, "status": { "schema": 92, "optional": false }, "requiresConfirmation": { "schema": 6, "optional": false } } },
  { "kind": "literal", "value": "pending" },
  { "kind": "object", "fields": { "deploymentId": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "topicId": { "schema": 3, "optional": false }, "status": { "schema": 94, "optional": false }, "sequence": { "schema": 36, "optional": false }, "updatedAt": { "schema": 3, "optional": false }, "warnings": { "schema": 65, "optional": false } } },
  { "kind": "union", "members": [95, 96, 97] },
  { "kind": "literal", "value": "processing" },
  { "kind": "literal", "value": "suspended" },
  { "kind": "literal", "value": "finished" },
  { "kind": "object", "fields": { "accepted": { "schema": 6, "optional": false }, "duplicate": { "schema": 4, "optional": false } } },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "status": { "schema": 100, "optional": false }, "expiresAt": { "schema": 3, "optional": false }, "result": { "schema": 101, "optional": false } } },
  { "kind": "literal", "value": "completed" },
  { "kind": "object", "fields": { "operationId": { "schema": 3, "optional": false }, "status": { "schema": 102, "optional": false }, "message": { "schema": 7, "optional": false }, "replacement": { "schema": 105, "optional": false }, "completedAt": { "schema": 3, "optional": false } } },
  { "kind": "union", "members": [103, 104] },
  { "kind": "literal", "value": "succeeded" },
  { "kind": "literal", "value": "failed" },
  { "kind": "union", "members": [8, 106] },
  { "kind": "object", "fields": { "messageId": { "schema": 3, "optional": false }, "revision": { "schema": 36, "optional": false } } },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "status": { "schema": 3, "optional": false }, "expiresAt": { "schema": 25, "optional": true } } },
  { "kind": "object", "fields": { "items": { "schema": 109, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 110 },
  { "kind": "object", "fields": { "fileId": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false }, "mimeType": { "schema": 7, "optional": false }, "sizeBytes": { "schema": 36, "optional": false }, "sha256": { "schema": 7, "optional": false }, "sharedBy": { "schema": 40, "optional": false }, "sharedAt": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "content": { "schema": 7, "optional": false }, "totalCharacters": { "schema": 43, "optional": false }, "nextOffset": { "schema": 43, "optional": false }, "unreadableReason": { "schema": 112, "optional": false }, "image": { "schema": 118, "optional": false }, "images": { "schema": 120, "optional": true }, "download": { "schema": 17, "optional": true }, "fileId": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false }, "mimeType": { "schema": 7, "optional": false }, "sizeBytes": { "schema": 36, "optional": false }, "sha256": { "schema": 7, "optional": false }, "sharedBy": { "schema": 40, "optional": false }, "sharedAt": { "schema": 3, "optional": false } } },
  { "kind": "union", "members": [8, 113, 114, 115, 116, 117] },
  { "kind": "literal", "value": "PERMISSION" },
  { "kind": "literal", "value": "TOO_LARGE" },
  { "kind": "literal", "value": "UNSUPPORTED_TYPE" },
  { "kind": "literal", "value": "NOT_TEXT" },
  { "kind": "literal", "value": "UNREADABLE" },
  { "kind": "union", "members": [8, 119] },
  { "kind": "object", "fields": { "mimeType": { "schema": 3, "optional": false }, "width": { "schema": 36, "optional": false }, "height": { "schema": 36, "optional": false } } },
  { "kind": "union", "members": [17, 121] },
  { "kind": "array", "item": 122 },
  { "kind": "object", "fields": { "data": { "schema": 3, "optional": false }, "mimeType": { "schema": 123, "optional": false } } },
  { "kind": "union", "members": [124, 125] },
  { "kind": "literal", "value": "image/png" },
  { "kind": "literal", "value": "image/jpeg" },
  { "kind": "object", "fields": { "fileId": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "fileName": { "schema": 3, "optional": false }, "sizeBytes": { "schema": 36, "optional": false }, "sha256": { "schema": 3, "optional": false }, "mimeType": { "schema": 7, "optional": false }, "status": { "schema": 127, "optional": false } } },
  { "kind": "literal", "value": "ok" },
  { "kind": "object", "fields": { "fileId": { "schema": 3, "optional": false }, "status": { "schema": 127, "optional": false }, "sizeBytes": { "schema": 36, "optional": false }, "sha256": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 130, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 131 },
  { "kind": "object", "fields": { "taskId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "source": { "schema": 132, "optional": false }, "creator": { "schema": 40, "optional": false }, "assignee": { "schema": 133, "optional": false }, "executionStatus": { "schema": 136, "optional": false }, "acceptanceStatus": { "schema": 3, "optional": false }, "executionEpoch": { "schema": 36, "optional": false }, "version": { "schema": 36, "optional": false }, "dueAt": { "schema": 7, "optional": false }, "updatedAt": { "schema": 3, "optional": false }, "permalink": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "topicId": { "schema": 7, "optional": false }, "messageId": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [8, 134] },
  { "kind": "object", "fields": { "type": { "schema": 135, "optional": false }, "id": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false } } },
  { "kind": "union", "members": [23, 24, 85] },
  { "kind": "union", "members": [100, 104, 137, 138, 139] },
  { "kind": "literal", "value": "todo" },
  { "kind": "literal", "value": "running" },
  { "kind": "literal", "value": "cancelled" },
  { "kind": "object", "fields": { "taskKey": { "schema": 7, "optional": false }, "goal": { "schema": 3, "optional": false }, "requester": { "schema": 141, "optional": false }, "attachments": { "schema": 142, "optional": false }, "progress": { "schema": 7, "optional": false }, "conclusion": { "schema": 7, "optional": false }, "resultArtifacts": { "schema": 144, "optional": false }, "rejection": { "schema": 150, "optional": false }, "pendingAction": { "schema": 7, "optional": false }, "controlHistory": { "schema": 152, "optional": false }, "delivery": { "schema": 154, "optional": false }, "startedAt": { "schema": 7, "optional": false }, "createdAt": { "schema": 3, "optional": false }, "taskId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "source": { "schema": 132, "optional": false }, "creator": { "schema": 40, "optional": false }, "assignee": { "schema": 133, "optional": false }, "executionStatus": { "schema": 136, "optional": false }, "acceptanceStatus": { "schema": 3, "optional": false }, "executionEpoch": { "schema": 36, "optional": false }, "version": { "schema": 36, "optional": false }, "dueAt": { "schema": 7, "optional": false }, "updatedAt": { "schema": 3, "optional": false }, "permalink": { "schema": 3, "optional": false } } },
  { "kind": "union", "members": [8, 40] },
  { "kind": "array", "item": 143 },
  { "kind": "object", "fields": { "fileId": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false } } },
  { "kind": "array", "item": 145 },
  { "kind": "union", "members": [146, 148] },
  { "kind": "object", "fields": { "type": { "schema": 147, "optional": false }, "content": { "schema": 3, "optional": false }, "title": { "schema": 25, "optional": true }, "format": { "schema": 25, "optional": true } } },
  { "kind": "literal", "value": "text" },
  { "kind": "object", "fields": { "type": { "schema": 149, "optional": false }, "name": { "schema": 3, "optional": false }, "url": { "schema": 3, "optional": false }, "fileId": { "schema": 25, "optional": true } } },
  { "kind": "literal", "value": "file" },
  { "kind": "union", "members": [8, 151] },
  { "kind": "object", "fields": { "executionEpoch": { "schema": 36, "optional": false }, "reason": { "schema": 3, "optional": false }, "by": { "schema": 40, "optional": false }, "at": { "schema": 3, "optional": false } } },
  { "kind": "array", "item": 153 },
  { "kind": "object", "fields": {}, "values": 66 },
  { "kind": "object", "fields": {}, "values": 66 },
  { "kind": "object", "fields": { "items": { "schema": 156, "optional": false }, "counts": { "schema": 160, "optional": false }, "total": { "schema": 36, "optional": false }, "page": { "schema": 36, "optional": false }, "pageSize": { "schema": 36, "optional": false }, "revision": { "schema": 3, "optional": false } } },
  { "kind": "array", "item": 157 },
  { "kind": "object", "fields": { "taskId": { "schema": 3, "optional": false }, "title": { "schema": 3, "optional": false }, "requesterId": { "schema": 7, "optional": false }, "acceptanceStatus": { "schema": 3, "optional": false }, "status": { "schema": 3, "optional": false }, "channelId": { "schema": 3, "optional": false }, "channelName": { "schema": 3, "optional": false }, "projectId": { "schema": 3, "optional": false }, "projectName": { "schema": 3, "optional": false }, "assignee": { "schema": 158, "optional": false }, "createdAt": { "schema": 3, "optional": false }, "updatedAt": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "type": { "schema": 159, "optional": false }, "id": { "schema": 7, "optional": false }, "name": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [8, 23, 24, 85] },
  { "kind": "object", "fields": { "failed": { "schema": 36, "optional": false }, "todo": { "schema": 36, "optional": false }, "running": { "schema": 36, "optional": false }, "cancelled": { "schema": 36, "optional": false }, "complete": { "schema": 36, "optional": false } } },
  { "kind": "object", "fields": { "taskId": { "schema": 3, "optional": false }, "version": { "schema": 36, "optional": false } } },
  { "kind": "object", "fields": { "executionEpoch": { "schema": 36, "optional": false }, "executionStatus": { "schema": 136, "optional": false }, "acceptanceStatus": { "schema": 3, "optional": false }, "taskId": { "schema": 3, "optional": false }, "version": { "schema": 36, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 164, "optional": false }, "nextCursor": { "schema": 27, "optional": true }, "hasMore": { "schema": 26, "optional": true }, "recentItems": { "schema": 166, "optional": true } } },
  { "kind": "array", "item": 165 },
  { "kind": "object", "fields": { "userId": { "schema": 3, "optional": false }, "username": { "schema": 3, "optional": false }, "displayName": { "schema": 3, "optional": false } } },
  { "kind": "union", "members": [17, 164] },
  { "kind": "object", "fields": { "items": { "schema": 168, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 169 },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 171, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 172 },
  { "kind": "object", "fields": { "id": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 164, "optional": false } } },
  { "kind": "object", "fields": { "items": { "schema": 175, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 176 },
  { "kind": "object", "fields": { "providerInstallationId": { "schema": 3, "optional": false }, "appId": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false }, "description": { "schema": 3, "optional": false }, "status": { "schema": 3, "optional": false }, "available": { "schema": 4, "optional": false }, "specRevision": { "schema": 7, "optional": false }, "operations": { "schema": 177, "optional": false }, "errorCode": { "schema": 25, "optional": true } } },
  { "kind": "array", "item": 178 },
  { "kind": "object", "fields": { "operationId": { "schema": 3, "optional": false }, "summary": { "schema": 3, "optional": false }, "description": { "schema": 3, "optional": false }, "topicReply": { "schema": 66, "optional": true } } },
  { "kind": "object", "fields": { "providerInstallationId": { "schema": 3, "optional": false }, "appId": { "schema": 3, "optional": false }, "name": { "schema": 3, "optional": false }, "description": { "schema": 3, "optional": false }, "specRevision": { "schema": 3, "optional": false }, "available": { "schema": 4, "optional": false }, "items": { "schema": 180, "optional": false }, "hasMore": { "schema": 4, "optional": false }, "nextCursor": { "schema": 7, "optional": false } } },
  { "kind": "array", "item": 181 },
  { "kind": "object", "fields": { "operationId": { "schema": 3, "optional": false }, "summary": { "schema": 3, "optional": false }, "description": { "schema": 3, "optional": false }, "inputSchema": { "schema": 153, "optional": false }, "outputSchema": { "schema": 153, "optional": false }, "errorCodes": { "schema": 65, "optional": false } }, "values": 66 },
  { "kind": "object", "fields": { "callId": { "schema": 3, "optional": false }, "status": { "schema": 183, "optional": false }, "specRevision": { "schema": 3, "optional": false }, "resultAvailable": { "schema": 4, "optional": false }, "topicReply": { "schema": 186, "optional": false }, "response": { "schema": 197, "optional": false }, "error": { "schema": 204, "optional": false } } },
  { "kind": "union", "members": [100, 104, 138, 184, 185] },
  { "kind": "literal", "value": "accepted" },
  { "kind": "literal", "value": "unknown" },
  { "kind": "object", "fields": { "state": { "schema": 187, "optional": false }, "sender": { "schema": 192, "optional": false }, "format": { "schema": 195, "optional": false }, "messageId": { "schema": 7, "optional": false }, "reason": { "schema": 7, "optional": false } } },
  { "kind": "union", "members": [92, 188, 189, 190, 191] },
  { "kind": "literal", "value": "not_required" },
  { "kind": "literal", "value": "published" },
  { "kind": "literal", "value": "skipped" },
  { "kind": "literal", "value": "stopped" },
  { "kind": "union", "members": [8, 193, 194] },
  { "kind": "literal", "value": "provider" },
  { "kind": "literal", "value": "consumer" },
  { "kind": "union", "members": [8, 147, 196] },
  { "kind": "literal", "value": "card" },
  { "kind": "union", "members": [8, 198] },
  { "kind": "object", "fields": { "status": { "schema": 199, "optional": false }, "data": { "schema": 66, "optional": false } } },
  { "kind": "union", "members": [200, 201, 202, 203] },
  { "kind": "literal", "value": 200 },
  { "kind": "literal", "value": 201 },
  { "kind": "literal", "value": 202 },
  { "kind": "literal", "value": 204 },
  { "kind": "union", "members": [8, 205] },
  { "kind": "object", "fields": { "code": { "schema": 3, "optional": false }, "message": { "schema": 3, "optional": false }, "requestId": { "schema": 3, "optional": false }, "providerErrorCode": { "schema": 25, "optional": true } } }
];
var methodSchemas = {
  "projects.list": 0,
  "channels.list": 9,
  "channels.listMembers": 15,
  "channels.listMessages": 28,
  "channels.listUnreadMessages": 50,
  "messages.get": 55,
  "messages.replace": 60,
  "messages.recall": 61,
  "messages.send": 62,
  "topics.list": 69,
  "topics.listMessages": 72,
  "topics.listParticipants": 77,
  "topics.readImage": 80,
  "directMessages.list": 81,
  "directMessages.downloadAttachment": 89,
  "drafts.create": 91,
  "events.reportStatus": 93,
  "events.reportUndelivered": 98,
  "actions.complete": 99,
  "interactions.openDialog": 107,
  "interactions.get": 107,
  "interactions.complete": 107,
  "interactions.showToast": 107,
  "files.list": 108,
  "files.readContent": 111,
  "files.createText": 126,
  "files.download": 89,
  "files.upload": 128,
  "tasks.list": 129,
  "tasks.get": 140,
  "tasks.listPersonal": 155,
  "tasks.create": 161,
  "tasks.update": 161,
  "tasks.reportExecution": 162,
  "contacts.list": 163,
  "contacts.listChannels": 167,
  "contacts.listProjects": 170,
  "contacts.resolve": 173,
  "apps.list": 174,
  "apps.listOperations": 179,
  "apps.callOperation": 182
};

// src/shared/wire-values.mts
function isWireValue(value, index, schemas, depth = 0) {
  if (depth > 100) return false;
  const schema = schemas[index];
  const valid = (v, id2, nextDepth) => isWireValue(v, id2, schemas, nextDepth);
  switch (schema.kind) {
    case "unknown":
      return true;
    case "never":
      return false;
    case "undefined":
      return value === void 0;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "literal":
      return value === schema.value;
    case "bytes":
      return value instanceof Uint8Array;
    case "array":
      return Array.isArray(value) && value.every((v) => valid(v, schema.item, depth + 1));
    case "tuple":
      return Array.isArray(value) && value.length === schema.items.length && schema.items.every((id2, i) => valid(value[i], id2, depth + 1));
    case "union":
      return schema.members.some((id2) => valid(value, id2, depth + 1));
    case "intersection":
      return schema.members.every((id2) => valid(value, id2, depth + 1));
    case "object":
      return isRecord(value) && Object.entries(schema.fields).every(([key, field]) => field.optional && value[key] === void 0 || valid(value[key], field.schema, depth + 1)) && (schema.values === void 0 || Object.values(value).every((v) => valid(v, schema.values, depth + 1)));
  }
}
function businessResult(method, value) {
  if (!isWireValue(value, methodSchemas[method], resultSchemas)) throw fail("PLATFORM_RESPONSE_INVALID", 502);
  return value;
}

// src/clients/client-methods.mts
var resource = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail("INVALID_RESOURCE", 400);
  return value;
};
var record2 = isRecord;
function checkedObject(value, id2) {
  if (!record2(value) || id2 && (typeof value[id2] !== "string" || !value[id2])) throw fail("PLATFORM_RESPONSE_INVALID", 502);
  return value;
}
function checkedPage(value, id2) {
  checkedObject(value);
  if (!Array.isArray(value.items) || typeof value.hasMore !== "boolean" || (value.hasMore ? typeof value.nextCursor !== "string" || !value.nextCursor : value.nextCursor !== null)) throw fail("PLATFORM_RESPONSE_INVALID", 502);
  for (const row of value.items) checkedObject(row, id2);
  return value;
}
var string = (value) => typeof value === "string";
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var nullable = (check) => (value) => value === null || check(value);
var array = (check) => (value) => Array.isArray(value) && value.every(check);
var shape = (fields) => (value) => record2(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
var principal = shape({ type: (v) => v === "user" || v === "agent" || v === "app", id: string, name: string });
var channel = shape({ channelId: string, channelName: string });
var fileSummary = shape({
  fileId: string,
  channelId: string,
  title: string,
  fileName: string,
  mimeType: nullable(string),
  sizeBytes: integer,
  sha256: nullable(string),
  sharedBy: principal,
  sharedAt: string
});
function checked(value, check) {
  if (!check(value)) throw fail("PLATFORM_RESPONSE_INVALID", 502);
  return value;
}
function checkedHistory(value) {
  checkedPage(value, "messageId");
  return checked(value, shape({ channel, items: array(shape({
    messageId: string,
    revision: integer,
    channelId: string,
    topicId: nullable(string),
    author: principal,
    text: string,
    createdAt: string,
    recalled: (v) => typeof v === "boolean",
    sentToChannel: (v) => typeof v === "boolean",
    files: array(shape({ fileId: string, title: string, fileName: string, sizeBytes: nullable(integer) })),
    apps: array(shape({ appKey: string, resourceId: string, title: nullable(string) })),
    quote: nullable(shape({ messageId: string, authorName: string, text: string, recalled: (v) => v === void 0 || typeof v === "boolean" })),
    event: nullable(shape({ kind: string, taskId: nullable(string), summary: nullable(string) })),
    taskId: nullable(string)
  })) }));
}
function checkedUnread(value) {
  checkedPage(value, "messageId");
  return checked(value, shape({
    channel,
    items: array(shape({ messageId: string, channelId: string, topicId: string, createdAt: string })),
    unreadSnapshot: shape({
      scope: (v) => v === "channel",
      readerUserId: string,
      readStateAvailable: (v) => typeof v === "boolean",
      readAt: nullable(string),
      capturedAt: string,
      unreadCount: nullable(integer)
    })
  }));
}
function checkedFile(value) {
  checked(value, fileSummary);
  return checked(value, shape({
    download: (v) => v === void 0,
    content: nullable(string),
    totalCharacters: nullable(integer),
    nextOffset: nullable(integer),
    image: nullable(shape({ mimeType: string, width: integer, height: integer })),
    unreadableReason: (v) => v === null || typeof v === "string" && ["PERMISSION", "TOO_LARGE", "UNSUPPORTED_TYPE", "NOT_TEXT", "UNREADABLE"].includes(v),
    images: (v) => v === void 0 || array(shape({ data: string, mimeType: (v2) => v2 === "image/png" || v2 === "image/jpeg" }))(v)
  }));
}
function pageMethods(list, id2) {
  const read = async (query = {}) => checkedPage(await list(query), id2);
  return Object.freeze({ list: read, async *iterate(query = {}, { maxPages = 100, signal } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw fail("INVALID_PAGINATION", 400);
    const input = structuredClone(query), seen = /* @__PURE__ */ new Set();
    for (let count = 0; count < maxPages; count++) {
      signal?.throwIfAborted();
      const page = await read(input);
      signal?.throwIfAborted();
      if (page.hasMore && (page.nextCursor === input.cursor || seen.has(page.nextCursor))) throw fail("PAGINATION_CURSOR_REPEATED", 502);
      for (const item of page.items) {
        signal?.throwIfAborted();
        yield item;
      }
      if (!page.hasMore) return;
      seen.add(page.nextCursor);
      input.cursor = page.nextCursor ?? void 0;
    }
    throw fail("PAGINATION_INCOMPLETE", 409);
  } });
}
function createBusinessMethods(http, boundEventId, sendMessage) {
  const get = async (method, path, query) => businessResult(method, await http({ path, query }));
  const post = async (method, path, body, key) => businessResult(method, await http({ method: "POST", path, body, key }));
  const search = ({ query, ...rest } = {}) => ({ ...rest, ...query === void 0 ? {} : { q: query } });
  const fileKey = (idempotencyKey) => {
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw fail("IDEMPOTENCY_KEY_REQUIRED", 400);
    return idempotencyKey;
  };
  const prepareFile = (input, mode, extra) => {
    const { idempotencyKey, ...body } = input;
    return http({ method: "POST", path: "/app-files", body: { ...body, ...extra, mode, uploadKey: fileKey(idempotencyKey) }, key: idempotencyKey }).then((value) => checkedObject(value, "fileId"));
  };
  const methods = {
    projects: pageMethods((query) => get("projects.list", "/app-projects", query), "projectId"),
    channels: Object.freeze({
      ...pageMethods((query) => get("channels.list", "/app-channels", query), "channelId"),
      listMembers: ({ channelId, ...query }) => get("channels.listMembers", "/app-channels/" + resource(channelId) + "/members", query).then((value) => checkedPage(value, "id")),
      listMessages: ({ channelId, ...query }) => get("channels.listMessages", "/app-channels/" + resource(channelId) + "/messages", query).then(checkedHistory),
      listUnreadMessages: ({ channelId, ...query }) => get("channels.listUnreadMessages", "/channels/" + resource(channelId) + "/unread-messages", query).then(checkedUnread)
    }),
    messages: Object.freeze({
      send: ({ idempotencyKey, ...body }) => {
        if ("mentions" in body && (!body.mentions || !parseMessageMentions(body.mentions) || typeof body.text !== "string" || body.mentions.items.some((item) => item.end > body.text.trim().length))) throw fail("VALIDATION_FAILED", 400);
        if (!sendMessage) throw new TypeError("Internal send implementation is required");
        return sendMessage({ ...body, idempotencyKey });
      },
      get: ({ messageId }) => get("messages.get", "/messages/" + resource(messageId)).then((value) => checked(value, shape({
        source: shape({ messageId: string, channelId: string, topicId: string, projectId: (v) => v === void 0 || string(v) }),
        content: shape({
          author: principal,
          text: string,
          createdAt: string,
          recalled: (v) => typeof v === "boolean",
          files: array(shape({ fileId: string, fileName: string }))
        })
      }))),
      replace: ({ messageId, ...body }) => http({ method: "PUT", path: "/messages/" + resource(messageId), body }).then((value) => businessResult("messages.replace", value)),
      recall: ({ messageId, idempotencyKey, ...body }) => post("messages.recall", "/messages/" + resource(messageId) + "/recall", body, idempotencyKey)
    }),
    topics: Object.freeze({
      list: (options = {}) => get("topics.list", "/topics", options),
      listMessages: ({ topicId, ...query }) => get("topics.listMessages", "/topics/" + resource(topicId) + "/messages", query),
      listParticipants: ({ topicId, ...query }) => get("topics.listParticipants", "/topics/" + resource(topicId) + "/participants", query),
      readImage: ({ topicId, artifactId }) => get("topics.readImage", "/topics/" + resource(topicId) + "/images/" + resource(artifactId))
    }),
    directMessages: Object.freeze({
      list: ({ conversationId, ...query }) => get("directMessages.list", "/app-direct-messages/" + resource(conversationId) + "/messages", query),
      downloadAttachment: ({ conversationId, artifactId }) => http({ path: "/app-direct-messages/" + resource(conversationId) + "/attachments/" + resource(artifactId) + "/download" }).then((value) => businessResult("directMessages.downloadAttachment", value))
    }),
    drafts: Object.freeze({ create: ({ idempotencyKey, ...body }) => post("drafts.create", "/message-drafts", body, idempotencyKey) }),
    events: Object.freeze({
      reportStatus: ({ idempotencyKey, ...body }) => post("events.reportStatus", "/agent-sessions/status", { ...body, eventId: boundEventId || body.eventId }, idempotencyKey).then((value) => checked(value, shape({
        deploymentId: string,
        channelId: string,
        topicId: string,
        sequence: integer,
        status: (v) => typeof v === "string" && ["processing", "suspended", "finished"].includes(v),
        updatedAt: string,
        warnings: array(string)
      }))),
      reportUndelivered: (body) => post("events.reportUndelivered", "/extensions/agent-apps/receipts", { ...body, eventId: boundEventId || body.eventId })
    }),
    actions: Object.freeze({ complete: ({ idempotencyKey, ...body }) => post("actions.complete", "/extensions/ui-requests", { ...body, kind: "action_result", eventId: boundEventId || body.eventId }, idempotencyKey) }),
    interactions: Object.freeze({
      openDialog: ({ idempotencyKey, ...body }) => post("interactions.openDialog", "/extensions/ui-requests", { ...body, kind: "dialog", eventId: boundEventId || body.eventId }, idempotencyKey),
      showToast: ({ idempotencyKey, ...body }) => post("interactions.showToast", "/extensions/ui-requests", { ...body, kind: "toast", eventId: boundEventId || body.eventId }, idempotencyKey),
      get: ({ interactionId, eventId = boundEventId }) => get("interactions.get", "/extensions/ui-requests/" + resource(interactionId), { eventId }),
      complete: ({ interactionId }) => post("interactions.complete", "/extensions/ui-requests/" + resource(interactionId) + "/complete", {})
    }),
    files: Object.freeze({
      ...pageMethods((query) => {
        if (!query || !Object.hasOwn(query, "channelId") || typeof query.channelId !== "string" || !query.channelId.trim())
          throw new CoLinkError("INVALID_ARGUMENT", 400, void 0, { details: [{
            field: "query.channelId",
            code: "FIELD_REQUIRED",
            message: "\u6587\u4EF6\u5217\u8868\u5FC5\u987B\u663E\u5F0F\u6307\u5B9A\u9891\u9053\uFF1B\u4ECE\u53EF\u4FE1\u4E0A\u4E0B\u6587\u6216 channels.list \u9009\u62E9\u9891\u9053\uFF0C\u9879\u76EE\u4E3B\u9875\u6CA1\u6709\u9ED8\u8BA4\u6765\u6E90\u9891\u9053\u3002"
          }] });
        return get("files.list", "/app-files", query);
      }, "fileId"),
      readContent: ({ fileId, ...query }) => get("files.readContent", "/app-files/" + resource(fileId), query).then(checkedFile),
      createText: (input) => prepareFile(input, "text").then((value) => {
        const { upload, ...file } = checked(value, shape({ fileId: string, status: (value2) => value2 === "ok" }));
        return businessResult("files.createText", file);
      }),
      download: ({ fileId }) => get("files.download", "/app-files/" + resource(fileId) + "/content"),
      async upload({ bytes, ...input }) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 20 * 1024 * 1024) throw fail("INVALID_ARGUMENT", 400);
        const copy = new Uint8Array(bytes), digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
        const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const file = await prepareFile(input, "upload", { sizeBytes: copy.byteLength, sha256 });
        const receipt = checked(
          businessResult("files.upload", await http({ method: "PUT", path: "/app-files/" + resource(file.fileId) + "/content", bytes: copy, contentType: "application/octet-stream" })),
          shape({ fileId: string, status: (v) => v === "ok", sizeBytes: integer, sha256: (v) => string(v) && /^[a-fA-F0-9]{64}$/.test(v) })
        );
        if (receipt.fileId !== file.fileId || receipt.sizeBytes !== copy.byteLength || receipt.sha256 !== sha256) throw fail("PLATFORM_RESPONSE_INVALID", 502);
        return receipt;
      }
    }),
    tasks: Object.freeze({
      ...pageMethods((query) => get("tasks.list", "/tasks", search(query)), "taskId"),
      get: ({ taskId }) => get("tasks.get", "/tasks/" + resource(taskId)),
      listPersonal: (query = {}) => get("tasks.listPersonal", "/personal-tasks", search(query)).then((value) => {
        checkedObject(value);
        if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pageSize)) throw fail("PLATFORM_RESPONSE_INVALID", 502);
        for (const row of value.items) checkedObject(row, "taskId");
        return value;
      }),
      create: ({ idempotencyKey, ...body }) => post("tasks.create", "/tasks", body, idempotencyKey),
      update: ({ taskId, idempotencyKey, ...body }) => post("tasks.update", "/tasks/" + resource(taskId), body, idempotencyKey),
      reportExecution: ({ taskId, idempotencyKey, ...body }) => post("tasks.reportExecution", "/tasks/" + resource(taskId) + "/execution-reports", body, idempotencyKey)
    }),
    contacts: Object.freeze({
      list: (query) => get("contacts.list", "/extensions/contacts", search(query)),
      listChannels: (query) => get("contacts.listChannels", "/extensions/contact-channels", search(query)),
      listProjects: (query) => get("contacts.listProjects", "/extensions/contact-projects", search(query)),
      resolve: (body) => post("contacts.resolve", "/extensions/participant-selections", body)
    }),
    apps: Object.freeze({
      list: (query = {}) => get("apps.list", "/app-capabilities", query).then((value) => checkedPage(value, "providerInstallationId")),
      listOperations: ({ providerInstallationId, ...query }) => get("apps.listOperations", "/app-capabilities/" + resource(providerInstallationId) + "/operations", query).then((value) => checkedPage(value, "operationId")),
      callOperation: ({ providerInstallationId, idempotencyKey, ...body }) => post("apps.callOperation", "/app-capabilities/" + resource(providerInstallationId) + "/calls", body, idempotencyKey)
    })
  };
  return withMethodDiagnostics(methods);
}

// src/clients/identity-methods.mts
var guides2 = METHOD_GUIDES;
var routes2 = HTTP_ROUTES;
function identityMethods(methods, identity, { active = () => {
} } = {}) {
  function select(value, path = "") {
    const result = {};
    for (const [name, entry] of Object.entries(value)) {
      const member = entry;
      const method = path ? path + "." + name : name;
      if (typeof member !== "function") {
        if (member === null || typeof member !== "object") throw new TypeError("Invalid internal method tree");
        const nested = select(member, method);
        if (Object.keys(nested).length) result[name] = nested;
        continue;
      }
      const guide = guides2[method], route = routes2[guide?.route];
      const policies2 = guide?.operation ? [route?.readPolicies?.[guide.operation]] : [route?.policy, ...route?.alternatives || []];
      if (policies2.some((p) => p?.tokens.includes(identity))) {
        const explain = (error2) => explainMethodError(error2, identity + "." + method, void 0, identity, void 0);
        result[name] = method.endsWith(".iterate") ? async function* (...args) {
          try {
            await active();
            const values = Reflect.apply(member, void 0, args);
            if (!isIterable(values)) throw new TypeError("Invalid internal iterator");
            for await (const item of values) {
              await active();
              yield item;
            }
          } catch (error2) {
            throw explain(error2);
          }
        } : async (...args) => {
          try {
            await active();
            return await Reflect.apply(member, void 0, args);
          } catch (error2) {
            throw explain(error2);
          }
        };
      }
    }
    return Object.freeze(result);
  }
  return select(methods);
}

// src/pages/page-values.mts
var strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var optionalText = (value) => value === void 0 || value === null || typeof value === "string";
function isMessageContent(value) {
  if (!isRecord(value) || !isRecord(value.author)) return false;
  return (value.author.type === "user" || value.author.type === "agent" || value.author.type === "app") && typeof value.author.id === "string" && typeof value.author.name === "string" && typeof value.text === "string" && typeof value.createdAt === "string" && typeof value.recalled === "boolean" && Array.isArray(value.files) && value.files.every((file) => isRecord(file) && typeof file.fileId === "string" && typeof file.fileName === "string") && (value.mentions === void 0 || parseMessageMentions(value.mentions) !== void 0);
}
function isBackgroundGrant(value) {
  return isRecord(value) && typeof value.grantId === "string" && typeof value.installationId === "string" && typeof value.userId === "string" && (value.projectId === null || typeof value.projectId === "string") && strings(value.scopes) && typeof value.version === "number" && typeof value.authorizationVersion === "number" && (value.status === "active" || value.status === "inactive");
}
function isPageIdentity(value) {
  return isRecord(value) && typeof value.sessionId === "string" && typeof value.authorizationVersion === "number" && typeof value.userId === "string" && typeof value.installationId === "string" && typeof value.pageSessionId === "string" && isRecord(value.source) && strings(value.scopes) && typeof value.expiresAt === "string" && optionalText(value.username) && optionalText(value.displayName) && (value.content === void 0 || isMessageContent(value.content)) && (value.viewData === void 0 || isRecord(value.viewData)) && (value.backgroundGrant === void 0 || isBackgroundGrant(value.backgroundGrant));
}
function pageContext(value) {
  if (!isRecord(value) || !isRecord(value.source) || typeof value.container !== "string" || value.theme !== "light" && value.theme !== "dark" || typeof value.themeId !== "string" || typeof value.language !== "string" || !strings(value.availableMethods) || value.content !== void 0 && !isMessageContent(value.content) || value.viewData !== void 0 && !isRecord(value.viewData)) return void 0;
  return {
    ...value,
    source: value.source,
    container: value.container,
    theme: value.theme,
    themeId: value.themeId,
    language: value.language,
    availableMethods: value.availableMethods,
    readingForeground: value.readingForeground === true,
    ...isMessageContent(value.content) ? { content: value.content } : {},
    ...isRecord(value.viewData) ? { viewData: value.viewData } : {}
  };
}

// src/shared/file-save.mts
var FILE_SAVE_MAX_BYTES = 16 * 1024 * 1024;
var FILE_SAVE_CONFIRM_MS = 5 * 60 * 1e3;
function parseFileSave(input) {
  const fail2 = () => {
    throw Object.assign(new Error("INVALID_FILE_SAVE"), { code: "INVALID_FILE_SAVE" });
  };
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["fileName", "blob"].includes(key))) return fail2();
  const { fileName, blob } = input;
  if (typeof fileName !== "string" || !fileName.length || fileName.length > 200 || fileName.trim() !== fileName || fileName === "." || fileName === ".." || /[/\\:*?"<>|\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(fileName) || !(blob instanceof Blob) || blob.size > FILE_SAVE_MAX_BYTES) return fail2();
  return { fileName, blob };
}

// src/shared/manifest-protocol.mts
var MANIFEST_PROTOCOL_DEFAULTS = Object.freeze({
  manifestVersion: ProtocolVersion.ManifestV2_0_0,
  "events.schemaVersion": ProtocolVersion.EventsV2_0_0,
  "ui.contractVersion": ProtocolVersion.UiV1_0_0,
  "ui.entries.*.extensionPoint.version": ProtocolVersion.ExtensionPointV1_0_0,
  "ui.views.*.bridgeVersion": ProtocolVersion.BridgeV1_0_0,
  "api.contextVersion": ApiContextVersion.V2
});
var BridgeProtocol = "colink.ui/" + MANIFEST_PROTOCOL_DEFAULTS["ui.views.*.bridgeVersion"];

// browser.mts
var connectedWindows = /* @__PURE__ */ new WeakSet();
var connections = /* @__PURE__ */ new WeakMap();
var protocol = BridgeProtocol;
var object2 = isRecord;
var error = (code) => new CoLinkError(code, 400);
function viewSnapshot(value) {
  const visit = (item, depth) => {
    if (depth > 8) throw error("PAGE_INVALID_VIEW_DATA");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((value2) => visit(value2, depth + 1));
    if (!object2(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw error("PAGE_INVALID_VIEW_DATA");
    const result = {};
    for (const key of Object.keys(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw error("PAGE_INVALID_VIEW_DATA");
      result[key] = visit(item[key], depth + 1);
    }
    return result;
  };
  if (!object2(value)) throw error("PAGE_INVALID_VIEW_DATA");
  const snapshot = visit(value, 0);
  if (!object2(snapshot)) throw error("PAGE_INVALID_VIEW_DATA");
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 16384) throw error("PAGE_INVALID_VIEW_DATA");
  return snapshot;
}
var accepted = (value) => {
  if (record(value).accepted !== true) throw error("PAGE_RESPONSE_INVALID");
  return Object.freeze({ accepted: true });
};
function connectPage({
  hostOrigin,
  allowInsecureLocal = false,
  timeoutMs = 15e3,
  window: win = globalThis.window,
  signal,
  deferPresentation = false
} = { hostOrigin: "" }) {
  if (typeof deferPresentation !== "boolean") throw error("INVALID_PRESENTATION_OPTION");
  let origin;
  try {
    origin = new URL(hostOrigin);
  } catch {
    throw error("INVALID_HOST_ORIGIN");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (origin.origin !== hostOrigin || origin.username || origin.password || !(origin.protocol === "https:" || allowInsecureLocal && local && origin.protocol === "http:"))
    throw error("INVALID_HOST_ORIGIN");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15e3) throw error("INVALID_TIMEOUT");
  if (!win || win.parent === win) throw error("NOT_EMBEDDED");
  if (connectedWindows.has(win)) throw error("PAGE_ALREADY_CONNECTED");
  if (signal?.aborted) throw error("PAGE_CLOSED");
  connectedWindows.add(win);
  let port, timer, closed = false;
  let resolve, reject;
  let initialized = false, sequence = 0;
  const pending = /* @__PURE__ */ new Map();
  const closing = /* @__PURE__ */ new Set(), subscribers = /* @__PURE__ */ new Set();
  const viewSubscribers = /* @__PURE__ */ new Set(), viewOpenings = /* @__PURE__ */ new Set();
  const requestId = "initialize";
  const ready = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  function close(reason = error("PAGE_CLOSED")) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    win.removeEventListener("message", receive);
    win.removeEventListener("pagehide", onClose);
    signal?.removeEventListener("abort", onClose);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(reason);
    }
    pending.clear();
    for (const action of closing) action();
    closing.clear();
    subscribers.clear();
    viewSubscribers.clear();
    viewOpenings.clear();
    if (port) {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    }
    reject(reason);
  }
  function onClose() {
    close();
  }
  function receive(event) {
    const data = event.data;
    if (closed || port || event.source !== win.parent || event.origin !== hostOrigin || !object2(data) || data.type !== "colink.ui.connected" || data.version !== "1.0.0" || typeof data.uiSessionId !== "string" || !data.uiSessionId.trim() || event.ports?.length !== 1) return;
    port = event.ports[0];
    win.removeEventListener("message", receive);
    port.onmessage = ({ data: data2 }) => {
      const reply = data2;
      if (closed || !object2(reply) || reply.protocol !== protocol) return;
      if (reply.event) {
        if (initialized && reply.event === "host.themeChanged" && (reply.theme === "light" || reply.theme === "dark"))
          for (const listener of subscribers) {
            try {
              listener(Object.freeze({ theme: reply.theme, themeId: typeof reply.themeId === "string" ? reply.themeId : void 0 }));
            } catch {
            }
          }
        if (initialized && reply.event === "view.closed" && typeof reply.requestId === "string" && viewOpenings.has(reply.requestId)) {
          let completion;
          try {
            if (reply.status === "submitted") completion = { requestId: reply.requestId, status: "submitted", result: viewSnapshot(reply.result) };
            else if (reply.status === "cancelled" && !Object.hasOwn(reply, "result")) completion = { requestId: reply.requestId, status: "cancelled" };
            else return;
          } catch {
            return;
          }
          viewOpenings.delete(reply.requestId);
          for (const listener of viewSubscribers) {
            try {
              listener(Object.freeze(completion));
            } catch {
            }
          }
        }
        return;
      }
      if (reply.requestId !== requestId) {
        if (typeof reply.requestId !== "string") return;
        const item = pending.get(reply.requestId);
        if (!item) return;
        pending.delete(reply.requestId);
        clearTimeout(item.timer);
        if ("error" in reply) item.reject(error(typeof reply.error === "string" && /^[A-Z0-9_]+$/.test(reply.error) ? reply.error : "BRIDGE_UNAVAILABLE"));
        else item.resolve(reply.result);
        return;
      }
      if (initialized) return;
      if ("error" in reply) {
        close(error(typeof reply.error === "string" ? reply.error : "INVALID_RESPONSE"));
        return;
      }
      const value = pageContext(reply.result);
      if (!value) {
        close(error("INVALID_RESPONSE"));
        return;
      }
      clearTimeout(timer);
      initialized = true;
      resolve(Object.freeze({ ...value, readingForeground: value.readingForeground === true }));
    };
    port.onmessageerror = () => close(error("INVALID_RESPONSE"));
    try {
      port.start();
      port.postMessage({ protocol, requestId, method: "host.initialize", params: {} });
    } catch {
      close(error("BRIDGE_UNAVAILABLE"));
    }
  }
  win.addEventListener("message", receive);
  win.addEventListener("pagehide", onClose);
  signal?.addEventListener("abort", onClose, { once: true });
  timer = setTimeout(() => close(error("BRIDGE_TIMEOUT")), timeoutMs);
  try {
    win.parent.postMessage({ type: "colink.ui.ready", version: "1.0.0", ...deferPresentation ? { deferPresentation: true } : {} }, hostOrigin);
  } catch {
    close(error("BRIDGE_UNAVAILABLE"));
  }
  const bridge = {
    win,
    closing,
    get closed() {
      return closed;
    },
    async call(method, params, timeout, onRequest, callSignal) {
      const context = await ready;
      if (closed || callSignal?.aborted) throw error("PAGE_CLOSED");
      if (!context.availableMethods.includes(method)) throw error("PAGE_METHOD_UNAVAILABLE");
      const id2 = "page-" + ++sequence;
      onRequest?.(id2);
      return new Promise((resolve2, reject2) => {
        const finish = (fn) => (value) => {
          pending.delete(id2);
          clearTimeout(timer2);
          callSignal?.removeEventListener("abort", cancel);
          fn(value);
        };
        const cancel = () => finish(reject2)(error("PAGE_CLOSED"));
        const timer2 = setTimeout(() => finish(reject2)(error("PAGE_BRIDGE_TIMEOUT")), timeout);
        pending.set(id2, { timer: timer2, resolve: finish(resolve2), reject: finish(reject2) });
        callSignal?.addEventListener("abort", cancel, { once: true });
        try {
          port.postMessage({ protocol, requestId: id2, method, params });
        } catch {
          finish(reject2)(error("BRIDGE_UNAVAILABLE"));
        }
      });
    }
  };
  const connection = Object.freeze({
    ready,
    close: onClose,
    async saveFile(input) {
      const payload = parseFileSave(input);
      const result = record(await bridge.call("host.saveFile", payload, FILE_SAVE_CONFIRM_MS + 1e3));
      if (!["download_started", "cancelled"].includes(String(result.status)) || Object.keys(result).some((key) => key !== "status")) throw error("PAGE_RESPONSE_INVALID");
      return Object.freeze({ status: result.status });
    },
    markPresentationReady: () => bridge.call("view.ready", {}, 15e3),
    async closeView(options = {}) {
      if (!object2(options) || Object.keys(options).some((key) => key !== "result")) throw error("PAGE_INVALID_VIEW_DATA");
      const params = Object.hasOwn(options, "result") ? { result: viewSnapshot(options.result) } : {};
      return accepted(await bridge.call("view.close", params, 15e3));
    },
    async openView(options = { viewId: "" }) {
      if (!object2(options) || Object.keys(options).some((key) => !["viewId", "data"].includes(key)) || typeof options.viewId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.viewId)) throw error("PAGE_INVALID_VIEW_DATA");
      const params = { viewId: options.viewId, container: "modal_dialog", data: viewSnapshot(options.data === void 0 ? {} : options.data) };
      if (viewOpenings.size >= 32) throw error("PAGE_OPERATION_BUSY");
      let requestId2 = "";
      try {
        const result = await bridge.call("view.open", params, 15e3, (id2) => {
          requestId2 = id2;
          viewOpenings.add(id2);
        });
        return Object.freeze({ ...accepted(result), requestId: requestId2 });
      } catch (cause) {
        if (errorCode(cause) !== "PAGE_BRIDGE_TIMEOUT") viewOpenings.delete(requestId2);
        throw cause;
      }
    },
    onViewClosed(listener) {
      if (closed || typeof listener !== "function") throw error("PAGE_CLOSED");
      viewSubscribers.add(listener);
      return () => viewSubscribers.delete(listener);
    },
    async openTopic(input = { channelId: "", topicId: "" }) {
      if (!object2(input) || Object.keys(input).some((key) => !["channelId", "topicId"].includes(key)) || !["channelId", "topicId"].every((key) => typeof input[key] === "string" && input[key].length > 0 && input[key].length <= 36))
        throw error("PAGE_INVALID_NAVIGATION");
      return accepted(await bridge.call("host.openTopic", { channelId: input.channelId, topicId: input.topicId }, 15e3));
    },
    composer: Object.freeze({ insert: (input) => composer("composer.insert", input), send: (input) => composer("composer.send", input) }),
    resize({ height }) {
      if (!Number.isFinite(height) || height <= 0) return Promise.reject(error("INVALID_VIEW_SIZE"));
      return bridge.call("view.resize", { height }, 15e3);
    },
    openExternal({ url }) {
      if (typeof url !== "string" || url.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(url))
        return Promise.reject(error("INVALID_EXTERNAL_URL"));
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return Promise.reject(error("INVALID_EXTERNAL_URL"));
      }
      const localLink = parsed.protocol === "http:" && origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.origin === win.location?.origin;
      if (!(parsed.protocol === "https:" || localLink) || parsed.username || parsed.password)
        return Promise.reject(error("INVALID_EXTERNAL_URL"));
      return bridge.call("host.openExternal", { url }, 15e3);
    },
    onThemeChange(listener) {
      if (closed || typeof listener !== "function") throw error("PAGE_CLOSED");
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    }
  });
  connections.set(connection, bridge);
  return connection;
  async function composer(method, input) {
    if (!object2(input) || Object.keys(input).some((key) => !["operationId", "text", "images"].includes(key)) || typeof input.operationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(input.operationId) || input.text !== void 0 && (typeof input.text !== "string" || input.text.length > 4e3) || input.images !== void 0 && (!Array.isArray(input.images) || input.images.length > 4)) throw error("PAGE_INVALID_COMPOSER_CONTENT");
    const BlobType = win.Blob || globalThis.Blob;
    const images = (input.images || []).map((image) => {
      if (!object2(image) || Object.keys(image).some((key) => !["name", "blob"].includes(key)) || typeof image.name !== "string" || !image.name || image.name.length > 128 || /[/\\\x00-\x1f]/.test(image.name) || !BlobType || !(image.blob instanceof BlobType) || !image.blob.size || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.blob.type))
        throw error("PAGE_INVALID_COMPOSER_CONTENT");
      return { name: image.name, blob: image.blob };
    });
    if (!(input.text || "").trim() && !images.length || images.reduce((bytes, image) => bytes + image.blob.size, 0) > 10 * 1024 * 1024)
      throw error("PAGE_INVALID_COMPOSER_CONTENT");
    const params = { operationId: input.operationId, ...input.text === void 0 ? {} : { text: input.text }, ...input.images === void 0 ? {} : { images } };
    const result = record(await bridge.call(method, params, 6e4));
    if (!object2(result) || result.operationId !== params.operationId || result.status !== (method === "composer.send" ? "sent" : "inserted") || method === "composer.send" && (typeof result.messageId !== "string" || !result.messageId)) throw error("PAGE_RESPONSE_INVALID");
    return result;
  }
}
async function createPageClient(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || "fetcher" in options) throw error("PAGE_INVALID_OPTIONS");
  const { path = "/colink/page", connection: existing } = options;
  const fetcher = globalThis.fetch;
  const ownsConnection = existing === void 0;
  const common = ["path"];
  const connecting = ["window", "signal", "timeoutMs", "deferPresentation"];
  const explicit = options.hostOrigin !== void 0 || options.issuer !== void 0;
  const allowed = existing !== void 0 ? [...common, "connection", "issuer"] : [...common, ...connecting, ...explicit ? ["hostOrigin", "issuer", "allowInsecureLocal"] : ["configUrl"]];
  if (Object.keys(options).some((key) => !allowed.includes(key)) || typeof fetcher !== "function") throw error("PAGE_INVALID_OPTIONS");
  if (!/^\/[a-z][a-z0-9/-]*$/.test(path) || path.endsWith("/") || path.includes("//")) throw error("INVALID_PAGE_PATH");
  const { timeoutMs = 15e3, signal } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15e3) throw error("INVALID_TIMEOUT");
  if (signal?.aborted) throw error("PAGE_CLOSED");
  let config = options;
  if (ownsConnection && !explicit) {
    const { configUrl = "/page-config.json" } = options;
    if (typeof configUrl !== "string" || !/^\/(?!\/)[A-Za-z0-9/_-]+\.json$/.test(configUrl)) throw error("PAGE_CONFIG_INVALID");
    const configSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...signal ? [signal] : []]);
    let response;
    try {
      response = await fetcher(configUrl, {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: configSignal
      });
    } catch {
      throw error(signal?.aborted ? "PAGE_CLOSED" : "PAGE_CONFIG_UNAVAILABLE");
    }
    if (!response.ok) throw error("PAGE_CONFIG_UNAVAILABLE");
    let received;
    try {
      received = await response.json();
    } catch {
      throw error(signal?.aborted ? "PAGE_CLOSED" : configSignal.aborted ? "PAGE_CONFIG_UNAVAILABLE" : "PAGE_CONFIG_INVALID");
    }
    if (configSignal.aborted) throw error(signal?.aborted ? "PAGE_CLOSED" : "PAGE_CONFIG_UNAVAILABLE");
    if (!object2(received) || typeof received.hostOrigin !== "string" || typeof received.issuer !== "string" || received.allowInsecureLocal !== void 0 && typeof received.allowInsecureLocal !== "boolean") throw error("PAGE_CONFIG_INVALID");
    config = { hostOrigin: received.hostOrigin, issuer: received.issuer, allowInsecureLocal: received.allowInsecureLocal };
  }
  const { issuer } = config;
  let url;
  try {
    url = new URL(issuer ?? "");
  } catch {
    throw error("INVALID_ISSUER");
  }
  if (url.origin !== issuer || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw error("INVALID_ISSUER");
  if (ownsConnection && config.allowInsecureLocal !== void 0 && typeof config.allowInsecureLocal !== "boolean") throw error("PAGE_INVALID_OPTIONS");
  const connection = existing ?? connectPage({
    hostOrigin: config.hostOrigin ?? "",
    allowInsecureLocal: config.allowInsecureLocal,
    timeoutMs,
    signal,
    window: options.window,
    deferPresentation: options.deferPresentation
  });
  const registeredBridge = connections.get(connection);
  if (!registeredBridge) throw error("PAGE_CONNECTION_REQUIRED");
  const bridge = registeredBridge;
  if (bridge.client) throw error("PAGE_CLIENT_ALREADY_CREATED");
  bridge.client = true;
  let context;
  try {
    context = await connection.ready;
    if (bridge.closed) throw error("PAGE_CLOSED");
  } catch (failure) {
    bridge.client = false;
    if (ownsConnection) connection.close();
    throw failure;
  }
  const crypto = bridge.win.crypto ?? globalThis.crypto;
  let token, active;
  let loginPending, authorizationPending;
  const controller = new AbortController();
  const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  async function fileBody(response, requestSignal) {
    const limit = 16 * 1024 * 1024, contentType = response.headers.get("content-type") || "application/octet-stream";
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > limit) {
      void response.body?.cancel().catch(() => {
      });
      throw error("PAGE_FILE_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) return { bytes: new Uint8Array(), contentType };
    const abort = () => {
      void reader.cancel().catch(() => {
      });
    };
    requestSignal.addEventListener("abort", abort, { once: true });
    const chunks = [];
    let size = 0;
    try {
      if (requestSignal.aborted) abort();
      while (!requestSignal.aborted) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw error("PAGE_RESPONSE_INVALID");
        size += part.value.byteLength;
        if (size > limit) {
          abort();
          throw error("PAGE_FILE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
      if (requestSignal.aborted) throw error(controller.signal.aborted || bridge.closed ? "PAGE_CLOSED" : "PAGE_NETWORK_UNAVAILABLE");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return { bytes, contentType };
    } catch (failure) {
      if (failure instanceof CoLinkError && ["PAGE_FILE_TOO_LARGE", "PAGE_RESPONSE_INVALID", "PAGE_CLOSED"].includes(failure.code)) throw failure;
      throw error(controller.signal.aborted || bridge.closed ? "PAGE_CLOSED" : "PAGE_NETWORK_UNAVAILABLE");
    } finally {
      requestSignal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }
  async function request(route, body, authenticated = true, custom = false, options2 = {}) {
    if (controller.signal.aborted || bridge.closed) throw error("PAGE_CLOSED");
    if (authenticated && !token) throw error("PAGE_LOGIN_REQUIRED");
    const sentToken = token;
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(options2.timeoutMs ?? 15e3)]);
    let response;
    try {
      response = await fetcher(custom ? route : path + route, {
        method: options2.method || "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json", ...authenticated ? { Authorization: "Bearer " + sentToken } : {}, ...options2.key ? { "Idempotency-Key": options2.key } : {} },
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal: requestSignal
      });
    } catch {
      throw error(controller.signal.aborted || bridge.closed ? "PAGE_CLOSED" : "PAGE_NETWORK_UNAVAILABLE");
    }
    if (options2.binary && response.ok) {
      const value2 = await fileBody(response, requestSignal);
      if (controller.signal.aborted || bridge.closed) throw error("PAGE_CLOSED");
      if (token !== sentToken) throw error("PAGE_LOGIN_REQUIRED");
      return value2;
    }
    if (options2.binary && response.status === 401 && token === sentToken) token = void 0;
    let value;
    try {
      value = response.status === 204 ? null : options2.binary ? JSON.parse(new TextDecoder().decode((await fileBody(response, requestSignal)).bytes)) : await response.json();
    } catch (failure) {
      if (options2.binary && failure instanceof CoLinkError) throw failure;
      throw error("PAGE_RESPONSE_INVALID");
    }
    if (controller.signal.aborted || bridge.closed) throw error("PAGE_CLOSED");
    if (!response.ok) {
      const failure = responseError(value, response.status, { fallback: "PAGE_UNAVAILABLE", secrets: [sentToken, token].filter((value2) => typeof value2 === "string") });
      if (response.status === 401 && token === sentToken) token = void 0;
      throw failure;
    }
    return value;
  }
  function operation(kind, fn) {
    if (controller.signal.aborted || bridge.closed) return Promise.reject(error("PAGE_CLOSED"));
    const pendingLogin = active?.kind === "login" && kind.startsWith("authorize:") ? active.work : void 0;
    if (active && !pendingLogin) return active.kind === kind ? active.work : Promise.reject(error("PAGE_OPERATION_BUSY"));
    const work = (pendingLogin ?? Promise.resolve()).then(fn);
    active = { kind, work };
    return work.finally(() => {
      if (active?.work === work) active = void 0;
    });
  }
  async function identityOperation(kind, fn) {
    const value = await operation(kind, fn);
    if (!isPageIdentity(value)) throw error("PAGE_RESPONSE_INVALID");
    return value;
  }
  async function transaction(kind, scopes, accessMode = "session") {
    let pending = kind === "login" ? loginPending : authorizationPending;
    if (pending && Date.now() >= pending.expiresAt) pending = void 0;
    if (pending && kind === "authorize" && (pending.scopeKey !== scopes?.join(" ") || pending.accessMode !== accessMode)) pending = void 0;
    if (!pending) {
      const state = random(), nonce = random(), verifier = random();
      const codeChallenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const begin = () => request("/" + kind + "/start", { state, codeChallenge, ...kind === "login" ? { nonce } : { ...scopes === void 0 ? { scopeMode: "manifest" } : { scopes }, accessMode } }, kind !== "login");
      let result;
      try {
        result = await begin();
      } catch (failure) {
        if (kind !== "authorize" || !(failure instanceof CoLinkError) || failure.code !== "PAGE_LOGIN_REQUIRED" || failure.status !== 401) throw failure;
        await transaction("login");
        result = await begin();
      }
      if (!object2(result) || typeof result.transaction !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.transaction)) throw error("PAGE_RESPONSE_INVALID");
      pending = { transaction: result.transaction, state, nonce, verifier, codeChallenge, scopeKey: scopes?.join(" "), accessMode, expiresAt: Date.now() + (kind === "login" ? 12e4 : 6e5) };
    }
    if (kind === "login") loginPending = pending;
    else authorizationPending = pending;
    try {
      if (!pending.reply) {
        pending.reply = await bridge.call(kind === "login" ? "host.login" : "host.authorize", {
          state: pending.state,
          codeChallenge: pending.codeChallenge,
          codeChallengeMethod: "S256",
          ...kind === "login" ? { nonce: pending.nonce } : { ...scopes === void 0 ? { scopeMode: "manifest" } : { scopes }, accessMode }
        }, kind === "login" ? 15e3 : 6e5, void 0, controller.signal);
      }
      const reply = pending.reply;
      if (!object2(reply) || reply.state !== pending.state || reply.issuer !== issuer || typeof reply.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(reply.code) || kind === "authorize" && (typeof reply.executionId !== "string" || !reply.executionId)) throw error("PAGE_TRANSACTION_INVALID");
      const body = {
        transaction: pending.transaction,
        state: reply.state,
        issuer: reply.issuer,
        code: reply.code,
        codeVerifier: pending.verifier,
        ...kind === "authorize" ? { executionId: reply.executionId } : {}
      };
      const result = await request("/" + kind + "/complete", body, kind !== "login");
      if (!object2(result) || typeof result.sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.sessionToken) || !isPageIdentity(result.identity) || result.backgroundGrant !== void 0 && !isBackgroundGrant(result.backgroundGrant)) throw error("PAGE_RESPONSE_INVALID");
      if (controller.signal.aborted || bridge.closed) throw error("PAGE_CLOSED");
      token = result.sessionToken;
      if (kind === "login") loginPending = authorizationPending = void 0;
      else authorizationPending = void 0;
      return Object.freeze({ ...result.identity, ...result.backgroundGrant ? { backgroundGrant: result.backgroundGrant } : {} });
    } catch (failure) {
      if (errorCode(failure) !== "PAGE_NETWORK_UNAVAILABLE" && !(failure instanceof CoLinkError && failure.status >= 500)) {
        if (kind === "login") loginPending = void 0;
        else authorizationPending = void 0;
      }
      throw failure;
    }
  }
  function dispose() {
    if (controller.signal.aborted) return;
    controller.abort();
    bridge.closing.delete(dispose);
    bridge.client = false;
    const old = token;
    token = void 0;
    loginPending = authorizationPending = void 0;
    if (old) void fetcher(path + "/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + old },
      body: "{}",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      keepalive: true,
      signal: AbortSignal.timeout(5e3)
    }).catch(() => {
    });
  }
  bridge.closing.add(dispose);
  const business = createBusinessMethods(async (input) => {
    input = structuredClone(input);
    if (input.bytes instanceof Uint8Array) {
      let text = "";
      for (let i = 0; i < input.bytes.length; i += 8192) text += String.fromCharCode(...input.bytes.subarray(i, i + 8192));
      input.bytes = btoa(text);
    }
    const slow = input.method === "POST" && (/^\/app-deployments(?:\/|$)/.test(input.path) || /^\/app-capabilities\/[^/]+\/calls$/.test(input.path));
    const result = await request("/http", input, true, false, { timeoutMs: slow ? 125e3 : 15e3 });
    if (object2(result) && typeof result.bytes === "string" && typeof result.contentType === "string") result.bytes = Uint8Array.from(atob(result.bytes), (c) => c.charCodeAt(0));
    return result;
  }, void 0, void 0);
  function requestBackend(input) {
    const invalid = (field, message, hint) => Promise.reject(new CoLinkError("PAGE_INVALID_REQUEST", 400, void 0, {
      message,
      hint,
      details: [{ field: "requestBackend." + field, code: "INVALID_REQUEST_FIELD", message }]
    }));
    if (!object2(input) || Object.keys(input).some((key) => !["path", "method", "query", "body", "idempotencyKey"].includes(key)))
      return invalid("request", "App \u540E\u7AEF\u8BF7\u6C42\u5305\u542B\u4E0D\u652F\u6301\u7684\u53C2\u6570\u3002", "\u4EC5\u4F20 path\u3001method\u3001query\u3001body\u3001idempotencyKey\uFF1B\u4E0D\u8981\u4F20\u51ED\u636E\u5934\u3002");
    const { path: route, method = "GET", query, body, idempotencyKey } = input;
    if (typeof route !== "string" || !/^\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(route) || route.includes("//"))
      return invalid("path", "App \u540E\u7AEF path \u5FC5\u987B\u662F\u540C\u6E90\u8DEF\u5F84\uFF1B\u67E5\u8BE2\u53C2\u6570\u8BF7\u653E\u5165 query\u3002", '\u4F8B\u5982 {path:"/api/items",query:{limit:20}}\uFF1Bpath \u4E0D\u542B\u57DF\u540D\u3001?\u3001#\u3001\u8D8A\u754C\u6BB5\u6216\u53CC\u659C\u7EBF\u3002');
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
      return invalid("method", "App \u540E\u7AEF\u8BF7\u6C42\u65B9\u6CD5\u4E0D\u53D7\u652F\u6301\u3002", "method \u4F7F\u7528 GET\u3001POST\u3001PUT\u3001PATCH \u6216 DELETE\u3002");
    if (method === "GET" && body !== void 0)
      return invalid("body", "GET \u8BF7\u6C42\u4E0D\u80FD\u5305\u542B body\u3002", "\u7701\u7565 body\uFF0C\u5C06\u7B5B\u9009\u6761\u4EF6\u653E\u5165 query\uFF1B\u5199\u5165\u4F7F\u7528\u5BF9\u5E94\u7684 method\u3002");
    if (idempotencyKey !== void 0 && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)))
      return invalid("idempotencyKey", "App \u540E\u7AEF\u4E1A\u52A1\u64CD\u4F5C\u952E\u683C\u5F0F\u65E0\u6548\u3002", "idempotencyKey \u4F7F\u7528 1\u2013128 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u6216 ._:-\uFF1B\u540C\u4E00\u64CD\u4F5C\u91CD\u8BD5\u4FDD\u6301\u539F\u503C\u3002");
    if (query !== void 0 && (!object2(query) || Object.values(query).some((v) => !["string", "number", "boolean"].includes(typeof v))))
      return invalid("query", "App \u540E\u7AEF query \u5FC5\u987B\u662F\u7B80\u5355\u503C\u5B57\u5178\u3002", "\u6BCF\u4E2A query \u503C\u4F7F\u7528\u5B57\u7B26\u4E32\u3001\u6570\u503C\u6216\u5E03\u5C14\u503C\uFF0C\u4E0D\u4F20\u6570\u7EC4\u6216\u5D4C\u5957\u5BF9\u8C61\u3002");
    const params = new URLSearchParams(Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]));
    return request(route + (params.size ? "?" + params : ""), body, true, true, { method, key: idempotencyKey });
  }
  function downloadBackend(input) {
    const invalid = (field, message) => Promise.reject(new CoLinkError("PAGE_INVALID_REQUEST", 400, void 0, {
      message,
      hint: "\u4F20\u540C\u6E90 path \u548C\u7B80\u5355\u503C query\uFF1B\u4E0D\u4F20 URL\u3001\u51ED\u636E\u5934\u3001method \u6216 body\u3002",
      details: [{ field: "downloadBackend." + field, code: "INVALID_REQUEST_FIELD", message }]
    }));
    if (!object2(input) || Object.keys(input).some((key) => !["path", "query"].includes(key)))
      return invalid("request", "\u6587\u4EF6\u4E0B\u8F7D\u53EA\u63A5\u53D7 path \u548C query\u3002");
    const { path: route, query } = input;
    if (typeof route !== "string" || !/^\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(route) || route.includes("//") || route.split("/").some((part) => part === "." || part === ".."))
      return invalid("path", "\u6587\u4EF6 path \u5FC5\u987B\u662F\u540C\u6E90\u8DEF\u5F84\uFF0C\u67E5\u8BE2\u6761\u4EF6\u5355\u72EC\u653E\u5165 query\u3002");
    if (query !== void 0 && (!object2(query) || Object.values(query).some((v) => !["string", "number", "boolean"].includes(typeof v))))
      return invalid("query", "\u6587\u4EF6 query \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u3001\u6570\u503C\u6216\u5E03\u5C14\u503C\u7EC4\u6210\u7684\u5B57\u5178\u3002");
    const params = new URLSearchParams(Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]));
    return request(route + (params.size ? "?" + params : ""), void 0, true, true, { method: "GET", binary: true });
  }
  return Object.freeze({
    context,
    connection,
    user: identityMethods(business, "user"),
    login: () => identityOperation("login", () => transaction("login")),
    authorize(scopes, { accessMode = "session" } = {}) {
      if (!["session", "background"].includes(accessMode) || (scopes === void 0 ? accessMode !== "session" : !Array.isArray(scopes) || !scopes.length || scopes.some((s) => !USER_SCOPES.includes(s) || ["openid", "profile"].includes(s) || accessMode === "background" && !BACKGROUND_SCOPES.includes(s)) || new Set(scopes).size !== scopes.length)) return Promise.reject(error("PAGE_UNSUPPORTED_SCOPE"));
      const copy = scopes === void 0 ? void 0 : [...scopes].sort();
      return identityOperation("authorize:" + accessMode + ":" + (copy?.join(" ") ?? ""), async () => {
        if (!token) await transaction("login");
        return transaction("authorize", copy, accessMode);
      });
    },
    async getIdentity() {
      const identity = await request("/identity", {});
      if (!isPageIdentity(identity)) throw error("PAGE_RESPONSE_INVALID");
      return identity;
    },
    /** JSON POST to an App-owned same-origin route. App must call pages.authenticate. */
    requestBackend,
    downloadBackend,
    logout: async () => {
      await operation("logout", async () => {
        try {
          if (token) await request("/logout", {});
        } finally {
          token = void 0;
          loginPending = authorizationPending = void 0;
        }
      });
    },
    close() {
      dispose();
      if (ownsConnection) connection.close();
    }
  });
}
export {
  ApiContextVersion,
  AppTag,
  BridgeProtocol,
  ExtensionPoint,
  InstallationScope,
  NavigationParent,
  Permission,
  ProtocolVersion,
  ViewContainer,
  ViewRenderer,
  connectPage,
  createPageClient
};
