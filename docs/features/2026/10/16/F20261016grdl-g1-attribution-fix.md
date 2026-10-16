---
id: F20261016grdl
title: bash 守卫基建（一期止血 1a/1b/1c）：判定基元排除区下沉 + 落点感知豁免 + ruleId 指纹补齐
summary: |
  G1 归因（healing 台账 10/16 六例 + 调查期亲历三例，生产日志/原 session jsonl 双锚）
  修正诊断演进链：v1「V1/V2 双链不对称」（×，连接图错误）→ 检视「通道散落豁免」（表象）
  → 真根因「判定基元 isInsideMainCheckout 不知道排除区 + 豁免按形态后挂」。修复：
  ① 基元下沉排除区（MAIN_CHECKOUT_WRITE_EXEMPT_REGIONS，root 级锚定防 decoy）；
  ② one-liner 落点感知豁免（onelinerAbsPathsOutsideMain，按载荷逐个判防聚合洞）；
  ③ 段级 cd 豁免（segmentCdExemptsGitLiteral + checkSegmentStructuralWrite 段序列 cwd
  跟踪——混合段命令族 E）；④ guard-intercept-classify 补 main_write_resolve 指纹
  （:1935 文案是 10/16 全部 70 条 ruleId=unknown 的直接来源）。行为变更（4 用例翻转）：
  写动词+落点全部合法 → 放行（旧 fail-closed 不看落点=误拦面）；管道负门收窄为
  落点语义。G1 归因报告与完整命令提取件在工作区 drafts/。
change_type: bug_fix
capability_test: tests/frameworks/agent/bash-guard-grdl-g1-fix.test.ts（24 用例）+ 全量 1708 passed + tsc clean + eslint clean
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
causal_links:
  - F20261016grdl-bash-guard-reliability（本方案文档，Design 三 commit：b8b06734/dfa19c10/8d3b9aec）
  - F20261015gsub（守卫定位收敛——军备规则族已删，本次在其兜底面上修误拦）
  - F20261015phys（物理沙箱已默认开启——main_write 预判面退役的换血前提，二期 2b）
  - F20260916b1ea（恢复语义 at-least-once 设计取舍先例——「没有损失证据不动设计」同款纪律）
---

# bash 守卫基建一期止血：基元下沉 + 落点感知 + 指纹

## 背景 / 意图锚

- 搭档 10/16 11:12（原话）：「咱们的 bash守卫一直在反复修改、一直在出问题。dots中有相应的设计方案吗」
- 大獭三步走方案（F20261016grdl 设计文档）一期止血：G1 归因先行 → 不归因不修
- G1 归因执行：healing_events 六例（sqlite 直查）+ 生产日志 BLOCKED 出口（messageId 锚）+ session jsonl 完整命令提取 + harness 复现 → 归因四族（A/B/C/D + 实现期发现 E）

## G1 归因结论（证据件：工作区 drafts/g1-attribution-report.md + g1-full-commands.json）

诊断演进链（防未来按旧叙事修，全链留痕）：
1. v1 方案：「V1/V2 双链不对称，排除区语义只在 V2 求值器」——**错**：write-target-evaluator 不被 bash-safety-guard import，不在 bash 双链任何一链上（检视獭 S1 复验）
2. 检视修正：「通道散落豁免，heredoc 字面通道没吃到」——**表象**：通道只是豁免的挂载位置
3. **真根因（本 PR 实证）**：判定基元 `isInsideMainCheckout` 只判「主仓树内」，不知道 data/workspaces、.otter/worktrees、.otter/workforms 是排除区（物理在树内、语义不属主仓工作树）——所有豁免都以「通道×形态」后挂，每种新形态都要单独撞墙（30+ issue 族谱的生成机制）

四族误拦（全部实证，例证含 healing id）：
- **族 A**（例 1/2/4/6）：排除区绝对路径写形态无豁免分支——`cat > <workspaces>/x <<EOF`、`cat >> <worktrees>/x <<EOF`
- **族 B**（例 3/4/6）：one-liner 载荷 fail-closed 吞只读/树外写——`python3 -c` 含转义引号/f-string → 提取失败或写动词不在白名单 → 保守拦，不看落点
- **族 C**（例 5）：`PAT=$(cat …); curl POST` ——$() 赋值 + 网络载文误进写族（例 5 复现已放行，通道归因：$( 赋值前缀形态在守卫收敛 gsub 后不再触发；网络外发窄规则按方案 S5 属保留面，本 PR 不动）
- **族 D**（亲历 3 例）：retry-policy.ts:72 对所有 bash_safety 拦截无差别拼「主进程是海獭运行环境」kill 域文案 + 诊断块「进程名模式」标签——main_write 误拦被包装成 kill 违规（展示层，ruleLayer=self_kill 是 UNKNOWN_RULE 兜底值）；三例复现全放（守卫本体不拦），**展示层文案拼接是独立小修，挂本 PR 后续**（见「下一步」）
- **族 E**（例 1 完整形态，实现期发现）：混合段命令——`cat > <ws>/m <<EOF…EOF` + `cd <worktree> && git commit -F …`：modelCdExemption 只认首段链 cd（首段是 cat）→ 无豁免；cwdInGitWorktree 锚 sessionCwd（=workspace 非 git 工作树）→ 不豁免；git 写族字面通道吃掉 commit 段

## 修复设计

### 1a' 族 A 治根：基元下沉（isInsideMainCheckout）

```ts
const MAIN_CHECKOUT_WRITE_EXEMPT_REGIONS = ["data/workspaces", ".otter/worktrees", ".otter/workforms"];
// isInsideMainCheckout 内：目标在排除区（root 级锚定）→ false
```
- 三通道（redirect/字面/one-liner 锚 :1788/:2021/:2030）一次继承豁免，未来新形态自动继承
- root 级锚定防 decoy：区域 = projectRoot/<region> 前缀精确锚定，主仓内 src/data/workspaces 同名嵌套不匹配
- 同源契约：区域清单与 write-target-evaluator.ts OTTER_RUNTIME_REGIONS 语义同步（改动两侧同步）

### 1a'-B 族 B：one-liner 落点感知豁免（onelinerAbsPathsOutsideMain）

- python/node 载荷逐个判（**非聚合**——聚合洞实证：delta r3 H1 掩蔽写用例，只读载荷的 /tmp 路径曾为掩蔽写载荷开绿灯，修后仍拦）
- 每载荷：含绝对路径 → 全部落主仓外才豁免；无绝对路径 → cd 段锚定非主仓 cwd 才豁免（否则该载荷是不安全面）
- 挂点两处（同一豁免基座原则）：writeChannelExempt（正则通道 pi 1-4）+ checkSegmentStructuralWrite→judgeSegment（结构通道——例 6 实际出口在此，只挂正则通道时仍拦）

### 1a'-E 族 E：段级 cd 豁免

- `segmentCdExemptsGitLiteral`：任一段位 cd 目标可静态求值（绝对路径、无变量/展开、非 ./..）且落主仓树外（排除区或树外）→ 该 cd 段后的 git 写族字面命中免除（& / | 切断的子 shell 不豁免）
- `checkSegmentStructuralWrite` 段序列 cwd 跟踪：遇 cd 段更新 trackedCwd，judgeSegment 用段内生效 cwd 判 git 落点（git 分支内：sessionCwd 落 .otter/worktrees 区 → 不拦）

### 1b ruleId 指纹补齐（guard-intercept-classify）

- 指纹表补 `main_write_resolve`（「写命令落点解析到主仓（session 工作目录=」+「主仓相对路径写落点解析到主仓」）——:1935 文案不在表里是 10/16 全部 70 条 ruleId=unknown 的直接来源（#844 误报聚合路线由此打通）

### 1c 分账派生（随 1b 免费获得）

- ruleId=main_write* → 误拦嫌疑；habit（sleep）→ 引导；self_kill* → 进程域。数据源 healing_events，验收口径见设计文档验证 6（交付后第 7 天复盘门）

## 不兼容更新（行为变更锚点，4 用例断言翻转）

| 旧行为 | 新行为 | 翻转用例 |
|---|---|---|
| one-liner 写动词 fail-closed 不看落点（`open('/tmp/f','w')` 拦） | 写动词+载荷绝对路径全部树外 → 放行 | bash-safety-guard.test.ts「S1 对照」→放 |
| 管道负门：node 写 worktree + \| tail 拦（cd 豁免被管道杀） | 落点排除区 → 放行；落点主仓/相对路径写仍拦 | gduc P0-1 / gdcc 双链一致 / shadow-eval 三处 →放 |

安全边界不回退（新增用例钉死）：主仓绝对路径写拦 / 相对路径写（cwd 主仓树内）拦 / 掩蔽写拦（聚合洞修复后）/ git -C 主仓拦 / data 破坏护栏完整（跨会话工作区删拦、data 根删拦、cd 主仓 rm -rf data 拦）/ cd 变量不可求值拦 / & 切断子 shell 拦。
已知边界（行为保持，非本次变更）：`cd <主仓> && git commit` 放行（显式意图，F20261014cwsp 已声明收紧属独立立项）。

## 影响范围

- src/frameworks/agent/bash-safety-guard.ts（+3 函数，基元改造）
- src/frameworks/agent/guard-intercept-classify.ts（指纹表 +2 条目）
- tests：bash-guard-grdl-g1-fix.test.ts 新增（24 用例）；4 用例断言翻转（上表）
- 二期 2b（守卫写面退役给沙箱）的前提之一「误拦止血」由本 PR 达成

## 下一步

- 族 D 展示层：retry-policy.ts:72 kill 域文案无差别拼接 → 独立小修（按 ruleLayer 分流文案），随二期或独立 PR
- 二期 2a/2b/2c：沙箱可用性探测 + main_write 族条件退役（G3 枚举表门）+ 保留面
- harness 与生产 redirect 通道差异（例 1 复现需长体）：实现期已消解——完整命令（session jsonl 提取）复现成功，差异源是此前 harness 用骨架命令（短体）不含族 E git 段
- T4 验收：交付后第 7 天 healing guard_intercept 分账复盘（1c 口径）
