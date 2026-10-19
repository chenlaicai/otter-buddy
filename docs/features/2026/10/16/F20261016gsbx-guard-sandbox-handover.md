---
id: F20261016gsbx
title: bash 守卫二期换血：沙箱接防写面条件退役（2a/2b）+ R1 直推与 S5 网络外发保留面窄规则（2c）
summary: |
  F20261016grdp 第二步落地。2a 沙箱探测（probeSandboxAvailability：平台+env+profile 构建）
  与 spawnHook 挂载同次求值并绑 session，attachGuards 消费挂载决策位（R-2b：探测与挂载
  结构上不可能分歧）。2b G3 枚举表退役 main_write 文件写族（redirect/one-liner/cat 管道
  heredoc/载荷递归透传）；git 写族/data 破坏族/引导类保留；不可用回位降级不降安全。
  2c checkNarrowRules 自带消息：R1 git push 直推受保护分支（词级 refspec，动态 fail-closed）
  + S5 POST/PUT 非白名单外发（白名单含 huawei-colink.com/回环）——关闭一期检视发现 6 的
  「网络外发零防护窗口」。R-2 失败引导在 spawnHook 包裹层（SBPL with-message 实测不达
  stderr）。G2 对表 S3：白名单补 .otter/workforms/。
change_type: feature
capability_test: tests/frameworks/agent/bash-guard-gsbx-phase2.test.ts
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
causal_links:
  - F20261016grdp（bash 守卫基建全案——第二步 2a/2b/2c 与 G2/G3 约束的方案来源）
  - F20261016grdl（一期止血 1a/1b/1c——检视发现 6「网络外发零防护窗口」的兑现承诺在此）
  - F20261015phys（bash 物理沙箱——写面退役的接防方；本特性补 R-2 文案与 2a 探测）
  - F20261015gsub（守卫定位收敛——退役只动 main_write 族，收敛后的保留面不动）
---

# bash 守卫二期换血：沙箱接防 + 保留面窄规则

## 背景 / 意图锚

- 10/16 派工（大獭）：按 F20261016grdp 第二步实现 2a/2b/2c，R-2b 约束「探测与 spawnHook 挂同一
  isSandboxEnabled+profileBuild 单一真相源」；G3「仅 main_write 文件写落点族退役，缺表不退役」
- 10/19 续跑（10/16 派工被 429 打断）：「当前任务 = 二期换血……惯例流程：worktree → commit → PR
  → 检视獭-守卫 对抗审视 → delta → 呈搭档终审」
- 一期检视发现 6（F20261016grdl :95）显式声明：例 5 误拦修复后、2c 窄规则落地前
  「密钥外发面为零防护」，窗口截止挂 2c 验收——本特性即关闭该窗口

## 实现

### 2a 沙箱可用性探测（R-2b 同源）

- `probeSandboxAvailability(repoRoot, dataDir)`（bash-sandbox.ts）：isSandboxEnabled（平台+
  env）+ buildSandboxProfile 不抛（profile 构建成功）三条件，不缓存、env 变更即失效
- `createSandboxedTools` 返回 `{ tools, sandboxGuarded }`——挂载与否与决策报告由同一次
  probeSandboxAvailability 结果决定，结构上不可能分歧
- pi-session-factory：session 创建点把决策绑定进 `sandboxGuardedBySession`（WeakMap），
  attachGuards 消费该位（缺席回退 false=写面回位，安全方向）；readOnly 合成会话无 bash 不绑定

### 2b 写面条件退役（G3 枚举表门控，`writeChannelSkip: "file-write"`）

退役（sandboxGuarded 时）：redirect 通道、one-liner 通道（python/node/ruby/perl）、
cat 管道 heredoc 通道、段结构 one-liner 载荷判定、bash -c 载荷内文件写族（writeChannelSkip
随递归透传）、heredoc 体写面负门（cdExemptionWithVeto 首行门控）。

保留（两路径恒跑）：git 写族字面通道 + 段结构 git 判定（含 GIT_WRITE_SUBCOMMAND 镜像）、
data 破坏族、引导类（sleep→wait、脚本自杀、kill 族）、PR merge 服务面、以及 2c 窄规则。
解析失败/未闭合的 shell -c 形态保持 fail-closed（载荷不可提取时 git 写族/data 破坏族可能藏于
载荷——「缺表不退役」，测试「G3 缺表不退役」钉住）。

### 2c 保留面窄规则（checkNarrowRules 唯一实现点，自带拦截消息）

- **R1 git push 直推受保护分支**：词级 refspec 判定（dst 侧命中 main/master/develop/
  production/prod 即拦，`HEAD:main`/`:main`/`+main` 全形态覆盖）；refspec 位动态词
  fail-closed（目标不可校验，R1 红线不盲跑）；bare push 与 `--dry-run`/`-n` 继承既有
  语义（r2-C：dry-run 非写；bare=保留面语义）
- **S5 网络外发**：curl/wget POST/PUT 上传族（-X POST/--data*/-F/-T/--post-*/短参簇全形态）
  + 非白名单目的拦；上传但目的不可静态校验（动态 URL）fail-closed；GET/下载面不动
  （窄规则）；白名单 = NETWORK_EXFIL_WHITELIST（huawei-colink.com 项目 MCP 端点 + 回环），
  扩展=改常量走 PR（既有合法 POST 目标普查为空，常量白名单与规模相称）
- 走查器 narrowRuleWalk：切段 + 落点解析 + shell -c 载荷递归 + 尾段 + 命令替换（$()/反引号），
  argv 落点判定——引号内提及（echo 'git push origin main'）不误拦；数据 heredoc 体是数据
  （blankDataHeredocBodies 基座）
- 消息诚实：窄规则自带文案（「受保护分支…请走 feature 分支+PR」/「非白名单目标 POST/PUT…
  白名单登记」），不借道写面「写主仓被拦截」文案（判定说真话）；实现单点、调用镜像既有
  规则族模式（checkBashCommandSafety 入口 + checkPidIndependentRules 递归面）

### R-2 失败引导文案（spawnHook 包裹层）

失败时追加一行（成功零噪音）：拒写（Operation not permitted）→ 指引 worktree/对话工作区
正道 + 写主仓走 PR；exit 65 → 附条件措辞（「若非内层命令自身语义（diff(1) 同码）……请报告
服务异常，勿重试」）——R-2b 实测后不单凭 65 判定沙箱失效。

## 验证

- bash-guard-gsbx-phase2.test.ts：38 用例（沙箱双路径可用退役/不可用回位 + 模拟沙箱不可用
  + 窄规则双侧钉死 + G3 缺表不退役形态）
- bash-sandbox.test.ts 扩：probeSandboxAvailability 三态 + 挂载决策位 + R-2 文案（含 macOS
  拒写真执行引导断言）
- 全量 5822 passed（373 文件，6 skipped 为既有平台条件用例）+ tsc clean + eslint clean
- guard-write-eval-corpus / touchstone 既有条目零翻案（受保护 refspec 与非白名单 POST
  在 corpus 中均无出现；仅有的两条 POST 条目目的均为回环——白名单兕住）

## 实测归档（scratch 实验，脚手架已删、结论如下）

1. SBPL `(deny file-write* (with message "…"))` 语法合法，但消息进系统日志**不达 stderr**
   ——LLM 唯一可见面是命令 stderr，引导文案只能在包裹层出
2. 沙箱拒写：bash 重定向失败 exit **1**，stderr 含「Operation not permitted」（可辨文案）
3. profile 解析崩溃：exit **65** +「sandbox-exec: unbound variable」stderr——与 diff(1) 等
   内层 65 退出码按 stderr 文案可辨，混淆面闭合
4. 内层命令退出码原样透传（exit 3 实测）

## 行为变更与已知边界

- 新拦截面：`git push` 受保护 refspec（此前 worktree cwd 下放行）+ curl/wget POST/PUT
  非白名单目的（此前仅词表污染误拦、无专门判定）+ 动态 refspec fail-closed
- 不翻既有钉住契约：`cd 主仓 && git commit → 放行`（grdl-g1:128 已知边界 #cwsp，「收紧属
  cd 豁免语义重议独立立项」）——本特性只动 main_write 文件写族，git 写族语义不动
- 声明边界（窄规则不追）：one-liner（node -e 等）载荷内嵌套 shell 字符串（#1513 间接构造
  同界）；xargs 等词包装首词不在落点解析器；scp/rsync 非 HTTP 上传面；多 URL 混合
  （静态 URL 全白名单 + 动态词夹带第二目标）——与既有「间接构造不追」边界同口径

## 遗留

- guard-touchstone 试金石 corpus 追加退役面/保留面标本：契约「进库冻结、追加须双签+呈报」
  ——本 PR 不单方面动 corpus，标本以 bash-guard-gsbx-phase2.test.ts 承载，corpus 追加待双签
- 「cd 主仓 && git commit」边界收紧 = cd 豁免语义重议（既有独立立项，见 grdl-g1:128 注）
