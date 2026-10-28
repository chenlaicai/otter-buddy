---
id: F20261028runfa
title: 脚本运行器族收编 jshell/Rscript/lua/octave——非 SCRIPT_RUNNERS 解释器载荷零判读收口（#1491 残留面）
summary: "#1491 主诉面（node/python 文件形态零判读）已由 F20261019gses P0（#1523）闭合（探针核实）；本轮收口案面补记残留面：jshell/Rscript/lua/octave 非集内解释器真写主仓双层漏——SCRIPT_RUNNERS 扩员四名（小写口径，resolveExecHead 归一）+ 后缀门 .r/.jl + R/Java 写面词面三处同源收编。定向 225/全量 7335 零翻红，题库零命中不翻现役题。"
change_type: fix
capability_test: tests/frameworks/agent/write-target-evaluator.test.ts #1491 describe 块（8 条：真写四形态 fail-closed/落点披露 + 只读零误伤 + 文件形态后缀门）
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [bash-guard, script-runner, write-target-evaluator]
modules: [src/frameworks/agent/payload-extract-aux.ts, src/frameworks/agent/write-target-evaluator.ts, src/frameworks/agent/write-word-face.ts]
causal_links:
  - F20261019gses（P0 已闭合主诉面：node/python 文件形态三牙通道 + 运行时 sourcing——本特性是其收编面的族扩）
  - F20261015smrj（语义模型重裁与三牙通道基座；其 delta4 建议①即 #1491 案面补记本轮收口）
  - issue #1491（本特性实施载体）
---

## 问题陈述

#1491 立案（10-14）：node/python 等非 shell 解释器外置脚本文件形态零判读（`node build.js` 正面放行，脚本可写任意主仓落点）。

**主诉面已闭合（本轮探针核实）**：F20261019gses P0（#1523，10-19 合入）把 SCRIPT_RUNNERS 文件形态接进 shellScriptFileArg 三牙通道 + fsContentPlan 运行时真实读取——`node build.js`（脚本含 writeFileSync 主仓）现正确披露 `/repo/project/data/pwned.txt` 写落点；只读脚本、absent（文件不存在）各归各位。issue 由此悬空未收。

**残留面（issue 案面补记，delta4 复核建议①）**：jshell/Rscript/lua/octave 等不在 SCRIPT_RUNNERS 的解释器——载荷提取以 SCRIPT_RUNNERS 身份为前提，集外解释器零判读：

| 攻击向量（探针实证，修复前） | 判定 |
|---|---|
| `jshell <<'EOF'` + `Runtime.getRuntime().exec("touch 主仓")` | evaluated []（双层漏） |
| `Rscript -e 'file.create("主仓")'` | evaluated []（双层漏） |
| `lua -e 'io.open("主仓","w")'` | evaluated []（双层漏） |
| `octave --eval 'fopen("主仓","w")'` | evaluated []（双层漏） |

## 根因与修法

1. **SCRIPT_RUNNERS 扩员**（payload-extract-aux.ts）：+jshell/rscript/lua/octave。⚠️ 大小写坑：resolveExecHead 归一执行名为小写（`Rscript`→`rscript`），集合成员必须小写——首版写 `Rscript` 导致 isScriptRunnerSeg 判 false 静默不收，探针当场抓出。
2. **文件形态后缀门**（SCRIPT_FILE_SUFFIXES）：+`r|lua` + i 旗标（R 惯用后缀含大写 .R；lua 无雷同词；r1 检视后定稿）。jsh/m/jl 后缀不收（宽泛风险或死条目；julia 不在集内）——无后缀文件形态走保守放行侧不变（issue 主战场是内联/heredoc 载荷，非文件形态）。
3. **R/Java 写调用词面收编**（三处同源同步，词表漂移=双链反判）：
   - SCRIPT_WRITE_TOKENS（write-target-evaluator.ts:1016）：+`file.(create|append|copy|rename|remove|unlink|link)(`、`dir.(create|unlink)(`、`writeLines(`、`write.table(`、`fwrite(`、`saveRDS(`、`Runtime.getRuntime().exec`
   - PAYLOAD_WRITE_FACE（write-word-face.ts）同款同步
   - 措辞：Rscript -e 载荷的 file.create 落点提取（R 语法首参）不在 evalScriptWriteTargets 的 node/python 调用形态正则内——词面负门兜底 fail-closed（写证据在但落点求值不出 → 保守回落），安全语义达成；lua 的 `io.open("p","w")` 命中既有 `open(...,'w')` 形态A正则，落点正确披露。

### 机制判定（动手前完成）

未命中机制预算四问——不新增守卫机制：扩员既有三牙通道域（集合 + 后缀门 + 词面正则），既有语义内修，Modification-Class = narrow-fix。

## 验证

- 定向：write-target-evaluator.test.ts 全量 225（217 旧 + 8 新）passed；守卫族四文件 811 passed
- 全量：7335 passed / 6 skipped（基线 7303 + 新 8 + 沿带 24），零翻红
- 修复前失败证据：探针四形态 evaluated []（上表）；修复后同四形态 unevaluated/落点披露
- 题库核对：guard-touchstone-*.json 对 jshell/Rscript/lua/octave 零命中——收编不翻任何现役题
- 两条现役题（TS-74fd58ae/TS-10eb58ff）在新语义（P0 后 absent 三态）下结论不翻：TS-10eb58ff 的 usage_check.py 走 fsContentPlan（文件不存在→absent 零写面）；套件全绿即守恒证据。裁决注记过时（仍是旧词面证措辞），不需翻案——结论未变仅依据描述滞后

## 边界与记档

- **R 落点提取不完整**（记档）：file.create 首参落点静态求值未实现（evalScriptWriteTargets 无 R 调用形态）——词面负门 fail-closed 兜底，安全面达成；树内合法 R 写（写 worktree/tmp）会被误拦回落——保守方向，可接受，P2 载荷 AST 再收
- **octave --eval 全形态 fail-closed**（r1 检视记档）：octave 无内联旗标位通道（--eval 走 heredoc 负门），只读 --eval 也 fail-closed——保守方向，可接受；只读面走文件形态正道（后缀门 .m 未收，无后缀默认）

### r1 检视处置（检视獭-1491，2026-10-28）

严重 2（三坑叠加，全部修复）：① isRunnerArgv0 裸比无小写（Rscript 大写官方拼写落错分支）→ 裸名一律小写化再比；② dispatch 硬编码后缀正则第 4 份同源表未同步 → 补 r|lua + i 旗标；③ 后缀门区分大小写（.R 不入门）→ i 旗标。回归钉：大写 Rscript+.R fail-closed。
建议处置：① .lua 漏收 → 已收（探针：真写脚本落点披露）；② .jl 死条目（julia 不在集内）→ 已删；③ 代码注释 FID 与 doc 不一致 → 已统一 runfa；④ octave --eval 全形态 fail-closed 未记档 → 已记档（上节）。
恒真测试（不存在的文件 + 断言 ≠ parse-failed）→ 改真 fixture + fail-closed 断言。
- **jshell 文件形态**（记档）：.jsh 后缀未收（宽泛风险同 jsh/m）——内联/heredoc 已收编，文件形态保守面不变
- **Runtime.exec 双身份**：SCRIPT_WRITE_TOKENS 与 SCRIPT_EXEC_FACE（执行面负门）同词不同面——先命中先判，不冲突

## 最简实现检查

已过最简检查：三处改动均为集合/正则扩员（+1 行集合成员、+2 后缀、+6 词面分支），无新文件、无新依赖、无新通道——站在 F20261019gses P0 通道上扩域，未重复建设。
