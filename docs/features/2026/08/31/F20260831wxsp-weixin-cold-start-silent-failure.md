---
id: F20260831wxsp
title: 微信冷启动静默失败修复：ensureWeixinConfig 路径对齐 + 孤儿账号降级启动
summary: 扫码后 config.yaml 补写路径错误（./config.yaml vs config/config.yaml）导致 weixin 段静默丢失，重启后轮询无声消失——三处修复：补写路径与读入路径对齐（原子写）、yaml 写回从全量 dump 改为文本追加（保注释）、冷启动有账号无配置段时降级启动 + warn 而非静默 return。
change_type: fix
created: 2026-09-01
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
tags: [weixin, bootstrap, config, cold-start, silent-failure]
modules: [src/bootstrap/platforms.ts, src/app.ts]
---

## 背景

2026-08-31 晨间实测发现（PR #635 合入重启后）：微信轮询没有起来，飞书正常。排查确认三个叠加缺陷：

1. **补写路径错误**（F20260829wxui 引入）：`ensureWeixinConfig`（src/bootstrap/platforms.ts:415）缺省写 `./config.yaml`，而真实配置在 `config/config.yaml`（`loadConfig` 的 `CONFIG_PATH = path.resolve(process.cwd(), "config/config.yaml")`）。8-31 14:31 扫码时写回 ENOENT，仅留一条 `ensureWeixinConfig failed` warn，weixin 段从没写进 config。
2. **冷启动静默失败**：重启后 `startWeixinChannels` 读不到 weixin 配置段直接 `return []`，**一条日志都没有**——web 上看不到任何异常，微信就是不响。账号 state（token/游标）其实还在 `data/weixin/`，缺的只是 config 段。
3. **注释丢失隐患**（修 1 后才会显现）：原实现用 `yaml.dump` 全量重写 config.yaml，而真实 config/config.yaml 满篇人工注释（对齐 config.yaml.example），dump 会把注释全部抹掉。

## 改动

1. **`src/bootstrap/platforms.ts` — `ensureWeixinConfig`**
   - 缺省路径 `./config.yaml` → `path.resolve(process.cwd(), "config/config.yaml")`，与 `loadConfig` 的 CONFIG_PATH 对齐
   - 写回策略从「yaml.load → 改对象 → dump 全量重写」改为「读原文 → 文本追加 weixin 段（yaml.dump 只序列化新段）→ 原子写」——weixin 是顶层段，追加到文件末尾语义等价，且保留全部既有注释
   - 原子写对齐 `updateDefaultModelInYaml` 既有模式：write-to-temp + rename，防 truncate+write 中途崩溃损坏配置
   - 非法 YAML（load 得 null）不覆盖文件——loadConfig 已在启动时把关
2. **`src/app.ts` — 登录成功回调**：`ensureWeixinConfig({ configPath: options.configPath, ... })` 显式传 buildApp 的 configPath（测试注入的临时路径），生产缺省走函数内默认（与读入同源）
3. **`src/bootstrap/platforms.ts` — `startWeixinChannels`**：config 无 weixin 段时不再静默 return——用默认 stateDir 列账号，**有账号则 warn + 降级拉起轮询**（默认段：默认网关 + partnerUserId 未配置）。安全性论证：PartnerResolver 未配置时不拦截命令（降级语义），消息收发不受影响；web 登录流程本身不依赖 config weixin 段（F20260829wxui 零配置设计），降级启动与热启动路径使用同一默认段，行为一致。

## 判别表（运维速查）

| 现象 | 含义 | 处置 |
|---|---|---|
| 启动日志有 `Weixin polling channel started` | 轮询正常 | — |
| 启动日志有 `Weixin: logged-in accounts exist but config.yaml has no weixin section` | 孤儿账号降级启动（本修复新增） | 手工补 weixin 段（或重新扫码触发 ensureWeixinConfig）恢复 partnerUserId 门禁 |
| 扫码后日志有 `ensureWeixinConfig failed` | 补写失败（路径/权限） | 按日志 error 处理；此前该 warn 极易被忽略，重启后轮询丢失 |
| 无上述任何日志且微信不响（曾用自定义 stateDir） | **降级不可达**（检视建议 1）：自定义 stateDir 记录在已丢失的 weixin 段里，降级检查读默认 `./data/weixin` 找不到账号 → 静默 return | 手工补 weixin 段（含自定义 stateDir）。已知边界：降级兜底只覆盖默认 stateDir 用户 |

## 验证

- 新增 `tests/bootstrap/weixin-cold-start.test.ts` 5 例：注释保留追加 / 幂等不写 / 双字段顶层缩进 / 文件不存在 warn 不抛 / 零配置无账号不误报
- 受影响面全绿：bootstrap + frameworks/weixin + interface-adapters/weixin + usecases/im 共 171 例；build-app 组装根 6 例
- tsc --noEmit 通过；eslint 通过
- **最简实现检查**：已过——修 1/2 只改函数体不动签名；修 3 复用既有 `startWeixinAccount` 装配（传空段），未新增抽象层

## 影响

- 本修复落地后，**不需要执行任何数据订正**：8-31 已手工补写 config.yaml weixin 段（热修），下次重启轮询即恢复；代码修复保证的是「未来任何扫码 → 补写 → 重启」链路不再断
- 孤儿账号降级启动是兜底而非推荐态：降级期间命令门禁未锚定（任何人可发命令），有安全敏感场景应尽快补 config 段；且降级检查只读默认 `./data/weixin`——自定义 stateDir 用户的账号不在默认路径，降级不可达（见判别表末行）

## 关联

- from: F20260829wxui（ensureWeixinConfig 引入处，缺陷 1/2 的源头）
- 关联 F20260831xtrt（同日 externalType 路由修复，同属微信链路收尾）
