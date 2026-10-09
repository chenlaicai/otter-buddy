---
id: F20261009tspg
title: 工具签名泛化：带实体参数管理工具的批量调用误报修复
doc_type: feature
change_type: fix
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
summary: |
  修复 issue #475：buildToolSignature 对 merge_pr / halt_otter / unhalt_otter /
  transition_matter / get_message / get_memory_detail / get_related /
  manage_healing_events / register_matter 等带实体参数的管理工具只取工具名兜底，
  批量操作不同实体被连续相同签名计数器误判为卡壳循环。
  按 F20260826d464「实体标识入签名」先例泛化：签名只取「行为」（实体标识），
  忽略无关参数值；标识缺失时退回工具名。无参/纯查询工具保留名称兜底（设计决策）。
tags: [circuit-breaker, tool-signature, batch-ops, management-tools]
modules: [src/frameworks/agent/tool-call-circuit-breaker.ts, tests/frameworks/agent/tool-call-circuit-breaker.test.ts]
causal_links:
  from: [F20260826d464, F20260728cbwt]
created_at: 2026-10-09
---

# F20261009tspg - 工具签名泛化：带实体参数管理工具的批量调用误报修复

## 1. 问题

`buildToolSignature`（src/frameworks/agent/tool-call-circuit-breaker.ts）只对
bash/read/write/edit/speak/otter 三件套（dissolve/restart/create）有专属签名，
其余工具全走名称兜底（`return toolName`）。带实体参数的管理工具因此存在
「批量调用误报口子」：连续 merge 不同 PR、halt 不同 otter、迁移不同 matter、
批量 resolve 不同 healing 事件——签名全部是同一工具名，连续 5 次即被 steer
误报为卡壳循环。与 #464（批量解散小獭误报，F20260826d464）同根因。

issue #475 立项后的两次数据核查（2026-09-04、2026-09-22）均显示 healing 台账
0 条真实误报，触发条件为「首条真实误报或下次动 circuit-breaker 时带上」。
本修复趁 #464 先例已验证、签名机制在同一文件内时扩展签名覆盖（机制性修复，
非症状驱动）。覆盖范围为下表 9 个工具；带实体/内容参数但不在本 PR 覆盖内的
同类工具（link_memory、workspace_read/write、create_linked_resource、
set_context、search_* 等）由 #1399 跟踪，不在本 PR 扩散。

## 2. 方案设计

### 2.1 设计哲学（沿用搭档拍板，F20260728cbwt）

**签名只取「行为」（实体标识），忽略无关参数值。** 同一命令换参数重试仍算卡壳
是错误设计；不同实体操作不是重复。与 bash（取命令词忽略参数）、speak/edit
（取内容指纹）的设计一脉相承。

### 2.2 签名覆盖扩展（9 个工具）

| 工具 | 签名构成 | 说明 |
|---|---|---|
| merge_pr | `merge_pr: <prNumber>` | 批量合入不同 PR 不算重复 |
| halt_otter / unhalt_otter | `<tool>: <otterId\|otterName>` | otterId 优先，缺失回退 otterName |
| transition_matter | `transition_matter: <matter_id>` | 批量迁移不同待办不算重复 |
| get_message | `get_message: <messageId>` | |
| get_memory_detail | ≤2 ids 全列；>2 压成 `数量#指纹` | ids 是数组，签名限长防拖慢 |
| get_related | `get_related: <entry_id>` | |
| manage_healing_events | `action [过滤特征]` | eventIds（>5 收敛「前5+计数#指纹」）/issueNumber/filterBoundIssue/filterRuleId/filterErrorType/filterStatus/filterSeverity/filterCreatedBefore/After；无过滤特征退化为 action 级；签名出口 cap 200（#475 审视补充） |
| register_matter | `register_matter#<title指纹>` | title 是内容非标识，取内容指纹（同 speak 先例） |

通用 helper `entityToolSignature(toolName, key, value)` 抽取「标识缺失退回工具名」
的公共退化路径，otterToolSignature（F20260826d464）重构并入，行为零变化
（既有测试原样通过验证）。

### 2.2.1 签名长度防护（#475 审视补充）

签名会注入 steer 提示与 warn 日志，超长签名在卡壳时浪费 LLM token、拖长日志。
两道防护：① manage_healing_events 的 eventIds >5 个时收敛为
「前 5 直拼 + +剩余计数#全量指纹」——同一批重试签名稳定、增删任一 ID 换指纹；
② buildToolSignature 出口统一 capSignature：超 200 字符截断加 contentDigest
指纹（与 contentDigest 先例同构）。

### 2.3 明确不改（设计决策）

1. **无参/纯查询工具保留名称兜底**：get_active_participants、get_context、
   list_messages、list_matters、list_artifacts、matter_sweep、
   get_html_card_contract 等——连续 5 次完全相同的无参调用正是卡壳检测的
   目标语义，入签名反而破坏检测。
2. **参数缺失退化路径**：缺参时签名退化为工具名——连续缺参被 steer 是合理
   纠错信号（工具调用本身会失败，重试同型缺参调用 = 真卡壳）。
3. manage_healing_events 的 `action: "query"` 等无过滤特征调用退化为 action 级
   签名——连续 query 连发仍算重复（查询连发是卡壳语义），不同实体的
   resolve/bind 才展开区分。query 侧旋钮参数（status/errorType/includeProbe）
   不入签名：查询旋钮非实体标识，同 action 连发正是卡壳语义，入签名反而破坏
   检测（#475 审视补充声明）。
4. truncated=true 同过滤续跑：工具协议要求「响应含 truncated=true 时需再次
   执行处理剩余批次」——同过滤特征续跑是协议规定的合法重复，会按同签名
   累计。跨调用批次状态会破坏签名无状态性，接受该限制（真 500+ 事件、无
   交错调用的纯续跑场景罕见；被 steer 后 LLM 交错一次其他调用即可继续）。
   （#475 审视补充声明）

## 3. 设计取舍

机制识别检查点判定（动手前完成）：本变更为既有语义内修——不新增机制、
不新增配置项、不改变熔断判定规则（两档制/阈值不动），仅扩展签名函数的
覆盖工具集。判定结论：未命中机制预算四问任何一项，属修法决策树①
（narrow-fix）。

- 粒度取舍：签名粒度与误检率是跷跷板（issue #475 自述）。本方案粒度只到
  「实体标识」一级，不取无关参数值——真卡壳（同一实体反复重试）依然抓得住，
  批量不同实体操作不误杀。
- manage_healing_events 签名含 action：resolve 与 batch_bind 是不同行为，
  action 入签名避免跨 action 连发被误并。

## 4. 影响范围

- 仅 `buildToolSignature` 签名计算路径；熔断判定逻辑（consecutive/sliding
  window/两档制）零改动。
- 行为变化面：上述 9 个工具的批量不同实体调用不再被误报；同实体连续重试
  检测能力不变。
- 无配置项、无 schema 变更、无兼容性影响（签名为运行时瞬态值，不落库）。

## 5. 验证

- 修复前失败证据：main 上 `buildToolSignature("merge_pr", { prNumber: 1381 })`
  与 `{ prNumber: 1382 }` 返回同一签名 `"merge_pr"`（名称兜底）——批量合入
  6 个 PR 序列第 6 次即触发 steer（阈值 5）。
- 单元测试 44/44 通过（新增 11 个用例覆盖 9 工具正反向 + 既有 33 个零回归）：
  - 正向：不同实体 → 签名不同不累计（merge_pr/halt/transition_matter/
    get_message/get_memory_detail/get_related/manage_healing_events/
    register_matter 各有不同实体用例）
  - 反向：同实体连续超限仍 steer（merge_pr 同一 prNumber 4 连发）；
    批量混合序列（PR 合入+halt+迁移+resolve 各 6 次）全 allow
  - 退化：缺参退回工具名（每个工具均有缺参用例）；
    无参查询工具保留名称兜底（设计决策锁定用例）
- 全量测试 + lint 四 gate：见 PR Verification 节
- 已过最简实现检查：复用既有 contentDigest/fileToolSignature 模式，新增
  entityToolSignature 一个 helper + managementToolSignature 一个分发函数，
  无新依赖无新配置。

## 6. 参考

- issue #475（circuit-breaker 工具签名机制性方案）
- F20260826d464（先例：otter 三件套实体标识入签名）
- F20260728cbwt（事件驱动改造 + 「签名只取行为」设计哲学）
