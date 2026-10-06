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

- **负门判定保守侧**：未闭合体/路径解析失败不触发阻断（回既有判定链，不扩面）；Windows 盘符路径在 mac/linux 主仓判定下永不落主仓，跳过不阻断。
- **只拦绝对路径落主仓**：相对路径写（`open('data/x','w')`）语义上落 cd 后的 cwd（/tmp），非主仓——不拦，正道放行。这与 modelCdExemption 的原始语义（cd 落点即工作目录）一致。
- **Modification-Class**：narrow-fix——既有 cd 豁免语义内加负门条件 + 两个段感知辅助函数，无新机制、不改模型层。

## 验证

- 新增 7 用例（tests/frameworks/agent/bash-safety-guard.test.ts，#1275 describe 块内）：
  - 攻击面 3：#1240 复现（rmtree 主仓 data）、open 写主仓 config、cd worktree + 体写主仓绝对路径（负门挡 cd 豁免，与 cwd 无关）
  - 放行面 4：相对路径写（cwd /tmp 非主仓）、绝对路径写非主仓（/tmp/scratch）、绝对路径读主仓（纯读探查）、cd worktree 正道（体内无绝对路径落主仓）
- 全量：守卫测试 370/370（363 基线 + 7 新增）、agent 全目录 1075/1075、tsc --noEmit 干净、eslint 干净。
- 反向验证：修复前 main 上 7 用例中 3 攻击面全放行（端到端 dbg 实证 r1/r2/r3 全 null）——真锚。
- Golden Gate: n/a（纯正则/路径判定逻辑，无 prompt/skill/协议层软代码变更）。

## Known Limitations

- 负门只覆盖 **python** heredoc 体——node/ruby/perl heredoc 体的绝对路径写主仓在 `cd <非主仓>` 形态下仍走顶层豁免（node 体有 #1207 白名单门在 `checkHeredocScriptBodies`，但模型路径下 cd 豁免 return null 同样旁路）。评估：node 体白名单判定在模型路径 1278 行之后独立运行（checkHeredocScriptBodies），非只读体在那一层被拦——python 是唯一「体判定完全挂靠在主仓写检测内」的解释器，故负门单点覆盖即可闭环。ruby/perl heredoc 无体判定链（全拦 fail-closed），不受影响。
- 体内路径拼接（`os.path.join('/repo', 'data')`、变量接收路径）不在静态字面量覆盖面——与 #1207 白名单判定同型局限，由 denylist 签名（`os.\w` 非白名单即非只读）兜底：拼接形态体必含 `os.path` → 非只读 → 写判定拦，但「落主仓」维度不感知（cd 豁免形态下拼接路径写非主仓也会被拦——保守侧，可接受）。

## 后续动作

- 随 PR closes #1240。
