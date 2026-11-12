---
id: F20261110grdls
title: 能力护栏：faux 硬门禁、保证格点与 durable 读侧原语
summary: 把能力保证从文档纪律搬到机器门禁与基座契约：全量 faux 能力档进 CI，保证格点和公开排除由 lint 锁定，runtime 变更触发双分支 parity 与真 LLM 证据；durable 当前世代读取改用公开 Storage API，并修复身份未进入模型 wire 的迁移回归。
change_type: feature
capability_test: tests/capability/model-visible-parity.capability.test.ts
created_in_conversation: b4e05359-7a17-4478-8774-162360569279
causal_links:
  from: [F20261109pidrx, F20261110genrs, F20261110dursl]
  supersedes: []
tags: [testing, capability, durable, ci, runtime-contract]
modules:
  - tests/capability/guardrails.json
  - scripts/lint-capability-guardrails.mjs
  - scripts/check-capability-change.mjs
  - scripts/run-capability-parity.sh
  - src/frameworks/agent/durable-slice-source.ts
  - src/frameworks/agent/pi-session-factory.ts
intent:
  problem: 能力测试被静默排除且消费者依赖底层表面形状，durable 迁移后身份与前世读取失去保证
  expected_effect: 17 个能力文件全部进入 faux CI，未登记/无 issue 排除会红，相关变更自动做双分支 parity，durable 读取不再依赖 entries 表结构且模型可见身份恢复
  verify_by:
    type: capability_test
---

# 能力护栏：faux 硬门禁、保证格点与 durable 读侧原语

## 决策与边界

搭档 2026-11-10 明确要求一次 PR 完成已梳理方案。每日哨兵撤回：功能没变时每日真 LLM
结果恒定且浪费 token，压缩场景还需养到阈值。最终原则是：**贵的验证跟着变更走，
便宜的断言跟着运行走，日历不触发任何花钱的事。**

保证强度按层递减：结构消灭（基座原语）→ 运行时守护 → 消费者观察等价 →
faux/live 测试 → 机制测试 → 显式无保证。登记不是能力文件镜像：每项必须写
〈触发 / 可观察效应 / 消费者 / 当前保证层〉，`none` 也是合法且显式的值。

## 机器形态

### 1. faux 全量硬门禁

- `vitest.capability-faux.config.ts` 收集全部 `*.capability.test.ts`，真 app、真 sqlite、
  真 bge-m3，外部 LLM 成本为零；模型智力场景保留显式 skip 报告。
- `guardrails.json` 是文件集合与排除的唯一真相源。新增/删除/改名未同步登记即 lint 红；
  文件级 `faux=exclude` 必须带 `#issue`，把无声排除变为公开债务。
- `OTTER_CAPABILITY_FORCE_FAUX=1` 防止开发机 local overlay 把 faux 档偷换成真 LLM。
- 真 LLM 档默认关闭长缓存，且在 local overlay 整段替换 `llm` 后仍恢复该默认值；
  环境覆盖保留 `thinkingLevel`，避免 Kimi 收到不支持的 `prompt_cache_retention=24h`
  或 `reasoning.effort=none`。无 speak 的 API 早失败由等待器立即透出，不再伪装成超时。

### 2. 变更触发与换底清单

`check-capability-change.mjs` 只对 runtime/存储/会话/prompt/能力测试路径触发，PR 必须
在「能力变更验证」段呈交以下三类命令与输出锚点；无命中路径则不产生模型成本：

- `parity: PASS`：`npm run test:capability:parity -- origin/main`，基线 worktree capture、
  当前分支 compare，逐字段断模型实际收到的 wire 请求等价；CI 自动执行。有意变化在
  `parity-allowlist.json` 按完整基线 commit 登记精确 diff，未登记漂移与过期许可都会红。
  许可绑定 HEAD 与 `origin/main` 的实际 merge-base：rebase 改变真实基线后必须重新跑
  parity 并同步 base/diffs，不得只改 SHA 复用旧许可；无关 main 尖端前进不影响许可。
- `真 LLM: PASS`：不再接受一次全绿或 PR 文本自报。`run-capability-live.mjs` 分别生成
  base/head manifest，绑定完整 source/merge-base SHA、模型与配置指纹、harness/断言哈希、
  原始日志和 Vitest JSON 哈希；`compare-capability-live.mjs` 生成自包含 comparison，
  证据门从两侧 run 重算结果。仓库没有真 LLM CI secret，因此本地证据真实性仍由对抗审视
  核对原始日志与全部 attempts，机器闸不声称能识别一个精心伪造的本地文件。
- `换底: PASS`：逐项检查新增/改动依赖的文件名、扩展名、schema、调用作用域，分类为
  语义依赖或约定依赖；约定依赖必须下推为原语、补消费者契约测试或加运行时守护。

### 3. durable 当前世代读侧原语

`readDurableActiveEntries(Storage)` 只经公开 `findLatestHeadMarker` 与分页 `scanEntries`
取得根会话当前世代；`projectDurableSessionEntries` 才负责 coding-agent 消费形状。
SQLite 表名、record JSON 与 head 列不再是交接消费者的共同知识。只读连接不开 Harness，
保留 `undefined=缺失/失败`、`[]=真空` 语义，也不触发 reopen recovery。

### 2.1 概率行为的三态非劣协议

2026-11-12 搭档确认按第一性原理重构：目标不是「62 项同一轮碰巧全绿」，而是
「不可谈判机制仍成立，且本次变更没有让受支持配置的能力分布变差」。三层责任分开：

1. faux/parity/权限/持久化/状态机/fail-closed 等确定性硬门始终零失败；
2. 概率行为同时满足 head 绝对成功底线和 base→head 非劣区间，不能只证明「base 也差」；
3. 既有能力缺口独立记账，不自动成为 PR 豁免。

`live-protocol.json` 在任何 head 结果之前固定 α、样本下限、绝对底线、非劣 δ 和多重比较
方法。当前初始口径为每侧恰好 17 轮完整运行、ABAB 交错、每侧至少 50 个有效样本、
head 观测成功率 ≥0.8、Newcombe 差值区间下限 >−0.2，按同族场景数做 Bonferroni 修正。
17 轮沿用各测试原有 3/5/7 采样与超时，不改断言；50 是检测约 0.90→0.70 劣化的初始下限，
不是任何场景的万能充分样本量；更严格场景可在看 head 前预注册覆盖，禁止事后调宽。
少跑、额外抽奖重跑、复制 runId、运行重叠或时间顺序不交错都拒判。canonical 常量锁定协议，
完整 inventory 锁定 62 测试、37 自动采样、2 人工场景与 2 个声明期 skip；CI 逐 run 重算实际
内容而非只认哈希。每轮先干净 build，default/secondary/fallback 均固定参考模型，禁止测试过滤。

结论为 `PASS / FAIL / INCONCLUSIVE / BLOCKED`：样本不足、预算 SKIP、超时、429、 undeclared
skip 或基线不可比均不放行；head 跌破底线、场景静默消失或确认劣化为 FAIL。完整跑完但
行为断言失败仍是有效实验，可进入比较并判红，不再要求先拿到一次全绿才允许比较。
共享 runtime/prompt/helper 变更默认全套件为影响面；全量运行保留以发现资源泄漏、限流和
跨会话污染，但联合全绿不被误当统计证明。base 使用当前版本 tests/harness 覆盖，保证两侧
场景与断言一致；被测 src 分别属于 merge-base 与 head。参考模型在协议中固定为当前测试
基座 apig-deepseek-v4.1-flash（搭档 2026-11-12 在首个有效 head 运行前指定）；禁止看结果后换模型凑绿，其他模型只进入独立兼容性报告。
manualReview 场景必须附 verdict 与 judged_by，缺失或两侧不一致均拒判。运行后附件通过同一生成器
从原始 log/Vitest/exitCode 重算，保留 unreviewed 原件与同 runId 哈希链；异常退出或其他无效原因
不能借人工附件洗绿。base 允许带明确硬/人工能力缺陷作为修复前证据，但不得携带 INVALID 或
inventory 缺口；head 始终必须零硬失败，防止把「base 也差」当放行理由。

## 三连事故的首批格点

| 能力 | 迁移前保证 | 本 PR 后保证 |
|---|---|---|
| 换世后只读当前世代 | 无（账本文件名与 open 路径靠约定） | 结构：pi.reset/head + Storage 当前世代原语；消费者回归 |
| 前世档案有真实原料 | 仅机制读取，durable 下恒空 | 结构：公开 Storage 查询；切片器端到端断言 |
| 身份/system prompt 到达模型 | 旧 ALS extension 机制测试 | 等价：录音网关直接断言 wire system 含「大獭」；每轮刷新 identity |

## 验收场景

| 编号 | 需求 | 预期结果 |
|---|---|---|
| AT-1 | 能力文件与保证格点不漂移 | 当前 17 文件精确一致；删登记/无 issue 排除的负例测试红 |
| AT-2 | faux 档不依赖真 LLM | 全量 faux CI 绿，skip 有显式报告，local overlay 不影响档位 |
| AT-3 | 贵验证只随变更触发 | 文档路径不触发；runtime 路径触发 parity/真 LLM/换底证据门禁 |
| AT-4 | durable 读侧不摸 schema | Storage 原语分页读取当前世代，8 个既有投影/工厂回归全绿 |
| AT-5 | 身份真正到达模型 | 录音 wire 的 system 非空且含大獭；两轮 speak/yield 共 4 请求 |

## 独立检视处置与残余边界

- 护栏脚本、faux/live 配置、`ci.yml` 与 `package.json` 均纳入变更触发，防止拆门不报警。
- 池命中刷新 options 时 `identity=undefined` 不再清空既有身份，消除两次刷新间的无身份窗口。
- 麻将 `SdkOtterGateway` 缺 `currentInvokeId` 是 #1783 遗留且非本 PR 引入，已独立登记 #1827。
- faux 排除的 issue 号当前只做格式校验；本 PR 实际排除数为零，未来启用排除时须由审视核对 issue 存在且开放。
- faux 档按每次 CI 运行全量执行（含 bge-m3 缓存），这是「便宜断言跟运行走」的有意选择；parity 仍按相关路径跳过。
- 只读 Storage 不执行未来新增 migration；pi-durable 升级窗口若 schema 未先由写路径升级，读取会响亮失败并由调用方降级为机械档案，不作静默写迁移。
- 当前尚未取得新协议下的同配置 base/head 非劣 PASS，PR 继续 Draft；旧日志是问题定位证据，
  不能倒填成新协议证明。
- 首轮真 LLM 全量档暴露的装置腐化已修：session 读取器适配 durable sqlite/string content；
  matters 档案断言兼容叙事/机械两种合法标题；已退役「星星罐子」急停契约的旧测试删除，
  现行「停下」3/3 守护不变。wait 工具描述明确「先 speak 后 wait」硬顺序；「绕路了」
  测试补 afterSeq 与首轮 invoke 终态等待，识别合法重审同义表达；SYSTEM.md 明确收到
  「绕路了」后不得再先调工具，并由 stop-word scanner 注入就近 L1 重审提醒。
  durable 通过 ResourceLoader + `formatSkillsForPrompt` 接回 skills 可见面，需求分析用例改守
  现行 `requirement-analysis` 路由；小獭 objection/blocked 改为等待真实终态，不固定 sleep。
  Kimi 定向 wait 2/3、detour 3/3；Flash 的 skill/objection/blocked 均 3/3。
  wait 另由 durable `beforeTool` 拒绝当前 invoke 尚未 speak 的等待，机制测试覆盖拒绝→纠正→放行。
  身份自称识别补「调度团队/调度」合法表达；慢 golden 场景可显式延长响应窗，不断言降级。

## 非目标

- 不新增每日/每周真 LLM 哨兵。
- 不把 PR 文本证据冒充测试执行；机器闸负责触发与留痕，异体审视负责证据真实性。
- 不为假想的多基座另建通用抽象层；原语直接采用 pi-durable 公开 Storage 契约。
