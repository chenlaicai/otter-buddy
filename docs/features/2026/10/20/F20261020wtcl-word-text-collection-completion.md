---
id: F20261020wtcl
title: 词文本收编补完——// 前缀族与中缀斜杠族收编（前缀空间穷举表例外 1/4 收口）
summary: delta8（F20261015smrj）前缀空间穷举表两例外收口：例外 1 `//x` ≡ `/x` 功能性旁路（delta4 防 JS 注释误命中而排 //，旁路只在词文本层——path.normalize 折叠双斜杠实证下游天然同判）+ 例外 4 中缀斜杠族（scripts/x 等）不对称缺口。修法=isDirectExecArgv0 内补两族（形状判别：路径安全字符集+≥1 内部斜杠；裸 // 除外保 JS 注释防线），三牙/三态/造-执对通道全复用。frozen 三库（795/82/105 含 TS-b42e23be）零翻转守恒验收通过。
capability_test: tests/frameworks/agent/write-target-evaluator.test.ts（M-1438463a describe 9 钉 + 全文件 140/140）+ guard-touchstone-exam/corpus/v2-real-replay 三库守恒（31 passed + 6 skipped 零翻转）+ 全量 407 files 6486 passed + 6 skipped 零失败 + tsc/eslint 零报
change_type: fix
intent:
  problem: "delta8（F20261015smrj）前缀空间穷举表两例外未收：例外 1 `//x` ≡ `/x` 功能性旁路（delta4 防 JS 注释误命中而排 //，旁路只在词文本层）+ 例外 4 中缀斜杠族（scripts/x 等）不对称缺口——裸直执不进三牙三态，bash 侧早已收"
  expected_effect: "`//tmp/…`/`scripts/x` 裸直执进三牙三态（主仓写内容拦/缺席放行）与 bash 侧对称同判；裸 `//`（JS 注释标记）与 foo$BAR 类例外 2 边界不误收；frozen 三库（含 TS-b42e23be）零翻转"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/agent/write-target-evaluator.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/write-target-evaluator.test.ts
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_by: 守卫修复獭
---

## 问题陈述（delta8 穷举表例外 1/4，M-1438463a）

delta8（F20261015smrj）前缀空间穷举表 17 形态双层实测留 4 例外，本单收口其二：

- **例外 1 `//x.sh`**：X 裸形态双层放 vs `bash //x.sh` 双层拦（对称缺口 ✗）。delta4 为防 JS 注释行误命中（`// foo` 注释行段首词）显式排 `//`，留下功能性旁路——`//tmp/…` ≡ `/tmp/…`（node path.normalize 折叠前导双斜杠实证：`//tmp/x`→`/tmp/x`；`///tmp`→`/tmp`），攻击者换写法即可跳过直执通道（真存在脚本→内容判读、缺席→放行的三态接不上）。
- **例外 4 中缀斜杠族**（`scripts/x.sh`、`node_modules/.bin/x`）：同款不对称（裸形态放/bash 拦 ✗）。delta8 试收编实测翻红 TS-b42e23be（非壳载荷垃圾解析把真实目录参数词误收进牙口→unreadable fail-closed，能力 8 误收面同族），按大獭 M-026d87ff 裁决原则「扰动 frozen 考试的收编必须独立工单带守恒验收」独立成单（M-1438463a）。

## 根因（write-target-evaluator.ts isDirectExecArgv0）

段首直执行位的词文本口径只收「词首特殊字符形态」（`./`、`../`、`/` 排 `//`、`~`、纯展开词）——`//` 前缀被显式排除、中缀斜杠不收。旁路形态：裸 `//tmp/pwn.sh` / `scripts/x.sh` 直执不进三牙通道；而 `bash` 侧（interpreterScriptFileArg 首个非旗参脚本位）两族早已收——单侧缺口。

## 机制判定（修法决策树，动手前）

机制识别检查点：新增配置/状态/定时任务/信号/持久化/记住结果的决策分支/跨模块调用路径——全否。**修法①（narrow-fix，既有语义内修）**：既有词文本判定函数内补两族形态识别，三牙/三态/造-执对/缺席证明通道全复用（buildScriptPayloadPlan 对 shellScriptFileArg 同链自动接上），净新增 1 个内部纯函数（middleSlashPathShaped）。

## 设计取舍

1. **形状判别而非上下文传参**（中缀斜杠族误收防线的核心）：middleSlashPathShaped 判「路径安全字符集（词字符+`._-`）+ ≥1 内部斜杠无空段」，展开/转义序列位以 `x` 占位参与形状。两道误收防线：①非壳载荷垃圾词（`readFileSync('tests/…','utf8')` 类——括号/逗号/引号残渣）形状不符不收（TS-b42e23be 同型单测钉死）；②delta5 例外 2 边界（`foo$BAR`/`kill${IFS}` 类非斜杠动态词不误伤）由「必须含斜杠」天然保住。**被否方案**：给 isDirectExecArgv0 加 shell-text 上下文参数——四处调用点全改签名（「一条语义一个接口」被削弱为两套口径），且 hasOpaqueScriptExec 的 scriptText 门控已覆盖替换型载荷层误收面；形状判别在单一接口内闭环，可独立验证。
2. **裸 `//` 除外**（delta4 防线保持）：`litRaw==="//" && fullRaw==="//"` 不收——JS 注释行 `// foo` 段首词正是裸 `//`（TS-b42e23be 载荷实证含此形态）；`//` 后接展开（`//$VAR`）按 litRaw/fullRaw 分野同收 → 动态位 script-path-dynamic fail-closed（与 `bash //$P` 对称同判）。
3. **`//x`≡`/x` 不做二次归一**：下游 evalPath/resolvesToMainCheckout 经 path.normalize 天然同判（node 实证折叠双斜杠）——旁路只在词文本层一层，收词文本即闭环。镜像义务履行：resolvesToMainCheckout（bash-safety-guard.ts F20260916gtlr）补镜像注记。
4. **中缀动态词同收**（`scripts/$X`→占位形状 `scripts/x`）：不收=「收静态漏动态」的新旁路（与 delta5「双层全漏」教训同构）；走 script-path-dynamic fail-closed 与 `bash scripts/$X` 对称。
5. ⚠️ 已排除路径：只收静态不收展开（新旁路）；中缀族要求脚本后缀（`node_modules/.bin/x` 无后缀漏收——matter 明示形态）；全词 `contains("/")` 判定（delta8 实测翻红 TS-b42e23be 的原形态）。

## 影响范围

- 行为变化：①`//` 前缀族裸形态直执（`//tmp/x`、`///x`）从「不判」进三牙三态（真存在→真实读取内容判读（主仓写拦）/缺席→放行）；②`//` 后接展开动态 fail-closed；③中缀斜杠族（含动态形态）同进三态/动态通道；④裸 `//`（JS 注释标记）、`foo$BAR` 类例外 2 边界、`./`/`../`/`~`/纯展开词既有行为零变化。
- hasOpaqueScriptExec scriptText 门控、interpreterScriptFileArg、guard-model-judge U5 生产层（同源共用）口径自动同步，无第二套判定器。
- frozen 三库零翻转（守恒验收，见验证）。

## 验证

- **单测**：M-1438463a describe 9 钉——// 收编三链对称拦（`//tmp/…` 造-执对×3）、同构三态放（缺席臂+零写面内容臂）、裸 // 防线（TS-b42e23be 同型注释行）、`//$P` 动态对称、中缀收编对称拦（tmpdir 真文件×裸/bash）、中缀三态放、引号形态剥壳同判、TS-b42e23be 同型误收防线（node -e 垃圾词 ALLOW + 裸垃圾词 ALLOW）、`scripts/$X` 动态对称；write-target-evaluator 全文件 140/140
- **守恒验收（本单成立前提，M-026d87ff 裁决原则）**：guard-touchstone-exam（795/82/105 含 TS-b42e23be）+ guard-touchstone-corpus + guard-v2-real-replay 三库 **31 passed + 6 skipped 零翻转**
- **全量**：407 files **6486 passed + 6 skipped 零失败**；tsc 0 / eslint 0
- **穷举表行级对照**（delta8 表 17 形态）：例外 1 行（`//x.sh`）翻「双层同判 ✓」、例外 4 行（`scripts/x.sh`、`node_modules/.bin/x`）翻「同判 ✓」，其余行经既有 delta4/5/8 单测钉死零变化；例外 2（`foo$BAR`）与例外 3（纯词 vs bash 文件操作数）边界保持
- **最简实现**：单一判定函数内补族 + 1 个内部纯函数，无新依赖/新通道/新文件（测试除外）

## 残余记档（修复时须同步翻红对应钉/本节）

- **反斜杠转义组合**（`scripts\/x`、`\x2f` 拼接）不满足形状不收——与既有 `./x` 家族转义组合边缘同级（改口径须全家族同改）
- **`//path` 形状的 JS 注释行起点**（如注释行 `//tmp/x is a path` 的段首词 `//tmp/x`）会被收——fail-closed 方向（真存在→内容判读/目录→unreadable 拦；`//tmp` 类注释起点罕见），与 `/*` 注释标记今日既有面同类，入误拦台账口径
- wrapper 剥除形态两层同缺、xargs stdin→args 语义近似（F20261020c2sm R2 记档）均不变
