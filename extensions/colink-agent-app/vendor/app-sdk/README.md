# CoLink App SDK

服务端使用 `runtime.userClient(binding)` / `runtime.appClient(binding)` 取得单身份业务客户端：userClient 只接受 request/grantId，appClient 只接受 installationId；事件回调使用已绑定的 `colink.user` / `colink.app`，浏览器使用 `page.user`。主体由调用者明确选择，失败不切换身份。完整方法见 [SDK 文档包](https://colink.link/docs/app-extensions/colink-for-ai.zip)。

CoLink App 的 JavaScript / TypeScript SDK。随包示例的用途、运行方式与集成前提见[示例导航](examples/README.md)。

每个 App 在自己的项目目录独立安装 SDK；创建时使用最新发布版本，保留 package.json 与 package-lock.json，后续用 npm ci 复现安装，不自动升级。升级 SDK 时同步适配 App 代码并验证。

清单使用根入口导出的 `Permission` 和 `EventType` 常量；`AppManifest` 检查完整结构，TypeScript 用 `satisfies`，JavaScript 用 JSDoc `@satisfies`（见 examples/preferences/manifest.ts）。浏览器和 Agent 入口也提供所需常量及权限类型。常量值仍是协议字符串，不授予权限或选择身份。Playground 只静态读取清单，官方常量按当前 App 独立锁定并安装的 SDK 定义解析，不执行模块或自动升级依赖。

业务事件可在 `createCoLinkRuntime({ manifest, onEvent: { [type]: handler } })` 中内联声明，也可通过 `runtime.onEvent(type, handler)` 注册。两种方式共用类型与执行规则，同一事件重复注册时报错。`app.user_message_received` 提供 `reply` 等消息回合能力，例如 `runtime.onEvent(EventType.UserMessageReceived, async ctx => { await ctx.reply({ text: ctx.event.data.text }); });`。所有 onEvent 回调只返回 void；任务、按钮、协作和取消事件不提供 reply，使用各自的业务方法。全部事件类型、字段、调用身份及恢复规则见文档 ZIP 中 `for-ai-sdk-events.md` 的「事件类型与能力」。

`createCoLinkRuntime({ manifest })` 和 `createCoLinkAgent({ manifest, agent })` 默认在创建时读取 `COLINK_ISSUER`、`COLINK_APP_ID`、`COLINK_APP_INSTANCE_ID`、`COLINK_CLIENT_ID`、`COLINK_CLIENT_SECRET`、`COLINK_SIGNING_SECRET`；`COLINK_ALLOW_INSECURE_ISSUER` 可选，仅接受 `true` / `false`，默认 false，true 只允许本地回环 HTTP。手动启动用 `node --env-file=./app.env ./index.mjs`，Node.js 先加载文件为进程环境变量，SDK 再读取；仅把 app.env 放在目录中不会自动生效。

默认状态保存到 `./.colink/state.enc`，密钥首次自动生成到旁边的 `.key` 文件，重启复用；整个目录需要持久化、备份并加入 `.gitignore`。Manifest 声明 App 渲染页面时填写 COLINK_APP_ORIGIN，SDK 自动启用页面会话和浏览器资源。页面文件通过 `serveCoLinkRuntime(runtime, { views: { home: new URL("./index.html", import.meta.url) } })` 按 Manifest 的 viewId 绑定，SDK 自动使用 entryPath；普通静态资源仍通过 assets 声明。路径冲突或无效绑定会在启动时拒绝。

存储路径覆盖、外部密钥、本地 HTTP、宿主来源、显式 config、页面会话设置 及服务选项，统一见文档 ZIP 中 `for-ai-sdk.md` 最后一章「4. 可选配置与自定义部署」；普通接入无需额外填写。

包内 `app.env.example` 为不含真实凭据的配置模板，初始化器也会生成它。手动启动时将 node_modules/@colink/app-sdk/app.env.example 复制到项目根目录为 app.env（与 index.mjs 同级）、填写占位值，并用 `node --env-file=./app.env ./index.mjs` 加载；不要提交真实 app.env。Playground run 会生成隔离配置，无需另填此文件。

开发与使用说明统一从 [For AI 开发指南](https://colink.link/docs/app-extensions/colink-for-ai.zip) 进入。

清单业务选择使用 AppTag、InstallationScope、ExtensionPoint、NavigationParent、ViewContainer 和 ViewRenderer，配合 AppManifest 检查类型。清单、事件、UI、扩展点、Bridge 和业务 API 上下文的协议字段由 SDK 自动补齐，业务声明无需填写；App 自己的 version 仍由发布流程维护。Playground 读取当前 App 锁定 SDK 的同一份协议数据，不执行 App 或借用工具最新版。字段和组合约束见文档 ZIP 的 for-ai-sdk-runtime.md 与 for-ai-manifest.md。

页面 `authorize(scopes)` 会保留同一用户、安装和项目下仍有效且适用的已授权权限；新增权限由平台确认，SDK 从绑定当前页面的可信执行记录读取实际集合。拒绝新增不撤销旧授权。后台仅累加后台同意。任务管理权限包含任务读取能力，业务客户端会识别；只读策略仍可独立限制写操作。

先用 Playground api-search / api-describe 离线查方法和授权前提，按业务维护 Manifest；permissions --manifest 只核对权限名称、依赖及事件约束。diagnose 检查清单、锁定 SDK 与项目类型，再用 verify 验证启动、安装和页面。类型检查支持 HTML 内联模块/相对 src，需在 App 工程安装 TypeScript 与 @types/node。SDK 不再提供任意 App 源码权限推断，不判断多余权限或改写清单；运行观察只覆盖已执行调用。工具集成可用 permissions.plan/check，旧 analyzeSources/analyzeFiles/checkFiles 已移除。完整说明见 [For AI](https://colink.link/docs/app-extensions/colink-for-ai.zip)。

开发指南只通过文档 ZIP 分发，解压后从 `for-ai.md` 开始；SDK 方法参考见同目录 `for-ai-sdk.md`。错误诊断的 `docs` 是 ZIP 地址，`reference` 是包内相对文件与章节锚点。

`for-ai-sdk.md` 保留简洁的“项目助手”接入 Demo：页面直读项目、request 绑定的后端读取和提及回显，只同步 TS 与构建方式；完整业务工程按需查看随包 examples。普通示例使用 serveCoLinkRuntime，自有业务路由用 routes，动态路由用 fallback。已有 Node HTTP 框架则使用 createCoLinkHttpHandler：只接管 SDK 协议及公开连接配置、浏览器模块，页面与业务路由由框架注册；返回 true 后不再响应，false 才交给业务路由。自有服务负责监听及 runtime.start/close。方法索引另列事件上下文字段，区分 event 数据、reply 方法与 colink 客户端。参考正文按应用运行与客户端、页面与用户交互、事件与回合、Agent 与 MCP、平台业务方法、跨 App 业务调用与提供、应用登记与安装管理、错误与权限诊断分类。SDK 可调用方法与开发者需要实现的适配接口按分册归类列出；点击索引中的完整方法名可直达参数、返回值和调用条件。

页面初始化统一使用 `const page = await createPageClient()`（`@colink/app-sdk/browser`）。默认读取同源 `/page-config.json` 并完成宿主连接；`page.context` 提供初始化快照，`page.connection` 提供宿主交互。访问平台数据时直接调用 `await page.authorize(scopes)`，SDK 自动完成必要的登录并复用有效会话；仅需用户身份时单独调用 `page.login()`。初始化本身不登录或授权。自定义部署可传 `{ hostOrigin, issuer }`，也可用 `{ connection, issuer }` 复用已有连接；所有方式均异步。`page.close()` 释放客户端，并关闭 SDK 自建连接；传入的连接由调用方管理。详见文档 ZIP 中的 `for-ai-sdk-browser.md` 的 createPageClient 一节。

后台委托独立于页面：用户在接入页批准后，可信后端通过 `await runtime.backgroundGrants.findActive({ installationId, userId })` 查询有效委托，并明确绑定 `grantId`，用 `runtime.userClient({ grantId })` 执行。SDK 按需获取、加密保存和刷新凭据；`pages:false` 同样支持。用户在平台撤销委托后，旧标识不会自动恢复；重新批准后需明确绑定新标识。

随包 `examples/greeting/schedule.ts` 展示直接查询指定用户的有效委托，以及用已保存的 grantId 读取项目；业务调度由 App 实现。

权限分析使用 `@colink/app-sdk/diagnostics` 的 `permissions`；Provider 回执摘要使用 `@colink/app-sdk/provider` 的 `hashProviderReceipt`。SDK 的加密存储由运行时内部管理，不向 App 提供加解密工具。运行时自动调度事件，App 只需管理启动与关闭。Agent 和 Provider 的回调契约见对应参考分册。

回复、进度和主动消息直接传入完整文本，由 SDK 自动分片并管理重试。Provider handler 使用绑定本次已验签调用的 `call.directory` 读取目录。

App / Agent 默认输出 JSON 生命周期日志到 stderr；`log: false` 关闭，`log: entry => logger.info(entry)` 接入自有日志系统。SDK 仅传递经过过滤的生命周期字段，不输出正文或凭据，不负责业务日志与文件轮转。

运行时参考按创建、服务启停、客户端、后台委托、诊断五章组织。显式 config 字段见 for-ai-sdk-runtime.md，环境变量、状态与密钥备份见 for-ai-sdk.md 第 4 章；发送与恢复分别见业务和错误分册。执行策略错误在创建时返回 INVALID_APP_CONFIG，details 指向配置字段，不创建状态文件；安装诊断为只读本地快照，不能代替在线授权。

普通事件接收 `EventContext<E>`，提供 event、context、colink 和 signal；用户消息事件接收 `UserMessageContext`，另有 source、reply、sendProgress、setDisplayStatus 和 assertActive。消息统一读取深度只读的 event.data。注册时按 EventType 推导处理器上下文，字段与用法见事件分册的“普通事件上下文”和“用户消息上下文”。

原来源统一使用 `ctx.source.listMessages(options?)`，按 kind 区分话题与私聊的分页和返回结构。SDK 根据可信来源固定读取身份：公共话题用安装 A，私密话题及私聊用本轮 U；没有身份子入口，拒绝后不换身份。旧话题缺少可见性时读取明确失败，事件接收及按原授权回复仍可执行。

Agent 的 runTurn 接收 AgentTurn，在提及上下文外增加 key、sessionId、tools 和可选 mcpConnection。模型工具用 turn.tools.list/call，与本地 MCP 共用 tools.transformResult 及输出检查。该可选回调只在 createCoLinkAgent 配置；普通 createCoLinkRuntime 不接受工具配置。详见 Agent 分册“Agent 回合上下文”和“工具与 MCP”。

事件注册使用根入口导出的 `EventType`；提及回调为 `UserMessageContext`，其余事件为 `EventContext<E>`，Agent 适配器使用 `AgentTurn`。SDK 的实现、共享协议和生成快照均接受严格 TypeScript 检查，按职责分层；编译输出仅进入独立产物目录。App 安装发行包后直接运行 JavaScript，无需编译 SDK。分模块声明由 `contracts/` 中的公开契约生成，声明按文档分册放在 `types/`，五个公开入口的导出清单集中放在 `types/entries/`，公共导入入口不变；方法 JSDoc 保留必要的失败提示；完整错误与恢复说明见文档包中的 `for-ai-sdk-errors.md`。
