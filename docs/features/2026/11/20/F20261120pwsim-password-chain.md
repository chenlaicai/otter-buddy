---
id: F20261120pwsim
title: "登录口令值源砍到两级：config 优先，没配就生成到启动机上可查看的文件"
summary: "搭档明确否决了 env 那一层：口令要「配了就用我配的，没配就启动时生成一个放在启动机上、我能查看」。原值源是 env `OTTER_OWNER_PASSWORD` → config `auth.ownerPassword` → `data/owner-password` 文件 → 首启生成，四层里第一层对用户不可见（进程环境），排障时人会以为「我配的是这个」。本笔删掉 env 这一层：判定只剩 config 与文件两级；进程环境里若还留着旧变量，启动日志 warn 一句「已废弃并被忽略」，绝不静默改走别的值。同期把 e2e 的注入方式从 env 改为 `config.e2e.yaml` 的 `auth.ownerPassword`，让测试也走生产同款路径。"
change_type: refactor
capability_test: "tests/interface-adapters/http/auth/owner-password.test.ts（11 例：config 优先 / 文件复用 / 首启生成 0600 / 空白文件 fail / config 覆盖旧文件 warn / 解析入参不再含 env）"
intent:
  problem: "登录口令原先有四个值源（env → config → 文件 → 生成），其中 env 在进程环境里，用户在配置文件里看不见它，于是「我明明配在 config 里」与「实际生效的是别处」并存——口令配错的表现是登录不进去，而看不到的那一层让人查错方向。搭档的原话是：不要 env 这这那那，配了就用我的，没配就生成一个放启动机上我能查看。"
  solution: "删掉 env 层：resolveOwnerPassword 只接受 config `auth.ownerPassword` 与数据目录口令文件；文件不存在时首启生成（0600，日志明说路径与「可查看」）。app.ts 若发现进程环境里仍有旧变量，warn 一句「已废弃并被忽略」（不回显值）。e2e 改用 config.e2e.yaml 的 auth.ownerPassword，脚本不再 env 注入。config 示例、部署 README、config-service 注释同步去掉 env 说法。"
  expected_effect: "登录口令的来路只剩两处可查：配置文件里那行，或数据目录里那个文件。用户看到口令没生效时只需要看这两地方，不需要猜进程环境。"
  verify_by:
    type: static_only
created_in_conversation: 0401284f-dff7-4927-af60-3516a984529d
tags: [auth, password, config, simplification, ops]
modules:
  - web
causal_links:
  - {type: "supersedes", id: "F20261113uaccs", note: "那笔建立了四层值源（含 env 层）；本笔按搭档口谕砍掉 env 层，保留 config 与文件两级"}
  - {type: "complements", id: "F20261120hubex", note: "同日另一笔：公网开站前需要知道口令从哪来；本笔把「从哪来」简化到只有两处可查"}
---

# 登录口令值源砍到两级（F20261120pwsim）

## 搭档的口谕

> 「本机里我是配置了 config 的，而且你这个优先级我可不认，我当时说过了，不要搞那么复杂，要支持我自定义配置，如果没配置，就启动时生成一个放到启动机器上然后我可以查看到，不要搞什么 env 这这那那。」

## 改动前后

| | 改动前 | 改动后 |
| --- | --- | --- |
| 值源层数 | 4 层 | **2 层** |
| 顺序 | env `OTTER_OWNER_PASSWORD` → config `auth.ownerPassword` → `data/owner-password` → 首启生成 | config `auth.ownerPassword` → `data/owner-password`（无则首启生成） |
| 用户可查性 | 最优先那层在进程环境里，配置文件里看不到 | 只有两处：配置文件那行、数据目录那个文件 |
| env 残留 | 生效 | **不生效**，启动日志 warn「已废弃并被忽略」（不回显值） |

`data/owner-password` 落在**启动机的数据目录**（默认 `./data`，ECS 上是 `/var/lib/otter-buddy/data`，经 `/opt/otter-buddy/data` 软链），权限 0600。查看方式：

```bash
sudo cat /var/lib/otter-buddy/data/owner-password
```

## 为什么不是「留着 env 当后门」

env 层的收益只有「部署脚本能改口令而不碰配置文件」，代价是：口令这种「配错就登不进去」的东西多了一条不可见的值源。用户在 config 里改了口令、却没生效时，第一反应会是查 config——而错因在别处。砍掉它之后，排障路径与用户的心智模型一致。

代价（诚实记下）：部署侧不再能用 env 临时覆盖口令；要换口令就改 config 的 `auth.ownerPassword`，或删掉那个文件让服务重启重生成。

## 配套改动

1. **e2e 走生产同款路径**：`scripts/e2e-server.sh` 不再 `env OTTER_OWNER_PASSWORD=…` 启动，改为 `config/config.e2e.yaml` 里 `auth.ownerPassword: "e2e-owner-password"`（该文件入库、零机密）。这样 e2e 覆盖的正是生产的 config 优先路径，而不是一条只有测试在用的旁路。
2. **文档**：`config/config.yaml.example` 与 `deploy/ecs/README.md` 去掉 env 说法，写清「只有两级」，并给出 `sudo cat` 的查看命令。
3. **启动提示**：`app.ts` 检查进程环境里是否残留旧变量，有则 `warn`（只报键名，不回显值）。

## 测试

`tests/interface-adapters/http/auth/owner-password.test.ts`（11 例全绿）：

| 例 | 断言 |
| --- | --- |
| config 优先于文件 | 文件里有旧值也不影响 config 生效 |
| config 生效时不落盘 | 不产生口令文件 |
| config 为空白 → 回落文件 | 空白不算配置 |
| 文件复用 | 二次启动同一口令（会话可续） |
| 首启生成 | 文件 0600、内容与返回值一致 |
| 空白文件 → 抛错 | 损坏宁 fail，不静默换口令 |
| config 覆盖旧文件 → warn | 提示旧值将被忽略 |
| 解析入参不再含 env | 形态断言：旧变量无法从这条路径进入判定 |

## 已知边界

- 本笔是**行为变更**（env 不再生效）：若某处部署脚本仍用旧变量注入口令，升级后会改走「config 或文件」，启动日志有一行 warn 提示。当前线上 ECS 的 unit 里没有该变量（已实测 `Environment=` 仅 PATH/HOME/CI、进程环境无相关键），所以本笔对现网零影响。
- 历史特性文档 `F20261113uaccs` 记录的是四层设计，按历史文档不可改口径保留原文；口径以本笔为准。
