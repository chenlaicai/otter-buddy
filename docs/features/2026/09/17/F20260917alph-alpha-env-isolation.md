---
id: F20260917alph
title: alpha 验证环境隔离：worktree 独立实例 + 端口宪法 + detached 启动纪律
summary: 吸收 tutu-vessel alpha.sh 的结构隔离哲学（9/17 搭档指令「学习吸纳进来，直接作为特性优化海獭系统」）——agent 验证环境与活运行时在端口/数据/PID 三维不相交，自杀从「发生了被拦截」升级为「结构上不可能」。三件套：新增 scripts/alpha.sh（worktree 隔离实例管理，端口宪法 3000 主 / 3100-3198 验证段避让白名单，独立数据根经 --config 指定，main.ts 补 argv 解析）、detached-launch.mjs（机器通道纪律：裸 PID + ANSI 剥离，治半启动孤儿）、守卫拦截文案升级（组合杀形态现状已拦——INDIRECT_PID_PATTERNS 保守策略，本期把文案从不引导升级为指向 alpha.sh）。
change_type: feature
created_in_conversation: 6be5479d-3828-4a18-945a-dc7643d8d306
tags: [alpha-isolation, port-constitution, bash-guard, detached-launch, tutu-absorption, worktree]
intent:
  problem: "海獭验证代码的唯一路径是动活运行时（9/16 獭 7708a033 restart 杀主进程 31385）；现有防线是拦截式守卫（缩小攻击面），攻击面本身仍在"
  expected_effect: "海獭在 worktree 里一条命令拉起隔离验证实例（独立端口+独立数据），永远不碰 3000；守卫拦截主进程相关命令时引导文案指向 alpha.sh"
  verify_by:
    type: behavior_check
    detail: "在任意 worktree 跑 scripts/alpha.sh start 得到 3100+ 段隔离实例（独立数据根）；alpha.sh stop 只停自己；守卫拦截 'kill $(lsof -ti :3000)' 形态；全量测试通过"
modules: [scripts/alpha.sh, scripts/detached-launch.mjs, scripts/otter-buddy.sh, src/frameworks/agent/bash-safety-guard.ts, src/frameworks/agent/pi-session-factory.ts, src/main.ts, .pi/skills/worktree-isolation/SKILL.md, README.md, tests/frameworks/agent/bash-safety-guard.test.ts]
created_at: 2026-09-17
capability_test: "n/a: 本提交为特性方案文档（requirement-analysis 产出），行为类验证设计见正文「验证」表——实现 PR 交付时补 golden/行为测试路径"
---

> **修订史**：2026-09-17 初稿 → 同日经检视獭-alpha（glm）对抗审视两轮收敛。初轮 8 条（4 严重 4 建议）全接受：T2/T4 重定位（组合杀现状已拦，改为文案升级）、--config 声明诚实化（main.ts 需 +argv 解析）、端口段加白名单避让、embedding.localModelPath 绝对路径改写、槽位数 40→50、stale-lock 用例、生效面声明。delta 轮 3 条（1 严重 2 建议）全接受：alpha 端口组合杀验证表修正为「现状拦截、正道 alpha.sh stop」（守卫不加放行逻辑）、frontmatter summary/intent 三处同步、取舍表孤行改写。

# alpha 验证环境隔离：worktree 独立实例 + 端口宪法 + detached 启动纪律

## 背景

搭档原话（意图锚，按时间序）：

> 「你去学习下tutu项目（之前应该提过），作者说他从来没遇到过 "自己杀自己 和启动不了"的问题，然后他说可能是因为他的alpha.sh脚本」

> 「本次我更想你来学习吸纳进来，直接作为特性来优化咱们海獭系统」

学习结论（2026-09-17 精读 `/tmp/tutu-vessel` 源码，scripts/alpha.sh:1-414 + AGENTS.md:44-79 + detached-launch.mjs）：tutu 作者「从不自杀、从不启动不了」不是运气，是五个机制从物理上删掉两类故障的可能：

1. **端口宪法**（AGENTS.md）：API 端口三段分治 dev 7700 / test 7710 / alpha 7720-7798；文本禁令原话 *"Never stop, kill, restart, or seize it — not by PID, not by `kill $(lsof -ti :7700)`… If a port is busy, that is the answer: do not clear it."*
2. **结构隔离**：每 worktree 独立数据根 `~/.vessel-alpha-{hash}`，agent 环境与活运行时端口/数据/PID 三维不相交——自杀在结构上不可能，杀得到的全是自己的
3. **哲学翻转**：agent 只在自己的 alpha 里折腾，永远不碰活运行时——消灭攻击面，而非缩小攻击面
4. **机器通道纪律**：detached-launch.mjs stdout 只写裸 PID（血泪注释：FORCE_COLOR 下 console.log 给 PID 包 ANSI 码，之后所有 `kill -0` 打偏→误报死→孤儿占端口）
5. **每条失败路径清理现场**：端口等待 fail-fast、前端起不来回头杀 API——半启动状态不存活成无锁文件孤儿

历史脉络（search_memory 命中，实质影响本方案）：

- R20260821supp（8/24）已有结论「AI 碰活运行时必须物理隔离：alpha 环境 + 端口宪法是 tutu 不自爆的关键」——本特性是该结论的落地
- F20260916gsrd → F20260916gtlr（9/16）：事故后两层封堵已收敛为「拦截归于 tool 层守卫，脚本回归纯工具」。本特性遵守该架构决策——守卫层只改文案与注释，不往脚本里塞防海獭逻辑
- F20260914dsrv（9/14）：端口白名单 + restart-service.mjs 受控执行已是半个端口宪法，本特性把宪法补全

## 目标

T1: worktree 隔离验证实例——任意 worktree 内 `scripts/alpha.sh start` 一条命令拉起独立实例（3100-3198 偶数段端口 + 独立数据根），`stop` 只停自己，「启动不了」类故障 fail-fast 且不留孤儿

T2: 端口宪法落成文本与机制——README 端口分配表（3000 主 / 3100-3198 验证段，避让白名单已声明端口），守卫拦截主进程时引导文案指向 alpha.sh

T3: detached 启动纪律——机器通道（stdout 裸 PID + ANSI 剥离校验）+ 半启动清理，消灭「进程活着但管不到」的孤儿形态

T4: 守卫拦截文案升级——组合杀形态（`kill $(lsof -ti :3000)`、管道 xargs kill）现状已被 INDIRECT_PID_PATTERNS 保守拦截（bash-safety-guard.ts:66-70，9/17 检视实证五种形态全触发），但文案只说「无法判断」不引导到 alpha.sh；本期把拦截文案与 9/16 gsrd 引导文案统一升级为指向 alpha.sh，守卫注释记录 3100-3198 为 alpha 语义段（放行仍走白名单机制，注释防未来增强误伤）

## 非目标

- 不动主服务启动方式（搭档的 `otter-buddy.sh start` 3000 端口流程零变化）
- 不做 agent 自动拉起 alpha（本期只提供脚本 + skill 引导；自动生命周期管理是后续候选）
- 不改 bash 守卫的拦截架构（遵守 F20260916gtlr 收敛决策：拦截在 tool 层，不在脚本层加防海獭逻辑）
- 不做多实例并行调度（同一 worktree 同时只允许一个 alpha，与 tutu 一致）
- 不引入 Docker/容器级隔离（与 tutu 的非目标一致，进程级隔离已够）

## 方案设计

### 一、端口宪法

| 环境 | 端口 | 数据 | 谁碰 |
|---|---|---|---|
| 主服务 | 3000 | 主仓 config.yaml `./otter-buddy.db` | 只有搭档 |
| alpha 验证 | 3100-3198 偶数（hash 建议 + 冲突顺延 + 白名单避让） | `~/.otter/alpha/<hash>/` | 獭自管，无需许可 |

README 新增端口分配表 + 禁令文本（借鉴 tutu AGENTS.md 措辞）：「端口被占就是答案，不要清它」。

**生效面声明**：宪法文本写 README 只对搭档可见——海獭的生效面 = 守卫拦截/引导文案 + worktree-isolation skill 指引（README 不在任何海獭注入链上）。tutu 宪法写 AGENTS.md 是因 agent 上下文自动注入该文件；otter 无等价注入面，不为此动 SYSTEM.md（增长纪律）。**端口段与白名单的交互**：3100 是 dongbeicun dev server 的实际端口（F20260914dsrv，白名单机制标准示例）。alpha.sh start 分配端口时必须读 `.otter/allowed-service-ports.json` 跳过已声明端口——否则白名单放行会混淆「杀 alpha」与「杀 dongbeicun」语义，restart-service.mjs 也可能撞上 alpha 实例。

### 二、scripts/alpha.sh（新增，核心交付）

借鉴 tutu alpha.sh 结构，适配 otter 差异（单进程、config 文件指定数据路径）：

```bash
scripts/alpha.sh start [--port PORT] [--quick]
scripts/alpha.sh status
scripts/alpha.sh stop
```

机制清单：

- **worktree 身份**：`git rev-parse --show-toplevel` → sha256 前 8 位作 hash
- **端口分配**：默认 `3100 + (hash 十进制 % 50) * 2`（确定性、同 worktree 稳定；3100-3198 偶数共 50 槽）；被占则 +2 顺延探测；**探测前读 `.otter/allowed-service-ports.json`，跳过白名单已声明端口**；`--port` 显式指定时强制偶数、在 3100-3198 段内且不在白名单内
- **隔离数据根**：生成 `~/.otter/alpha/<hash>/config.yaml`（从主仓 config.yaml 复制，改写三字段：`server.port`、`database.path: ~/.otter/alpha/<hash>/otter-buddy.db`、`embedding.localModelPath: <主仓 models 绝对路径>`——localModelPath 按 cwd 解析（embedding-env-config.ts:44-48），不改写则 alpha 从 worktree 启动时解析到 `<worktree>/models`，触发 ensure-model 重新下载 bge-m3 ~2GB 到每个 worktree），启动命令 `node dist/src/main.js --config <路径>`
- **main.ts 新增 argv 解析**（约 5-10 行）：现状 main.ts 是薄 shim 无参数解析（9/17 检视核验：全 src grep `--config|process.argv` 零命中），`buildApp({ configPath })` 程序内接口已存在（app.ts:86-87），只需 main.ts 暴露到 CLI
- **锁文件**：`<worktree>/.otter-alpha.json`（gitignored）：pid / port / config / log / worktree / created_at
- **stale-lock 处理**（对齐 tutu cmd_start:190-207）：锁文件存在但 PID 已死 → 清理残留孤儿进程（锁文件记录的其他 PID 逐一探测）+ 删锁文件后继续启动流程
- **启动**：build（`--quick` 跳过但 dist 缺失时兜底）→ `scripts/detached-launch.mjs` 全分离启动（survive 獭 shell 退出）→ 健康检查 `curl /api/settings` fail-fast（进程死了立刻返回不傻等）→ 任何失败路径 `stop_process_tree` 清理（TERM 1s→KILL，杀子进程树）
- **stop**：读锁文件 → 校验 PID 确是该端口监听者（沿用 otter-buddy.sh F20260831aksp T1 杀伐校验）→ 进程树 TERM→KILL → 删锁文件

### 三、scripts/detached-launch.mjs（新增，抄 tutu 作业）

```bash
node scripts/detached-launch.mjs <logFile> <cmd> [args...]
```

- `spawn(cmd, { detached: true, stdio: ['ignore', fd, fd] })` + `unref()` + 立即退出
- **stdout 机器通道纪律**：`process.stdout.write(\`${child.pid}\n\`)`——裸数字，不走 console.log（FORCE_COLOR ANSI 污染教训，tutu 注释实证）
- alpha.sh 侧 `read_launcher_pid`：sed 剥 ANSI + 正则校验，拿不到 PID 即失败

### 四、守卫文案升级 + alpha 段语义声明

现状防线（9/16 后，9/17 检视实证核验）：

| 形态 | 现状 |
|---|---|
| `kill <主PID>` 字面量 | ✅ 拦（PID 文件比对） |
| `otter-buddy.sh stop/restart`（主仓路径） | ✅ 拦（F20260916gsrd） |
| `pkill -f otter` 特征名 | ✅ 拦 |
| `kill $(lsof -ti :3000)` | ✅ **已拦**（INDIRECT_PID_PATTERNS `\$[{(]` 命中命令替换，bash-safety-guard.ts:66）——但文案只说「无法判断是否针对主进程」，不引导 |
| `lsof -ti :3000 \| xargs kill` | ✅ **已拦**（管道+xargs 模式，:69-70）——同上，文案不引导 |

（检视獭实证：五种组合杀形态全部触发拦截，守卫「非字面量即保守拦」策略覆盖了方案原以为的漏洞。）

本期改动（文案与声明，不加识别机制）：

1. 主进程相关拦截的引导文案统一指向 alpha.sh：「需验证代码变更：在 worktree 内跑 `scripts/alpha.sh start` 起隔离实例（3100+ 端口、独立数据）；主服务是海獭运行环境本身，任何形态不得终止」——含 INDIRECT_PID 拦截、9/16 gsrd 脚本拦截两处文案
2. 守卫注释记录 3100-3198 为 alpha 语义段——**仅注释声明，不加放行逻辑**：alpha 实例清理的正道是 `alpha.sh stop`（锁文件持有 PID，字面量 kill 本就不拦）；组合杀形态（`kill $(lsof -ti :3102)`）现状仍拦，这是可接受的——正道不走组合杀，拦了恰好把獭引导回脚本。放行若未来确有需要，走既有白名单机制扩展，不在本期

### 五、prompt 层落地

- `worktree-isolation` SKILL.md 验证步骤：worktree 内验证服务行为的标准动作 = `scripts/alpha.sh start`（替代手工 `otter-buddy.sh start -p xxx`）
- SYSTEM.md 或 README 端口宪法段（README 为主，SYSTEM.md 不动——增长纪律）

**新增 schema 字段**：无。新增文件：`.otter-alpha.json`（锁文件，gitignored）、`~/.otter/alpha/<hash>/`（数据根）——均无既有消费方冲突；锁文件消费方 = alpha.sh 自身 status/stop。

## 影响范围

| 既有功能 | 影响 |
|---|---|
| 搭档主服务启停（otter-buddy.sh 3000） | 零变化 |
| 守卫既有拦截（kill PID / pkill / 主仓脚本 stop） | 零回归，只改文案与注释，不加识别模式 |
| worktree 内手工 `otter-buddy.sh start -p <port>` | 保留可用（守卫现状放行），skill 引导改用 alpha.sh |
| restart-service.mjs 白名单（外部项目 dev server） | **有交互**：3100 是 dongbeicun 实际端口——alpha.sh 分配端口时读白名单避让（机制见方案二），避让后无冲突 |
| config.yaml 格式 | 不变（alpha 用生成副本） |
| src/main.ts | 新增 argv 解析（--config），薄 shim 加 5-10 行 |

## 风险与约束

1. **alpha 实例数据膨胀**：`~/.otter/alpha/<hash>/` 每 worktree 一份 SQLite。embedding 模型不膨胀——config 副本把 `localModelPath` 改写为主仓 models 绝对路径，多实例共享只读（无并发写风险）。**不新增 embedding 开关字段**——保持「机制不净新增」判定
2. **端口段耗尽**：50 个槽位（3100-3198 偶数），实际并行 worktree 远少于此；耗尽时报清晰错误
3. **守卫误拦**：`lsof -ti :3000` 单独查询（不带 kill）不拦，只有组合形态拦；查询场景保留
4. **worktree 删除后孤儿**：worktree 删了但 alpha 还活着 → 锁文件随 worktree 消失。缓解：alpha.sh start 时扫描 `~/.otter/alpha/` 陈旧目录提示；首期文档告知

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 隔离 vs 守卫 | 隔离为主、守卫补洞 | 继续堆守卫规则 | tutu 实证：消灭攻击面优于缩小攻击面；守卫对命令替换/管道组合天然有盲区 |
| 端口分配 hash 建议制 | hash 确定性 + 冲突顺延 | tutu 式动态扫描首个空闲 | 同 worktree 端口稳定（书签/curl 脚本可复用）；tutu 用动态是因为多 worktree 并行高频，otter 场景更稀疏 |
| 数据隔离用 `--config` 副本 | 生成改写版 config（port/db/localModelPath 三字段） | 加 env 覆盖机制 | `buildApp({ configPath })` 已存在（app.ts:86-87），main.ts 加 argv 解析仅 5-10 行；env 覆盖是净新增机制（config-service 无 env 层） |
| 机制识别检查点 | **不涉及净新增机制** | — | 逐项：新脚本/新文件格式（锁文件）不属配置字段/状态生命周期/信号/存储表/决策分支/跨模块调用——锁文件生命周期由 alpha.sh 自管，无系统级消费者；守卫只改文案与注释，不加识别模式/状态。前提：风险 1 采纳「共享模型路径」而非「加 embedding 开关字段」（若加字段则判定重开） |
| alpha 实例清理路径 | 正道 `alpha.sh stop`；兜底字面量 `kill <pid>` | 守卫加 alpha 段静态放行 / alpha.sh 自动注册白名单 | 组合杀现状拦截恰好把獭引导回脚本正道；静态放行需重开「只改文案」声明；自动注册污染白名单的搭档语义域 |

省事声明审计：本方案初稿曾自称「--config 已存在、零代码改动」——9/17 检视核验证伪（main.ts 无 argv 解析，grep 零命中）。教训记录：省事声明审计不能只审取舍，必须核验前提声明的事实性（本次正是审计该抓的那类失守）。修订后本方案无「零改动」类声明：main.ts argv 解析为小幅新增（5-10 行），省掉的是 config-service env 覆盖层；其代价主人是 alpha.sh 的 config 副本生成逻辑（三字段改写），不转嫁给运行时——副本生成失败时 alpha.sh 在启动前报错退出，无静默降级。

## 验证

| 测试 | 场景 | 验证点 |
|---|---|---|
| alpha.sh start | worktree 内首次启动 | 3100+ 偶数端口、独立数据根、锁文件写入、健康检查通过 |
| alpha.sh start 幂等 | 已在跑时重复 start | 报错提示先 stop，不双开 |
| alpha.sh start stale-lock | 锁文件存在但 PID 已死（残留孤儿存活） | 清理孤儿进程 + 删锁文件后继续启动（对齐 tutu cmd_start:190-207） |
| alpha.sh start 白名单避让 | 白名单声明 3100 且 hash 建议落 3100 | 跳过 3100 分配下一槽位 |
| alpha.sh embedding 路径 | alpha 启动后查 embedding 配置 | localModelPath 解析到主仓 models（绝对路径），不触发 worktree 内下载 |
| alpha.sh start 冲突 | 占用建议端口后启动 | 顺延到下一空闲偶数端口 |
| alpha.sh start 失败 | mock 端口等待超时/进程早退 | 半启动进程树被清理，无孤儿，锁文件不写 |
| alpha.sh stop | 正常停止 | 只停自己 PID 树，3000 主服务不受影响，锁文件删除 |
| alpha.sh stop 错杀防护 | PID 文件指向非本端口监听者 | 拒杀（沿用 T1 杀伐校验） |
| detached-launch | FORCE_COLOR=1 环境启动 | read_launcher_pid 拿到裸 PID，kill -0 命中 |
| 守卫：组合杀拦截回归 | `kill $(lsof -ti :3000)` / `lsof -ti :3000 \| xargs kill` | 仍被拦（既有 INDIRECT_PID_PATTERNS 行为不回归），且文案指向 alpha.sh |
| 守卫：不误拦 | `lsof -ti :3000` 纯查询；alpha 实例经 `alpha.sh stop` 清理（正道） | 放行 |
| 守卫：alpha 组合杀 | `kill $(lsof -ti :3102)`（清理自己 alpha 的野生形态） | **现状拦截**——这是可接受的：正道是 `alpha.sh stop`（锁文件持有 PID）；兜底是 lsof 查 PID 后字面量 `kill <pid>`（字面量不拦）。守卫不加 alpha 段放行逻辑 |
| 守卫回归 | 既有 kill PID / pkill / 主仓脚本 stop 用例 | 全绿 |
| skill 引导 | worktree-isolation 验证步骤文本 | 指向 alpha.sh |

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| scripts/alpha.sh | 新增 | worktree 隔离实例管理（核心，含 stale-lock 清理 + 白名单避让） |
| scripts/detached-launch.mjs | 新增 | 全分离启动器（机器通道纪律） |
| src/main.ts | 修改 | 新增 argv 解析（--config），薄 shim +5-10 行 |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | 拦截文案升级指向 alpha.sh + 3100-3198 alpha 语义段注释声明 |
| tests/frameworks/agent/bash-safety-guard.test.ts | 修改 | 文案断言更新 + 组合杀回归用例 + 不误拦用例 |
| .pi/skills/worktree-isolation/SKILL.md | 修改 | 验证步骤指向 alpha.sh |
| README.md | 修改 | 端口分配表 + 禁令文本 |
| .gitignore | 修改 | `.otter-alpha.json` |
