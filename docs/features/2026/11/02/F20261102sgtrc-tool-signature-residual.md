---
id: F20261102sgtrc
title: 工具签名残余口子收口：五组管理/检索工具接入实体签名（#1399）
change_type: fix
status: implemented
created: 2026-11-02
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/tool-call-circuit-breaker.ts
summary: "#1399：buildToolSignature 五组残余名称兜底收口（触发已满足：11-01 晨检獭实锤两条误拦——批量回写 10 条评论 workspace_write 连续 7 次熔断 + write 草稿迭代 force terminated）。①link_memory：from→to 组合签名（方向是语义）；②workspace 读写：path+内容指纹（与 read/write 同构）；③create_linked_resource：类型+title/url/content 首参指纹；④set_context：key 实体签名；⑤search 三件套：query 内容指纹与 speak 同构（同词重搜算重复换词不算）。关键取舍：实体相同即同签名（附加参数不区分）——同实体连发值得提醒，不同实体才是正当批量流。存量断言一处更新（旧期望退化工具名→新语义指纹，正是 issue 目标行为）。"
tags: [circuit-breaker, tool-signature, false-positive]
intent:
  problem: "五组带实体/内容参数的工具仍走名称级签名兜底——正当批量流（批量回写评论、批量登记产物、批量记忆建边、换关键词重搜）被「连续同签名」规则误拦，实锤两条 healing 事件"
  expected_effect: "批量操作不同实体/不同检索词不再累计熔断计数；同一实体连发/同词重搜仍累计（卡壳目标语义保持）——误拦消失且防护不弱化"
  verify_by:
    type: capability_test
capability_test: "tests/frameworks/agent/tool-call-circuit-breaker.test.ts 5 个新用例：link_memory 组合签名（不同记忆对不算重复/同对不同 type 仍算）、workspace 批量流（不同文件/同文件不同内容迭代/同内容重试三分支）、create_linked_resource 类型+内容指纹、set_context key 签名（不同 key 连发/同 key 反写）、search query 指纹（换词/同词/无参三分支）——红测先行（先红 5 后实现转绿）"
---

# 工具签名残余口子收口（#1399）

## 问题

buildToolSignature 自 #475/F20261009tspg 覆盖 9 个管理工具后仍有五组残余走名称兜底。11-01 晨检獭实锤两条误拦（healing 0b984c73 / a16ace8e）：

1. regression-verify 批量回写 10 条 issue 评论——workspace_write 连续 7 次被 K=7 滑窗规则熔断（10 条不同评论的正当节奏流，签名=纯工具名无法区分）
2. write 同一评论草稿迭代（c1203.md）撞 K=6/M=3 + 6 steers ignored 后 force terminated

两条均判误拦。触发条件（首条真实误报）满足，issue 转正式处理。

## 方案

五组工具接入既有签名模式（entityToolSignature/fileToolSignature 同款），判据各自适配：

| 工具组 | 签名 | 判据说明 |
|---|---|---|
| link_memory / unlink_memory | 有向：`link_memory: <from>→<to>`；relates-to 对称：字典序归一 + `≈` 后缀（分桶） | 有向边（produced/references/supersedes）两方向独立；relates-to 反向建边归一累计。分桶语义：同对混 type 连发不互累计（≈ 标记区分桶，B-3b 滑窗兜底），同桶内连发仍累计 |
| workspace_read / workspace_write | read 取 path；write 取 path+内容指纹 | 与 read/write/edit 完全同构（实锤误拦 0b984c73 直接对因）；同一编辑重试仍累计（a16ace8e 是 write 的同因，已在既有覆盖内） |
| create_linked_resource | `create_linked_resource: <type>#<digest>` | url→content→title 取首参指纹（r1 S2 修正：url 是资源定位主键且多与 title 并存——title 优先会把「同 title 不同 url」正当批量误归同签名、「同 url 改 title」幂等重登记签名漂移）；同类型同内容幂等登记算重复，不同内容正当批量不算 |
| set_context / delete_context | `set_context: <key>` | key 实体签名；get_context 兜底保持（查询无实体），写不同 key 连发不误报（issue 原判据），同 key 反写算重复 |
| search_memory / search_messages / search_terminology | `search_memory#<digest>` | query 内容指纹与 speak 同构（issue 建议口径：检索词是内容非实体）——换关键词重搜不算重复，同词反复重搜算（换着法子搜不到才该换策略） |

**关键取舍**：实体相同即同签名，附加参数（关系 type、resourceType 之外的 title 等）不区分——「不同实体」才是正当批量流的判别特征，「同一实体连发」无论附加参数都是值得提醒的模式。

## 验证

- [x] 红测先行：5 新用例先红（名称兜底语义下全挂）→ 实现转绿（55/55）
- [x] 全量回归：426 文件 5633 测试零失败（含存量断言 1 处更新：search_memory {query:"x"} 旧期望「退化工具名」→新语义指纹——该断言记录的正是本 issue 要改的旧行为）
- [x] tsc --noEmit 零错误
- [x] 误拦场景直接对因：0b984c73 的 workspace_write 批量流在 path+内容指纹下 10 次签名各不相同，永不累计
- [x] 防护不弱化验证：同一编辑重试/同实体连发/同词重搜三个卡壳形态仍累计（测试三分支覆盖）

## 后续观察

其余名称兜底工具（无实体参数的查询类）为设计保留（连续 5 次无参调用正是卡壳目标语义，既有测试明文锁定）。若再现正当批量流误拦，按本模式逐组接入。

## 影响

- 批量回写评论/批量登记产物/批量记忆建边/换词重搜四类正当流不再误拦
- 同实体重复操作/同词重搜的纠错提示保持（防护强度不降）
- 无 API/配置变更，签名格式变化仅影响熔断内部判重（steer 文本更精确）
