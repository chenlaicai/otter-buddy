---
id: F20261001tbar
title: 'Touch Bar 状态桥失联修复：/api/conversations 分页包装兼容'
doc_type: feature
summary: |
  status-core.sh 因 #1119（9/22 对话列表分页改造）引入的 {items, total} 响应包装
  而解析崩溃——jq 的 [.[] | select(...)] 在对象上迭代报错，display-model.json
  恒为 0 字节空文件，Touch Bar 自 9/22 起失联。修复：jq 入口一步归一化
  (if type == "array" then . else .items end)，兼容 v1 裸数组与分页包装两种
  形态，后续聚合逻辑零改动。验证：双形态单元测试 + 限时真实脚本全链路
  （产出 model：4 未读会话 / 3 场干活中）。

status: final
change_type: fix
tags: [touchbar, status-core, api-compat, bugfix]
modules:
  - scripts/otterbar/status-core.sh
capability_test: "n/a: 本机彩蛋工具（非主服务路径），行为由手动验证覆盖（见 Verification）"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
---

# F20261001tbar: Touch Bar 状态桥失联修复

## 背景

搭档 10/1 晚反馈「Touch Bar 现在看到的都是失联」。排查现场：

- `launchctl list`：core 与 renderer-swift 服务均在跑（exit 0）
- `/tmp/otterbar-core.*.log`：每 5 秒一条 `jq: error: Cannot index array with string "status"`
- `display-model.json`：0 字节（jq 失败重定向清空）

## 根因

`/api/conversations` 响应结构变更：v1 裸数组 → #1119（F20260922cgrp，9/22 合入，
「左侧栏三分组分页」）起的 `{items: [...], total}` 分页包装。

status-core.sh:58 的 `[.[] | select(.status == "active")]` 在对象上迭代，
jq 报 `Cannot index array with string "status"`，`fetch_model` 的重定向
`> "$MODEL_FILE"` 先清空文件再等 jq 输出——jq 失败即 0 字节。

渲染层（renderer-swift）读空 model → 常驻离线/空态。失联起始时间与 #1119
合入时间（9/22）吻合，静默 9 天（本机彩蛋工具，无监控告警路径）。

## 修复

jq 程序入口一步归一化，后续逻辑零改动：

```jq
(if type == "array" then . else .items end) as $all |
[$all[] | select(.status == "active")] as $act |
```

- v1 裸数组（旧）→ 原样使用
- 分页包装（新）→ 取 .items
- 不假设后端回滚，两种形态长期兼容

## Verification

**失败证据（修复前）**：
```
/tmp/otterbar-core.*.log 连续输出：
jq: error (at <stdin>:0): Cannot index array with string "status"
```

**修复后验证**：

1. 新形态真实数据（分页包装）单元验证 → 产出正确 model（waiting.count=4,
   working.convs=3, otters=3）✓
2. 旧形态（裸数组，jq '.items[0:2]' 构造）单元验证 → 产出正确 model ✓
3. 限时 8s 跑完整真实脚本（OTTERBAR_MODEL_FILE 指 /tmp）→ model 正常产出，
   无 jq 报错 ✓

**最小回归命令**（上游 API 再变形态时，一行验证修复是否仍兼容）：

```bash
# 新形态（当前后端）：应输出对象而非报错
curl -s http://localhost:3000/api/conversations \
  | jq '(if type == "array" then . else .items end) | length'
# 旧形态模拟（裸数组）：应输出条目数而非报错
echo '[{"status":"active"}]' \
  | jq '(if type == "array" then . else .items end) | map(select(.status == "active")) | length'
```

**审视建议处置记录**（检视獭-tbar，PR #1276）：
- 建议 1（`.items // []` 防御性兜底）：评估后不采纳——会把上游 API 故障静默成
  「显示 0」，比显式报错更难发现；本机工具以「Touch Bar 回归系统默认」为
  可感知失效信号，显式失败符合定位
- 建议 2（补最小验证命令）：本节上述两命令即处置

## 影响范围

- 仅 `scripts/otterbar/status-core.sh` 一文件 4 行
- 渲染层（renderer-mtmr / renderer-swift）零改动——Display Model v1 契约未变
- 上游 API 零改动

## 已知限制

- 若后端未来再改分页字段名（items → data 之类），仍会静默失败——本机彩蛋工具
  不加监控（体积不成比例）；renderer 的长离线自禁（600s 后 Touch Bar 回归系统
  默认）是用户可感知的失效信号，本次失联正是搭档肉眼发现

## 与 F20260902tbar 的关系

- 该文档记录 v3 架构（core/renderer 解耦 + Display Model 契约），历史文档不可变
- 本次是契约消费侧对上游 API 变化的适配修复，契约本身（v1）未动
