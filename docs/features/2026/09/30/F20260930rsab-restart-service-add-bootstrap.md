---
id: F20260930rsab
title: restart-service 兜底正道（--add 现场声明）
summary: 白名单缺失/端口未声明时 --add 现场声明写回，修复「守卫拦截后正道死路」的最后一公里（#1069）
change_type: fix
capability_test: "n/a: 脚本纯逻辑（resolvePortEntry）+ 守卫文案，真 sqlite/LLM 行为面均不涉；9 用例单测 + 4 场景手工冒烟覆盖"
intent:
  problem: "#844 修复闭环停在代码落地：restart-service.mjs 硬依赖搭档手动创建 allowed-service-ports.json，文件未建期间（#1069 提报时 9 天）同模式拦截复发 4 次——獭被拦后守卫指给的「正道」本身走不通，正当诉求无出路。"
  expected_effect: "白名单缺失或端口未声明时，獭可用 --project + --add 一次调用完成「声明写回 + 受控重启」；拦截文案同步指路；主进程防线（PID 恒拒 + cwd 归属校验）零松动。30 天内同模式拦截归零或 restart-service 至少被真实使用 1 次（issue 断言）。"
  verify_by:
    type: static_only
    reason: "脚本参数解析/白名单写回为确定性文件 IO，9 用例单测（tmp 目录驱动）+ 4 场景真跑冒烟（worktree 沙箱内 --add 全链路）固化；拦截文案为静态字符串拼接由 tsc/回归保障；行为面（獭实际是否走正道）由 issue #1069 验证断言到期回查（2026-10-21，healing guard_intercept 计数 + ls 白名单）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [bash-guard, devserver, whitelist, restart-service, healing, daily-review]
modules: [scripts/, src/frameworks/agent/]
from: ["F20260914dsrv"]
causal_links: ["#1069", "#844"]
created_at: 2026-09-30
---

# restart-service 兜底正道（--add 现场声明）

## 问题（#1069）

#844 的修复含 scripts/restart-service.mjs 受控脚本（9/15 落地）+ `.otter/allowed-service-ports.json` 白名单，但白名单依赖搭档手动创建。issue 提报时（9/21 00:39）文件不存在，「正道存在但走不通」——9/20 同模式拦截复发 4 条（healing efd853f8/8774868c/7cfcdcd2/76af6ee1，獭 52cdde02 六小时被拦 4 次）。

**现场核实更新（9/30 开工时）**：白名单文件 9/21 21:33 已被创建（晚于 issue 提报 21 小时），但只声明了 colink 项目（3001/5173）——对非白名单端口的正当重启诉求，正道仍是死路：守卫拦截文案指给 restart-service，脚本对未声明端口硬性 die，獭无自助出路，只能继续被拦。

## 方案设计（issue 推荐方案 a）

`restart-service.mjs <port> --project /abs/path --add`——端口未声明时把目录声明写回白名单，随后自动走原校验链执行重启。一次调用完成「声明 + 重启」，不依赖搭档手动创建。

### 改动清单（3 文件）

1. **scripts/restart-service.mjs**：
   - 抽出 `resolvePortEntry({port, projectDir, add, whitelistPath})` 纯函数并导出（lint-date-bombs 先例：脚本导出函数供单测 import）；主流程用 main-guard（`import.meta.url === pathToFileURL(process.argv[1])`）包裹，被测试 import 不触发执行
   - 白名单缺失/端口未声明 + 无 --add → 拒绝但错误信息给两条正道（搭档编辑 / --add 现场声明）
   - --add + --project → 写回白名单（保留既有 entries）后继续原校验链
   - 损坏 JSON 一律拒绝（--add 不覆盖搭档待修配置）
2. **src/frameworks/agent/circuit-breaker-helpers.ts**：守卫拦截文案两分支同步——已配置分支补「端口未声明的可用 --add 现场声明」；未配置分支把「请搭档创建」降为第二选项，首选 --add 自助路径
3. **tests/scripts/restart-service-resolve.test.ts**（新增）：9 用例覆盖声明解析全分支

### 安全面论证（不稀释 #844 契约）

`--add` 只解决「声明怎么来的」，不松动任何终止校验：

- **白名单不是安全边界，cwd 校验才是**（#844 原设计）：即使獭把任意端口 --add 进白名单，能终止的仍只有「lsof 解析 cwd 在声明目录下」的进程
- **主进程恒拒**：PID === .otter-buddy.pid 纵深防御在 --add 路径原样执行（校验 ② 在声明解析之后、终止之前，无旁路）
- **--project 必填约束**：--add 必须显式给出项目目录（拒绝裸 --add），声明是明确动作不是默认行为
- **不可逆操作防护**：损坏 JSON 不覆盖（搭档待修配置不丢）；写回保留既有 entries（append-only）

## 设计取舍记录（机制判定）

本次不新增机制：--add 是既有受控脚本的参数扩展，校验链（①白名单 ②主进程 PID ③cwd 归属）结构不变，只是「① 的来源」多了自助路径。Modification-Class: narrow-fix。

### Why（未选替代方案）

- **b（大獭替搭档创建配置模板）**：只解 colink 一家，下个新项目端口又死路——治标；且「大獭替搭档配置」角色错位（白名单是搭档对所有权重启范围的授权面）。已在现场核实中确认白名单 9/21 已建但仍复发——证明 b 不可持续。
- **c（维持现状）**：issue 实证 6h 被拦 4 次的损耗不可接受。
- **守卫直接放行变量形态终止**：不动守卫铁拦（kill 族形态拦截是 #844 的安全底座），正道加固而非铁拦开口。

## 验证

### 测试证据

- **单测**（tests/scripts/restart-service-resolve.test.ts，9 用例）：已声明直取/不一致拒绝/缺失+无 add 拒绝含两正道且不偷偷创建/缺失+add 从空创建写回/未声明+add 保留既有 entries/未声明无 add 拒绝含白名单现状/add 缺 project 拒绝/损坏 JSON 不覆盖原文/main-guard 导入面——全过
- **回归**：tests/frameworks/agent/allowed-service-ports.test.ts 23 用例全过（守卫放行判定 + 升级判定零回归）
- **真跑冒烟**（worktree 沙箱）：无参 usage 引导 ✓ / 白名单缺失拒绝+两正道 ✓ / 8123 --add 写回→无监听 exit 0 ✓ / 二次调用免 --add 直达 ✓（测试痕迹已清理）
- **tsc**：0 新增错误（narrow 变更面）

### Golden Gate

Golden Gate: n/a（verify_by=static_only。改动为脚本参数解析 + 守卫文案字符串，无 prompt/skill/协议层行为触发语义变更；无 golden_replay 场景可跑。行为面由 issue #1069 验证断言到期回查。）

### 验证断言（issue #1069 回查口径）

断言：修复后 30 天内同模式（非字面量 PID 终止）guard_intercept healing 事件归零，或 allowed-service-ports.json 存在且 restart-service.mjs 至少被使用 1 次。检查：sqlite healing_events 计数 + ls .otter/ + 白名单 entries 增长记录。到期 2026-10-21。

## 后续动作

- PR 合入后观察下一波 dev server 重启诉求是否走 --add 正道（healing guard_intercept 计数应下降）
- issue #1069 随 PR closes；#844 原始修复文档（F20260914dsrv）不再回改——本文档 from 链已建立谱系
