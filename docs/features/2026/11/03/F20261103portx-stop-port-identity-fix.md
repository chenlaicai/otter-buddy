---
id: F20261103portx
title: stop 误报浏览器进程三连修：LISTEN 过滤 + 监听者身份识别 + 未验证断言中性化
summary: 2026-11-02 搭档重启系统时 otter-buddy.sh stop 误报「another worktree's Otter Buddy (PID 970)」并建议 kill 970——实际 970 是 Safari 网络进程（与 3000 的客户端连接），主服务 63397 健康在跑。三层根因：采集层 lsof 无 LISTEN 过滤（#375 引入）、身份层 PID 文件缺失时 stop 认不出主进程、推断层对未验证身份的 PID 直接断言 worktree 实例。本次三层同修。
change_type: fix
capability_test: tests/scripts/port-identity.test.sh
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [scripts, port, stop, lsof]
modules: [scripts]
created_at: 2026-11-03

intent:
  problem: "stop 脚本误把无关的浏览器进程当服务进程杀：端口表只查 LISTEN 未核监听者身份，跨进程误报"
  expected_effect: "含 LISTEN 过滤+监听者身份识别后，stop 只终止确认属于本服务的进程；浏览器等无关进程不受影响，回归测试接入 pre-commit 与 CI"
  verify_by:
    type: behavior_check
---

# F20261103portx：stop 误报浏览器进程三连修

## 事故现场（2026-11-02 21:32）

搭档执行 `scripts/otter-buddy.sh stop` 想重启系统升级代码，得到：

```
[warn] Port 3000 is in use by another process (PID 970)
       This is likely another worktree's Otter Buddy.
       Stop it from that worktree, or run:  kill 970
```

实测排查（fact f1b848d1-4446-4de2-8f7c-8de6232e6ea2）：

| 对象 | 事实 |
|---|---|
| PID 970 | com.apple.WebKit.Networking（Safari 网络服务，10/30 启动），与 3000 有 2 条 ESTABLISHED 客户端连接（搭档用 Safari 开着海獭页面） |
| PID 63397 | node dist/src/main.js，cwd=主仓，LISTEN *:3000，PPID=1——**这才是主服务**，健康在跑 |
| .otter-buddy.pid | 不存在（删除轨迹不可考，见「遗留问题」） |

照建议 `kill 970` 会杀掉 Safari 网络进程，海獭毫发无损地继续占着 3000。

## 根因（三层）

1. **采集层**：`port_owner_pid()` 用 `lsof -ti:"$1" | head -1`（otter-buddy.sh:76-78，#375 引入）——无 `-sTCP:LISTEN` 过滤，返回「与端口有任意 TCP 关系的进程」，Safari 的客户端连接条目恰好排在监听者前面。同文件 :169-170 的杀伐校验（F20260831aksp T1）用的却是正确写法——同一端口问题两种口径，本 PR 对齐。
2. **身份层**：PID 文件缺失时 stop/start/status 完全不认识主进程——健康主服务仅因文件缺失被当「外人」。
3. **推断层**：对未经身份验证的任意 PID 直接断言「likely another worktree's Otter Buddy」并给 kill 指令。

## 修复（三层同修）

- **采集层**：`port_owner_pid` 加 `-sTCP:LISTEN`（与杀伐校验口径对齐）
- **身份层**：新增 `listener_class()` 三分类——node 特征（`^node` 或 `*dist/src/main.js*`）+ cwd 判定：cwd=本仓 → `main-service`；node 特征但 cwd 异 → `otter-or-node`；无 node 特征 → `foreign`
- **推断层**：`report_port_occupant()` 分类报告——kill 建议只给身份验证过的分支；foreign 分支明确「It is NOT an Otter Buddy instance — verify before killing」；stop/status 识别 main-service 后如实报「appears to be running but PID file is missing」

行为变化：stop 无 PID 文件 + 监听者=本仓 node 时不再报「another worktree」，改报主服务识别结果并给重启指引（`kill <pid> && start`）——主进程仍需手动 kill（PID 文件缺失时拒绝代杀是 F20260831aksp 的安全边界，保持不变）。

## 设计取舍

**机制识别检查点判定**（七项清单逐项）：新增配置字段/状态生命周期/定时任务/信号类型/持久化存储/被记住的决策分支/跨模块调用路径——**全部未命中**。`listener_class`/`report_port_occupant` 是纯运行时临时分支（每次调用现查 ps/lsof，不落盘不缓存），修法决策树①既有语义内修（stop 本来就该认识自己的主进程、本来就该报真正的占用者），`Modification-Class: narrow-fix`。

- 为什么 stop 不代杀无 PID 文件的主进程：F20260831aksp 杀伐校验的信任根是 PID 文件，绕过它代杀会打开「端口上任何 node 进程都可被 stop 杀掉」的新攻击面。给出现状+指引、人来按，是安全边界内的最大改善。
- 为什么不修「PID 文件为什么会丢」：删除轨迹磁盘上不可考（日志无时间戳、文件删除无审计）。根治需要 PID 文件生命周期审计，属独立机制新增（决策树④），超出本次 narrow-fix 边界——记录为遗留问题，不打着治本旗号顺手加机制。
- 修主服务识别为什么用 cwd+命令特征双因子：单看命令（node）会把任何 node 进程当海獭；单看 cwd 查不动非 node 进程。双因子是 foreign 误判（杀 Safari 建议）与漏判（认不出主服务）之间的平衡点。

## 验证

### 失败证据链（修复前 → 修复后，bugfix 硬规则）

对照脚本：`git show origin/main:scripts/otter-buddy.sh` 提取为 `/tmp/otter-buddy-old.sh`。

**修复前**（场景B 完整复现事故形态——无 PID 文件 + 本仓 node 监听 3458）：

```
FAIL: 场景B: 应认出主服务（appears to be running），实得: [warn] Port 3458 is in use by another process (PID 45684)
       This is likely another worktree's Otter Buddy.
       Stop it from that worktree, or run:  kill 45684
```

**修复后**（三场景全过）：

```
PASS: 场景A: 占用者=监听者（PID 45706），客户端 45742 未被选中
PASS: 场景B: 无 PID 文件时认出主服务（PID 45814），不再误报另一实例
PASS: 场景C: foreign 占用者如实报告，无未验证断言
ALL PASS: 端口占用者身份识别三场景全部通过
```

场景A 说明：lsof 按 PID 升序输出，本测试客户端 PID 恰大于监听者，故旧版在场景A上偶发通过（对旧版非稳定复现器）；场景B 才是事故忠实复现（无论 lsof 顺序，旧版必然落入未验证断言分支）。场景A 的价值是防新版将来丢掉 LISTEN 过滤。

### 最简实现检查

已过。全程用 lsof/ps 既有工具，零新依赖零配置；`listener_class` 用 shell case 模式匹配实现命令特征判定，无更少代码路径（等价实现仍是「取 command → 匹配 → 查 cwd」三步）。

### Golden Gate / Intent 块 / 锚点重放

均 n/a：本变更不涉及 prompt/skill/协议层（纯运维 shell 脚本），golden 无对应场景可跑；无行为触发语义改动，锚点重放豁免。

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 监听者+客户端并存 | `bash tests/scripts/port-identity.test.sh` 场景A | 占用者=监听者 PID，客户端 PID 不出现 |
| 无 PID 文件+本仓 node 监听 | 同上场景B（`stop -p <port>`） | exit 1 + 「appears to be running」+「PID file is missing」，无「another worktree」 |
| 非 Otter 进程占端口 | 同上场景C（`status -p <port>`） | 「non-Otter process」+ 命令行，无 worktree 断言、无裸 kill 建议 |
| 既有放行路径不回归 | `npm run test:script-arg-parse` | 全过（修复未碰解析循环） |
| 语法 | `bash -n scripts/otter-buddy.sh` | 0 |

## 遗留问题（不本次修）

1. **PID 文件生命周期无审计**：63397 的 `.otter-buddy.pid` 如何消失不可考。根治需文件生命周期审计机制（决策树④，须重对抗门）。当下缓解：本次修复后「PID 文件缺失 + 主服务在跑」的现场会如实报告而非误导。
2. **stop 的 PID 文件信任根**：无 PID 文件时 stop 仍不能安全停主进程（需手动 kill）。属 F20260831aksp 安全边界的既有语义，非本次回归。
