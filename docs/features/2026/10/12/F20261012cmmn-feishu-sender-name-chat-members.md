---
id: F20261012cmmn
feature_id: F20261012cmmn
created: 2026-10-12
title: 飞书发言人姓名解析改走聊天成员接口（真名链路修复）
summary: "PR #1426 后真名仍未解析——contact/v3/users 对授权范围外用户返回脱敏对象（code 0 但无 name），实测 im/v1/chats/{chat_id}/members（im:chat.members:read，#1426 已注入）直接返回成员 name。本次把发言人姓名解析的主数据源切到聊天成员映射（id→name），contact 单查降为备用源，兜底「飞书·尾6位」保留。单聊/群聊的发言人从此都出真名，无需飞书后台任何手动配置。"
change_type: fix
capability_test: 'n/a: 数据源切换修复，行为由 user-info-client/message-processor 共 10 个新增用例守护（见验证节）'
created_in_conversation: b7ba808d-be14-4369-9b13-8f9d077c5441
tags: [im, feishu, sender-identity, chat-members, user-info, name-resolution]
modules:
  - src/usecases/im/feishu-user-info-gateway.ts
  - src/frameworks/feishu/user-info-client.ts
  - src/interface-adapters/feishu/message-processor.ts
  - tests/frameworks/feishu/user-info-client.test.ts
  - tests/interface-adapters/feishu/message-processor.test.ts
intent:
  problem: "飞书发言人姓名解析只走 contact/v3/users 单一数据源，该接口对授权范围外用户返回脱敏对象（code 0 但无 name），导致气泡上方只能显示兜底「飞书·26cd95」，#1426 的「气泡上方显示真名」验收未达成"
  expected_effect: "发言人姓名解析优先从聊天成员映射取真名（实测不脱敏），气泡上方显示「陈绍国」类真名；contact 脱敏或失败时逐层降级，兜底可读标签不变，消息主链路永不阻塞"
  verify_by:
    type: behavior_check
causal_links:
  - F20261010fspm（前序：权限集注入 + 兜底可读化——其「气泡上方真名」效果被本特性接完）
  - F20260826fuid（user-info-client 本体——本特性给它补第二数据源）
  - F20260724regd（sender name 投影链）
---

# 飞书发言人姓名解析改走聊天成员接口（真名链路修复）

## 背景（搭档反馈，2026-10-12）

#1426 合入后搭档重连 csg-feishu2 实测，气泡上方仍显示「chen(飞书·26cd95)」，反馈「海獭还是没认出来我是谁」「以前是能查出来的，你确认下，为啥现在没查出来」，并要求「你必须自己验证下 api 可用。否则，前两个的修复的预期效果本来就是能查到的，结果现在根本没达成效果」——即 #1426 的验收标准（气泡上方显示真名）未达成。

## 排查结论

**预注册**（排查初）：预期根因是「飞书应用可用范围不含用户 → 姓名脱敏，scope 解不了」；验证标准 = 实测飞书 API 返回是否带 name；若发现 name 可从其他接口取得，则原预期修正为「数据源选错」。

**问题现象**：飞书消息气泡上方显示 `chen(飞书·26cd95)`——「chen」来自 web 全局注入的搭档名（名册域），`飞书·26cd95` 是 resolveSenderName 兜底（open_id 尾 6 位）。entries 表实录 sender_name=`飞书·26cd95`（conversation 88510f3a）。LLM 答「你是 chen」是全局注入推断，不是身份链识别——换人发消息同样答 chen。

**根因分析**（全部本机实测，2026-10-12）：

1. **身份链代码无恙**：#1426 的 addons scope 注入生效——`contact:contact.base:readonly` 在 app scopes 列表（application/v6/applications 实查），users API 返回 code 0 不再 99991672；前缀已删、兜底可读正常。
2. **contact 单查被字段级脱敏**：`GET /contact/v3/users/{open_id}` 与 `/users/batch` 均返回 `{code:0, data:{user:{open_id, union_id, mobile_visible:true}}}`——**无 name 字段**。日志证据：`Feishu user info query failed`（warn，code 0）今日 3 次 + 10-10 旧 app（ou_fd59...b2d82e）2 次，两代 app 一致复现。
3. **脱敏不来自通讯录授权范围**：`GET /contact/v3/scopes` 返回 `user_ids:[ou_ce41...26cd95]`——用户本人在授权范围内，name 仍不给。API 层面 `PATCH /application/v6/applications/{id}/visibility` 需 `admin:app.visibility`（99991672 实测）。
4. **聊天成员接口不脱敏（关键实测）**：`GET /im/v1/chats/{chat_id}/members`（im:chat.members:read，#1426 已注入）返回 `{"member_id":"ou_ce41...26cd95","name":"陈绍国","tenant_key":"1901d4d422171b8b"}`——**真名直接给出**。发消息者必在会话成员里，p2p chat 同样可查（oc_e1e114c7... 实测 1 条成员记录）。
5. **代码落点**：`message-processor.ts:373 resolveSenderName` 只调 `feishuUserInfo.getUserName()`（contact 单查，user-info-client.ts:65 USER_ENDPOINT），脱敏返回 null 后走 `飞书·${idTail}` 兜底（message-processor.ts:373-383）。

**预期 vs 实际对照**：预期（#1426 后）气泡上方显示真名——实际显示兜底标签，**偏离**。偏离原因：#1426 把「API 调不通」修成「API 通但字段脱敏」，而当时未发现同一权限体系下的 chat members 接口不脱敏（10-10 实测只覆盖 contact 一族）。搭档「以前能查出来」的判断方向正确（API 确实能给出名字），错误在数据源选择而非权限缺失。

**⚠️ 已排除路径**：
- 「admin:app.visibility + PATCH visibility 自动配全员可用范围」——需要管理员级 scope，扫码确认页可能卡审批，且只是 contact 一族的脱敏开关；chat members 路径无需任何飞书侧配置即出真名，优先级更高。
- 「ownerOpenId 登记绑定」——只覆盖单聊主人，群里其他发言人仍无名，治标；chat members 天然覆盖全会话成员。

## 机制识别检查点判定（动手前）

清单逐项：新增配置字段/枚举/开关 ✗；新增状态生命周期 ✗；新增定时任务/后台进程 ✗；新增信号类型/消息格式 ✗；新增持久化存储 ✗（进程内 Map 缓存，沿用既有模式）；新增决策分支 ✗（纯运行时数据源降级，不落库不记忆）；**新增跨模块调用路径 ✓**（message-processor → 网关新方法 → im chat members endpoint）。

命中一项但不涉净新增机制的论证：本修复在**既有「发言人姓名解析」机制语义内**补第二数据源（修法决策树①「缺啥补啥」）——机制实体零新增（无新配置/状态/定时/持久化/信号），缓存与在途合并沿用 user-info-client 既有 inflight/cache 模式，降级链沿用既有「解析失败→可读兜底」语义；新调用发生在既有「消息处理 → 身份网关」路径内部（网关接口加一方法而非新网关）。判定走①，`Modification-Class: narrow-fix`，轻对抗。

## 设计取舍

1. **主备顺序：chat members 主、contact 备**。发消息者必在会话成员中，chat members 实测不脱敏且一次拉全表（群聊高效）；contact 单查保留为备用源（chat members 缺漏/接口变化时兜住），兜底「飞书·尾6位」最后兜底。三层逐层降级，任一层失败不阻塞消息主链路（网关既有原则）。
2. **接口加必选方法而非可选**：`getChatMemberNames` 为必选——可选方法 + 防御调用 = 兼容桥代码，弱化契约；仓内 2 处测试 mock 同步适配（断言零改动）。
3. **空成员表缓存空 Map**（有效数据），业务失败/网络异常返回 null 不缓存（可重试，权限/网络恢复后自愈）——与 getUserName 的「null 不缓存」语义一致。
4. **翻页防御**：page_size=100 + page_token 翻页合并，上限 20 页（2000 成员，远超真实会话规模），防失控循环。

## 变更明细

- `src/usecases/im/feishu-user-info-gateway.ts`：端口加 `getChatMemberNames(chatId)`（含数据源选型的 why 注释）
- `src/frameworks/feishu/user-info-client.ts`：实现 chat members 拉取（缓存 + 在途合并 + 分页 + null 不缓存），模式与 getUserName 同构
- `src/interface-adapters/feishu/message-processor.ts`：resolveSenderName 加 chatId 参数，双路降级（chat members → contact → 可读兜底）
- 测试：user-info-client 6 个新用例（映射/缓存/失败重试/并发合并/翻页/URL 形态）+ message-processor 3 个新用例（真名优先/未命中降级/异常降级）+ 空成员表缓存锁定 1 个（检视发现 4 处置）+ 2 处 mock 适配（断言零改动）

## 验证

**失败证据（修复前固化，troubleshooting 5a）**：

```
FAIL ... user-info-client.test.ts > 聊天成员数据源 getChatMemberNames > 请求 URL ...
TypeError: client.getChatMemberNames is not a function

FAIL ... message-processor.test.ts > chat members 映射命中真名时优先用真名 ...
AssertionError: expected '飞书·b2d82e' to be '陈绍国'
Expected: "陈绍国"
Received: "飞书·b2d82e"   ← 精确复刻真机 bug：脱敏场景退化兜底拿不到真名

Test Files 2 failed (2) | Tests 7 failed | 17 passed (24)
```

**修复后**：`Tests 24 passed (24)`（同两文件）；全量回归 `Tests 5347 passed (5347)`；`tsc --noEmit` 0 error。

**真机 API 验证**（搭档要求「必须自己验证 api 可用」）：本机 curl 实测 `GET /im/v1/chats/oc_e1e114c7.../members` 返回 `name: "陈绍国"`（csg-feishu2 凭证），客户端代码为该请求的忠实封装（URL 形态与响应解析由测试锁定）。合入后让搭档在飞书发条消息做端到端验收：气泡上方应显示「陈绍国」（或群内各发言人真名）。

**最简实现检查**：已过阶梯——仓内无现成 chat members 封装可复用；fetch 平台原生直用（零新依赖）；不把 API 调用塞进 message-processor（数据源归网关层）。已过最简检查。

**负面向验收条目**：本次变更破坏的旧契约 = `FeishuUserInfoGateway` 接口新增必选方法（仓内全部实现/mock 已适配：FeishuUserInfoClient + 2 处测试 mock）；`resolveSenderName` 私有方法签名加参（无外部调用方）。未绕过任何既有保护：兜底可读语义、网关永不阻塞、null 不缓存三条既有约定全部保持并有测试锁定。
