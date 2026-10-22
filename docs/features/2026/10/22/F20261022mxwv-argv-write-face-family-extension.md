---
id: F20261022mxwv
title: 造-执对族外延收编——sed -i/tar/unzip/rsync 写面族 + dot-source 对称根修（M-f6762368）
summary: argv 写面族外延（原地编辑/解包/同步）不进造-执对配对与写目标提取（实测全 ALLOW），收编四族双面 + dot-source 执行段对称根修（canonicalExecName 版本剥离吃空「.」）；touchstone 放行池 2 条真实造+执命令随修复语义有意重定基（棘轮 +2 键，呈评审裁决）。
change_type: fix
capability_test: "n/a: 纯 A 类求值器行为修复，无 LLM 参与行为"
intent:
  problem: "argv 写面 8 族（F20261019wvcp）已进造-执对配对，族外延 sed -i/perl -pi/ruby -pi/tar/unzip/rsync 不进配对也不进写目标提取——`sed -i … /tmp/g.sh && python3 /tmp/g.sh` 造段不被回扫、执行段 absence 证明放行（TOCTOU 假证明），tar/rsync 直写主仓 ALLOW；附带 dot-source 执行段缺口（canonicalExecName 把「.」剥成空名，source/dot 同义词不对称）"
  expected_effect: "四族写面进 writerContent（content=null fail-closed，tar/unzip/rsync 目录性写面前缀匹配）+ 写目标提取补齐 + dot/source 对称；造+执形态全 BLOCK，纯读/良性写不误拦"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-22
from:
  - F20261019wvcp
tags: [guard, write-target-evaluator, creator-exec-pair, fail-closed]
modules: [guard]
---

# 造-执对族外延收编 + dot-source 对称根修（M-f6762368）

## 基线复现（探针 /tmp/probe-f6762368-baseline.txt，worktree @742f0ca1）

| 面 | 形态 | 修复前 | 判定 |
|---|---|---|---|
| 造-执对 | sed -i 造 + python/source/dot 执行 | **ALLOW** | 族外延真洞（cp 对照组 BLOCK） |
| 造-执对 | tar/unzip/rsync 造 + dot 执行 | **ALLOW** | 族外延真洞 |
| 造-执对 | cp 造 + dot 执行 / echo 内容造 + dot 执行 | **ALLOW** | dot 对称洞（source 对照组 BLOCK） |
| 写目标提取 | tar -C /repo、rsync → /repo/dest/ | **ALLOW** | 提取双缺 |
| 对照 | sed -i 写主仓、bash file 通道、find -delete | BLOCK | 既有语义在位 ✓ |

**根因两条**：
1. **族外延缺席**：writerContent/argvWriterContent 与 evalExtendedWriteTargets 只认 8 族 argv 写面，sed/perl/ruby 原地编辑与 tar/unzip/rsync 写面不产出写面条目——配对回扫跳过、提取空集放行。
2. **dot 对称缺口**（P1 排查中发现，与族外延同识别基座）：`canonicalExecName(".")` 版本剥离正则 `[\d.]+$` 把「.」整体吃成空名 → `SCRIPT_FILE_RUNNERS.has("")` 恒 false → dot-source 执行段不进载荷判读（source 进、dot 不进）。探针插桩定位（/tmp/probe-debug.txt：`interp bare="." inSet=true` 后静默 null）。

## 修法（修法决策树① 既有语义内修，narrow-fix）

「造出内容为权威载荷、可重建则判读、不可知则 fail-closed」（F20261019wvcp 语义）在漏收写法上的执行补齐：

- `inPlaceEditFiles` 抽出共用（提取与造-执对一条语义一个接口）：sed -i/perl -pi/ruby -pi 精确文件写面 content=null
- `archiveFamilyTargets` 新解析：tar（x=解包写 -C 目录、c/r/u=归档文件写、t=纯读、模式不明保守 uncovered）、unzip（-l/-t/-Z 纯读、否则 -d 目录）、rsync（-n 无写、dest=末位置参数）
- WriteFaceEntry 增 `dirWrite`（目录性写面）：配对匹配从纯精确扩到前缀命中（writeFaceMatches——解包/同步写目录下任意文件）
- canonicalExecName 空名护栏：版本剥离剥空即回原文（1 行，dot 对称根修）
- 机制识别检查点：全未命中（无配置/存储/生命周期/跨模块调用路径新增；目录性写面匹配是既有配对接口的匹配语义扩展）

**不军备化（#1513 之尺）**：不猜 tar 归档内容文件名——目录性写面前缀匹配即止；不建 rsync basename 语义模型——一律目录性保守归位。

## touchstone 棘轮有意重定基（⚠️ 评审裁决点）

放行池 **2 条**真实命令随修复语义转 fail-closed（exam 棘轮 +2 键，guard-touchstone-exam-gaps.json）：

- **TS-4a2dc895**：`node -e "…writeFileSync('/tmp/lint-test-copy.mjs',…)"; sed -i '' '…' /tmp/lint-test-copy.mjs; node /tmp/lint-test-copy.mjs`——sed 造段 × node 执行段同链，执行内容=改写后不可重建
- **TS-f3b397ad**：`sed -i '' '…' smoke3.tmp.mjs; …; node smoke3.tmp.mjs`——同型

**为什么不是回归而是修复语义本身**：两条的原放行裁决只按 §3.2.1-1「写证据落点全树外→按落点判放行」，**未含造-执对维度**——执行文件由同链造出（eval 时未落盘 → absence 证明），是 TOCTOU 假证明（运行时造+执行）。M-f6762368 的立案动机正是此形态「实测全 ALLOW」。按棘轮机制走「有意重定基」通道（EXAM_REGEN 语义，评审看 diff）：+2 键、0 收缩、block/cond 池零变化。**本重定基须检视/裁决确认**——若裁决维持放行，替代口径是造-执对让位显式载荷声明（`entry ?? planned`），但那削弱「造出内容为权威载荷」，不推荐。

## Verification（证据链）

**修复前红证**（vitest write-target-evaluator-family-extension.test.ts 首轮，12 failed | 7 passed）：族外延/dot/提取 12 形态全红（`expected false to be true`），放行侧 7 钉绿。
（时序注：并行批中 dot 根修一行先落地，二轮 capture 为 10 红——dot 两项先行转绿；完整红证以首轮 12/7 为准。）

**修复后绿证**：
- 矩阵 19/19 绿（造-执对 7 + dot 对称 2 + 提取 4 + 放行侧 6）
- **守卫域全量回归 77/77 文件、2088 passed | 6 skipped**（含 guard-touchstone-exam 三池）
- 基线对照：exam 在干净 main@742f0ca1 上 3 passed（GAP 归因实验：canonicalExecName 单独绿、wte 改动引入 2 键差——全程补丁存档法对照，/tmp/probe-f6762368-fix.patch）

## 剩余风险与非目标（诚实边界）

- rsync dest 一律目录性写面（前缀匹配）——单文件 dest 形态略过宽（保守侧，fail-closed 方向）
- tar 旗标簇解析只认 f 值位与常见长旗标——冷僻形态（--files-from 等）落 unknown→uncovered-cmd 保守拦
- wget `-qO-` 假阳落点（F20261021pdex 归档 M-f6762368 的旗标提取面）**不在本单射程**，维持记档
- M-48ac4e39（find -exec 执行体破坏面）/ M-dd668952（stash 落点豁免洗白）经基座分析为异构（前者 guard 破坏面规则、后者 evalGitWrite 落点解析），按拆单结论独立处理
