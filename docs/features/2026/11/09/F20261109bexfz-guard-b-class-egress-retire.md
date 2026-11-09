---
id: F20261109bexfz
title: bash 守卫 B 类外发域名判定整类退役（伪需求清算）
summary: 搭档 2026-11-09 拍板：B 类「数据外发」域名白名单判定整类退役——该需求无真实来源（搭档从未提出），白名单语义与 10/29「禁止白名单！只允许有黑名单！」总则相反。删除 uploadExfilHit 判定链与 bashGuard.allowedEgressDomains 配置节；存量 healing 归因由 classify 指纹表回溯兜底（network_exfil 进 RETIRED_RULE_IDS）；回放库 B 类负门翻转为退役钉。
change_type: refactor
capability_test: "n/a：守卫规则删除，验证=回放回归库全绿（B 类钉翻转）+ classify 双清单一致性"
intent:
  problem: "B 类「数据外发」域名白名单判定与守卫总则相悶：搭档 10/29 拍板「禁止白名单！只允许有黑名单！」「看不懂的放通」，但 curl/wget 的 POST/PUT 实际被做成「目标域名不在白名单表=拦」（fail-closed）——回查决策链，搭档 5 条定调原话无一条要求域名白名单，该表是 F20261030gblkv 重写时实现侧自行加进的兑底，需求无真实来源。实战代价：正常 API 测试连续被拦（11-09 单日 4 次，零次真泄密），白名单语义反成正常工作摩擦。"
  solution: "B 类外发域名判定整类退役：删 uploadExfilHit 判定链与 bashGuard.allowedEgressDomains 配置节（validate 残留键报错防静默失效）；第二站黑名单收为两类（A 凭证路径 + C 下载即执行）；存量 healing 归因由 classify 指纹表回溯兑底（network_exfil 进 RETIRED_RULE_IDS）。"
  expected_effect: "curl/wget 的 POST/PUT 不再看目的地，正常 API 调用不再被拦；主进程保护面不变（第一站全部保留）；A/C 两类拦截不变（cat ~/.ssh|curl 组合仍由 A 类词面凭证拦住）。"
  verify_by:
    type: behavior_check
    assertions:
      - "回放库+classify 119/119 全绿：B 类负门 13 处翻转为退役钉（非协作域名 POST 放行）；A/C 类负门全保留（cat ~/.ssh|curl 组合仍拦，归因 A 类凭证）"
      - "兼容语义：GuardOptions.allowedEgressDomains 传表不再影响判定（静默忽略钉）"
      - "config.yaml 残留 bashGuard 节：validate 启动报错并给出迁移指引"
      - "全量 5741/5742（唯一失败 durable-runtime SIGKILL 为预存 flaky，裸 origin/main 同样超时已 git stash 对照验证）"
created_in_conversation: 9d6ffef1-c9b2-48f9-b2ac-0751090f3ebf
created_at: 2026-11-09
causal_links:
  - supersedes: F20261030gblkv（B 类外发域名表部分；该文档守卫两层架构整体保留）
tags: [bash-guard, guard-v4, mechanism-retirement]
modules: [src/frameworks/agent/bash-safety-guard.ts]
---

# bash 守卫 B 类外发域名判定整类退役

## 背景：一个虚构的伪需求

2026-11-09，搭档让大獭测试第三方 API 网关连通性。curl 的 GET `/v1/models` 放行、POST `/v1/chat/completions` 连续 4 次被守卫拦截（healing 台账 4 条 network_exfil）。搭档质疑「bash 守卫不应该是能识别的拦截、无法识别的全放通吗，为什么还有个白名单？」——顺着查下去发现：

1. **守卫总则**（F20261030gblkv，搭档 2026-10-29 原话锚定）：「禁止白名单！只允许有黑名单！」「只拦截明确有问题的，其余看不懂的全放通」。
2. **实际实现**：B 类「数据外发」判定是域名白名单制——curl/wget 的 POST/PUT/带载荷，目标域名必须在 `bashGuard.allowedEgressDomains` 表内，不在表 = 拦（fail-closed）。
3. **需求来源**：翻遍 F20261030gblkv 决策链——搭档 5 条定调原话没有一条要求域名白名单；该表是重写时作为「凭证读到手送不出」的兜底由实现侧自行加进的（F 文档残余风险第 1 条自述「搭档专改」，但搭档从未改过——因为搭档不知道它存在）。

搭档拍板（2026-11-09 14:54 原话）：「这个防止外发的需求我甚至都不知道是从哪里提出的，肯定不是我遇到过的，所以你直接移除这个外发拦截机制，如果真的没有真实需求的话，那说明这只是个虚构的伪需求。」

**结论：整类退役（方案 A，议题卡三方案呈报后搭档选定）。**

## 改动设计

### 删除的判定链（src/frameworks/agent/bash-safety-guard.ts）

- `DEFAULT_EGRESS_DOMAINS`（内置缺省域名表）
- `makeEgressDomainAllowed`（域名后缀匹配器）
- `uploadVerbHitFor`（curl/wget 上传动词词元表——S1/S5/D1/D3 历次检视修复的全部机械）
- `uploadExfilHit`（B 类主判定）
- `NETWORK_EXFIL_BLOCK_MSG`（拦截块）
- `checkBlacklistStation` 中 B 类调用分支——第二站黑名单从三类收为两类（A 类凭证路径 + C 类下载即执行）

### 配置链拆除

- `config-service.ts`：`bashGuard` 节从 RawConfig/AppConfig/buildBashGuardConfig 全链删除；validate 增残留键报错（照 compactionReserveTokens 先例——静默忽略会让搭档以为白名单还在生效）
- `pi-session-factory.ts`：不再从 config 读 `guardAllowedEgressDomains` 注入 store
- `model-runtime-registry.ts`：守卫调用不再传该参数；store 字段保留为退役兼容形状（恒 undefined）
- `GuardOptions.allowedEgressDomains`：保留签名兼容存量测试桩，判定不再读取
- `config/config.yaml.example`：示例节替换为退役说明

### 归因链保留（历史 healing 可回溯）

照 F20261105killa（self_kill_nonliteral）退役先例：

- `guard-intercept-classify.ts`：`network_exfil` 指纹保留在 FINGERPRINTS（存量 healing 事件回溯归因仍可分类），ID 进 `RETIRED_RULE_IDS`（isHistoricalAttribution=true，月度剪枝不再当活跃规则呈报）
- `prompts/scheduled/monthly-prune-review.md`：活跃清单七条→六条，退役段补 network_exfil 条目（classify 测试机械核对双清单一致）

### 回放回归库（真实使用为准 → 行为变化全量钉进回归）

- `cases-2026-10-29.ts`：「非协作域名 POST 带数据」负门翻转为 allow（退役钉）；「cat ~/.ssh | curl POST」组合负门保留 block——但归因改为 A 类凭证路径（B 类部分退役后仍由词面凭证拦截兜住，这个组合负门恰好验证 A 类还在）
- `replay.test.ts`：「B 类域名表语义」describe 整段重写为「B 类已退役」钉（非协作域名 POST 放行 / 兼容参数静默忽略 / fail-closed 分支退役放行）；S5/D1/D3 系列上传动词负门全部翻转为退役放行钉
- `guard-intercept-classify.test.ts`：network_exfil 探针断言改为「历史文案 classify 可归因 + 裸探针断言放行」双钉；ACTIVE_RULE_IDS 双清单一致性测试随 monthly-prune 口径更新自动对齐

## 验证

- 回放回归 + classify：119/119 全绿（含 13 个翻转钉）
- 全量 vitest：5741/5742，唯一失败 `durable-runtime.test.ts > reopens after a real process SIGKILL` 为**预存 flaky**——裸 origin/main 同样超时（已 git stash 对照验证），与本 diff 无关
- tsc --noEmit：零错误
- 兼容性：config.yaml 残留 bashGuard 节会在启动时 validate 报错并给出迁移指引（已有部署不会静默失效）

## 删除保护接管表（retirement-handover-checklist）

| 被删/替换物 | 原保护的不变量全集（含异常路径） | 原消费者（运行时/观测/测试/文档） | 新机制如何接管；不接管则显式风险接受 |
|---|---|---|---|
| B 类 uploadExfilHit 主判定（非协作域名 POST/PUT 拦） | 拦「上传动词 + 域名不在白名单」；子域后缀匹配；无 URL 可静态校验时 fail-closed；短旗标大小写敏感（curl -d/-F/-T vs wget 全 GET 侧） | 运行时：checkBashCommandSafety 唯一入口；观测：healing 落账 network_exfil；测试：回放库 13 钉 + classify 探针；文档：F20261030gblkv | **不接管（搭档拍板风险接受）**：需求无真实来源；回放钉翻转为退役放行钉（未来回加必红） + classify 指纹保留供存量回溯归因 |
| bashGuard.allowedEgressDomains 配置节（含缺省表/fail-closed 语义） | 缺省内置 8 域名；显式空数组 = 全拦；搭档专改防注入自放行 | 运行时：config-service validate + pi-session-factory 注入 + model-runtime-registry 传参；运维：config.yaml.example；测试：回放域名表语义段 | validate 残留键报错引导删除（键存在即拦，空节/null 同拦——本次新增钉）；config 链全拆；example 节替换为退役说明 |
| NETWORK_EXFIL_BLOCK_MSG 拦截块（文案+ruleId 绑定） | 文案引导「搭档登记白名单」；ruleId=network_exfil 直标 | 观测：guardOnIntercept 落 healing 事件；classify 指纹「向非协作域名上传数据」 | 指纹保留在 FINGERPRINTS + ID 进 RETIRED_RULE_IDS：存量 healing 事件回溯分类不断，月度剪枝单列「历史归因」不入活跃候选 |
| GuardOptions.allowedEgressDomains 运行时参数 | 从 config 注入到判定函数全链生效 | 运行时：model-runtime-registry 守卫调用；测试：各测试桩 options 传参 | 保留签名兼容（防类型破损），恒 no-op，注释标退役；回放钉「传表/空表同放行」钉住不参与判定 |
| 凭证外传组合形态（cat ~/.ssh \| curl POST）的 B 类半边 | A 类拦词面凭证路径 + B 类拦外发，双层叠加 | 运行时：同主判定入口；测试：cases-2026-10-29 组合负门 | **A 类全接管**：词面 ~/.ssh 命中即拦（组合负门保留 block，归因改 A 类）；B 类半边不接管（变量构造路径本就绕过，与退役前等价） |

## 取舍与残余风险（搭档已知情接受）

- **「读凭证→POST 出去」通道全开**：A 类凭证拦截只认命令词面路径（~/.ssh 等），变量构造路径本就绕得过（F20261030gblkv 残余风险已记录）；B 类退役后「读到手送不出」的兜底消失。搭档裁决：该兜底保护的需求本身是虚构的，不构成保留理由。
- **兼容参数静默忽略**：GuardOptions.allowedEgressDomains / store.guardAllowedEgressDomains 保留形状——防止测试桩/存量调用方类型破损；语义上恒 no-op，注释已标明退役。
- **不删 C 类「下载即执行」**：curl|sh 结构拦截与外发白名单语义无关（拦的是「执行结构」不是「目的地」），不在本次清算范围。

## Golden Gate 记录（B7 豁免声明）

- selftest 层（零 LLM，判别力校验）：10/10 通过（vitest.capability.config.ts，2026-11-09 本机复跑；selftest 在 LLM 未配置时也执行，10 skip 仅为采样段，skip 前置 selftest 断言全过）
- 采样层（真 LLM）：**n/a 豁免**——本 PR 的 monthly-prune-review.md 改动为口径清单同步（六条/七条 + 退役段补录），无新增独立 LLM 行为场景；与 F20261103dotrg 先例同型（口径调整不冒充特性执行记录）。环境无 OTTER_TEST_LLM_API_KEY，豁免声明留档，如检视认为需采样补跑请指出具体场景。

## 爆炸半径归档（锚点值）

- 变更规模：10 文件（守卫本体 1 + 判定链拆除 4 + 测试 3 + 配置 example 1 + prompt 1 + 本文档）
- 路径杠杆：**高**（bash 守卫机制删除，SYSTEM.md 级守卫路径）
- 可逆性：git 可回滚（单 PR revert）
- 影响面：全量（所有 session 的 bash 工具共用守卫）

按 R8 爆炸半径调制：高杠杆 + 机制删除 → PR + 对抗审视 + 重对抗门。
