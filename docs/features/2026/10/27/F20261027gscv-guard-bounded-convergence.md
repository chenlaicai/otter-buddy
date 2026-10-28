---
id: F20261027gscv
title: bash 守卫有限范围收敛——物理承重、结构化路径与执行域授权
summary: 落实搭档 2026-10-27 方案 C 拍板：停止把 bash 守卫做成无限 Shell 解释器；物理沙箱承担可证明边界，write/edit 走结构化 operations 接防，Git 默认不授 .git 写能力而只给有限工作流精确开口，无沙箱路径保持有限 Best Effort 而非伪装同等安全；先补接防与观测再退役旧规则。
change_type: refactor
capability_test: "n/a: 文件与 Git 守卫均为确定性代码行为，由 tests/frameworks/agent 的 A 类单测和真实 SDK/sandbox 集成测试覆盖"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-27T14:48:00+08:00
causal_links:
  from: [F20261015gsub, F20261015phys, F20261019gsbx, F20261019gses]
tags: [bash-guard, sandbox, bounded-evaluation, structured-file-tools, git-execution-boundary]
modules: [src/frameworks/agent, docs/designs/bash-guard-constitution.md]
doc_type: Implementation
intent:
  problem: "bash 词面规则持续扩张，但 write/edit 与 Git 元数据缺少结构化/物理边界，旧规则也缺少可消费退役数据"
  expected_effect: "write/edit 在真实副作用前拒绝主仓、Git 元数据和链接穿透；未识别 bash 命令没有 .git 写 capability，登记 worktree 的直接 Git 工作流可用，拦截可按 ruleId/operation/assurance 聚合"
  verify_by:
    type: behavior_check
---

# bash 守卫有限范围收敛

## 1. 背景与方向裁决

### 1.1 问题不是沙箱无效，而是有限边界没有兑现

F20261015gsub 已确定：bash 守卫防常见 LLM 误操作，不追求百分百识别混淆脚本；物理隔离负责真正的边界。F20261015phys 随后提供 macOS 文件写与信号沙箱，F20261019gsbx 在沙箱可用时退役文件写求值，F20261019gses 将无沙箱文件写判定切换为语义求值。

这些方向不必推翻。后续漂移发生在三处：

1. 将沙箱未覆盖的 `.git`、write/edit、网络及无沙箱路径继续交给 bash 规则追全；
2. 将「有限求值 + 求值不出时保守处理」改成「所有求值不出都是需要消灭的缺陷」；
3. 新样例默认变成永久扩规则与新增测试义务，而宪法写明的退役消费方未接通。

GLM 独立审视与 Kimi delta 复核（2026-10-27，本对话）一致确认：**沙箱方向正确，有限求值有用途；无限 Shell 语义、无限词面和无退役机制错误。** 双方曾误判 write/edit 已有求值器接线，查阅当前代码后已共同撤回。

### 1.2 本次搭档裁决

2026-10-27 14:46，搭档选择方案 C，原话：

> 确认方案 C：沙箱承重、规则有限、结构化路径与授权补位；停止无限扩面，按此做收敛设计

这是本文的产品与技术边界依据。搭档随后明确要求「要完整实现，不要纸上谈兵，或者分长期计划」并要求「功能要快速合入，然后实践出真知」；本 PR 因此把 Phase 1-4 的代码接防、有限规则迁移与月度消费一次落地，不把核心功能留给后续工单。

### 1.3 事实基线

- 设计 worktree 基于 `origin/main@f35a53db`（2026-10-27 创建时 fetch 实测）。此前审视基线为 `e8e353a2`；main 后续前进不改变本设计的核心判断。
- `src/frameworks/agent/bash-sandbox.ts:84-122`：主仓 deny file-write，白名单含 workspaces、worktrees、workforms、主仓 `.git`、alpha 与 tmp；`:118` deny signal。
- `src/frameworks/agent/bash-safety-guard.ts:2391-2413`：sg=true 时文件写求值与 heredoc 负门退役，其余保留面继续执行。
- `src/frameworks/agent/model-runtime-registry.ts:406-438` 与 `circuit-breaker-helpers.ts:352-379`：beforeToolCall 门与 subscribe/abort 兜底双通道；subscribe 不是唯一可靠的物理拦截点。
- 当前没有 write/edit 的路径守卫调用。`evaluateWriteVerdict` 接收 bash 字符串，不能直接充当结构化文件工具守卫。
- pi-coding-agent 1.1.0 已提供 `WriteOperations`、`EditOperations`；`createSandboxedTools` 已覆写 base tools，但 write/edit 仍使用默认 operations（`bash-sandbox.ts:189-223`）。
- #1654 已合入；#1638 仍 open。`fix-1542-evaluator-cp` worktree 存在，按可能在途处理，本设计不接管。

## 2. 目标与非目标

### 2.1 目标

1. 明确每层能提供何种保证，停止将物理安全、结构化判定与 Best Effort 混称。
2. 常见工作流有稳定、低摩擦的合法通道；常见直白危险操作仍可被拦截。
3. write/edit 在真正副作用 operations 上接防，不解析 bash，也不只检查工具入参文本。
4. Git 写从「枚举壳形态」转向「执行域最小授权」；未知复杂形态不得因此获得 `.git` 写能力。
5. 无沙箱路径保持有限规则范围，未知可以更保守，但不追求完整脚本理解。
6. 旧规则只在替代边界有等价证据后退役，契约测试随边界迁移。
7. 真实生产误拦/真洞和范围扩张成为复盘对象，规则可退役。

### 2.2 非目标

- 不实现完整 Shell、Python、JavaScript 或动态语言解释器。
- 不承诺识别所有对抗性绕过、编码、反射、命令替换或构造—执行链。
- 不在本轮新建通用特权 broker、完整网络沙箱或跨平台物理沙箱。
- 不以 open issue 清零、代码行数零净增或所有攻击样例 BLOCK 为完成定义。
- 不因本设计自动回滚 #1654；其最终版含合法面误拦修复，个体 PR 不是根因。
- 不改变搭档人工终端权限，不开放在主仓直接 commit/push。
- 非 macOS 产品支持范围是独立决策，不作为本轮收敛前置。
- 不顺手接管 #1542 worktree、关闭/推进 #1638 或创建一串形态修复 PR。

## 3. 设计取舍

### 3.1 方向方案对比

| 方案 | 判断 | 理由 |
|---|---|---|
| A. 继续扩充当前求值器与保留面 | 否决 | Shell/脚本组合无上限；每个局部补丁都合理，总和仍发散 |
| B. 只留沙箱并大删规则 | 否决 | `.git` 当前可写，write/edit 不经 bash，无沙箱路径与网络/受控操作仍有边界 |
| C. 有限范围收敛 | **采纳** | 物理承重、结构化路径与执行域授权补位，规则范围有限且可退役 |
| D. 新建统一特权 broker | 暂缓 | 会把所有能力集中成新的高权限攻击面；只有执行域原型无法覆盖必要工作流时再论证 |

**Modification-Class**：`mechanism-addition`。机制识别命中「新增 operation wrapper」与「新增 Git 执行域能力」，已在同特性方案审视中完成重对抗门（1 严重 + 8 建议全部处置，delta 9/9）。

机制预算四问（实现时核对，非事后补作业）：
1. **为何不能用已有机制表达**：SDK write/edit 不经 bash 字符串求值，必须在 operations 接防；旧 bash profile 将主仓 `.git` 整树常开，文本规则无法替代真实执行域。
2. **最小新增面**：一个小路径策略、一层 SDK operations 适配和一个封闭 Git envelope/profile 派生器；不引入 broker、完整 Shell parser 或通用高权限服务。
3. **后续机制**：只有真实生产样本证明必要工作流不可表达时，才考虑封闭 schema 窄 Git 工具；不得自动回到词面扩张。
4. **退役条件**：旧 subshell/backtick Git 词面规则已由默认 deny 与真实沙箱集成测试替代并在本 PR 退役；新规则族/解冻仍需搭档 L2。月度按 ruleId/operation/assurance 聚合，若连续一个完整周期零真实命中且替代证据仍成立，提出保留/迁移/删除候选交搭档裁决；无命中不自动删防线。

### 3.2 统一威胁模型

保护对象首先是 **LLM 常见误操作、错误落点与明确不可逆动作**，不是假设宿主上已存在恶意并发攻击者。

新样本必须先分类：

| 类型 | 处置 |
|---|---|
| 常见工作流误拦/错误落点 | 修复；优先修真实路径与执行边界 |
| 常见直白危险形态漏拦 | 修复有限规则或结构化/物理边界 |
| 探针构造的对抗混淆 | 检查通用物理/结构化不变量是否仍成立；不自动新增 bash 规则 |
| 超出声明边界 | 记入守卫宪法 known-holes 节（含边界、证据、物理/结构化覆盖、复核条件），由月度剪枝核销；不自动新立 issue，符合 P0/P1 立案纪律的另按既有流程处理 |
| 实际生产 P0 | 可先止血，事后审视；不得借 P0 名义固化无限扩面 |

合成测试允许存在，但应验证公开不变量（例如「沙箱内任意命令都不能写主仓源文件」），不是每个新字符变体都获得一条永久实现契约。

## 4. 理想终态

### 4.1 分层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| 物理执行层 | macOS bash 文件写、信号及 Git 执行域 capability | write/edit、所有网络、宿主全部路径、非 macOS |
| 结构化工具层 | write/edit 的真实文件副作用路径；受控服务/PR 操作 | bash 字符串理解 |
| 有限 bash 规则层 | 常见 kill、data 破坏、R1 直推、S5 外发、有限 Git/文件写 | 任意壳、脚本语义完备、所有攻击样本 |
| 授权/审计层 | `merge_pr` 原话闸、受控操作审计、healing/ruleId | 用授权文本代替真实落点判定 |
| 观测/退役层 | 真实误拦、真洞、未知保守拦截、范围变化；定期退役 | 实时防护、用报表替代执行边界 |

### 4.2 两种保证等级，不再称「降级不降安全」

| 场景 | 可以提供 | 明确不提供 |
|---|---|---|
| sg=true | OS 文件写与信号边界；Git 执行域按 capability 授予 | 任意网络/全部宿主路径安全、write/edit 物理隔离 |
| sg=false | 同一有限规则集合的 Best Effort；可识别的未知写可 fail-closed | 与沙箱等价的安全、任意脚本识别、零误拦 |

规则范围由威胁模型决定，不因 sg=false 自动扩大。无沙箱时为减少未知拦截而增加新语义族，必须先有真实生产样本证明收益。

## 5. 核心设计

### 5.1 共享写区事实源，而不是再建一个路径名单

抽取一个小的路径策略模块，供沙箱与 write/edit 共用：

- `repoRoot`、workspace、worktrees、workforms、alpha、tmp 等根路径统一注入；
- 文件工具与沙箱引用同一写区定义，禁止各自复制近似白名单；
- 非 git 追踪的本地配置/记忆是否允许写，必须用显式路径清单，不以「被 gitignore」推导整个目录可写；
- 先观察现有真实 write/edit 落点再确定清单，避免接防后破坏本地配置正道；
- 路径策略只做路径集合与真实落点，不读取文件内容判断意图。

### 5.2 write/edit：在 SDK operations 上接防

pi-coding-agent 1.1.0 的 `write.d.ts` 暴露 `WriteOperations.writeFile/mkdir`，`edit.d.ts` 暴露 `EditOperations.readFile/writeFile/access`。SDK 实现表明 write 会先 mkdir 再 writeFile，edit 会先 access/readFile 再 writeFile。因此不能只包 writeFile。

实现方向：在 `createSandboxedTools` 的现有 baseToolsOverride 接线中，为 write/edit 注入 guarded operations，所有可能副作用的 operation 在委托前校验真实目标：

1. 与 SDK 相同，基于**运行时 `ctx.cwd` 优先、构造时 cwd 兜底**将相对路径解析为绝对路径，保证判定路径与实际 `resolveToCwd` 路径一致；
2. 已存在目标做 realpath；不存在目标寻找最近已存在祖先并 realpath，再拼接剩余段；
3. 校验解析后的目标是否位于允许写区，主仓源树及主仓受保护路径默认拒绝；
4. `mkdir`、`writeFile` 每次委托前都校验；edit 的目标路径按「写意图」在 access/readFile 前即可拒绝，readFile 本身不得把主仓只读误判为禁止，writeFile 委托前必须再次校验；
5. 拒绝在执行前返回明确错误，引导 worktree/workspace，不依赖事后 abort；
6. 校验失败、路径解析失败或策略缺失时 fail-closed，并落可观测事件。
7. 在工具装配处通过闭包/显式 adapter 注入统一 `guardOnIntercept` 审计依赖：按 tool、operation、写区标签、ruleId 与保证等级落账，不记录文件内容；不得回退到未包裹的默认 operations。审计失败不得把应拒操作改为放行——仍执行拒绝并记录本地错误。

**诚实边界**：operations 路径校验解决的是 LLM 错误落点和普通符号链接穿透，不宣称抵御本地恶意进程的 TOCTOU 竞态。若未来把恶意并发宿主进程纳入威胁模型，需要 dirfd/O_NOFOLLOW 或独立 broker 的另一轮设计，不能用本方案冒充物理等价。

### 5.3 Git：默认无 `.git` 写 capability，有限工作流精确开口

当前沙箱为支持 linked worktree，将整个主仓 `.git` 放开；这使得「任意 bash 是否能写主仓 Git」仍需靠文本规则。目标不是继续完善 `SUBSHELL_GIT_WRITE_GATE`，而是把默认权限倒转：

1. 默认 bash profile **不允许写主仓 `.git`**，普通源码 worktree 文件写不受影响。
2. spawnHook 在真正启动前按该次命令授予最小 Git 写域；未识别/复杂嵌套命令不获得该域。默认拒绝的是写不是读，但 `status/diff/log` 等只读命令可能尝试可选索引锁，须在原型中实测；必要时只对已识别的只读 envelope 注入 `GIT_OPTIONAL_LOCKS=0`，不能为保只读体验重开 `.git` 写。
3. 写域授予必须匹配**整条命令的完整 envelope**，不能因命令前缀含合法 `git` 就顺带授权后续 `&&`/替换载荷。只支持声明过的常见 Git envelope，例如：
   - 直接 `git -C <字面 worktree> ...`；
   - 可静态解析的 `cd <字面 worktree> && git ...`；
   - 直接 `git worktree add/remove`、受控 fetch、feature 分支 push 等经矩阵验收的工作流。
4. 授权对象尽量是具体 gitdir、worktree 管理目录或 ref 路径，不重新开放整个 `.git`；对象写与引用写分别评估。
5. 主仓 commit、直接 push 受保护分支仍拒绝；PR 合入只走 `merge_pr`，不因 capability 获得新授权。
6. 不能证明 envelope 与落点时，不执行原命令并给「拆成直接 Git 命令/使用受控入口」的指引；sg=true 下至少保证原命令没有 `.git` 写 capability。
7. 任意 Shell 写 `.git` 不再逐形态枚举，由默认 deny 统一承担。

**实现前置**：先做单独原型证明 spawnHook 的同步约束、profile 生成、真实 Git 写落点与正常 fetch/worktree/push 流程可满足。profile 缓存键必须从当前进程级 repo/data key 扩为包含**规范化授权域指纹**（envelope 类型、目标 gitdir/ref 等）；不同授权域不得复用同一 profile，未授权默认使用 deny profile。若必须引入异步或高权限宿主服务，不静默改成 broker，回到方案取舍。

**失控退路**：若 envelope/profile 原型无法覆盖必要工作流或复杂度开始增长，改用封闭参数 schema 的窄受控 Git 工具（固定操作、结构化目标、真实落点校验），不得回退到更多文本规则枚举，也不开放自由命令参数。

**有意的可用性取舍**：复杂嵌套 Git 可能要求拆成直接命令。这是有限边界的成本，不再为它增加反引号、`$()`、控制流或脚本语言规则。

### 5.4 有限 bash 守卫的存量处置

| 当前族 | 终态方向 |
|---|---|
| sg=true 文件写求值/heredoc 负门 | 已由沙箱接防的保持退役，不回摆 |
| sg=false 文件写求值 | 冻结新语义族；保留有限常见形态与未知保守处理 |
| Git 顶层落点求值 | 迁移到直接 envelope + 执行域；保留至等价证据通过 |
| Git subshell/backtick/写动词词面 | 默认 `.git` deny 覆盖后删除对应特殊规则与实现契约测试 |
| `proveNoWrite`/词面豁免 | 不继续扩；先按真实 cp/scp 等常见样例核销，再缩减 |
| kill/pkill/stop | sg=true 由信号边界承重；字面规则只保留有明确 UX/降级价值的部分 |
| data 破坏、R1 直推、S5 外发 | 保留常见直白窄规则；明确沙箱未覆盖的剩余风险 |
| sleep/服务重启引导 | 属工作流可用性，不与安全规则混账；真实沙箱下验证受控脚本是否可执行 |

受控服务重启是否能在 deny signal 的 bash 沙箱内完成，必须先实测；不能仅凭存在脚本就宣称合法正道已通。若不通，另做窄受控工具，不开通用信号权限。

### 5.5 拦截链与失败语义

- 真实副作用前的同步 gate/operations/spawnHook 是主防点；subscribe/abort 只作兼容兜底或观测，不能作为「命令必然未执行」的唯一证明。
- 不为了单点化而一次删除双通道；先用测试证明 beforeToolCall、结构化 operations 与沙箱在各自边界无静默成功。
- store/配置缺失不得把结构化文件写静默变为无守卫；bash 物理层仍独立生效，窄规则的 fail-open/fail-closed 按各层保证明示并排障。
- healing 记录层、ruleId、保证等级（physical/structured/best-effort）与未知原因，避免所有拦截混成 `main_write`。bash 走现有 `guardOnIntercept`，write/edit 由工具装配闭包注入同一审计适配器；两者均记录 operation 与写区分类而非文件内容。known-hole 统一进守卫宪法清单，月度核销，不另造分散台账。

## 6. 测试与退役契约

### 6.1 测试按不变量组织

1. **沙箱通用边界**：在临时 fixture 根中，以多类命令验证主仓源树不可写；不为每种壳各建永久规则。
2. **文件工具真实执行**：write 的 mkdir/writeFile、edit 的 access/readFile/writeFile 全链；允许区成功，主仓与符号链接穿透在副作用前失败。
3. **新路径**：不存在文件、不存在多级父目录、最近已存在祖先为链接、`..`、路径别名、根目录本身。
4. **Git capability**：无授权任意命令写 `.git` 失败；直接 worktree 常用 Git 成功；主仓 commit/受保护分支直推失败；复杂嵌套按声明保守处理；只读 `status/diff/log` 与会写本地引用/对象的 `fetch` 分别钉清锁需求和真实写落点，合法前缀后接恶意命令不继承写域。
5. **双链一致性与差异**：sg=true 验证物理结果，sg=false 只验证声明的 Best Effort，不要求判定文案/覆盖面完全相同。
6. **运行时版本**：记录实际服务版本与沙箱挂载状态；远端 main 合入不冒充运行实例已生效。

### 6.2 测试可以删，但必须有替代证据

- 行为仍保留：测试不能为减行数而删。
- 行为退役：旧实现契约测试随规则删除。
- 替代边界已覆盖：保留少量跨形态代表用例，其余载荷枚举可收敛为通用物理/结构化测试。
- 已知但未覆盖的对抗面：转 known-hole 或研究材料，不伪装成必须全绿的守卫契约。

## 7. 实施顺序与本次落地范围

### Phase 0：冻结与基线（本次落地）

- 冻结新形态规则族；P0 与常见工作流误拦仍可按本边界处理，但**冻结期内新增/解冻 bash 规则族属于改变已拍板边界，必须由搭档显式裁决（L2）**。
- P0 优先用既有物理/结构化阻断或暂停危险通道止血；确需新增规则的走紧急 L2，实现者不得自批。搭档不在场时只做已有边界内的可逆止血并记录，不把紧急样本固化为常态扩面。
- 仅修正既有声明内缺陷且不扩大语义族/通道/保证范围的，仍按普通实现审视，不借 L2 名义阻塞必要修复。
- 用现有 healing、会话与 PR 证据建立真实样本基线；分母不存在时只报计数，不编造误拦率。
- 盘点 write/edit 合法落点、Git 必需工作流、受控重启在真实沙箱下的表现。
- 存量 issue/PR 标记「已覆盖/仍有效/超边界/重复」，不直接按本设计批量关闭。

### Phase 1：结构化文件写接防（本次落地）

- 引入共享路径策略与 guarded operations；完成 SDK 真实执行测试。
- 锁定已通过验收的 SDK 版本；升级 PR 必须审查 write/edit execute 与 operations 集合/调用顺序 diff，并跑副作用契约测试。构造期校验受支持 SDK 与必需 wrapper 注入，接防状态未知时不得静默使用默认 operations。
- 接入统一拦截审计，验证 tool/operation/ruleId/写区分账与无文件内容落账。
- 不改变 bash 求值器，不以本阶段为由扩 bash 语法。
- 预期影响：`bash-sandbox.ts`、新小路径策略模块、工具测试；不改 SDK 源码。

### Phase 2：Git 执行域原型与迁移（本次落地）

- 独立原型验证 capability profile、必需 Git 工作流及拒绝指引。
- 原型不过则保留现状并重新评审，不先删 Git 守卫。
- 通过后逐步替换顶层/壳层词面规则；#1654 对应特殊壳规则可在等价物理证据后退役。

### Phase 3：有限降级与规则退役（本次落地）

- 固定 sg=false 的支持范围，删除重复洗白/负门和已被替代的规则。
- 将规则按 physical/structured/best-effort 重新归层，修订守卫宪法。
- 每次删除同时给替代证据、误拦影响与测试迁移，不做大删豪赌。

### Phase 4：复盘与停止（本次接线，月度任务按既有调度消费）

- 在现有月度剪枝任务接入 ruleId/层/保证等级消费，不另建台账系统。
- 每月输出保留、迁移、退化、删除及理由；无命中不是永不退役的理由。
- 新规则 PR 必须说明威胁分类、所属层、良性正道和退役条件；新增/解冻规则族还须附对应 L2 裁决锚，不能只靠 PR 描述自证合规。

## 8. 实现记录与验证

### 8.0 本次实现要点（2026-10-27）

- `file-write-policy.ts` 统一派生 workspaces/worktrees/workforms/alpha/tmp 根路径；bash profile 与 write/edit 共享同一事实源。真实 `.git` 文件或目录即使在 tmp/alpha 等允许区也不当普通文件写，`.gitignore/.github` 不受影响。
- `file-tool-guard.ts` 覆写 SDK write 的 `mkdir/writeFile` 与 edit 的 `access/readFile/writeFile` 全链；允许区真实执行，主仓/链接穿透/解析失败在副作用前拒绝。edit 的只读 `readFile` 保持可读主仓。
- `git-execution-policy.ts` 复用现有 `parseOnce`，只接受单段 Git 或字面 `cd && git`；授权注册表来自 `git worktree list --porcelain -z`。直接主仓 add/commit 不获写域；worktree add/commit/fetch/push/merge 等按精确路径授权，缓存 key 含 repo/data/授权域/新建 worktree 目标。
- 默认 bash profile 不再允许整棵 `.git`；精确组件 deny 也覆盖 tmp/alpha 中独立仓库。`worktree add` 只对声明目标、目标 `.git` 指针、管理目录和实际锁文件精确放行，不重开整个 `.git`。
- sg=true 的 Git 嵌套词面职责迁移到物理 deny；sg=false 保留原有有限 Best Effort，未宣称物理等价。
- 文件工具拒绝复用 invoke 级 `guardOnIntercept`；`guard-intercept-classify.ts` / `pi-session-factory.ts` 落 ruleId、tool、operation、assurance。monthly-prune-review 已接入近 30 天聚合查询与保留/迁移/删除候选。
- 有意边界：只支持声明的直接 Git envelope，复杂命令须拆分；不追任意 shell/对抗混淆，不引入 broker；不防恶意宿主进程 TOCTOU；远端 main 合入后仍需服务实例加载新版本才算运行实例生效。

### 8.0.1 负面向与最简检查

- **破坏/绕过的旧契约**：默认 bash 不再拥有主仓 `.git` 整树写权限；write/edit 不再能修改主仓、Git 元数据或经普通 symlink 穿透；sg=true 不再为嵌套 Git 词面提供文本判定。对应合法正道是 worktree、直接 Git envelope、PR 与受控 merge，未绕过 `merge_pr` 或搭档授权闸。
- **最简检查**：复用了 SDK operations、现有 `parseOnce`、sandbox-exec 和 invoke 级 healing；没有新依赖、新 broker、新 parser 或第二套台账。共享写区只派生稳定部署路径，不随攻击样例增长。已过最简检查。

### 8.0.2 验收断言与证据

| 场景 | 操作 | 预期/实际结果 |
|---|---|---|
| write/edit 真实接防 | `npx vitest run tests/frameworks/agent/file-tool-guard.test.ts` | PASS：真实 SDK execute 下允许区成功；主仓、`.git`、链接穿透与解析失败无副作用；生产 invoke 审计复用；sg=true/false 均覆盖 |
| Git 默认 deny 与窄授权 | `npx vitest run tests/frameworks/agent/git-sandbox-policy.test.ts tests/frameworks/agent/git-sandbox-integration.test.ts` | PASS：默认/嵌套写 `.git` 失败；主仓 commit 无 capability；worktree add/commit、带空格路径、fetch/merge/push/remove 真实通过 |
| 目标守卫回归 | 六个相关测试文件合并执行 | PASS：6 files / 116 tests；后续共享路径与 worktree 授权返修后相关四文件 82 tests 复跑通过，最终全量结果见下方 |
| 全量 agent 回归 | `npx vitest run tests/frameworks/agent` | 初轮 PASS：92 files / 2352 passed / 6 skipped；最终复验以提交前最新输出为准 |
| 完整工程检查 | `npm run check` | 初轮 PASS：build + eslint + lint:schema + smoke:boot（8+4）+ script-arg-parse；最终复验以提交前最新输出为准 |
| 生产审计聚合 | `guard-intercept-classify.test.ts` + monthly-prune-review SQL | PASS：ruleId/tool/operation/assurance 可聚合；无分母只报计数 |

**修前红 / 修后绿**：文件线曾实证 worktree `.git` 指针可被 SDK write 改写；最终相关 file 测试 23/23 通过且指针/真实 gitdir 内容不变。共享路径返修时，真实 Git 集成曾红在 `/tmp` 下独立 `.git` 及 worktree add 指针/config.lock，最终按精确组件与目标窄授权修复并复跑通过；没有用整树 allow 消红。

### 8.0.3 CI 时间炸弹排查与解阻（2026-10-28）

**预注册**：预期三条 `rhi-scan-worker` 失败都由固定 2026-08-28 fixture 被 60 天窗口过滤引起；以冻结时钟前一天生成数据且不改业务断言，若仍出现 sink/聚合失败则放弃日期解释。

**证据与根因**：CI run 40607227221 与本地均在 `rhi-scan-worker.test.ts:345/385/477` 复现三条失败；fixture 在 `:89-91,103` 及装配回归段写死日期。`CLOCK_SNAPSHOT` 已冻结运行期时钟，固定成本数据却最终滚出扫描窗口。实际与预期一致。

**修复与影响**：只把 session 文件名/JSONL 时间、entries 时间和查询日期改为 `CLOCK_SNAPSHOT - 1d` 派生；保留成本、tool_call、metricType 转发、历史日期幂等与 overview 不互删断言。生产扫描逻辑不变，不新增配置/状态/分支/存储，走既有机制语义内的 `narrow-fix`，无需重对抗门。原 3 failed 变为 11/11 passed。

### 8.0.4 对既有文档口径的同步

本 PR 同分支修订守卫宪法的退役通道现状：monthly-prune-review 已接通 ruleId/assurance 消费，不再标为「待接通、需独立 PR」。本特性原「仅设计」描述已在本 PR 内更新为完整实现记录；未回改已合入历史特性文档。

## 8.1 验证与完成定义

### 8.1 各实现 PR 的最低验证

- 先失败、后通过的行为证据；纯 fixture，不写主仓或生产 data。
- `npm run check`、相关单测/SDK 集成测试、文档 lint；涉及 capability 的做真实沙箱 smoke。
- 独立对抗审视重点检查：是否偷偷扩威胁模型、是否只堵不疏、是否将 Best Effort 写成物理保证、是否提前删旧防线。

### 8.2 本轮收敛完成，不等于「绝对安全」

同时满足以下条件才称本轮收敛完成：

1. 五层职责与 sg=true/false 保证已落入可执行契约，运行实例版本已核实。
2. write/edit 所有副作用 operations 已接防，常见合法落点通过，主仓/链接穿透有红绿证据。
3. Git 默认 `.git` deny 与必需工作流 capability 通过；旧壳枚举已按证据退役，或明确列为未完成而非跳过。
4. 声明内的常见工作流矩阵通过；P1 原样例均已核销，无未处置严重发现。
5. 新规则族停止扩张；生产误拦、真洞、未知保守拦截有基线与后续复盘。
6. 月度退役通道实际运行一次，至少产出一个有证据的保留/删除/迁移决定。
7. 从上述边界在运行实例生效之日起，经过**至少一个完整月度剪枝周期**，没有新的生产 P1 安全洞或新增/解冻规则族；发生真实安全修复不受「零代码净增」限制，但扩边界仍须走 L2 裁决。

明确不以：issue=0、守卫行数必须下降、所有探针 BLOCK、两周不改代码作为判据。行数与测试数只作趋势信号。

## 9. 风险与反对意见

| 风险/反对意见 | 回应 |
|---|---|
| 有限范围会留下已知绕过 | 是，必须明示；物理/结构化层兜通用不变量，其余记 known-hole，不以无限规则假装消灭 |
| sg=false 更保守会误拦复杂命令 | 是，可能增加；用真实样本、直接命令与受控入口消化，不自动扩白名单 |
| Git capability 可能破坏 fetch/worktree/push | Phase 2 原型未证明前不迁移、不删旧规则；必要流程逐项验收 |
| write/edit operations 仍有竞态 | 本轮只承诺误操作与普通链接边界，不承诺恶意宿主并发；更强威胁另行设计 |
| 共享路径策略又成新名单 | 它只表达稳定写区，不理解命令/内容；规模由部署根路径决定，不随攻击样本增长 |
| 月度复盘会变形式主义 | 必须产出具体退役/保留决定及证据；没有消费数据的会议不算完成 |
| 当前仍有 open issue，是否应立即全修 | 否，先按新边界核销；常见误拦优先，超边界不自动转开发 |

## 10. 决策史与后续

- 2026-10-15：确定常见直白形态 + 物理隔离，拒绝军备竞赛（F20261015gsub）。
- 2026-10-19：沙箱接防部分文件写；求值器转正（F20261019gsbx/F20261019gses）。
- 2026-10-27：GLM/Kimi 对齐，纠正「write/edit 已接求值器」等事实误判；确认方向漂移在后续无限扩面而非沙箱本身。
- 2026-10-27：搭档拍板方案 C，要求按有限范围做收敛设计。

本 PR 已按搭档「完整实现、快速合入、实践出真知」完成核心接防与复盘接线，下一步是独立代码对抗审视与搭档终审。任何新增/解冻 bash 规则族、引入特权 broker、扩大网络/进程权限或改变平台支持范围的决策仍须重新上报（L2）。
