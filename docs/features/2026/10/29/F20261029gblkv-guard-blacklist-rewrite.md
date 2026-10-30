---
id: F20261029gblkv
title: bash 守卫终态重写：黑名单两层架构（guard-v4）
summary: 按搭档 10/29 定调（"禁止白名单！只允许有黑名单！""按照这个来！"）整体重写 bash 守卫：第一站杀进程判定（运行时身份三查）+ 第二站黑名单三类（凭证路径/数据外发/下载即执行）；sandbox-exec 层、白名单写区、git 动态授权全部退役；healing 实测误拦固化为回放回归库；CI 增 macos job 补真机验证盲区。
change_type: refactor
capability_test: "n/a：守卫重写，验证=回放回归库全绿+CI macos job+对抗审视"
created_in_conversation: 2deb62bf-1e41-464d-a794-0da4c75a5c03
created_at: 2026-10-29
causal_links:
  - "#1694"
  - "#1695"
  - "#1697"
  - "#1698"
  - "#1699"
  - "F20260916gtlr"
  - "F20260928slan"
tags:
  - bash-guard
  - blacklist-architecture
  - sandbox-retirement
  - replay-regression
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/model-runtime-registry.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/config-service.ts
  - tests/guard/replay/
  - .github/workflows/ci.yml
---

# bash 守卫终态重写：黑名单两层架构（guard-v4）

## 背景与决策链（搭档 2026-10-29 拍板）

10-27/28 守卫改造（白名单沙箱 + git 动态授权）在真机连环断裂（#1694/1695/1697/1698/1699），全系统交付链停摆。搭档当日连续定调，构成本文档的决策基础（原话锚定）：

1. 「只拦截明确有问题的，其余看不懂的全放通」（10-27 已定，10-29 重申）
2. 「禁止白名单！只允许有黑名单！」（16:21）
3. 守卫原点=防獭杀主进程（9/16 事故，F20260916gtlr）——「守卫 git」是后续补丁雪球里漂移出来的伪目标（16:36）
4. sandbox-exec（Apple deprecated）整层退役，凭证拦截并入文本黑名单（17:06）
5. 「按照这个来！」「一个 pr 做完！」（17:10）——本文档即该 PR 的设计真相源

## 终态架构：两层流水线

```
獭输入 bash 命令
   ↓
【第一站】杀进程判定站
   粗筛：kill/pkill/killall 以「命令位置」出现？（kill-segment-finder，现有引擎保留）
   ├─ 否 → 过站
   └─ 是 → 提取目标 → 三查身份 → 命中拦 / 未命中过站
   ↓
【第二站】黑名单判定站
   粗筛：凭证路径 / 外发数据 / 下载即执行 特征？
   ├─ 否 → 过站（= 放行执行）
   └─ 是 → 逐条核对 → 命中拦 / 未命中过站
   ↓
放行 → 真实执行（无包装裸跑）→ 结果返回獭
```

守卫为纯文本两层判定，执行层无任何包装。日常命令（git/npm/文件操作/进程查询）两站粗筛即过，开销=字符串特征检查。

### 第一站：杀进程判定（9/16 原点，唯一硬目标）

**粗筛**（kill-segment-finder.ts 整文件保留，235 行）：kill 族词以命令位置出现才进站——四层机制：命令位置判定（段首/操作符后）、引号状态机（引号内分隔符是文字）、$()/反引号/子 shell 真执行位（嵌套命令位置重启）、前缀包装剥离（sudo/路径/赋值/wrapper/bash -c）。#698/#777/#1635/#1641 事故钉过的成熟引擎。

**三查身份**（拦/放唯一依据，全部运行时事实）：

| 查 | 方法 | 命中含义 |
|---|---|---|
| 一查 | 目标 PID == 主进程号码（.otter-buddy.pid 文件，判定时读） | 主进程本体 |
| 二查 | ps args 含指纹 `otter-buddy/dist/src/main.js` | 主进程本体（兜底：PID 文件缺失/换号） |
| 三查 | ps 查目标**直接**父进程 == 主进程 | 直系 worker（杀它连带主进程） |

- 只查直接父进程不爬全链（獭自己起的进程链上必有主进程，爬全链必误拦——#1698 病根）
- 主进程号码三级来源：PID 文件（主源）→ lsof 端口问询（兜底1，端口从本进程 config）→ args 指纹（兜底2）
- 非字面量目标（$VAR/$()/xargs）：**保守拦**（现有 INDIRECT_PID_PATTERNS 语义保留）——运行时无法求值变量，宁可拦了问；白名单端口 lsof 溯源放行（#844 现有机制保留：`kill $(lsof :3100)` 类 alpha 实例清理）
- 服务脚本自杀（otter-buddy.sh stop/restart，9/16 原案字面无 kill）：SERVICE_SCRIPT_KILL 模式保留拦截
- 拦后：文案「主进程不能杀，重启走 restart-service 工具」+ healing 台账

### 第二站：黑名单判定（三类，全部机械判据）

| 类 | 内容 | 判据 |
|---|---|---|
| A 凭证路径 | ~/.ssh、~/.gnupg、~/.aws | 命令中出现这些路径（读写都算），第一站同款位置/引号语义 |
| B 数据外发 | curl/wget POST/PUT/带载荷 | 目标域名不在协作域名表（动词词元表按工具分：curl 认 -X POST/PUT、--data/--form/--upload-file/--json、短旗标 -d/-F/-T（含附着值 -T<file>）；wget 只认长形态 --post-data/--post-file/--body-data/--body-file 与 --method 值（wget 无上传短旗标——-T=timeout/-F=force-html/-d=debug/-t=tries 全是 GET 侧）；大小写敏感——-f≠-F、-D≠-d |
| C 下载即执行 | 网络命令→管道→sh/bash/python | 管道段配对按数据流（fetcher 段先于解释器段即拦，fetcher 含段首 curl/wget 与段内 <(curl) 替换形态——cat <(curl)|bash 同拦；& 后台复合不跨链；进程替换只拦「解释器段自带 <(fetcher)」——bash <(echo)|diff <(curl) 放） |

- 域名表 config.yaml `bashGuard.allowedEgressDomains`（默认 github.com/api.github.com/registry.npmjs.org/objects.githubusercontent.com + 现有 huawei-colink.com/localhost/127.0.0.1/::1），**搭档专改**（主仓文件走 PR，獭无权扩表防注入自放行）；未配置时用内置缺省表（非 fail-closed），**显式空数组 = fail-closed**（搭档清空表即关闭全部合法外发，而非回退缺省表）
- `curl … | head`（只看不执行）放行——C 类只拦「进解释器」
- 明确不拦：git 全家、npm、文件读写删、非主进程 kill、ps/lsof、GET、一切看不懂的形态（宁漏勿误）

### 退役清单（本 PR 删除）

| 现有机制 | 行数 | 病根 issue |
|---|---|---|
| bash-sandbox.ts 整层（spawnHook/profile/probeSandboxAvailability） | ~296 | #1697/#1699（SBPL 翻译断链） |
| git-execution-policy.ts 动态授权全链（evaluateGitExecution/grantToProfileRules） | ~464 | #1694/#1697 |
| file-write-policy.ts 白名单五区 + file-tool-guard.ts 写区翻转 | ~229 | #1695 |
| bash-safety-guard.ts 内：写词表族/脚本文件执行禁令/路径猜意图族（main_write_resolve）/heredoc 判读族/data 破坏判定/git 窄门 | ~2500（3214→~300） | #1608/#1690/今日 11 条误拦 |

write/edit 工具：随白名单退役恢复 SDK 原生行为（无写区闸）——文件误写由 git 可回滚兜底（搭档「改了就改了」定调）。

### 残余风险（搭档已知情接受）

1. 凭证可读（A 类只拦「命令中出现路径」的可见形态，node -e 内嵌构造路径等变形可绕过）——兜底：B 类拦外发，读到手送不出（curl POST 不在表=拦）；残余通道=git push 合法外发，搭档在「改了就改了」框架接受
2. 主仓文件可裸写（无沙箱 deny）——git 可回滚，PR 纪律由流程保证
3. sleep 拦截（habit 层）与脚本文件执行禁令（bypass_guard 层）退役——工作流摩擦消失，其防护意图由一二站覆盖
4. config 注入延迟激活（检视建议④）：bashGuard.allowedEgressDomains 是 config 单例读入，进程启动时生效——运行中改 config 不热载，需主进程重启才进判定；被拦外发命令会引导「呈搭档确认」，无静默失效面

## 验证体系（先于重写建设，本 PR 内置）

**回放回归库**（tests/guard/replay/）：healing 台账 guard_intercept 事件固化为用例——10/29 台账 12 条误拦实录「必须放行」（含 stash 组合、ps/kill 组合查询、外部仓 push、heredoc python、/tmp 写、mktemp 组合、sandbox-exec 探针）；9/16 杀主进程原案「必须拦」；凭证路径/外发三类「必须拦」负门；检视回归钉（初轮：S1 GET 旗标/S2 广播 kill/S5 PUT 族/S7 管道段配对/③ 进程替换/⑦ 白名单端口溯源；delta-r2：D1 附着值上传/D2 wget -t GET 旗标/S7& 后台复合/③ 段提取与 source）。must-block 用例逐条断言拦截理由锚词（reasonContains，防「拦对了理由错」的语义漂移）。守卫行为以真实使用为准。

**CI macos job**：ci.yml 增 `guard-macos` job（macos-latest，公共仓免费），跑回放库 + kill 族依赖单测（allowed-service-ports）。10-29 全部事故的共同根源=守卫改动从未在真机验证（CI 全 Linux、本机沙箱不可嵌套）——本 job 根治。范围窄化：只跑守卫相关测试（不重复主 check job 的全量面），反馈快且不挤公共资源。

### 交付形态（实现校准）

- 守卫文件：`src/frameworks/agent/bash-safety-guard.ts`（单文件，~290 行——原计划拆 egress-blacklist.ts，实现时判定逻辑内聚于单文件更简，不拆）；kill-segment-finder.ts / allowed-service-ports.ts 原样保留复用
- 接线：单点注入 `model-runtime-registry.ts` 的 tool_call 门（bashGuardGate，与 halt/loop-block 同机制链式判定）——被拦命令不执行，SDK 生成 isError tool result（显式落痕，#1616 静默假绿教训）；域名表经 store（guardAllowedEgressDomains）从 config 流入，铸造点 pi-session-factory._executeWithSession
- 回放库：`tests/guard/replay/`（replay.test.ts + cases-2026-10-29.ts）——初版 52 用例，delta-r3 后 85 用例：误拦实录 22（healing 台账四族：git 授权链/脚本禁令/sleep/heredoc + #1710 信封形态 5 种）/ 必拦 12（9/16 原案 6 + 黑名单三类 6，理由锚词断言逐条做实）/ 日常抽样 15 + 域名表语义 3 + 检视回归钉（初轮 15 + delta-r2 7：D1 附着值/D2 wget -t/S7& 后台复合/③ 段提取与 source）+ 门覆盖面 2；测试基建用 tmp projectRoot + processProbe 桩（全平台确定性，不真查 ps）
- 修复对线 WIP 两个缺陷：extractLiteralPids 幻影 import（从旧版恢复本地实现）；B 类 isPost 正则 \b 拴死分支组（-X POST/-d 全漏判，改为行首/空白前导判定）

### 机制增补准入三问（R8.5，检视 S3 处置：refactor 主体 + 机制增补声明）

本 PR 主体是守卫重写（refactor），但 `bashGuard.allowedEgressDomains` 域名表是**新增配置机制**（config-service 新配置节 + fail-closed 语义 + 全链注入），按准入纪律过三问：

1. **决策者变了么**：没有——域名表的决策者仍是搭档（主仓 config.yaml 走 PR，獭无权扩表防注入自放行）；机制只把「哪些域名可外发」的决策信息成本降低（一处配置 vs 改代码重编译），不改变决策归属。
2. **靠自觉还是靠守卫**：机械托底——fail-closed 语义（显式空数组=全拦）与后缀匹配规则是代码内机械判定；「搭档专改」由 git 追踪 + PR 流程机械保证（非自觉）。
3. **深潜成本降了吗**：升——外发拦截事件可直接下钻到 config 表核对（域名是否登记、谁登记的走 PR 历史），比硬编码常量的「当时为什么放这个域名」可追溯性更强。

结论：准入通过，声明为「refactor 主体 + 机制增补（allowedEgressDomains）」。

## 关联与取代

- 取代 #1694/#1695/#1697/#1698/#1699 的全部在途修复方案（两条旧 worktree 分支废弃）
- #1710（新守卫验收需求）：误拦语义清单的形态面已录入回放库（信封形态家族 5 种钉为「必须放行」回归钉子）；其「安全面清单」（写区闸语义）随写区闸退役不适用——v4 下 write/edit 恢复 SDK 原生，非守卫输入面（门覆盖面钉 guardGateCovers 回归钉防未来误加闸复发）
- 保留：kill-segment-finder.ts（整文件）、SERVICE_SCRIPT_KILL、INDIRECT_PID_PATTERNS、#844 白名单端口溯源（allowed-service-ports.ts）、guard-model-judge 结构模型语义（第一站粗筛底座，其判定已内化进 kill-segment-finder 调用链与广播/进程组保守拦——S2 处置后此句成立）
- F20260916gtlr（9/16 原点）→ 本文档继承其使命，收敛为唯一硬目标

## 验证记录（交付时点，2026-10-30）

- 回放库：`npx vitest run tests/guard/` → 52/52 passed，exit 0
- 类型：`npx tsc --noEmit` → 0 error，exit 0
- 既有测试：`npm test`（含 pretest 全仓 eslint）→ 417 文件 5471/5471 passed，exit 0
- lint：`npx eslint src/frameworks/agent/bash-safety-guard.ts src/frameworks/agent/model-runtime-registry.ts tests/guard/` → 0 problem，exit 0；`node scripts/lint-tests.mjs` → OK，exit 0
- CI macos job：PR 开出后 GitHub Actions guard-macos 实跑（本机不可替代真机验证）
