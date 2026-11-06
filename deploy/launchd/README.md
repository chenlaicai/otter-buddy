# otter-buddy 部署契约（launchd 单实例门闩）

## 背景

PR #1783（pi-durable 迁移）按搭档定调删除了会话文件锁（proper-lockfile）：
**会话单主人 = 运行环境责任，海獭系统不做锁**（#1791 契约条目）。

删除后防护矩阵重排：

| 防护层 | 责任方 | 机制 |
|---|---|---|
| 单实例（同数据域只有一个驱动进程） | **部署层（本配置）** | launchd Label 单实例保证 |
| 数据完整性 | 存储层（免费） | SQLite busy_timeout + WAL + pi-durable commit 一致性校验 |
| 进程内互斥 | 海獭系统 | SimpleLockManager（既有） |

## 设计边界（搭档 2026-11-06 定调，勿改）

- launchd **只做单实例门闩**，不做生命周期管理：
  - ❌ 无 RunAtLoad（开机不自启）
  - ❌ 无 KeepAlive（进程死不自动拉起）
  - ✅ 服务启停完全由用户手动控制
- 多环境 = 多数据域 = 多 Label：主服务 `ai.otter-buddy.main`、alpha `ai.otter-buddy.alpha`，互不隶属
- **配置就绪前勿对同一数据域双开进程**（两个不同数据域的进程共存是合法的，如 main + alpha）

## 文件

- `ai.otter-buddy.main.plist`——主服务（3000）
- `ai.otter-buddy.alpha.plist`——alpha 测试环境（3001，worktree 数据域）

## 安装（主服务为例）

```bash
cp deploy/launchd/ai.otter-buddy.main.plist ~/Library/LaunchAgents/
kill <现有 nohup 进程 PID>    # 先停手动进程，防双开
launchctl load ~/Library/LaunchAgents/ai.otter-buddy.main.plist
```

## 日常操作

```bash
launchctl kickstart gui/$(id -u)/ai.otter-buddy.main    # 启动
launchctl kill TERM gui/$(id -u)/ai.otter-buddy.main    # 停止（不会被拉起）
launchctl list | grep otter-buddy                        # 状态
```

双开验证：服务已运行时再 `kickstart`，launchd 不会创建第二个实例（同 Label 唯一性）。

## 迁移前状态

主服务此前为 nohup 手动启动（无进程管理器）。本配置落地即完成「部署前置项」
（PR #1783 特性文档「单主人与部署前置」节所述）。
