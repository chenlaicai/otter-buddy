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

## 取舍与残余风险（搭档已知情接受）

- **「读凭证→POST 出去」通道全开**：A 类凭证拦截只认命令词面路径（~/.ssh 等），变量构造路径本就绕得过（F20261030gblkv 残余风险已记录）；B 类退役后「读到手送不出」的兜底消失。搭档裁决：该兜底保护的需求本身是虚构的，不构成保留理由。
- **兼容参数静默忽略**：GuardOptions.allowedEgressDomains / store.guardAllowedEgressDomains 保留形状——防止测试桩/存量调用方类型破损；语义上恒 no-op，注释已标明退役。
- **不删 C 类「下载即执行」**：curl|sh 结构拦截与外发白名单语义无关（拦的是「执行结构」不是「目的地」），不在本次清算范围。

## 爆炸半径归档（锚点值）

- 变更规模：10 文件（守卫本体 1 + 判定链拆除 4 + 测试 3 + 配置 example 1 + prompt 1 + 本文档）
- 路径杠杆：**高**（bash 守卫机制删除，SYSTEM.md 级守卫路径）
- 可逆性：git 可回滚（单 PR revert）
- 影响面：全量（所有 session 的 bash 工具共用守卫）

按 R8 爆炸半径调制：高杠杆 + 机制删除 → PR + 对抗审视 + 重对抗门。
