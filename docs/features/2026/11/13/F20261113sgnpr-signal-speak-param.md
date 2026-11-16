---
id: F20261113sgnpr
title: signal 块改 speak 独立参数，废除 body 内嵌标签
change_type: fix
status: development
created_at: 2026-11-13
capability_test: "tests/capability/magic-words-signal.capability.test.ts（objection/blocked 采样用例已同步改为 signal 参数口径）"
intent:
  problem: "与 healing 同病：objection/blocked 信号让 LLM 在 speak body 自由文本里手写 <signal type=... severity=...>payload</signal> 结构化标签，靠 tokenizer+栈式配对抽取。自由文本写结构化必然漂移——healing 已在 F20261113hlprm 参数化根治，signal 是同构残留。chen 追问确认后拍板：现在就开工，同款改法。"
  expected_effect: "objection/blocked 走 speak 工具的 signal 参数（结构化数组），不再解析/剥离 body 文本中的 <signal> 标签；halt 仍只能经 halt_otter 工具（白名单不含 halt，小獭不可伪造）。body 里出现任何 <signal> 文本都不再被特殊处理，原样展示。"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "单测：parseSignalParam 合法（type/payload 必填、severity 缺省 medium、payload ≤1000 截断）→ signals 数组；非法（非数组/超 5 条上限/halt 伪造/空 payload/severity 白名单外）→ error 且不落账不建 entry（原子阻断）"
      - "单测：persistSignalEvents 逐条落账 signal_events（pending）+ 落库成功后 signalAlertRegistry.register（#1227 提醒链路不变）"
      - "回归：tsc 0、eslint 0、tool-manifest lint 通过、tools/ 与 usecases/signal/ 全绿"
    rollback: "git revert 本 PR；objection/blocked 上报通道回退为 body 内嵌 <signal> 解析（含其漂移不可见缺陷）"
    risk_note: "删除 body 内嵌解析后，模型若仍习惯在 body 写 <signal> 标签，该文本将原样展示给搭档（描述已禁止，无泄漏/剥离歧义）。halt 语义不变（halt_otter 工具路径零改动）。capability 采样用例的 prompt 已同步改为 signal 参数口径，LLM 采样评估不回归。"
causal_links:
  - F20261113hlprm
summary: objection/blocked 信号从 speak body 内嵌 <signal> 标签改为 speak 工具独立参数（数组，每条 type/severity/payload），删除 signal-report-parser 与 body 拦截路径，与 healing 参数法同构，根治自由文本写结构化的漂移。
---

# signal 块改 speak 独立参数，废除 body 内嵌标签

## 案发现场

chen 追问「signal 块也是这个让 llm 手写的设计方式？」——是的。objection/blocked 信号沿用
healing 修复前的同款设计：让 LLM 在 speak body 自由文本里手写
`<signal type="objection" severity="medium">正文</signal>` 标签，由
`signal-report-parser.ts`（tokenizer + 栈式配对）抽取。chen 拍板「现在就开工来改」。

## 根因链

1. 与 healing 同根：自由文本写结构化数据必然漂移，body 内嵌标签是错误设计。
2. healing 已在 F20261113hlprm 改为 speak 独立参数并根治；signal 是同构残留——
   objection/blocked 仍走 body 文本标签，漂移后 parser 不可见即信号静默丢失，
   恰好击穿协议要消灭的「假装没看见」。
3. signal 比 healing 更敏感：healing 漏报是「少一条自愈记录」，objection/blocked 漏报
   是「异议/卡住升级被静默吞掉」——裁决义务链断裂。

## 改动

- `signal-tools.ts`：删 `interceptSignalReport`（body 解析+剥离），增
  `parseSignalParam`（白名单校验/severity 缺省 medium/payload ≤1000 截断/单条≤5/非法原子
  阻断）与 `persistSignalEvents`（repo.create 成功后 signalAlertRegistry.register，
  fire-and-forget 各自失败不阻塞对方）；导出 `SPEAK_SIGNAL_PARAM_SCHEMA` 与白名单同源维护。
- 删除 `src/usecases/signal/signal-report-parser.ts` 及其测试（body 内嵌路径不再存在）。
- `tool-factory.ts`：speak `properties` 新增 `signal` 参数；执行路径从 body 解析剥离改为
  `parseSignalParam` 校验 + `persistSignalEvents` 落账；创建回包 blocked 指引、speak
  description 同步改为参数法口径。
- `.pi/SYSTEM.md` 獭间信号协议、`signal-event.ts`/`signal-alert-registry.ts` 注释同步改口径。
- 特性文档：本文档。

## 与 healing 的分界（不变）

- healing = 系统自愈（speak 的 `healing` 参数）；signal = 协作协调（speak 的 `signal` 参数）。
- halt 不走 speak：只能大獭经 halt_otter 工具发出（白名单不含 halt，小獭不可伪造）。
- 语义池独立（signal_events 表 vs healing_events 表），传输管道模式共享（均为 speak 参数法）。

## 验证

- `npx tsc --noEmit` 0；改动文件 eslint 0；`npm run lint:tool-manifest` 通过。
- `npx vitest run tests/interface-adapters/agent-runtime/tools/ tests/usecases/signal/`：
  含 signal-tools 参数解析/落账新测试、signal-alert-registry 链路、以及
  speak-healing-block 新增「跨参数原子性」（合法 healing + 非法 signal → 两者都不落账、
  entry 不建：全有或全无）。
- capability 采样用例（magic-words-signal）prompt 已同步为 signal 参数口径。

## 备注

- body 里若仍出现 `<signal>` 文本，现在原样展示给搭档（不再解析/剥离，描述已禁止）。
- severity 缺省 medium（objection/blocked 是协调升级信号，默认中等严重度，不低估不高估）。
- 行为变更（有意）：旧 parser 对畸形块 fail-open（静默剥离不阻断发言），新参数法
  fail-closed（非法 → 阻断逼重发）。objection/blocked 是「假装没看见」的保险丝，
  静默丢比阻断更危害裁决链。
- 跨参数原子性：healing 与 signal 均先 parse（任一非法即阻断）、全合法才各自落账——
  避免「healing 已入库但 signal 非法阻断发言」的部分落账。
