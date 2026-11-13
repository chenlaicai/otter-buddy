---
id: F20261113hlprm
title: healing 改 speak 独立参数，废除 body 内嵌标签（根治乱码泄漏）
change_type: fix
status: development
created_at: 2026-11-13
capability_test: "n/a: speak 新增结构化 healing 参数，不改变任何工具能力语义，仅上报通道形态变更"
intent:
  problem: "speak 末尾 healing 块泄漏成乱码：块识别正则只认 <healing> 后紧跟 [ 或 {，模型漂移出的 XML 属性形态（<healing> type=... description=... </healing>）与 YAML/键值对形态对 parse/strip 均不可见，100% 原样泄漏给搭档。此前三次修复（#1800/#1828/#1851）都是在给官方形态白名单加形态，前缀白名单而非标签对匹配，模型漂出新形态就继续漏。chen 拍板：自由文本写结构化数据必然漂移，body 内嵌设计本身错误，直接上独立参数，不保留 body 兜底。"
  expected_effect: "healing 上报走 speak 工具的 healing 参数（结构化数组），不再解析/剥离 body 文本中的 <healing> 标签；body 里出现任何 <healing> 文本都不再被特殊处理（也不会被剥，body 原样展示给搭档）；模型漂移形态无法再制造泄漏，因为根本不存在文本解析路径。"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "单测：合法 healing 参数 → entry 创建 + repo.create 落账（type/severity/suggestion 正确透传）；非法（缺 type、type 不在白名单、severity 非法）→ isError 且 entry/台账均为零（原子阻断）"
      - "单测：healing-alert-registry 集成改为 persistHealingIssues 后 high 登记提醒 + low 不路由语义不变"
      - "回归：tsc 0、eslint 0、tool-manifest lint 通过、vitest 全量除 durable-runtime（需 dist 前置）外全绿"
    rollback: "git revert 本 PR；healing 上报通道回退为 body 内嵌解析（含其已知漂移泄漏缺陷）"
    risk_note: "本改动删除 body 内嵌解析路径后，存量已落库的 healing 事件不受影响；模型若仍习惯在 body 写 <healing> 标签，该文本将原样展示给搭档（可接受：描述已明确禁止，且不再有泄漏/剥离歧义）。signal 块仍走 body 内嵌（架构同病但改动面更大，后续单独跟进）。"
causal_links: []
summary: healing 上报从 speak body 内嵌标签改为 speak 工具独立参数（数组，每条 type/severity/description/suggestion），删除 healing-report-parser 与相关拦截路径，根治模型漂移导致的标签泄漏乱码。
---

# healing 改 speak 独立参数，废除 body 内嵌标签

## 案发现场

chen 两次遇到海獭发言末尾带「乱码」：《<healing> type="tool_use_feedback" description="[tool:wait] …" </healing>》
原样泄漏给搭档。这不是偶发——实测 4 种模型漂移形态全部泄漏（XML 属性、XML 子标签、
YAML 裸键值、key=value），解析器均返回 hasIssues:false、invalidBlocks:0、STRIPPED 原样保留。

## 根因链

1. `healing-report-parser.ts` 块识别正则 `<healing>\s*([[{][\s\S]*?)(<\/healing>|$)/gi`
   只认 `<healing>` 后紧跟 `[` 或 `{`。模型漂出 `type="..."` 属性形态时，块整体不可见。
2. 三次历史修复（#1800 剥 JSON no_issue、#1828 剥围栏 no_issue、#1851 统一协议契约
   a838ca4b）都是在「官方形态白名单」上加形态；块识别始终是前缀白名单而非标签对匹配，
   漂出新形态就继续漏。
3. 结构性缺陷：让 LLM 在自由文本里手写结构化数据，必然漂移。chen 拍板：设计本身错误，
   直接改独立参数，不保留 body 内嵌兜底。

## 修复

**healing 成为 speak 工具的独立参数**（F20261113hlprm）：

- `src/interface-adapters/agent-runtime/tools/tool-factory.ts`：speak `parameters.properties`
  新增 `healing`（数组，items 为 `{type, severity, description, suggestion}`，required=type/description）；
  description 去掉 body 内嵌说明，改为 healing 参数；执行路径从 `interceptHealingReport`（body 解析+剥离）
  改为 `parseHealingParam` 校验 + `persistHealingIssues` 落账。
- `src/interface-adapters/agent-runtime/tools/healing-tools.ts`：删除 `interceptHealingReport`，
  新增 `parseHealingParam`（白名单校验、字段长度截断、单条 ≤10、非法原子阻断）与
  `persistHealingIssues`（high → healingAlertRegistry.enqueue + repo.create 双写，
  fire-and-forget 各自失败不阻塞对方）；导出 `SPEAK_HEALING_PARAM_SCHEMA` 供 schema 与白名单同源维护。
- 删除 `src/usecases/healing/healing-report-parser.ts`（parseHealingReport/stripHealingReport 不再有调用方）。
- `src/frameworks/agent/tool-builder.ts`：工具报错尾部提示文案从「speak 末尾用 healing 块」改为「用 healing 参数」。
- `.pi/SYSTEM.md` R5：整段重写为 healing 参数规格，删除 YAML/JSON 两形态与 `[no_issue]` 说明。
- 其余：healing-tools/alert-registry/orchestrator/signal 相关注释去引用已删符号。

**不做**：signal 块仍走 body 内嵌（架构同病但改动面更大，本次聚焦 healing，后续单独跟进）。

## Acceptance Test

- [x] `tests/interface-adapters/agent-runtime/tools/speak-healing-block.test.ts` 6/6（参数法原子性）
- [x] `tests/usecases/healing/healing-alert-registry.test.ts` 11/11（persistHealingIssues 高危路由）
- [x] `npx tsc --noEmit` 0；改动文件 eslint 0；`npm run lint:tool-manifest` 通过
- [x] vitest 全量 5953/5954（仅 durable-runtime 因缺 dist 前置失败，与本改动无关）
- [ ] 合入部署后验证：speak 带 healing 参数时事件入 healing_events 台账，body 无标签泄漏
