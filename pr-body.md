Driver: conversation=b4e05359

## Summary

将主 AgentGateway 的推理/session 持久化切换到 pi-durable 1.5.0 原生 Harness；保留 otter 对话、调度、matters/signals/yield 与审批领域，不保留 coding-agent 执行 fallback 或双恢复。

## Why

搭档明确要求迁移到 durable；目标是长期运行与可恢复 checkpoint，同时保持单 owner 和工具副作用边界。

## What Changed

- durable SQLite session store、registry、watch→现有流式事件、prompt/steer/followUp/abort、usage/compaction 适配。
- 所有 otter/MCP 工具 `replay:"unsafe"`；invokeId 缺失拒绝副作用。会话单主人归部署层（锁已删，见「单主人与部署前置」）。
- MCP 使用公开 pi-mcp client；旧 JSONL 仅作历史交接只读切片；reset 创建新 durable 世代。
- 删除旧 coding-agent JSONL 恢复实现与 1.1.0 私有 patch；统一 pi 1.5.0 依赖。
- 特性文档：`F20261109pidrx`。

### 单主人与部署前置（2026-11-06 搭档定调：锁移除）

- proper-lockfile 会话文件锁全链路移除（commit eb43a189，含 60s stale 误拦边角）；单实例由部署层保证（launchd/systemd Label 单实例 + 崩溃重启退避），数据完整性由 sqlite busy_timeout + pi-durable commit 一致性校验兜底。
- ⚠️ **部署前置项**：主服务 launchd/systemd 单实例配置尚未落地（当前 nohup 裸跑），配置就绪前勿对同一数据域双开；此项属合并后运行环境配置（#1791 契约条目：会话单主人=运行环境责任）。
- alpha 实测（删锁后）：SIGKILL 后 8 秒极速重启，中断 resume 直接成功（25s settle done）——原 stale 窗口误拦边角消失。

## Affected Areas

- [x] `src/*`
- [x] `tests/*`
- [x] Configuration or build tooling
- [x] Documentation

## 证据分层声明

- **机器锚点**：commit `7b60f0c7a3c242be0d04158ca45374419c3913fc`；CI run `41982803965`；本地 lint/build/全量测试输出见 Verification。
- **agent 陈述（未复验）**：真实外部 provider、生产/alpha 切换、MCP OAuth 与动态 extension 未验证；未进行独立对抗审视。

## Verification

### 机器锚点

- Commit: `7b60f0c7a3c242be0d04158ca45374419c3913fc`
- `npm run lint`：通过（0 errors；存量 3 warnings）。
- `npm run build`：通过；durable 1.5.0 安装校验通过。
- `npm test -- --reporter=dot`：432 files / 5681 tests 通过。
- 主链专项：59 files / 732 tests 通过。
- durable 专项：13 tests 通过，含真实 stdio MCP server、retry/compaction、abort/steer/followUp、unsafe replay、同 session 多轮 invoke。
- 真实进程 SIGKILL：工具执行一次后被杀，重启后 reopen，副作用仍为 1 次；checkpoint 可读（alpha 实测：删锁后 8s 快速重启 resume 直接成功）。
- `git diff --check`：通过。

### agent 陈述（未复验）

- 未运行真实外部 LLM provider，不能宣称生产 provider 兼容已验证。
- 未启动生产服务或 alpha 实例，未修改生产 DB。
- MCP OAuth 自动登录、动态 extension 注册未验证；不要把本 PR 描述为全量资源能力已完全覆盖。
- 未进行独立对抗审视；本 PR 由实现者提交，需大獭编排检视。

## Risks

- pi-durable 1.5.0 为 Experimental；真实 provider、生产切流与动态 extension 兼容仍需独立验证。
- durable checkpoint 与 otter invoke 恢复必须保持单 owner；禁止未来同时启用旧 JSONL resume 与 durable 自动 replay。
- 工具 unsafe replay 是副作用安全前提，不可改为默认 safe。

## Rollback

Revert PR commit `7b60f0c7`；恢复旧 runtime 代码与依赖。不要删除或覆盖旧 JSONL 档案；新 durable store 仅作审计保留。

## Discovered Issues

无。

## 测试改动声明

方向：收紧
理由：删除旧 SessionManager 恢复与私有 patch 测试，迁移为 durable 公开行为、真实 MCP 与进程 crash 验证；主链与全量回归均通过。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by Durable迁移獭
