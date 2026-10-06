---
id: F20261006obsv
title: 每日体检补上下文压缩观测（#1246 风暴复盘）
change_type: fix
capability_test: "n/a: prompt 软代码改动，无 LLM 行为面可跑场景（golden gate 豁免口径）"
status: implemented
created_at: 2026-10-06
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - F20260917pbgg
summary: daily-health-check 数据源清单补第 7 项压缩观测（SDK compaction failed 按日计数 + 阈值），9/23-9/29 压缩风暴形态从此进每日观测面
intent:
  problem: "9/29 压缩风暴（issue 记 372 次/日）发生时无任何观测面——日报数据源清单不含压缩事件，风暴只能靠搭档目视对话卡死发现"
  expected_effect: "体检跑时 grep 计数单日 SDK compaction failed ≥10 或连续 3 日递增即建 bug issue；shadow channel 配对失衡同理；无异常显式写「failed=N，健康」进数据源自查清单"
---

# F20261006obsv 每日体检补上下文压缩观测

## 背景（issue #1246）

9/29 压缩风暴：对话上下文爆炸导致一天 372 次压缩，各獭上下文连环爆。当日修复后，issue 追问「为什么体检没发现」——答案：**体检数据源清单里没有压缩事件这一项**，风暴形态在观测面外。

## 实测载体（口径勘误）

issue 建议里写的 `agent_compaction_total` 是设想名，实测真实载体是三层：

1. **失败压缩**：`data/logs/otter-buddy.log` 的 `"msg":"SDK compaction failed"`（level 40）——风暴真实载体，按日实测 9/23 220 次、9/24 97 次、9/29 59 次（量级与 issue 的 372 吻合，372 为当日全口径压缩尝试数）。典型 errorMessage 是「摘要请求超 k3-256k 上限」，即上下文爆炸的下游症状
2. **成功压缩**：session jsonl 的 `type:compaction` entry（按日个位数）
3. **shadow 通道**：`[compaction-synthesis] shadow channel starting/completed` 日志配对（健康日 5/5 配对）

**口径陷阱（实测踩坑）**：日志含脏 unicode（`\uXXXX\uXXXX` 孤立代理对），**jq 解析整文件必崩**——观测口径必须用 grep。

## 改动

1. 数据源清单第 7 项「上下文压缩观测」：grep 命令 + 阈值规则（单日 ≥10 或连续 3 日递增 → 建 bug issue，关联 messageId/otterId 定位）+ 无异常显式健康声明
2. 产出前自查清单加第 10 项对应锚点
3. 增量纪律出清（F20260917pbgg「加 X 减 X」）：同文件压缩止损线段（-47B）、信噪比段（-105B）、断言豁免段（-36B）——语义全保留，砍冗词

## 设计取舍

- **阈值定 ≥10/日**：健康基线实测为 0（10/6 全天 0 次），风暴日 59-220 次，阈值间留两个数量级缓冲，防偶发单次失败误报
- **只进 prompt 不建检测器**：issue 建议路径 3（prompt 观测段）优先于路径 1（新 RHI 检测器）——检测器是 L1 级机制新增，需观测期校准阈值，先用日报观测面收集基线数据，检测器作为后续演进（不动代码，无回归面）
- **RHI 检测器留作后续**：若日报观测 2-4 周后阈值稳定，可评估上 RHI 信号源（届时另立特性文档）

## 测试

- `npm run check` 全过（build + lint + smoke:boot + 7 测试）
- lint-prompt-size 过闸（body 9578B < 9600B 预算，增量纪律出清后达标）
- 口径在真实日志实测可执行：按日计数 / messageId 关联提取均验证

## 已知边界

- 观测面依赖体检任务按日跑（已有调度）；若体检停摆，压缩风暴仍无第二观测面（检测器演进项覆盖）
- failed 阈值 ≥10 对「慢爆炸」（每日 5-9 次持续一周）不敏感——连续 3 日递增条件部分覆盖，极端慢性形态留待基线数据校准
