---
id: F20261124prcmp
title: 每 invoke PromptComposer 与真实 Durable 请求契约
summary: 在首个模型请求前重编译 SYSTEM、当前身份、Skill 索引与任务配置；Durable 只消费唯一 renderedPrompt，restricted 改用独立公开任务配置并对内部资产故障隔离。
change_type: feature
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类运行时装配与失败语义，由真实 PiSessionFactory/DurableSession/HTTP wire 判别测试覆盖；不新增需要 LLM 自由行为的能力"
tags: [prompt, session, durable, external, readonly]
modules:
  - src/frameworks/agent/prompt-composer.ts
  - src/frameworks/agent/prompt-asset-provider.ts
  - src/frameworks/agent/durable-session.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/identity-builder.ts
  - src/frameworks/agent/model-runtime-registry.ts
intent:
  problem: "Durable 请求没有平台 SYSTEM，Skill 仅在 session 创建时快照，restricted 仍回读普通 otter systemPrompt；身份与资产读取失败还会静默降级，导致 cold/pool/restart/readOnly/restricted 的模型可见规则不一致。"
  expected_effect: "普通与 readOnly 的每个首个 model request 都含最新 SYSTEM、完整内部身份、Skill 索引和普通任务配置；restart 不依赖旧 pi.system；restricted 仅含中性身份、externalTaskConfig、公开 MCP 与最后的安全覆盖，内部资产失败不进入其分区请求。"
  verify_by:
    type: behavior_check
    rollback: "整体 revert 本 PR 的代码与测试；无数据库、durable SQLite、配置格式或历史 pi.system 回填。Composer 故障时暂停新 invoke，不以空 prompt 降级。"
    risk_note: "内部 SYSTEM、必需身份或 Skill 清单读取失败从静默降级改为 submit 前失败；restricted 不再继承普通 systemPrompt，含 external 的部署必须显式迁移已审公开文案。"
---

# 每 invoke PromptComposer 与真实 Durable 请求契约

## 背景与基线

实施基线为 `origin/main@6dfbb6907353e9bd22f0ec2ff0d8a2c0d35327b0`，已包含 PR-01 核心 prompt ratchet 与 PR-02 ConversationScope。开工时开放 PR 只有 #1994、#1966，无 C1 在途实现。

真实 wire 复现确认：

1. 普通 cold/restart/readOnly 请求的 `otter` section 只有任务、身份和创建期 Skill，没有 `.pi/SYSTEM.md`。
2. pool 第二轮虽刷新任务与身份，但 Skill 仍是创建时快照。
3. restricted 的真实请求包含普通 `INTERNAL_TASK_SECRET`，且没有独立公开任务入口。
4. `IdentityBuilder` 对缺失主体/身份文件返回匿名或仅头部文本；ResourceLoader 未预热时 Skill 静默为空。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| prompt 真源 | Factory 在 `_executeWithSession` 每 invoke 调 Composer，随后 `session.updateOptions({ renderedPrompt })` | Durable 继续从 ALS、旧 options、profile ResourceLoader 各自拼接 | 首个请求前只有一个完整决策点，pool/restart/readOnly 不会各走一套 |
| 资产更新 | Provider 每次重新读取 SYSTEM 并 reload Skill 清单，以内容 hash 复用相同快照 | 只在 warmup 发现一次；每轮不缓存地重建所有对象 | 变更下一 invoke 必见，同时保持相同内容的快照与 revision 稳定 |
| 并发读取 | 共享 ResourceLoader 的 reload 串行化，失败只拒绝当前 invoke，后续可重试 | 多獭并发 reload 同一 loader | 避免共享可变索引出现半替换读面 |
| restricted | 判别联合输入只接受 `externalTaskConfig` 与已过滤的公开 MCP；安全覆盖最后 | 回退普通 `otter_configs.systemPrompt`；裁减 readOnly 知识 | 类型与调用路径共同阻止内部任务配置进入外部分区；readOnly 只裁工具 |
| 失败语义 | 普通/readOnly 的 SYSTEM、必需身份、Skill 清单失败在 submit 前抛出 | 空 SYSTEM、匿名身份或空 Skill 冒充安全降级 | 用户得到明确失败而非另一个规则残缺的海獭 |

机制识别：命中「新增跨模块调用路径」与公开任务配置类型。本方案是定稿 PR-03 已批准的 Composer/Provider 机制，不新增数据库、后台任务、池或锁。机制预算四问：

1. **谁需要它**：普通主獭/小獭、readOnly 交接合成流程、restricted external connector，以及需要确认模型实际收到什么规则的实施者与检视者。
2. **失败后果**：旧行为会让模型缺少平台规则、沿用旧 Skill，或把内部任务文案泄露给外部用户；资产静默失败会让用户把规则残缺的回答当成正常回答。
3. **后续机制**：快照 hash、串行 reload 和公开配置输入可能出错；由五态真实 wire、内容更新、零 submit 与 restricted 故障隔离测试持续守护，修复仍在同一 Composer/Provider 边界。
4. **退役条件**：仅当 Durable 上游提供等价的每 invoke 单一编译入口、且五态请求与 external 负向测试全部迁移通过后，才可删除本地 Composer/Provider；在此之前是永久执行契约。

机制提案准入：决策者不变，仍由现有 invoke 流程执行、搭档保有产品裁决权；机械 wire 断言绑定而非靠自觉；人可直接从请求证据把控模型可见内容。无自动巡检、自动跳过或替代人审。

## 变更

1. 新增 `PromptComposer`：内部按 SYSTEM → 身份 → Skill → 普通任务 → MCP 渲染；restricted 按中性身份 → externalTaskConfig → 公开 MCP → 安全覆盖渲染。输出文本、整体 revision 与分段 hash/bytes。
2. 新增 `PromptAssetProvider`：读取仓根 `.pi/SYSTEM.md`，每 invoke reload 同仓根 ResourceLoader 的 Skill 清单；区分合法空 Skill 与读取错误，按内容 hash 缓存快照。
3. `DurableSession` 的 `otter` section 只渲染 Composer 字符串；删除 promptProvider、旧 identity/skills 拼接和旧 `before_agent_start` prompt 双路。
4. `PiSessionFactory` 在首个请求前统一编译并更新 session；池 key、epoch、锁、cwd、普通 otter-global transcript 与 restricted 分区文件不变。
5. `IdentityBuilder` 对缺失 otter 或 BIG/SMALL 必需资产 fail-loud；对话标题等既有可选信息仍按原语义省略。
6. `externalTaskConfig` 是受限 invoke 的独立公开配置入口。当前仓库没有 external 内容存储或存量文案迁移，本 PR 不创建它们；缺省只产生中性身份与安全边界。

## 旧机制接管与负向核查

| 被删/替换物 | 原保护的不变量 | 原消费者 | 新机制接管 |
|---|---|---|---|
| Durable `prompt + identity + skillsPrompt + mcp.instructions()` 拼接 | 普通请求有任务/身份/Skill/MCP；restricted 不装内部 Skill | `_createSessionWithTools`、pool 命中、reset 后重开、readOnly/restricted | Composer 每 invoke 完整重编译；MCP 从当前 session 的已准入 bridge 取值，restricted 只读公开面 |
| `promptProvider` 与 `before_agent_start` ALS 注入 | 第二轮任务/身份可刷新；旧 SDK hook 可覆盖 system | Durable prompt、旧 ModelRuntimeRegistry hook、system-prompt 单测 | `renderedPrompt` 在 submit 前更新；ALS 不再作为 prompt 真源，旧测试由 Composer 与真实 wire 测试接替 |
| 身份缺失静默降级 | 有身份文件时正常注入；无对话标题可省略 | 普通/readOnly 全部 invoke | 必需主体/BIG/SMALL 失败即零 submit；可选对话标题行为不变 |

负向结论：未删除工具准入、bash/halt/loop 物理守卫、readOnly/restricted 绕池、deferred tool 加载、epoch 所有权或 cwd 回滚。pre-submit 失败会清 activeSession，普通池可修复后重试，一次性 readOnly/restricted session 会释放。唯一有意行为收紧是内部资产失败不再带病请求、restricted 不再继承普通任务文案。

## 非目标

- 不做 C2 ProjectionPolicy、P1/P2、outbox 或 ToolAdmission 重排。
- 不改 durable SQLite/文件格式，不回填或改写历史 `pi.system`。
- 不重写池、锁、交接，不改普通 otter-global transcript 产品语义。
- 不大改 SYSTEM/BIG/SMALL 文案本体，不新增核心 prompt 体积预算。
- 不为 external 新增数据库配置或隐式文案迁移；公开内容须由 connector 显式提供。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| cold | 新小獭首次 invoke，经真实 Durable 到本地录音网关 | 首个 wire system 含 SYSTEM、当前身份、Skill name/description/path 与普通任务 |
| pool | 同獭 A→B 第二轮，修改 SYSTEM、Skill 描述与任务 | 第二请求含 B 身份和全部新值，不含旧值；历史仍含首轮 user 消息 |
| restart | 存量空 system_prompt 主獭 invoke → reset → invoke | 两世请求都有完整 SYSTEM/大獭身份/Skill；配置仍为空，不读旧 pi.system 充当真源 |
| readOnly | readOnly invoke；随后分别破坏 SYSTEM、Skill reload | 成功请求知识完整；失败均在 submit 前抛出、gateway 请求数不增、activeSession 清空 |
| 空 Skill | 删除唯一 SKILL.md 后 readOnly invoke | 请求正常且无 `<available_skills>`，不与读取失败混淆 |
| restricted | 普通任务设置内部 marker，分别传公开任务、省略公开任务、破坏内部资产 | 只出现公开任务/提醒/中性身份/安全覆盖；无内部 SYSTEM/Skill/身份/任务；缺省安全最简；内部故障不阻断分区请求 |
| revision/顺序 | Composer 输入固定或变更 | 分段 hash/bytes 可判别，restricted 安全覆盖固定最后 |

## 测试改动声明

方向：收紧。删除旧 `system-prompt-injection` 与 Durable identity 保留测试，因为对应 ALS/旧 options 双路已退役；新增 Composer 单测和真实五态 wire 闭包。`toolcall-count-race`、`token-usage-delta` 只把 prompt 编译 stub 移到新边界，原工具计数与 token 断言不变；身份旧降级断言改为 fail-loud，未删除既有正向覆盖。

## Verification

### 失败用例证据（bugfix）

新增测试未改实现时运行 `npx vitest run tests/frameworks/agent/prompt-composer-wire.test.ts --disable-console-intercept`，4 个场景全部失败，原文见对话工作区 `pr03-red-before.log`：

```text
cold/pool、restart、readOnly: 首个真实 system 不含 SYSTEM_V1
restricted: 不含 PUBLIC_TASK，实际反而包含 INTERNAL_TASK_SECRET
```

修复后同一文件扩为 6 个场景（含必需身份失败、空 Skill/Skill 失败），全部通过。完整 agent 目录回归见 `pr03-agent-suite.log`：65 文件 / 715 用例全绿；后续新增身份 wire 场景包含在最终全量结果中。`npx tsc --noEmit` 零错。

### 回归与最简检查

- 已过最简检查：复用现有 `buildOtterPrompt`、安全覆盖、ResourceLoader、`formatSkillsForPrompt`、池与锁；新增文件仅为定稿指定的 Composer/Provider，无新依赖或持久化格式。
- `npm run check`：build、eslint、schema、双形态 boot、脚本回归与 connector closure 全通过，最终日志为 `pr03-check-final.log`。
- `npm test -- --disable-console-intercept`：**529 文件 / 6825 用例全绿**，最终日志为 `pr03-full-test-final.log`。
- `npm run test:capability`：**17 文件通过，17 passed + 48 skipped**；跳过均为未配置真实 LLM，确定性录音网关与本地模型用例实际执行并通过。日志为 `pr03-capability-final.log`。
- `npx tsc --noEmit`、`git diff --check`：零错。

Golden Gate 的适用性：本批不改 prompt/skill 文案或触发语义，只修复运行时资产交付；已按仓库要求执行完整 capability/golden 套件并记录上述真实结果。锚点重放 `n/a`：没有修改任何 prompt/skill/tool description 文本。

## 回滚与迁移

整体 revert 本 PR 即可恢复旧代码；无数据库、durable、配置或运行时副本迁移。Composer 事故应暂停新 invoke 并修复资产，不能把空 prompt 当安全降级。

含 external 的部署若曾依赖普通 `systemPrompt` 提供外部人设，必须在启用前由运营者把已审公开文案显式迁移到 connector 的 `externalTaskConfig`；缺省只保留中性身份与安全覆盖。external 启用后不得回滚到会读取内部 taskConfig 的版本。
