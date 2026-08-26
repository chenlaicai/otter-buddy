---
id: F20260826fpbd
title: 飞书搭档静态绑定与访客命令权限
status: development
summary: 搭档身份从动态推断改静态绑定（config.feishu.partnerOpenId），访客消息不再冒充搭档；命令门禁仅搭档可用（方案B）
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
change_type: feature
tags: [feishu, identity, partner, permission, im]
modules:
  - src/frameworks/config-service.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/interface-adapters/feishu/message-processor.ts
  - src/interface-adapters/feishu/command-dispatcher.ts
  - src/bootstrap/platforms.ts
  - config/config.yaml.example
  - docs/user-guide/feishu-setup.md
created: 2026-08-26
created_in_conversation: 08a924c4-9c68-43b4-9360-56f9b251e84f
from: [F20260826fuid]
---

# 飞书搭档静态绑定与访客命令权限

## 背景

搭档原话（意图锚）：

> 「我拉你进飞书群聊就是因为我想把joy拉进来，然后多人+海獭对话。所以我还是需要你能够识别多人的，然后，你的搭档/主人 就是我，我也会有个open id。当然，后续发展，可能joy也在她电脑上也安装一个otter系统，那么那个otter系统的搭档/主人就是她了」

> 「b」（选择权限方案 B：命令仅搭档可用）

前置依赖 F20260826fuid（PR #488，已合入）：飞书消息 sender 姓名快照贯通。本特性在其基础上把「谁是搭档」从动态推断改为静态绑定，并对非搭档来源实施命令权限约束。

## 目标

- T1: 搭档身份静态化——`config.yaml` 配置 `feishu.partnerOpenId`，海獭判断「谁是搭档」以该配置为锚，不再跟随「当前谁在说话」
- T2: 访客语义注入——非搭档的飞书发言者（如 joy）在海獭 prompt 中有明确身份呈现：真名（姓名快照）+「访客」标注，海獭清楚「她不是我的搭档」
- T3: 命令权限（方案 B）——飞书侧会话管理命令（`/in` `/out` `/list` `/history` `/help`，即 parser 现有全部命令）仅搭档可用；非搭档发命令收到友好拒绝提示，普通聊天不受影响
- T4: Web 端兼容——Web 端 senderId 恒为 `'user'`，视同搭档（本机即搭档本人），行为不变

## 非目标

- 不做权限分级/白名单（方案 C）、不做访客仅限当前对话的沙箱
- 不做跨实例联邦（joy 自装 otter 系统后的双实例协作）——仅保证概念兼容：「搭档」是本实例概念，各实例各认各的主人
- 不做历史消息回填（姓名快照按 #488 约定只管新消息）
- 不改 Web 端 senderId 机制（恒 'user'）

## 方案设计

### 1. 配置层：partnerOpenId

`config.yaml`（`config.yaml.example` 同步）：

```yaml
feishu:
  appId: "cli_xxx"
  appSecret: "xxx"
  # 搭档（本实例主人）的飞书 open_id（F20260826fpbd）
  # 搭档身份静态锚定：海獭的「搭档」始终是这个人，不随消息发送者变化
  # 获取方式见 docs/user-guide/feishu-setup.md「搭档身份绑定」小节
  partnerOpenId: "YOUR_OPEN_ID"   # ← 替换为你的 open_id（ou_ 开头）
```

（审视发现 6 修正：example 不预填真实 open_id，用占位符——open_id 属 PII，不入仓库；真实值只进本地 config.yaml，方案文档中的样例值仅为本文档写作时的实测记录）

`config-service.ts` 的 `buildFeishuConfig` 增加解析（可选字段，缺省 undefined）。

**schema 字段消费方声明（issue #379 ⑥）**：`partnerOpenId` 消费方有二——① `DispatchChainEngine` 的搭档判定（roster 标签 + 历史渲染 label 决策）；② `CommandDispatcher` 的权限门禁。两处均通过构造注入读取，不散落。

### 2. 身份判定：PartnerResolver（新增 usecase，纯函数）

`src/usecases/im/partner-resolver.ts`：

```typescript
export class PartnerResolver {
  constructor(private readonly partnerOpenId: string | undefined) {}

  /** 统一入口：按 senderId 形态分派（ou_ 前缀→飞书比对；'user'→Web 恒搭档） */
  isPartner(senderId: string): boolean {
    if (senderId === 'user') return true;               // Web 端：本机即搭档本人
    if (!this.partnerOpenId) return false;              // 未配置：见降级说明
    return senderId === this.partnerOpenId;             // 飞书：静态比对
  }
}
```

所有消费方（engine + commandDispatcher/messageProcessor）统一用 `isPartner()`，不再区分 FromFeishu/FromWeb 两个方法——门禁语义是「是否搭档」而非「是否飞书搭档」，未来其他渠道接入无需改门禁。

**注入路径（审视发现 1 补全）**：
1. `AppConfig["feishu"]` 接口（config-service.ts）与 `FeishuConfig`（frameworks/feishu/types.ts）增加可选字段 `partnerOpenId?: string`；`buildFeishuConfig` 解析之
2. `createDispatchChainEngine(repos, uc, appConfig, logger, agentMetrics)` 已有 `appConfig` 参数——构造依赖增加 `partnerResolver: new PartnerResolver(appConfig.feishu?.partnerOpenId)`，无需改函数签名，仅改构造参数表
3. `setupFeishu` 里的 `CommandDispatcher` / `FeishuMessageProcessor` 构造同样注入 `new PartnerResolver(appConfig.feishu?.partnerOpenId)`（setupFeishu 入口有 `if (!appConfig.feishu) return;` 早退，此路径下 feishu 必存在，partnerOpenId 仍可选）

**未配置 partnerOpenId 时的降级**（向后兼容）：PartnerResolver 内部无法区分「未配置」与「配置了但不匹配」，降级逻辑在消费方：
- 历史渲染/roster：resolver 未配置（`partnerOpenId === undefined`）时回退现行为——动态推断（当前说话者视为搭档）。实现方式：PartnerResolver 暴露 `readonly configured: boolean`，engine 判 `!configured` 时走 #488 现逻辑分支
- 命令门禁：`!configured` 时不拦（维持现行为，避免把未升级配置的存量实例命令锁死）

已部署实例不升级配置也不坏。

### 3. 历史渲染与 roster：搭档判定改静态（dispatch-chain-engine.ts）

改动点一：`buildUserMessageContext`（历史渲染，#488 已引入快照名逻辑）：

```
现状（#488 后）：
  user 消息 label = senderName 快照 || (m.senderId === 当前 senderId ? partnerLabel : 裸 ID)

改为：
  isPartner(senderId)（配置匹配或 Web 'user'）
    → label = partnerLabel（搭档名，全局显示名设置）
  非搭档且有快照名
    → label = 快照名（joy 的真名）
  非搭档无快照名
    → label = 裸 open_id（不冒充，#488 约定延续）
```

关键差异：**非搭档的飞书消息即使触发了本次派发，也不再显示 partnerLabel**——joy 说话时海獭看到 `[joy]` 而非 `[搭档]`。partnerLabel 只属于配置锚定的那个人（和 Web 'user'）。

改动点二：`buildRoster` 签名变更（审视发现 4 补全）——`buildRoster(conversationId)` → `buildRoster(conversationId, senderId?)`，`executeOneHop` 透传 senderId。飞书来源、已配置 partnerOpenId、且 `senderId` 非搭档时，名册末尾追加提示：

```
## 在场成员
- 大獭
- chen（传 'user' 即交还行动权给搭档）

## 当前说话者
joy（访客）—— 非你的搭档；你的搭档是 chen
```

海獭由此获得双重信号：历史里 joy 的名字 + 名册里「当前说话者是访客」。对海獭的行为引导（如涉及隐私/敏感操作时更谨慎）由 prompt 自然产生，不做硬编码规则。

**注入路径**：`DispatchChainEngine` 构造依赖增加 `partnerResolver`（bootstrap 组装）。`buildUserMessageContext` 需要知道「本次触发来源」——飞书 dispatcher 传入的 senderId 是 open_id，Web 端是 'user'，`PartnerResolver` 两个方法按 senderId 形态自动区分（`ou_` 前缀走飞书判定，`'user'` 走 Web 判定），无需显式传 source。

### 4. 命令权限：CommandDispatcher 门禁（方案 B）

`message-processor.ts` 的命令分支：

```typescript
if (text.startsWith("/")) {
  if (partnerResolver.configured && !partnerResolver.isPartner(senderId)) {
    await this.deps.feishuGateway.replyText(
      chatId,
      "这些命令暂时不对所有人开放哦～直接聊天就行 🦦",
    );
    return;
  }
  await this.deps.commandDispatcher.dispatch(connection.id, text, chatId);
  return;
}
```

`partnerOpenId` 未配置时（`configured === false`）不拦——维持现行为，避免把已部署实例的命令锁死。

门禁位置说明：拦在 `message-processor.ts`（消息处理入口）而非 `command-dispatcher.ts`——命令分发器保持无身份概念，权限判定集中在与 PartnerResolver 同层的消费点，避免 dispatcher 也注入 resolver 双份依赖。

被拦命令清单：`/in` `/out` `/list` `/history` `/help`（parser 现有全部命令，审视发现 2 修正：原列的 `/new` 不存在，已删；`/help` 也在拦截范围——避免访客探测会话拓扑）。拒绝文案采用中性表述（审视发现 5）：「这些命令暂时不对所有人开放哦～直接聊天就行 🦦」——不提及「搭档/主人」所有权模型，与「不暴露内部机制」的取舍自洽。

### 5. 手册更新（docs/user-guide/feishu-setup.md）

- 新增「搭档身份绑定」小节：partnerOpenId 获取方式（open_platform 后台调试器 / 系统日志 `Feishu message parsed` 字段 / DB 查询）、语义说明、多人群聊场景
- 权限小节补充：访客可聊天不可用命令

## 影响范围

| 场景 | 影响 |
|------|------|
| 飞书私聊（搭档本人） | 无变化——senderId 恒等于 partnerOpenId |
| 飞书群聊（搭档发言触发） | 无变化——同上 |
| 飞书群聊（joy 发言触发） | 历史里 joy 显示真名/裸 ID（不再冒充搭档）；roster 注明访客；命令被拒 |
| Web 端 | 无变化——'user' 恒判为搭档 |
| 未配置 partnerOpenId 的存量实例 | 降级为现行为（动态推断 + 命令不拦），完全向后兼容 |

## 风险与约束

- **配置错误风险**：partnerOpenId 填错 → 搭档自己也被判为访客（命令被拒、历史显示裸 ID）。缓解：手册（feishu-setup.md「搭档身份绑定」）详述 open_id 获取三途径；启动时若 partnerOpenId 配置了但与库中已有飞书消息 sender 不匹配，log warn 提示
- **prompt 语义迁移**：海獭对「搭档」的判断从动态改静态后，SYSTEM.md 中「搭档」相关表述（R6 来源标注等）无需改——「搭档」概念本身没变，只是识别方式变了
- **测试面**：dispatch-chain-engine 与 message-processor 各有测试需扩展（partner/非 partner/未配置 三态）

## 不兼容更新

无。partnerOpenId 可选，未配置时行为与现状完全一致。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 搭档身份存储位置 | config.yaml 静态配置 | ① settings DB（Web 可改）② 首个发消息者自动绑定 | 搭档是部署级事实（谁装的谁是一生不变的主），不是运行时可随意变更的偏好；自动绑定有「抢注」风险 |
| 非搭档消息 label | 真名快照（无则裸 ID） | 统一显示「访客」 | 群聊里多个访客时「访客」不可区分；#488 快照链路现成 |
| 访客命令拒绝文案 | 中性表述，不提所有权（审视发现 5） | 「命令仅我的搭档可用」 | 群里其他访客能看到回复，不暴露主人绑定模型 |
| partnerOpenId 缺省降级 | 回退动态推断 | 启动报错强制配置 | 向后兼容优先；存量实例无感升级 |
| PartnerResolver 形态 | 独立 usecase 类，单一 isPartner() 入口（审视发现 3） | 直接在 engine 里比较字符串 / 双方法（FromFeishu+FromWeb） | 权限判定逻辑两处消费（engine + processor），集中一点便于测试与未来扩展；统一入口避免渠道语义泄漏 |
| example 配置值 | 占位符 YOUR_OPEN_ID（审视发现 6） | 预填真实 open_id | open_id 属 PII，不入 git 仓库；真实值只进本地 config.yaml |

## 验证

- 单测：PartnerResolver 三态（匹配/不匹配/未配置）；dispatch-chain-engine 历史渲染——非搭档触发的场景 label 不再是 partnerLabel；message-processor 命令门禁三态
- 集成：本地起服务，模拟两条消息（partnerOpenId 匹配 / 不匹配的 ou_），验证命令放行/拦截与历史 label
- 手册：`npm run build` 后人工过一遍 feishu-setup.md 的获取 open_id 步骤可操作性

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `config/config.yaml.example` | 修改 | 新增 partnerOpenId 示例（占位符 + 注释指引） |
| `src/frameworks/config-service.ts` | 修改 | AppConfig feishu 类型 + buildFeishuConfig 解析 partnerOpenId |
| `src/frameworks/feishu/types.ts` | 修改 | FeishuConfig 增加可选 partnerOpenId |
| `src/usecases/im/partner-resolver.ts` | 新增 | 搭档身份判定（isPartner + configured） |
| `src/usecases/conversation/dispatch-chain-engine.ts` | 修改 | 历史渲染搭档判定静态化 + buildRoster 签名加 senderId + 访客提示 |
| `src/interface-adapters/feishu/message-processor.ts` | 修改 | 命令分支加门禁（中性文案） |
| `src/bootstrap/platforms.ts` | 修改 | createDispatchChainEngine / setupFeishu 两处组装 PartnerResolver |
| `docs/user-guide/feishu-setup.md` | 修改 | 搭档绑定小节（含 open_id 获取三途径）+ 访客权限说明 |
| `tests/`（对应测试文件） | 修改/新增 | 三态覆盖（partner / 非 partner / 未配置降级） |

## 实现记录（F20260826fpbd）

实现于 worktree feishu-partner-binding，与方案 v2 一致，无方案外变更：

- `PartnerResolver`（新增）：单一 `isPartner()` 入口 + `configured` 标志；构造时 trim 双保险（config 层已 trim，resolver 再守一道，yaml 留空白串视为未配置）
- `config-service`：RawConfig/AppConfig 双接口 + buildFeishuConfig 解析 partnerOpenId（trim 后空串→undefined）；`FeishuConfig`（frameworks/feishu/types.ts）同步加可选字段
- `dispatch-chain-engine`：历史渲染静态模式（staticMode=configured）三分支——搭档→partnerLabel / 访客→快照名或裸 ID / 降级→#488 行为；buildRoster 签名加 senderId，静态模式下非搭档触发追加「当前说话者非你的搭档」提示
- `message-processor`：命令门禁在 `/` 分支（configured && !isPartner → 中性文案拒绝）；resolver 可选注入
- bootstrap 两处组装：createDispatchChainEngine（appConfig.feishu?.partnerOpenId）+ setupFeishu
- 手册新增「搭档身份绑定」小节（open_id 获取三途径）+ 访客权限说明 + 2 条 FAQ

**测试**：新增 16 个（PartnerResolver 5 + 门禁 4 + engine 静态/降级/roster 7，含调整）；全量 144 文件 1701 用例全过，tsc/lint 绿。（审视发现 1 修正：原文计数 13 为分项加法笔误，5+4+7=16）

### 终审阶段并入：Web 端同步显示冒充 gap 修复

搭档终审提问抓出的 gap：#488 在 `MessageList.tsx` 的回退逻辑是「user 消息无快照名 → 回退全局显示名」，在 Web/飞书同步场景下会把飞书访客（joy）的消息冒充成全局名「chen」——与 agent 侧「无快照不冒充搭档」的设计不对齐。修复：远程消息（`src` 存在，即飞书）无快照显示中性标签「飞书成员」，未知渠道兕底「外部成员」，Web 本地消息（无 src）保留全局名回退。后端无需改动（DTO 对 user 消息无快照时本就不携带 sn）。新增 4 个前端测试（快照名/中性标签/全局名回退/「我」回退），前端 194 用例全过 + tsc 绿。

## 对抗审视记录

第一轮方案审视（检视獭-fpbd，mimo 异体）：2 严重 + 4 建议，处置如下——
- 发现 1（bootstrap 注入路径缺失，🔴严重）：接受并修订——§2 补「注入路径」小节，核实 createDispatchChainEngine 已有 appConfig 参数无需改签名
- 发现 2（/new 命令虚构，🔴严重）：接受并修订——T3 与拦截清单改为 parser 现有五命令
- 发现 3（双方法语义错配）：接受并修订——统一 isPartner() 入口，按 senderId 形态内部分派
- 发现 4（buildRoster 签名未说明）：接受并修订——显式标注签名变更与透传路径
- 发现 5（拒绝文案暴露所有权）：接受并修订——中性文案「这些命令暂时不对所有人开放哦」，与取舍自洽
- 发现 6（example 预填 PII）：接受并修订——改 YOUR_OPEN_ID 占位符，真实值只进本地 config
