---
id: F20260920tdun
title: UI 时间展示统一化：修时区 bug + 格式收口
summary: 修 2 处时区 bug（泳道轴 UTC 切日期差一天、IM 出站 UTC 直出差 8 小时）+ 5 种时间格式收口为 3 种标准形态 + IM 出站显式 Asia/Shanghai + schema 双轨地雷标注
change_type: fix
created_at: "2026-09-20T14:00:00+08:00"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 纯展示格式化改动，无 LLM 行为变更"
modules:
  - web/src/lib/utils.ts
  - web/src/lib/utils.test.ts
  - web/src/pages/health/SwimlaneTimeline.tsx
  - web/src/pages/activity/index.tsx
  - web/src/pages/conversation/ScheduledTaskSection.tsx
  - web/src/pages/conversation/ExecutionHistoryModal.tsx
  - web/src/pages/health/index.tsx
  - web/src/pages/health/RecurrenceCard.tsx
  - src/usecases/im/time-format.ts
  - src/usecases/im/assistant-session.ts
  - src/usecases/im/feishu-command-parser.ts
  - src/frameworks/db/schema.ts
tags:
  - timezone
  - ui
  - bugfix
  - format
---

# UI 时间展示统一化：修时区 bug + 格式收口

## 背景

搭档发现 UI 时间展示「既有时区又有 UTC、格式不一致」，全局梳理（工作区 time-display-audit-20260920.md）结论：
存储层统一无问题（7 张核心表全部 JS 侧 `new Date().toISOString()` UTC 带 Z 写入），问题全在渲染/出站层——
2 处时区真 bug + 5 种日期格式并存 + 1 处服务器时区依赖 + 1 处潜在地雷。

实现过程说明：本特性由两任时钟獭接力——mimo 版初稿的 SwimlaneTimeline 修复有严重缺陷
（`fmtTimeShort(t.toString())` 传 epoch 毫秒数字符串，`new Date("1789...")` 在 Node 实测为 Invalid Date，
label 会输出 "17898" 垃圾；其文档声称「已验证 Node.js 行为正确」与实测不符）。
glm 版保留其可用部分（utils/activity/ExecutionHistory/ScheduledTask/RecurrenceCard/schema 注释），
重写 A1/A2/C 修复与本文档。

## 变更

### A 类：时区 bug 修复（2 处）

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| A1 | `web/src/pages/health/SwimlaneTimeline.tsx` | `new Date(t).toISOString().slice(5,10)` 转 UTC 再切日期，CST 0:00-8:00 期间泳道轴标签显示**前一天** | epoch ms 先 `new Date(t).toISOString()` 转回 ISO，再走 `fmtTimeShort` 本地时区格式化，`.slice(0,5)` 取 MM-DD |
| A2 | `src/usecases/im/assistant-session.ts` | `toISOString().slice(0,16)` UTC 直出收篇摘要，用户看到的时间**差 8 小时** | 收口到 `fmtImTime`（显式 Asia/Shanghai） |

### B 类：格式收口（5 种 → 3 种标准形态）

**标准形态**：
1. **完整**：`YYYY-MM-DD HH:mm:ss`（`fmtTime`，对话流继续用）
2. **紧凑**：`MM-DD HH:mm`（新增 `fmtTimeShort`，台账/定时任务/健康面板用）
3. **相对时间**：现有 `fmtRelativeTime` 不动（#227「未来时间显示绝对时间」语义保持）

**替换点**：
- `activity/index.tsx:76` 本地 `fmtTime`（toLocaleString 2-digit，斜杠格式）→ 薄包装 `fmtTimeShort`
- `ScheduledTaskSection.tsx:23,106` toLocaleString numeric（无前导零）→ `fmtTimeShort`
- `ExecutionHistoryModal.tsx:95` 裸 toLocaleString（斜杠+秒）→ `fmtTime`（完整形态，执行历史需秒级排查）
- `health/index.tsx:376` fmtDate、`RecurrenceCard.tsx:43` fmtDay — 输入是纯日期串（snapshot_date/git date，无时间部分），保留切片但去掉 `.replace('-', '/')`，统一为 `MM-DD` 连字符格式
- 各页面删除本地定义，统一 import `../../lib/utils`

### C 类：服务器时区依赖修正

- `src/usecases/im/feishu-command-parser.ts:41` `toLocaleString('zh-CN')` 依赖服务器进程恰好跑在 Asia/Shanghai
  → 收口到 `fmtImTime`（`Intl.DateTimeFormat` 显式 `timeZone: 'Asia/Shanghai'`）
- 新增 `src/usecases/im/time-format.ts` 共享模块：A2/C 两处出站格式化单一真相源，
  与前端 utils 是不同运行环境的平行实现（前端跑用户浏览器本地时区即用户时区；backend 无法假定进程时区必须显式传）
- 位置在 usecases/im 而非 frameworks：两个消费者（assistant-session/feishu-command-parser）都在同目录，
  frameworks 导入需 eslint 依赖方向豁免（仅 logger/repo-root/stock 有先例），放 usecases 零摩擦

### D 类：地雷标注

- `src/frameworks/db/schema.ts` 头部注释声明时间戳双轨：实际写入走 JS 侧 `new Date().toISOString()`（UTC 带 Z）；
  DB `DEFAULT (datetime('now'))` 是兜底，若未来有路径依赖它会产生无 Z 的 UTC 串，前端 `new Date()` 会误当本地时间（8h 偏移）。不改 schema 行为。

## Verification（bugfix 失败证据链）

**修复前失败输出**（旧实现行为复现，TZ=Asia/Shanghai）：

```
A1 旧: new Date(t).toISOString().slice(5,10).replace("-","/") = 09/19  ← 实际本地日期 09-20，显示前一天
A2 旧: toISOString().slice(0,16).replace("T"," ") = 2026-09-20 06:30  ← Shanghai 应为 14:30，差 8 小时
```

**修复后输出**：A1 label 由 `fmtTimeShort(...).slice(0,5)` 生成（本地时区）；A2 `fmtImTime("2026-09-20T06:30:00Z") = 2026-09-20 14:30`。

**回归测试**：
- `tests/usecases/im/time-format.test.ts` 新增 7 用例：正常转换 / 跨日 +8 溢出 / 跨年 / **进程时区无关性**（TZ=America/New_York 与 TZ=UTC 下输出恒为 Shanghai 时间——C 类核心承诺）/ 空串 / 无效输入 / 时区常量
- `assistant-session.test.ts` 新增「收篇摘要时间戳为 Shanghai 非 UTC 直出」：断言 `[2026-09-19 14:30]` 出现且 `[2026-09-19 06:3` 不出现
- `feishu-command-parser.test.ts` 新增同款：UTC 10:00Z → `[2026-07-29 18:00]`
- `web/src/lib/utils.test.ts` fmtTimeShort 6 用例：空串 / 无效 / 常规 / 跨年 / **UTC 不被误当本地**（A1/A2 根因）/ **跨日边界**（UTC 15:00Z vs 16:00Z 标签必不同，A1 泳道轴验证）

**全量验证**：backend vitest 3685/3685 通过（首次全量时 ensure-hooks 1 例 5s 超时 flaky，单跑与复跑全绿，与本改动无关）；web vitest 501/501；backend/web `tsc --noEmit` rc=0；ESLint 0 errors（7 个存量 warning 均在非本次改动文件）。

## 已知边界

- `fmtImTime` 与前端 `fmtTime/fmtTimeShort` 是平行实现（backend/web 无共享模块层），格式语义对齐（分钟精度），注释互相引用。若未来出站点增多可再评估提升共享层级。
- `SwimlaneTimeline` 轴标签取 `fmtTimeShort(iso).slice(0,5)` 得 `MM-DD`——与 health 域其他纯日期切片（fmtDate/fmtDay）格式一致，但实现路径不同（前者过完整格式化，后者纯字符串切片）。纯日期串无时区转换需求，切片安全。
- D 类是注释级地雷标注，schema 行为未动——DB DEFAULT 产生无 Z 串的路径依然存在但无调用方。
