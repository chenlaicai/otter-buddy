# 跨项目服务生命周期管理设计

## 问题

otter-buddy 的 alpha 隔离机制（端口宪法 + 锁文件 + 独立数据根）只解决了单项目内的问题。实证显示，同样的「worktree 起 detached 进程无人收」模式在多个项目重复发生：

- **otter-buddy**：10/13 抓到悬空实例 21577（cwd 指向已删目录）
- **colink**：dm-forward worktree 下两只 detached 实例（PID 18239/18240 backend + 90123/90124 frontend），PPID=1 已脱离终端

每个项目各自为战，重复造轮子，且都有「无全局兜底」的盲区。

## 目标

设计一套跨项目通用的服务生命周期管理机制，让「开了有人记得，关了有级联」成为默认行为，而不是每个项目各自实现的可选特性。

## 核心原则

1. **端口宪法**：每个项目显式声明「主服务端口」与「worktree 隔离段」，机械闸强制
2. **锁文件即登记**：所有 detached 启动必须写锁文件，零登记 = 违规
3. **全局 sweep 兜底**：跨项目扫描「无锁文件 + cwd 属于已删 worktree」= 孤儿
4. **生命周期闭环**：创建即登记、销毁有级联、异常有兜底

## 方案分层

### L0：项目内机械闸（单项目自闭环）

每个项目实现：
- 启动脚本硬校验：worktree 场景禁止默认主服务端口
- 隔离启动器：自动分配隔离段端口 + 写锁文件 + 独立数据根
- 停止脚本：只杀自己 worktree 的实例（杀伐校验）

**otter-buddy 现状**：alpha.sh + otter-buddy.sh 机械闸（本次修法 1/2 落地）

### L1：项目内全局兜底（单项目有保险）

每个项目实现：
- `sweep` 子命令：扫描「无锁文件 + cwd 属于已删 worktree」的孤儿
- 默认只报告，`--kill` 才执行清理
- `start` 前置自动 sweep：发现孤儿拒绝启动

**otter-buddy 现状**：alpha.sh sweep（本次修法 1 落地）

### L2：跨项目统一工具（一次实现，多项目复用）

**核心抽象**：`service-lifecycle.toml` 配置文件

```toml
[project]
name = "otter-buddy"
main_port = 3000
alpha_port_range = [3100, 3198, 2]  # min, max, step
worktree_pattern = ".otter/worktrees/*"
lock_file_name = ".otter-alpha.json"
process_pattern = "dist/src/main.js"

[project]
name = "colink"
main_port = 3001
alpha_port_range = [3200, 3298, 2]
worktree_pattern = ".otter/worktrees/*"
lock_file_name = ".colink-alpha.json"
process_pattern = "dev/backend"
```

**工具命令**：
```bash
# 扫描所有注册项目的孤儿
service-lifecycle sweep

# 扫描指定项目
service-lifecycle sweep --project otter-buddy

# 清理（默认只报告）
service-lifecycle sweep --kill

# 注册新项目
service-lifecycle register /path/to/project

# 系统级看门狗（launchd/cron 定时跑）
service-lifecycle watchdog --interval 300
```

### L3：系统级看门狗（可选，无人值守兜底）

- launchd plist（macOS）或 systemd timer（Linux）定时跑 `service-lifecycle sweep --kill`
- 或：报告模式 + 通知（发现孤儿时发消息给搭档，由人决策）

**风险**：自动杀进程可能误杀（如搭档手工起的调试实例），默认应只报告。

## 迁移路径

1. **Phase 1**（本次）：otter-buddy 落地 L0 + L1，验证机制有效
2. **Phase 2**：抽象 `service-lifecycle.toml` 配置格式，把 otter-buddy 的 sweep 逻辑泛化成独立工具
3. **Phase 3**：colink 等其他项目接入，验证跨项目通用性
4. **Phase 4**（可选）：系统级看门狗

## 开放问题

1. **配置发现机制**：工具如何知道哪些项目注册了？（扫描固定目录 / 全局配置文件 / 环境变量）
2. **锁文件格式标准化**：不同项目的锁文件字段是否统一？（PID / 端口 / 项目根 / worktree 路径 / 启动时间）
3. **孤儿判据的跨项目泛化**：「cwd 属于已删 worktree」的判据是否适用于所有项目？（如有些项目 worktree 不在 `.otter/worktrees/` 下）
4. **误杀防护**：自动清理时如何区分「孤儿」与「搭档手工起的调试实例」？（锁文件时间戳 / 交互确认 / 白名单）

## 参考

- otter-buddy alpha.sh：单项目 L0 + L1 实现（本次修法落地）
- tutu-vessel alpha.sh：端口宪法 + 锁文件 + 独立数据根的原始设计
- F20260917alph：otter-buddy alpha 隔离特性
- F20261005clup：合入清理补进程生命周期闭环
