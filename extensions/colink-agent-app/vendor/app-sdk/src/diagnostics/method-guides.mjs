export const METHOD_GUIDES = {
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.projects.list({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#projectslist--projectsiterate",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
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
                        "description": "最多遍历页数，正整数，默认 100；达到上限仍有数据则失败。"
                    },
                    {
                        "name": "signal",
                        "type": "AbortSignal",
                        "required": false,
                        "description": "调用方的 AbortSignal，用于取消遍历。"
                    }
                ],
                "open": false
            }
        ],
        "example": "for await (const item of colink.user.projects.iterate({})) { /* 处理 item */ }",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#projectslist--projectsiterate",
        "note": "迭代时 next() 拒绝；创建迭代器不开始请求；已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "for await (const item of colink.user.projects.iterate({})) { /* 处理 item */ }",
            "app": "for await (const item of colink.app.projects.iterate({})) { /* 处理 item */ }"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "projectId",
                        "type": "string",
                        "required": false,
                        "description": "项目 ID；从当前可信上下文或 projects.list 结果取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.channels.list({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#channelslist--channelsiterate",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "projectId",
                        "type": "string",
                        "required": false,
                        "description": "项目 ID；从当前可信上下文或 projects.list 结果取得。"
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
                        "description": "最多遍历页数，正整数，默认 100；达到上限仍有数据则失败。"
                    },
                    {
                        "name": "signal",
                        "type": "AbortSignal",
                        "required": false,
                        "description": "调用方的 AbortSignal，用于取消遍历。"
                    }
                ],
                "open": false
            }
        ],
        "example": "for await (const item of colink.user.channels.iterate({})) { /* 处理 item */ }",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#channelslist--channelsiterate",
        "note": "迭代时 next() 拒绝；创建迭代器不开始请求；已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "for await (const item of colink.user.channels.iterate({})) { /* 处理 item */ }",
            "app": "for await (const item of colink.app.channels.iterate({})) { /* 处理 item */ }"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "topicId",
                        "type": "string",
                        "required": false,
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.channels.listMembers({\"channelId\":\"<channelId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#channelslistmembers",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.channels.listMembers({\"channelId\":\"<channelId>\"});"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "beforeMessageId",
                        "type": "string",
                        "required": false,
                        "description": "读取该消息之前的消息。"
                    },
                    {
                        "name": "afterMessageId",
                        "type": "string",
                        "required": false,
                        "description": "读取该消息之后的消息。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.channels.listMessages({\"channelId\":\"<channelId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#channelslistmessages",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.channels.listMessages({\"channelId\":\"<channelId>\"});",
            "app": "await colink.app.channels.listMessages({\"channelId\":\"<channelId>\"});"
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
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.channels.listUnreadMessages({\"channelId\":\"<channelId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#channelslistunreadmessages",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.channels.listUnreadMessages({\"channelId\":\"<channelId>\"});"
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
                        "description": "消息 ID；从读取结果或发送回执取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.messages.get({\"messageId\":\"<messageId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#messagesget",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.messages.get({\"messageId\":\"<messageId>\"});",
            "app": "await colink.app.messages.get({\"messageId\":\"<messageId>\"});"
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
                        "description": "消息 ID；从读取结果或发送回执取得。"
                    },
                    {
                        "name": "expectedRevision",
                        "type": "number",
                        "required": true,
                        "description": "原消息的正文版本；更新成功后递增，版本冲突时先读取最新消息。"
                    },
                    {
                        "name": "text",
                        "type": "string",
                        "required": true,
                        "description": "消息或草稿正文。"
                    },
                    {
                        "name": "fileIds",
                        "type": "string[]",
                        "required": false,
                        "description": "随消息发送的已上传文件 ID 列表。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.messages.replace({\"messageId\":\"<messageId>\",\"expectedRevision\":1,\"text\":\"处理完成\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#messagesreplace",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。仅更新本安装自己的消息。expectedRevision 必须来自读取或点击事件；冲突时重新确认业务，不自动覆盖。省略 fileIds 会移除原附件引用。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.messages.replace({\"messageId\":\"<messageId>\",\"expectedRevision\":1,\"text\":\"处理完成\"});"
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
                        "description": "消息 ID；从读取结果或发送回执取得。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": false,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.messages.recall({\"messageId\":\"<messageId>\",\"idempotencyKey\":\"<persistent-operation-id>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#messagesrecall",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.messages.recall({\"messageId\":\"<messageId>\",\"idempotencyKey\":\"<persistent-operation-id>\"});"
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
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "text",
                        "type": "string",
                        "required": true,
                        "description": "消息或草稿正文。"
                    },
                    {
                        "name": "fileIds",
                        "type": "string[]",
                        "required": false,
                        "description": "随消息发送的已上传文件 ID 列表。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": false,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "topicId",
                        "type": "null | string",
                        "required": false,
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "sourceEventId",
                        "type": "string",
                        "required": false,
                        "description": "本安装收到的来源事件 ID，绑定项目公共话题及 Agent 协作预算。"
                    },
                    {
                        "name": "mentions",
                        "type": "MessageMentions",
                        "required": false,
                        "description": "逐项身份提及：version:1、items 最多100项；每项为原始正文 UTF-16 start/end、公开名 label，以及 user/userId 或 app/installationId。空 items 表示不解析文本。"
                    },
                    {
                        "name": "conversationId",
                        "type": "string",
                        "required": false,
                        "description": "当前唤醒所属的私聊 ID；必须有用户授权和本安装对应投递，不能选择其他会话。"
                    },
                    {
                        "name": "sourceMessageId",
                        "type": "string",
                        "required": false,
                        "description": "本安装已收到的私聊唤醒来源消息 ID；回话授权由平台按持久投递复核。"
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
                                "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                            },
                            {
                                "name": "text",
                                "type": "string",
                                "required": true,
                                "description": "消息或草稿正文。"
                            },
                            {
                                "name": "fileIds",
                                "type": "string[]",
                                "required": false,
                                "description": "随消息发送的已上传文件 ID 列表。"
                            },
                            {
                                "name": "channelId",
                                "type": "string",
                                "required": true,
                                "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                            },
                            {
                                "name": "topicId",
                                "type": "string",
                                "required": false,
                                "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                            },
                            {
                                "name": "sourceEventId",
                                "type": "string",
                                "required": false,
                                "description": "本安装收到的来源事件 ID，绑定项目公共话题及 Agent 协作预算。"
                            },
                            {
                                "name": "mentions",
                                "type": "MessageMentions",
                                "required": false,
                                "description": "逐项身份提及：version:1、items 最多100项；每项为原始正文 UTF-16 start/end、公开名 label，以及 user/userId 或 app/installationId。空 items 表示不解析文本。"
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
                                "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                            },
                            {
                                "name": "text",
                                "type": "string",
                                "required": true,
                                "description": "消息或草稿正文。"
                            },
                            {
                                "name": "fileIds",
                                "type": "string[]",
                                "required": false,
                                "description": "随消息发送的已上传文件 ID 列表。"
                            },
                            {
                                "name": "conversationId",
                                "type": "string",
                                "required": true,
                                "description": "当前唤醒所属的私聊 ID；必须有用户授权和本安装对应投递，不能选择其他会话。"
                            },
                            {
                                "name": "sourceMessageId",
                                "type": "string",
                                "required": true,
                                "description": "本安装已收到的私聊唤醒来源消息 ID；回话授权由平台按持久投递复核。"
                            },
                            {
                                "name": "topicId",
                                "type": "null | string",
                                "required": false,
                                "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
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
        "example": "await colink.app.messages.send({\"idempotencyKey\":\"<persistent-operation-id>\",\"channelId\":\"<channelId>\",\"text\":\"已处理\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#messagessend",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。文本最多64000码元，SDK按4000码元自动分片；messages返回全部回执，顶层字段指第一条。附件只在首片，新建频道话题后续片回同一话题。原键与完整原参数重试，分片非原子提交。mentions 逐项绑定公开名和稳定目标，按原始正文 UTF-16 范围计数；显式空 items 不解析文本，非法元数据拒绝；名册须声明 mentionProtocol:1。频道仅 channelId 创建新话题，topicId 回复已有话题。私聊回话时可选：传值回本会话该话题，null 回主时间线，省略回唤醒来源。App 卡片支持频道新话题和话题回复，新话题回执 topicId 等于 messageId；sendEvent 另需 app.colink_ui_action_invoked 订阅及 messages:receive 声明/批准，核对 error.card 的具体原因。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.messages.send({\"idempotencyKey\":\"<persistent-operation-id>\",\"channelId\":\"<channelId>\",\"text\":\"已处理\"});"
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
                        "description": "项目 ID；从当前可信上下文或 projects.list 结果取得。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": false,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "topicIds",
                        "type": "string[]",
                        "required": false,
                        "description": "按话题 ID 列表筛选。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.topics.list({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#topicslist",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.topics.listMessages({\"topicId\":\"<topicId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#topicslistmessages",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.topics.listMessages({\"topicId\":\"<topicId>\"});",
            "app": "await colink.app.topics.listMessages({\"topicId\":\"<topicId>\"});"
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
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.topics.listParticipants({\"topicId\":\"<topicId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#topicslistparticipants",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.topics.listParticipants({\"topicId\":\"<topicId>\"});",
            "app": "await colink.app.topics.listParticipants({\"topicId\":\"<topicId>\"});"
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
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "artifactId",
                        "type": "string",
                        "required": true,
                        "description": "话题图片附件标识；从消息图片元数据取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.topics.readImage({\"topicId\":\"<topicId>\",\"artifactId\":\"<artifactId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#topicsreadimage",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.topics.readImage({\"topicId\":\"<topicId>\",\"artifactId\":\"<artifactId>\"});"
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
                        "description": "当前唤醒所属的私聊 ID；必须有用户授权和本安装对应投递，不能选择其他会话。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "beforeId",
                        "type": "string",
                        "required": false,
                        "description": "读取该私聊消息之前的消息，必须与当前会话匹配。"
                    },
                    {
                        "name": "afterId",
                        "type": "string",
                        "required": false,
                        "description": "读取该私聊消息之后的消息，必须与当前会话匹配。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.directMessages.list({\"conversationId\":\"<conversationId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#directmessageslist",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.directMessages.list({\"conversationId\":\"<conversationId>\"});"
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
                        "description": "当前唤醒所属的私聊 ID；必须有用户授权和本安装对应投递，不能选择其他会话。"
                    },
                    {
                        "name": "artifactId",
                        "type": "string",
                        "required": true,
                        "description": "话题图片附件标识；从消息图片元数据取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.directMessages.downloadAttachment({\"conversationId\":\"<conversationId>\",\"artifactId\":\"<artifactId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#directmessagesdownloadattachment",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.directMessages.downloadAttachment({\"conversationId\":\"<conversationId>\",\"artifactId\":\"<artifactId>\"});"
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
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "topicId",
                        "type": "string",
                        "required": true,
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "text",
                        "type": "string",
                        "required": true,
                        "description": "消息或草稿正文。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.drafts.create({\"idempotencyKey\":\"<persistent-operation-id>\",\"topicId\":\"<topicId>\",\"text\":\"<text>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#draftscreate",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.drafts.create({\"idempotencyKey\":\"<persistent-operation-id>\",\"topicId\":\"<topicId>\",\"text\":\"<text>\"});"
        }
    },
    "events.reportStatus": {
        "method": "events.reportStatus",
        "route": "POST /agent-sessions/status",
        "arguments": [
            {
                "name": "input",
                "optional": false,
                "type": "{ idempotencyKey: string; eventId?: string; channelId: string; topicId: string; sequence: number; status: \"processing\" | \"suspended\" | \"finished\"; }",
                "parameters": [
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "eventId",
                        "type": "string",
                        "required": false,
                        "description": "当前平台投递的事件 ID；事件客户端可自动绑定，不构造事件。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "topicId",
                        "type": "string",
                        "required": true,
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "sequence",
                        "type": "number",
                        "required": true,
                        "description": "当前执行的递增序号，整数 1–2147483647；同一次重试沿用原值。"
                    },
                    {
                        "name": "status",
                        "type": "\"finished\" | \"processing\" | \"suspended\"",
                        "required": true,
                        "description": "本入口定义的状态，不能混用其他接口的状态枚举。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.events.reportStatus({\"idempotencyKey\":\"<persistent-operation-id>\",\"eventId\":\"<eventId>\",\"channelId\":\"<channelId>\",\"topicId\":\"<topicId>\",\"sequence\":1,\"status\":\"processing\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-events.md#eventsreportstatus",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。仅手动状态流程使用；自动状态管理开启时调用 turn.setDisplayStatus。eventId 在事件客户端中自动绑定。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.events.reportStatus({\"idempotencyKey\":\"<persistent-operation-id>\",\"eventId\":\"<eventId>\",\"channelId\":\"<channelId>\",\"topicId\":\"<topicId>\",\"sequence\":1,\"status\":\"processing\"});"
        }
    },
    "events.reportUndelivered": {
        "method": "events.reportUndelivered",
        "route": "POST /extensions/agent-apps/receipts",
        "arguments": [
            {
                "name": "input",
                "optional": false,
                "type": "{ eventId?: string; reason: \"agent_backend_unavailable\" | \"channel_denied\" | \"app_failed\"; requestId: string; threadId: string; channelId: string; errorCode?: string; errorMessage?: string; }",
                "parameters": [
                    {
                        "name": "eventId",
                        "type": "string",
                        "required": false,
                        "description": "当前平台投递的事件 ID；事件客户端可自动绑定，不构造事件。"
                    },
                    {
                        "name": "reason",
                        "type": "\"agent_backend_unavailable\" | \"app_failed\" | \"channel_denied\"",
                        "required": true,
                        "description": "状态或分派调整原因。"
                    },
                    {
                        "name": "requestId",
                        "type": "string",
                        "required": true,
                        "description": "持久保存的未送达报告去重标识，最长64；重试保持不变。"
                    },
                    {
                        "name": "threadId",
                        "type": "string",
                        "required": true,
                        "description": "原事件绑定的话题 ID，最长36；不是任务 ID。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "errorCode",
                        "type": "string",
                        "required": false,
                        "description": "供排查的安全错误码，最长64，不含凭据。"
                    },
                    {
                        "name": "errorMessage",
                        "type": "string",
                        "required": false,
                        "description": "供排查的安全描述，最长512，不含堆栈或凭据。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.events.reportUndelivered({\"reason\":\"app_failed\",\"eventId\":\"<eventId>\",\"requestId\":\"<persistent-request-id>\",\"channelId\":\"<channelId>\",\"threadId\":\"<topicId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-events.md#eventsreportundelivered",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。只上报原事件未送达；requestId 为业务持久去重标识，不换标识重试。threadId/channelId 必须匹配原事件，不含凭据或完整日志。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.events.reportUndelivered({\"reason\":\"app_failed\",\"eventId\":\"<eventId>\",\"requestId\":\"<persistent-request-id>\",\"channelId\":\"<channelId>\",\"threadId\":\"<topicId>\"});"
        }
    },
    "actions.complete": {
        "method": "actions.complete",
        "route": "POST /extensions/ui-requests",
        "arguments": [
            {
                "name": "input",
                "optional": false,
                "type": "{ idempotencyKey: string; eventId?: string; status: \"succeeded\" | \"failed\"; message?: string; replacement?: { messageId: string; revision: number; }; }",
                "parameters": [
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "eventId",
                        "type": "string",
                        "required": false,
                        "description": "当前平台投递的事件 ID；事件客户端可自动绑定，不构造事件。"
                    },
                    {
                        "name": "status",
                        "type": "\"failed\" | \"succeeded\"",
                        "required": true,
                        "description": "本入口定义的状态，不能混用其他接口的状态枚举。"
                    },
                    {
                        "name": "message",
                        "type": "string",
                        "required": false,
                        "description": "私人交互提示；toast 为 1–200 UTF-16 码元的纯文本。"
                    },
                    {
                        "name": "replacement",
                        "type": "{ messageId: string; revision: number; }",
                        "required": false,
                        "description": "已提交的来源消息更新回执，包含 messageId 和 revision；仅成功结果可附带。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.actions.complete({\"idempotencyKey\":\"<persistent-operation-id>\",\"status\":\"succeeded\",\"message\":\"已完成\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-events.md#actionscomplete",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。业务持久提交后上报原事件结果；ACK 不代表完成。replacement 必须引用已提交的来源消息版本；终态不可改写，重试保留原 idempotencyKey 和正文。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.actions.complete({\"idempotencyKey\":\"<persistent-operation-id>\",\"status\":\"succeeded\",\"message\":\"已完成\"});"
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
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "eventId",
                        "type": "string",
                        "required": false,
                        "description": "当前平台投递的事件 ID；事件客户端可自动绑定，不构造事件。"
                    },
                    {
                        "name": "viewId",
                        "type": "string",
                        "required": true,
                        "description": "本 App Manifest 声明的 renderer=app View ID。"
                    },
                    {
                        "name": "title",
                        "type": "string",
                        "required": false,
                        "description": "展示标题。"
                    },
                    {
                        "name": "message",
                        "type": "string",
                        "required": false,
                        "description": "私人交互提示；toast 为 1–200 UTF-16 码元的纯文本。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.interactions.openDialog({\"idempotencyKey\":\"<persistent-operation-id>\",\"viewId\":\"<viewId>\",\"message\":\"请确认\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-browser.md#interactionsopendialog",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。dialog 需要 viewId；toast 需要 message，不接受 viewId/title。eventId 在事件客户端中自动绑定，其他上下文显式提供。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.interactions.openDialog({\"idempotencyKey\":\"<persistent-operation-id>\",\"viewId\":\"<viewId>\",\"message\":\"请确认\"});"
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
                        "description": "平台交互回执中的 ID，仍须当前页面/事件来源授权。"
                    },
                    {
                        "name": "eventId",
                        "type": "string",
                        "required": false,
                        "description": "当前平台投递的事件 ID；事件客户端可自动绑定，不构造事件。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.interactions.get({\"interactionId\":\"<interactionId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-browser.md#interactionsget--interactionscomplete",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.interactions.get({\"interactionId\":\"<interactionId>\"});"
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
                        "description": "平台交互回执中的 ID，仍须当前页面/事件来源授权。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.interactions.complete({\"interactionId\":\"<interactionId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-browser.md#interactionsget--interactionscomplete",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.interactions.complete({\"interactionId\":\"<interactionId>\"});"
        }
    },
    "interactions.showToast": {
        "method": "interactions.showToast",
        "route": "POST /extensions/ui-requests",
        "arguments": [
            {
                "name": "input",
                "optional": false,
                "type": "{ idempotencyKey: string; eventId?: string; message: string; severity?: \"success\" | \"error\" | \"info\"; durationMs?: number; }",
                "parameters": [
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "eventId",
                        "type": "string",
                        "required": false,
                        "description": "当前平台投递的事件 ID；事件客户端可自动绑定，不构造事件。"
                    },
                    {
                        "name": "message",
                        "type": "string",
                        "required": true,
                        "description": "私人交互提示；toast 为 1–200 UTF-16 码元的纯文本。"
                    },
                    {
                        "name": "severity",
                        "type": "\"error\" | \"info\" | \"success\"",
                        "required": false,
                        "description": "提示级别，默认 success。"
                    },
                    {
                        "name": "durationMs",
                        "type": "number",
                        "required": false,
                        "description": "提示展示毫秒数，整数 1000–10000，默认 3000。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.interactions.showToast({\"idempotencyKey\":\"<persistent-operation-id>\",\"message\":\"操作已保存\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-browser.md#interactionsshowtoast",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.interactions.showToast({\"idempotencyKey\":\"<persistent-operation-id>\",\"message\":\"操作已保存\"});"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "query",
                        "type": "string",
                        "required": false,
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.files.list({\"channelId\":\"<channelId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#fileslist--filesiterate",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。显式指定 channelId 后查询该频道的已发布文件；从可信上下文或 channels.list 选择频道。项目主页不包含默认频道；跨频道查询须分别处理授权与分页。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.files.list({\"channelId\":\"<channelId>\"});"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "query",
                        "type": "string",
                        "required": false,
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
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
                        "description": "最多遍历页数，正整数，默认 100；达到上限仍有数据则失败。"
                    },
                    {
                        "name": "signal",
                        "type": "AbortSignal",
                        "required": false,
                        "description": "调用方的 AbortSignal，用于取消遍历。"
                    }
                ],
                "open": false
            }
        ],
        "example": "for await (const item of colink.user.files.iterate({\"channelId\":\"<channelId>\"})) { /* 处理 item */ }",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#fileslist--filesiterate",
        "note": "迭代时 next() 拒绝；创建迭代器不开始请求；已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。显式指定 channelId 后查询该频道的已发布文件；从可信上下文或 channels.list 选择频道。项目主页不包含默认频道；跨频道查询须分别处理授权与分页。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "for await (const item of colink.user.files.iterate({\"channelId\":\"<channelId>\"})) { /* 处理 item */ }"
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
                        "description": "平台文件 ID；从文件目录或上传准备回执取得。"
                    },
                    {
                        "name": "offset",
                        "type": "number",
                        "required": false,
                        "description": "文本读取起点。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.files.readContent({\"fileId\":\"<fileId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#filesreadcontent",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.files.readContent({\"fileId\":\"<fileId>\"});"
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
                        "description": "文本文件正文。"
                    },
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "fileName",
                        "type": "string",
                        "required": true,
                        "description": "带扩展名的文件名。"
                    },
                    {
                        "name": "title",
                        "type": "string",
                        "required": false,
                        "description": "展示标题。"
                    },
                    {
                        "name": "asArtifact",
                        "type": "boolean",
                        "required": false,
                        "description": "是否作为结果附件。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.files.createText({\"idempotencyKey\":\"<persistent-operation-id>\",\"channelId\":\"<channelId>\",\"fileName\":\"note.txt\",\"content\":\"示例\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#filescreatetext",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。mode=text 必须提供 content；mode=upload 必须提供 sizeBytes 和 sha256，再按回执上传完整字节。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.files.createText({\"idempotencyKey\":\"<persistent-operation-id>\",\"channelId\":\"<channelId>\",\"fileName\":\"note.txt\",\"content\":\"示例\"});"
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
                        "description": "平台文件 ID；从文件目录或上传准备回执取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.files.download({\"fileId\":\"<fileId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#filesdownload",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.files.download({\"fileId\":\"<fileId>\"});"
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
                        "description": "文件二进制字节，不是 Base64 字符串。"
                    },
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "fileName",
                        "type": "string",
                        "required": true,
                        "description": "带扩展名的文件名。"
                    },
                    {
                        "name": "title",
                        "type": "string",
                        "required": false,
                        "description": "展示标题。"
                    },
                    {
                        "name": "asArtifact",
                        "type": "boolean",
                        "required": false,
                        "description": "是否作为结果附件。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.files.upload({\"bytes\":new Uint8Array([1, 2, 3]),\"idempotencyKey\":\"<persistent-operation-id>\",\"channelId\":\"<channelId>\",\"fileName\":\"<fileName>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#filesupload",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.files.upload({\"bytes\":new Uint8Array([1, 2, 3]),\"idempotencyKey\":\"<persistent-operation-id>\",\"channelId\":\"<channelId>\",\"fileName\":\"<fileName>\"});"
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
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": false,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "executionStatus",
                        "type": "TaskExecutionStatus[]",
                        "required": false,
                        "description": "任务执行状态筛选；不同于验收状态。"
                    },
                    {
                        "name": "relatedTo",
                        "type": "\"me\"",
                        "required": false,
                        "description": "只筛选与当前用户相关的任务。"
                    },
                    {
                        "name": "assignee",
                        "type": "\"self\"",
                        "required": false,
                        "description": "负责人选择；self 表示当前已授权用户。"
                    },
                    {
                        "name": "query",
                        "type": "string",
                        "required": false,
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.tasks.list({\"channelId\":\"<channelId>\",\"limit\":20});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#taskslist--tasksiterate",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。没有绑定来源范围时须提供 channelId 或 topicId；不支持 projectId。项目统计先 channels.list({projectId})，再逐频道读取。limit 默认 20，范围 1–100。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.tasks.list({\"channelId\":\"<channelId>\",\"limit\":20});"
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
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": false,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "executionStatus",
                        "type": "TaskExecutionStatus[]",
                        "required": false,
                        "description": "任务执行状态筛选；不同于验收状态。"
                    },
                    {
                        "name": "relatedTo",
                        "type": "\"me\"",
                        "required": false,
                        "description": "只筛选与当前用户相关的任务。"
                    },
                    {
                        "name": "assignee",
                        "type": "\"self\"",
                        "required": false,
                        "description": "负责人选择；self 表示当前已授权用户。"
                    },
                    {
                        "name": "query",
                        "type": "string",
                        "required": false,
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
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
                        "description": "最多遍历页数，正整数，默认 100；达到上限仍有数据则失败。"
                    },
                    {
                        "name": "signal",
                        "type": "AbortSignal",
                        "required": false,
                        "description": "调用方的 AbortSignal，用于取消遍历。"
                    }
                ],
                "open": false
            }
        ],
        "example": "for await (const item of colink.user.tasks.iterate({\"channelId\":\"<channelId>\",\"limit\":20})) { /* 处理 item */ }",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#taskslist--tasksiterate",
        "note": "迭代时 next() 拒绝；创建迭代器不开始请求；已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。没有绑定来源范围时须提供 channelId 或 topicId；不支持 projectId。项目统计先 channels.list({projectId})，再逐频道读取。limit 默认 20，范围 1–100。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "for await (const item of colink.user.tasks.iterate({\"channelId\":\"<channelId>\",\"limit\":20})) { /* 处理 item */ }"
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
                        "description": "任务 ID；从 tasks.list 或创建回执取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.tasks.get({\"taskId\":\"<taskId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#tasksget",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.tasks.get({\"taskId\":\"<taskId>\"});"
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
                        "type": "\"cancelled\" | \"complete\" | \"failed\" | \"running\" | \"todo\"",
                        "required": false,
                        "description": "本入口定义的状态，不能混用其他接口的状态枚举。"
                    },
                    {
                        "name": "view",
                        "type": "\"actionable\" | \"assigned\" | \"created\" | \"requested\" | \"review\"",
                        "required": false,
                        "description": "读取视图。"
                    },
                    {
                        "name": "query",
                        "type": "string",
                        "required": false,
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "page",
                        "type": "number",
                        "required": false,
                        "description": "页码，首请求可省略。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.tasks.listPersonal({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#taskslistpersonal",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "title",
                        "type": "string",
                        "required": true,
                        "description": "展示标题。"
                    },
                    {
                        "name": "goal",
                        "type": "string",
                        "required": true,
                        "description": "任务目标及验收要求。"
                    },
                    {
                        "name": "taskKey",
                        "type": "string",
                        "required": false,
                        "description": "调用方的任务业务标识。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": false,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    },
                    {
                        "name": "topicId",
                        "type": "string",
                        "required": false,
                        "description": "话题 ID；从当前可信上下文或 topics.list 结果取得，不是频道 ID。"
                    },
                    {
                        "name": "assignee",
                        "type": "\"self\" | { type: \"user\" | \"agent\" | \"app\"; id: string; }",
                        "required": false,
                        "description": "负责人选择；self 表示当前已授权用户。"
                    },
                    {
                        "name": "dueAt",
                        "type": "null | string",
                        "required": false,
                        "description": "截止时间，使用接口规定的时间格式。"
                    },
                    {
                        "name": "attachments",
                        "type": "string[]",
                        "required": false,
                        "description": "已上传的平台文件 ID 列表。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.tasks.create({\"idempotencyKey\":\"<persistent-operation-id>\",\"title\":\"示例任务\",\"goal\":\"完成验收\",\"channelId\":\"<channelId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#taskscreate",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。没有绑定来源范围时须提供 channelId 或 topicId；title/goal 为必填非空文本。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.tasks.create({\"idempotencyKey\":\"<persistent-operation-id>\",\"title\":\"示例任务\",\"goal\":\"完成验收\",\"channelId\":\"<channelId>\"});"
        }
    },
    "tasks.update": {
        "method": "tasks.update",
        "route": "POST /tasks/:id",
        "arguments": [
            {
                "name": "input",
                "optional": false,
                "type": "{ taskId: string; idempotencyKey: string; expectedVersion: number; } & ({ action?: never; title?: string; goal?: string; dueAt?: string | null; attachments?: string[]; assignee?: never; reason?: never; } | { action: \"reassign\"; reason: string; assignee: TaskAssigneeInput; title?: never; goal?: never; dueAt?: never; attachments?: never; } | { action: \"cancel\" | \"restart\"; reason: string; assignee?: never; title?: never; goal?: never; dueAt?: never; attachments?: never; })",
                "parameters": [
                    {
                        "name": "taskId",
                        "type": "string",
                        "required": true,
                        "description": "任务 ID；从 tasks.list 或创建回执取得。"
                    },
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "expectedVersion",
                        "type": "number",
                        "required": true,
                        "description": "最近读取回执中的版本，用于并发控制；冲突后先重新读取。"
                    },
                    {
                        "name": "title",
                        "type": "string",
                        "required": false,
                        "description": "展示标题。"
                    },
                    {
                        "name": "goal",
                        "type": "string",
                        "required": false,
                        "description": "任务目标及验收要求。"
                    },
                    {
                        "name": "dueAt",
                        "type": "null | string",
                        "required": false,
                        "description": "截止时间，使用接口规定的时间格式。"
                    },
                    {
                        "name": "attachments",
                        "type": "string[]",
                        "required": false,
                        "description": "已上传的平台文件 ID 列表。"
                    },
                    {
                        "name": "action",
                        "type": "\"cancel\" | \"reassign\" | \"restart\"",
                        "required": false,
                        "description": "任务状态或分派操作；按类型中的联合分支组合字段。"
                    },
                    {
                        "name": "reason",
                        "type": "string",
                        "required": false,
                        "description": "状态或分派调整原因。"
                    },
                    {
                        "name": "assignee",
                        "type": "\"self\" | { type: \"user\" | \"agent\" | \"app\"; id: string; }",
                        "required": false,
                        "description": "负责人选择；self 表示当前已授权用户。"
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
                                "description": "任务 ID；从 tasks.list 或创建回执取得。"
                            },
                            {
                                "name": "idempotencyKey",
                                "type": "string",
                                "required": true,
                                "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                            },
                            {
                                "name": "expectedVersion",
                                "type": "number",
                                "required": true,
                                "description": "最近读取回执中的版本，用于并发控制；冲突后先重新读取。"
                            },
                            {
                                "name": "title",
                                "type": "string",
                                "required": false,
                                "description": "展示标题。"
                            },
                            {
                                "name": "goal",
                                "type": "string",
                                "required": false,
                                "description": "任务目标及验收要求。"
                            },
                            {
                                "name": "dueAt",
                                "type": "null | string",
                                "required": false,
                                "description": "截止时间，使用接口规定的时间格式。"
                            },
                            {
                                "name": "attachments",
                                "type": "string[]",
                                "required": false,
                                "description": "已上传的平台文件 ID 列表。"
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
                        "type": "{ taskId: string; idempotencyKey: string; expectedVersion: number; } & { action: \"reassign\"; reason: string; assignee: TaskAssigneeInput; title?: never; goal?: never; dueAt?: never; attachments?: never; }",
                        "parameters": [
                            {
                                "name": "taskId",
                                "type": "string",
                                "required": true,
                                "description": "任务 ID；从 tasks.list 或创建回执取得。"
                            },
                            {
                                "name": "idempotencyKey",
                                "type": "string",
                                "required": true,
                                "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                            },
                            {
                                "name": "expectedVersion",
                                "type": "number",
                                "required": true,
                                "description": "最近读取回执中的版本，用于并发控制；冲突后先重新读取。"
                            },
                            {
                                "name": "action",
                                "type": "\"reassign\"",
                                "required": true,
                                "description": "任务状态或分派操作；按类型中的联合分支组合字段。"
                            },
                            {
                                "name": "reason",
                                "type": "string",
                                "required": true,
                                "description": "状态或分派调整原因。"
                            },
                            {
                                "name": "assignee",
                                "type": "\"self\" | { type: \"user\" | \"agent\" | \"app\"; id: string; }",
                                "required": true,
                                "description": "负责人选择；self 表示当前已授权用户。"
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
                        "type": "{ taskId: string; idempotencyKey: string; expectedVersion: number; } & { action: \"cancel\" | \"restart\"; reason: string; assignee?: never; title?: never; goal?: never; dueAt?: never; attachments?: never; }",
                        "parameters": [
                            {
                                "name": "taskId",
                                "type": "string",
                                "required": true,
                                "description": "任务 ID；从 tasks.list 或创建回执取得。"
                            },
                            {
                                "name": "idempotencyKey",
                                "type": "string",
                                "required": true,
                                "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                            },
                            {
                                "name": "expectedVersion",
                                "type": "number",
                                "required": true,
                                "description": "最近读取回执中的版本，用于并发控制；冲突后先重新读取。"
                            },
                            {
                                "name": "action",
                                "type": "\"cancel\" | \"restart\"",
                                "required": true,
                                "description": "任务状态或分派操作；按类型中的联合分支组合字段。"
                            },
                            {
                                "name": "reason",
                                "type": "string",
                                "required": true,
                                "description": "状态或分派调整原因。"
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
        "example": "await colink.user.tasks.update({\"taskId\":\"<taskId>\",\"idempotencyKey\":\"<persistent-operation-id>\",\"expectedVersion\":1,\"title\":\"修正标题\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#tasksupdate",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。普通字段修改与 reassign/cancel/restart 互斥；控制操作必填 reason，reassign 另需 assignee。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.tasks.update({\"taskId\":\"<taskId>\",\"idempotencyKey\":\"<persistent-operation-id>\",\"expectedVersion\":1,\"title\":\"修正标题\"});"
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
                        "description": "任务 ID；从 tasks.list 或创建回执取得。"
                    },
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    },
                    {
                        "name": "expectedVersion",
                        "type": "number",
                        "required": true,
                        "description": "最近读取回执中的版本，用于并发控制；冲突后先重新读取。"
                    },
                    {
                        "name": "executionEpoch",
                        "type": "number",
                        "required": true,
                        "description": "当前任务执行轮次，从任务详情取得。"
                    },
                    {
                        "name": "executionStatus",
                        "type": "\"completed\" | \"failed\" | \"running\"",
                        "required": false,
                        "description": "任务执行状态筛选；不同于验收状态。"
                    },
                    {
                        "name": "progress",
                        "type": "string",
                        "required": false,
                        "description": "执行进展。"
                    },
                    {
                        "name": "conclusion",
                        "type": "string",
                        "required": false,
                        "description": "执行结论。"
                    },
                    {
                        "name": "resultArtifacts",
                        "type": "TaskResultArtifactInput[]",
                        "required": false,
                        "description": "结果附件；按类型中的文件引用分支填写。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.app.tasks.reportExecution({\"taskId\":\"<taskId>\",\"idempotencyKey\":\"<persistent-operation-id>\",\"expectedVersion\":1,\"executionEpoch\":1,\"executionStatus\":\"running\",\"progress\":\"开始处理\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#tasksreportexecution",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。completed 必须同次提供 conclusion 或 resultArtifacts；expectedVersion 和 executionEpoch 来自当前任务回执。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "app": "await colink.app.tasks.reportExecution({\"taskId\":\"<taskId>\",\"idempotencyKey\":\"<persistent-operation-id>\",\"expectedVersion\":1,\"executionEpoch\":1,\"executionStatus\":\"running\",\"progress\":\"开始处理\"});"
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
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "view",
                        "type": "\"picker\"",
                        "required": false,
                        "description": "读取视图。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.contacts.list({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#contactslist",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。q 提供时为 2–80 字符且不能同时使用 cursor；省略 q 时按每页 30 条读取本人可见联系人。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.contacts.listChannels({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#contactslistchannels--contactslistprojects",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。q 提供时为 1–80 字符；固定每页 30 条，不接收 limit。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.contacts.listProjects({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#contactslistchannels--contactslistprojects",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。q 提供时为 1–80 字符；固定每页 30 条，不接收 limit。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "选择的用户 ID，最多 100 个，不重复。"
                    },
                    {
                        "name": "channelIds",
                        "type": "string[]",
                        "required": false,
                        "description": "选择的频道 ID，最多 20 个，不重复。"
                    },
                    {
                        "name": "projectIds",
                        "type": "string[]",
                        "required": false,
                        "description": "选择的项目 ID，最多 20 个，不重复。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.contacts.resolve({\"projectIds\":[\"<projectId>\"]});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-business.md#contactsresolve",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。项目 ID 取自已核验的页面上下文；最多解析 100 名真人，结果排除当前使用者。此调用只读。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.contacts.resolve({\"projectIds\":[\"<projectId>\"]});"
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
                        "description": "检索文本或该入口定义的查询对象，详见类型。"
                    },
                    {
                        "name": "providerInstallationId",
                        "type": "string",
                        "required": false,
                        "description": "能力提供 App 的安装 ID；从 apps.list 取得。"
                    },
                    {
                        "name": "limit",
                        "type": "number",
                        "required": false,
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.apps.list({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-integrations.md#appslist",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "providerInstallationId",
                        "type": "string",
                        "required": true,
                        "description": "能力提供 App 的安装 ID；从 apps.list 取得。"
                    },
                    {
                        "name": "operationId",
                        "type": "string",
                        "required": false,
                        "description": "提供方操作 ID；从 apps.listOperations 取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.apps.listOperations({\"providerInstallationId\":\"<providerInstallationId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-integrations.md#appslistoperations",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.apps.listOperations({\"providerInstallationId\":\"<providerInstallationId>\"});",
            "app": "await colink.app.apps.listOperations({\"providerInstallationId\":\"<providerInstallationId>\"});"
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
                        "description": "能力提供 App 的安装 ID；从 apps.list 取得。"
                    },
                    {
                        "name": "operationId",
                        "type": "string",
                        "required": true,
                        "description": "提供方操作 ID；从 apps.listOperations 取得。"
                    },
                    {
                        "name": "input",
                        "type": "Record<string, unknown>",
                        "required": true,
                        "description": "满足提供方 inputSchema 的业务参数。"
                    },
                    {
                        "name": "expectedSpecRevision",
                        "type": "string",
                        "required": false,
                        "description": "apps.listOperations 返回的接口声明版本。"
                    },
                    {
                        "name": "idempotencyKey",
                        "type": "string",
                        "required": true,
                        "description": "业务操作标识，不是 API Key。使用已持久保存的业务请求 ID 加操作用途；同一操作跨重试保持不变，不同操作即使同文也不同。1–128 位字母、数字或 ._:-；未知结果后不能换键重做。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await colink.user.apps.callOperation({\"providerInstallationId\":\"<providerInstallationId>\",\"operationId\":\"<operationId>\",\"input\":{},\"idempotencyKey\":\"<persistent-operation-id>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-integrations.md#appscalloperation",
        "note": "Promise 拒绝；先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。input 必须满足 apps.listOperations 当前返回的 inputSchema；空对象只是结构示意。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。",
        "identityExamples": {
            "user": "await colink.user.apps.callOperation({\"providerInstallationId\":\"<providerInstallationId>\",\"operationId\":\"<operationId>\",\"input\":{},\"idempotencyKey\":\"<persistent-operation-id>\"});",
            "app": "await colink.app.apps.callOperation({\"providerInstallationId\":\"<providerInstallationId>\",\"operationId\":\"<operationId>\",\"input\":{},\"idempotencyKey\":\"<persistent-operation-id>\"});"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await call.directory.listChannels({});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-integrations.md#calldirectorylistchannels",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。"
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
                        "description": "单次读取数量；具体范围与默认值见该接口字段表（文件文本读取不同于列表分页）。"
                    },
                    {
                        "name": "cursor",
                        "type": "string",
                        "required": false,
                        "description": "上一页的 nextCursor；首请求省略，后续原样传回。"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "description": "频道 ID；从当前可信上下文或 channels.list 结果取得。"
                    }
                ],
                "open": false
            }
        ],
        "example": "await call.directory.listChannelMembers({\"channelId\":\"<channelId>\"});",
        "docs": "https://colink.link/docs/app-extensions/colink-for-ai.zip",
        "reference": "for-ai-sdk-integrations.md#calldirectorylistchannelmembers",
        "note": "Promise 拒绝；检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。示例中的 <...> 必须替换为可信上下文或平台回执中的值；示例不自动执行，也不授予权限。联合类型按同一分支组合字段；开放参数按接口字段表填写。"
    }
};
