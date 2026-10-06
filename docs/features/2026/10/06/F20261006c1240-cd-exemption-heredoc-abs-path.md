---
id: F20261006c1240
title: modelCdExemption 豁免粒度收窄：python heredoc 体绝对路径落主仓负门
summary: cd <非主仓> && python heredoc 体绝对路径写主仓的逃逸链封堵——cd 豁免加负门（体含绝对路径落主仓 → 不豁免），配段感知体只读判定防纯读误拦
change_type: fix
capability_test: "n/a: 纯防御性拦截逻辑（正则/路径判定），无 LLM 行为面"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [bash-guard, main-checkout-write, heredoc, cd-exemption, security]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
from:
  - F20260928grv2
  - F20260930l573
causal_links:
  - "#1240（9/29 登记，F20260930l573 known_limitations 显式记录）：modelCdExemption 粒度是整条命令——cd 落点非主仓即全豁免，不感知 python heredoc 体内绝对路径操作"
created_at: "2026-10-06"
intent:
  problem: "`cd /tmp && python3 - <<'PY'\\nimport shutil\\nshutil.rmtree('<repo>/data')\\nPY` 形态下，heredoc 体内绝对路径的主仓写/删操作被 modelCdExemption 顶层豁免放行（#1240）"
  expected_effect: "修复后该逃逸形态 100% 拦截；正道（cd 非主仓 + 相对路径写/非主仓绝对路径写/纯读探查）零误拦"
  verify_by:
    type: behavior_check
---

# modelCdExemption 豁免粒度收窄（#1240）

## 背景与逃逸链

**issue**：#1240（9/29 登记，F20260930l573 known_limitations 显式记录的遗留面）。

**逃逸形态**：
```
cd /tmp && python3 - <<'PY'
import shutil
shutil.rmtree('/repo/data')
PY
```

**逃逸链三段**（均有 file:line 锚点，修复前 main ea437d60）：

1. **顶层豁免粒度=整条命令**：`modelCdExemption`（guard-model-judge.ts:639）判定「cd 落点静态可求值且非主仓 → 整条命令豁免主仓写检查」——不感知 heredoc 体内的绝对路径操作。`cd /tmp` 落点非主仓 → 全豁免。
2. **detect/allow 判定不对称**：V1 检测侧用静态 `hasRealCdSegment`（bash-safety-guard.ts:1039），放行侧用模型版——`cd /tmp` 时检测=有写、放行=豁免 → 端到端 allow。
3. **体级检查被旁路**：`checkMainCheckoutWrite` 中 cd 豁免 `return null`（bash-safety-guard.ts:1067）直接旁路了后续 `MAIN_WRITE_PATTERNS[0]`（python heredoc 通道）+ 体只读门判定——体内容从此无人查。

## 修复设计

**负门前置**：cd 豁免生效前，先查「python heredoc 体是否含绝对路径字面量落主仓树」——含则不豁免，走完整判定链：

- 写形态（`open(...,'w')` / `shutil.rmtree`）→ 体非只读 → `MAIN_WRITE_PATTERNS[0]` 命中 + `heredocReadOnly=false` → 拦
- 纯读形态（`open(...).read()`）→ 体只读 → `heredocReadOnly=true` → pattern[0] 豁免 → 放行（不误伤正道）

**两个同型首词语义陷阱**（实现中发现，均为负门生效的前置条件）：

1. **负门的解释器判定**：`isPythonHeader`（bash-safety-guard.ts:719）是首词语义——`heredocInterpreter` 取 header 首词跳过 wrapper，header `"cd /tmp && python3 - <<'PY'"` 首词是 `cd`（非 wrapper 词表成员）→ 提取出 `cd` 非 python → 负门 span filter 后为空，永不触发。修：新增 `heredocHeaderIsPython`——按 shell 语义取 header 中 `<<` 前最后一个命令段（`&&`/`||`/`;`/`|` 切分）跑 `heredocInterpreter`。
2. **体只读判定的同型失效**：模型路径 1278 行传 `pythonHeredocBodiesReadOnly(command)`，内部同样用 `isPythonHeader`——cd 前缀形态下返回 false。负门不触发时顶层 cd 豁免先 return null 不消费该值（零行为变化）；负门触发后该值首次被消费——纯读探查会被误拦（可用性回归）。修：新增 `pythonHeredocBodiesReadOnlySegmentAware`（isHeader 换段感知版，其余逻辑同构），1278 行调用点切换。

**为何不改 `heredocInterpreter` 本体**：它是 #1207 判定链的共享基座（`scriptBodiesReadOnly`/`checkHeredocScriptBodies` 共 5 处调用），改语义影响面不可控；且 fail-closed 语义（首词非解释器→不豁免）在原调用场景是正确保守侧，只有负门/段感知两个新场景需要不同语义。新增专用函数，不动共享基座。

## 设计取舍

- **Modification-Class**：narrow-fix——既有 cd 豁免语义内加负门条件 + 段感知辅助函数，无新机制、不改模型层。

## 检视 r1 处置（检视獭-1301，glm）

初轮检视 7 严重 + 1 建议，全部探针实证（修复前后双跑对照）。处置：

- **发现 1（wrapper 形态拦不住，最严重）**：`cd /tmp && env python3 - <<'PY'` + rmtree 主仓——负门正确触发（段切分后 heredocInterpreter 跳过 wrapper 词），cd 豁免被阻断，但 MAIN_WRITE_PATTERNS[0] 通道正则要求 `python[\d.]*\s+-\s*<<` 形态、不认 wrapper 词前缀 → 端到端放行（拦截链「负门→通道正则」解耦缺口）。**采纳建议修复：负门触发后直接体感知拦**——`负门 && !scriptHeredocBodiesReadOnlySegmentAware(command)` 直接返回 BLOCK_MSG，不再依赖通道正则接力（体感知判定不依赖通道形态）。顺带覆盖发现 2 的无 `-` 形态（`python3 <<'PY'`）。
- **发现 2（无 `-` / cat 管道形态残留）**：无 `-` 形态由发现 1 方案覆盖；**cat 管道形态（`cat <<'PY' | python3 -`）本 PR 不修**——解释器不在 heredoc 头位（最后段是 cat），属另一类判定面（管道右段解释器识别），Known Limitations 补声明 + 建 issue 跟踪。
- **发现 3（拼接形态兜底声明失实）**：原文档称拼接路径「由 denylist 签名兜底」——实测 `p = os.environ['REPO'] + '/data/x'; open(p,'w')` 端到端放行：负门不触发（拼接片段非落主仓绝对路径字面量）→ cd 豁免 return null 旁路全部写判定，denylist 无消费点。**文档如实改写**（见 Known Limitations）+ 建 issue 跟踪。
- **发现 4（node 兜底论证错误）**：原文档论证 node 形态安全时引用 checkHeredocScriptBodies 白名单门——但该门用 isNodeHeader（首词语义，与 isPythonHeader 同型陷阱），`cd /tmp && node - <<'JS'` 形态下失效，实测 writeFileSync 主仓放行。**本 PR 负门扩 node**（同构扩展：heredocHeaderIsInterpreter 双族 + 体判定 nodeBodyReadOnly）。
- **发现 5（CI behind main）**：rebase main 后 force-push。
- **发现 6（src 注释残留旧编号 F20261005g1240）**：两处改 F20261006c1240。
- **发现 7（B5 撞车）**：编排知悉项——#1260/#1297/#1301 同文件并行，大獭仲裁合入序。
- **建议 8（攻击面形态单一）**：补 9 个 r1 用例（wrapper ×2、无 `-`、node 拦/放行 ×2、wrapper 纯读放行、分号拦/放行、cat 管道声明面锚定）。

## 验证

- 用例（tests/frameworks/agent/bash-safety-guard.test.ts，独立 #1240 describe）：
  - 攻击面 7：#1240 复现（rmtree 主仓 data）、open 写主仓 config、cd worktree + 体写主仓（负门挡 cd 豁免，与 cwd 无关）、wrapper env/sudo、无 `-` 形态、node writeFileSync
  - 放行面 8：相对路径写（cwd /tmp 非主仓）、绝对路径写非主仓（/tmp/scratch）、绝对路径读主仓（python/node 纯读探查 ×2）、cd worktree 正道、wrapper env 纯读、分号形态相对路径写
  - 声明面 1：cat 管道形态当前放行（Known Limitations 锚定，防静默回归被误判为「修复」）
- 全量：守卫测试 379/379、agent 全目录 1075/1075、tsc --noEmit 干净、eslint 干净。
- 反向验证：修复前 main 上攻击面全放行（端到端 dbg 实证 + 检视獭 14 形态探针双跑对照）——真锚。
- Golden Gate: n/a（纯正则/路径判定逻辑，无 prompt/skill/协议层软代码变更）。

## Known Limitations

- **cat 管道形态（`cat <<'PY' | python3 -`）不覆盖**——解释器不在 heredoc 头位（header 最后段是 cat），负门段切分识别不出 python。该形态在 `cd <非主仓>` 下顶层豁免放行。属另一类判定面（管道右段解释器识别），建 issue 跟踪；测试声明面用例锚定当前行为（防静默变化）。
- **动态路径拼接不覆盖且无兜底**——`p = os.environ['REPO'] + '/data/x'; open(p,'w')` 形态：负门不触发（体内无落主仓的绝对路径字面量）→ cd 豁免 return null **旁路全部写判定**（含 denylist 签名——它在负门之后的主仓写判定链内，无消费点）。对照：无 cd 前缀时同体被拦（denylist 生效）。cd 豁免形态下该攻击面无防线，建 issue 跟踪（可行方向：负门触发条件扩「体含非只读签名即阻断」——代价是 cd 形态下所有非只读 python heredoc 都被拦，可用性影响需评估）。
- **ruby/perl heredoc** 无体判定链（全拦 fail-closed），不受 cd 豁免负门影响。
- 负门判定保守侧：未闭合体/路径解析失败不触发阻断（回既有判定链，不扩面）；Windows 盘符路径在 mac/linux 主仓判定下永不落主仓，跳过不阻断。
- 只拦绝对路径落主仓：相对路径写（`open('data/x','w')`）语义上落 cd 后的 cwd（/tmp），非主仓——不拦，正道放行。这与 modelCdExemption 的原始语义（cd 落点即工作目录）一致。

## 后续动作

- 随 PR closes #1240。
- 建 issue ×2：cat 管道形态识别、动态拼接在 cd 豁免形态下无兜底。
