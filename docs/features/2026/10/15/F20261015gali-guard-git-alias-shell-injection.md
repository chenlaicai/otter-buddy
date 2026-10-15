---
id: F20261015gali
title: bash 守卫 P0——git alias shell 展开（! 前缀）注入防御（真执行体载荷拆解，宪法 L4）
summary: 检视獭1360 建议 4 实证 `git -c alias.pwn='!git -C <主仓> reset --hard' pwn` 双层全放（alias 展开=任意 shell 执行通道，一行命令摧毁主仓）——按真执行体语义修（#1513 取向：内容判定而非通道封杀）：载荷提取后递归过全量规则链（与直接执行同待遇），动态/提取不出 fail-closed；含 judgeScriptPayload 递归深度缺失修复（S6 嵌套载荷语义丢失）与指纹表/宪法同步
type: BugFix
date: 2026-10-15
capability_test: "n/a: 守卫判定规则与载荷递归逻辑，验证走单测（bash-safety-guard-git-alias 22 例 + write-target-evaluator-git-alias 9 例 + guard-intercept-classify 4 例）"
intent:
  problem: "git alias 的 `!` 前缀值是任意 shell 执行通道（git 原生语义：从仓库根以 shell 执行），`git -c alias.pwn='!载荷' pwn` / `git config alias.pwn '!载荷'` 一行命令即可执行任意 shell——检视獭1360 审查实证双层（prod/wv）全放、真破坏主仓（reset --hard/rm -rf/kill 主 PID），攻击成本极低；大獭定级严重（P0）（与 delta7 ~ 前缀同款依据：双层全放+真写主仓+攻击成本极低）"
  expected_effect: "alias shell 载荷与直接执行同待遇：载荷提取后递归过全量规则链——载荷命中既有拦截面（主仓写/kill 族/data 破坏）→ 拦且子文案携带；载荷可证安全（如 !git status）→ 放；动态/提取不出 → fail-closed。间接构造（env 注入/包装词）不追（#1513 物理隔离拍板）；纯子命令别名（非 !）不受影响"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
pr: ""
related_issues: ["#1513", "#1514"]
causal_links: ["F20261015gsub", "F20261015glfp", "F20261015smrj"]
---

# bash 守卫 P0：git alias shell 展开（! 前缀）注入防御

## 案情与排查证据（探针实证，2026-10-15）

检视獭1360 对抗审视 #1515 时构造的攻击面（建议 4）：`git -C <worktree> -c alias.pwn='!git -C <主仓> reset --hard' pwn`——alias 展开真执行、破坏主仓，双层全放。探针（checkBashCommandSafety + evaluateWriteVerdict 双层同命令对照）修前现状：

| 样本 | 修前 prod | 修前 wv | 修后 prod | 修后 wv |
|---|---|---|---|---|
| S1 审视样本（reset --hard 主仓载荷） | 拦（**偶然**：载荷词面穿透 GIT_WRITE_SUBCOMMAND 正则） | **ALLOW** ✗ | 拦（载荷拆解，主仓写文案） | 拦（正判，via:alias-shell） |
| S2 `git config alias.pwn '!git -C <主仓> reset --hard'`（持久注入） | **ALLOW** ✗ | **ALLOW** ✗ | 拦 | 拦（正判） |
| S3 `--global` + `!rm -rf /repo/data` | **ALLOW** ✗ | **ALLOW** ✗ | 拦 | 拦（正判） |
| S4 `-c alias.pwn="!kill 42877"`（kill 主 PID 载荷） | **ALLOW** ✗ | ALLOW（域分工） | 拦 | ALLOW（域分工，见下） |
| S5 动态载荷 `!$P` | **ALLOW** ✗ | 拦（fail-closed） | 拦（fail-closed） | 拦（fail-closed） |
| S6 嵌套 `!sh -c "rm -rf /repo"` | **ALLOW** ✗ | **ALLOW** ✗（见「递归深度缺失」） | ALLOW（=直接执行同判，见洞表） | 拦（正判，S6 修法钉死） |
| N1-N7 放行侧（无害载荷/纯子命令别名/普通配置/--unset/提及位/grep -c 参数位） | 放 | 放 | 放 | 放 |

**修前探针输出存档**（失败证据，5a 先行固化）：S2-S6 prod 全 ALLOW + wv 全 ALLOW（S5 除外），完整输出见 PR Verification 节。

**S1「偶然拦」的教训**：修前 prod 拦 S1 不是规则在起作用——是载荷里的 `reset --hard` 词面恰好穿透 `GIT_WRITE_SUBCOMMAND` 的 `\S+` 旗标解析（token 串配）。载荷换 `rm`/`kill`（S3/S4）即全线失守。**依赖偶然命中的防线不是防线**——本修复让检出走语义（载荷拆解）不走巧合。

**S6 语义丢失（排查中发现的共享层缺口）**：wv 侧递归（judgeScriptPayload）旧版走 `evaluateFromModel`，少了入口层的 shell 递归载荷收集（collectShellPayloadTargets）——载荷内的嵌套 `sh -c` 载荷被静默放过（S6 wv=ALLOW 但直接执行 X2 wv=BLOCK）。已修：judgeScriptPayload 递归升级为 `evaluateWriteTargets` 入口（与直接执行同待遇）——heredoc 载荷同型缺口一并修复，exam/corpus 零翻转（全量验证）。

## 宪法三问（生长规则，动手前作答）

1. **挂哪层？**——L4 `bypass_guard`（防绕过）。理由：alias `!` 通道是**任意命令走私通道**，可携带任何载荷绕过 L1/L2/L3 全部判定——「绕过面 = 上述所有层失效」正是 L4 的定义；修法语义与 L4 现有规则 script_file_exec 同款（「脚本文件执行必须拆解」= 载荷拆解）。新 ruleId `alias_shell_payload`（挂靠条目 L1 级獭定，特性文档留痕，宪法附录已同步）。
2. **carve-out 是什么？**——三层良性正道：①纯子命令别名（非 `!` 前缀）不检出（git 原生语义不进 shell）；②载荷可证安全即放行（`!git status` 等——正道就是内容判定）；③根本正道：直接执行目标命令（文案明示）。只堵不疏面 = 不可证载荷（动态/提取失败），该面无良性例（动态载荷本就不可审计）。
3. **退役条件是什么？**——可观测信号 + 量化阈值：healing_events 按 `ruleId=alias_shell_payload` 聚合，**连续 4 周误拦率 >80% 且零真报（拦截样本经裁决全为误拦）**，或**直接命令替代采纳量 >20 次/周且拦截量不降**（说明 carve-out 正道失效）→ 提请月度剪枝审视精化/退役。数据源：F20260930gslog 的 ruleId 聚合 SQL。

**双向生长自查**（#1240 教训）：本规则是**拆解**非豁免——载荷交既有规则全量判定（checkBashCommandSafety 全量递归），不新增任何豁免通道，不存在「豁免放走的命令集合扩大」面。唯一放行增量 = 载荷可证安全（与直接执行同判词，等价性测试钉死）。

## 机制识别检查点（修法决策树）

七项逐项：新增配置字段/枚举/开关——`WriteTarget.via` 联合类型加 `"alias-shell"` 标签值（诊断标签数据值，非机制开关）✅命中一项但非净新增机制（见下）；新增状态生命周期 ✗；新增定时任务/后台进程 ✗；新增信号类型/消息格式 ✗；新增持久化存储 ✗；新增决策分支（持久影响后续行为）✗（纯运行时谓词）；新增跨模块调用路径 ✗（payload-extract-aux 纯函数模块，两侧共享=单一真相源收敛）。

命中项显式论证：via 标签值是既有证据标注联合类型的数据值（机制=「载荷递归 + fail-closed」，judgeEvalPayload/judgeScriptPayload 既有语义），不涉净新增机制。**判定：修法决策树①（既有语义内修）→ Modification-Class: `narrow-fix`**。载荷拆解语义的既有先例：能力 1 heredoc 体递归、judgeEvalPayload eval 载荷递归（#1513 明文保留「真执行体语义」）、script_file_exec（L4 同层同款）。

## 设计取舍

1. **载荷递归（真执行体语义）而非通道封杀**——**与检视獭1360 建议 4 的「命中即视为不可证（fail-closed）」方向刻意不同，按大獭定级后的修法自主权取向 #1513 拍板（F20261015gsub：「防绕过军备竞赛」→「常见直白形态兜底」，eval 包装类通道封杀规则族被删、eval 载荷递归被保留）**：封杀整个 `!` 通道=通道封杀（军备取向），载荷拆解=内容判定（#1513 取向）。良性 `!` 别名（`!git status`）保持可用，恶性载荷由既有规则拦，不可证才 fail-closed——误拦面严格小于通道封杀，拦截面与直接执行严格等价。若审视认为该偏差不成立，回退到通道封杀只需改 `extractGitAliasShell` 的返回语义（一处）。
2. **检出面 = 定义位**（`-c` 子命令前全局旗标位 + `config` 子命令键值位），不是全文匹配——echo/grep 提及位、heredoc 文本体、`git grep -c` 参数位不检出（FP 陷阱探针 N5-N7 钉死）；`-c` 旗标位走查与 evalGitWrite 旗标循环同构（词法层归一引号三形态）。
3. **fail-closed 面**：键可见值动态（`alias.x="!$P"`）/载荷内动态（`!$P`）/解析失败 → 拦（不可证不豁免，牙3 同判据）；间接构造（env 注入 `GIT_CONFIG_*`、包装词 `env git`、整词动态 k=v `"$KV"`）**不追**——#1513 拍板：物理隔离才是真守卫（残余面如实入宪法洞表）。
4. **prod 递归走 checkBashCommandSafety 全量**（非仅文本链）：载荷过完整规则链（模型层+文本层）才叫「与直接执行同待遇」——等价性测试（7 载荷 × 双判词一致性）钉死不变量。
5. **judgeScriptPayload 递归升级**（evaluateFromModel → evaluateWriteTargets）：S6 语义丢失的修法，惠及 heredoc 载荷同型缺口——已全量验证 exam/corpus 零翻转（该修法让递归更深，唯一风险面是深度炸弹，由 depth 记账 + 文本长度严格递减双保险收敛）。
6. **S4 kill 载荷的域分工**（非反判）：wv 求值器只判写面（F20261015smrj 域分工口径），kill 族由文本路径承担——prod 拦、wv 放是设计内分工，两侧各有钉。

## 影响范围

- `payload-extract-aux.ts`：+extractGitAliasShell（纯函数提取器，单一真相源供双层共享）
- `bash-safety-guard.ts`：+消息常量 2、+checkGitAliasShellInjection（载荷拆解递归）、主流+OnText 双挂钩
- `write-target-evaluator.ts`：evalGitAliasShell + judgeScriptPayload 递归入口升级 + via 标签值
- `guard-intercept-classify.ts`：FINGERPRINTS +2（alias_shell_payload/bypass_guard）
- `docs/designs/bash-guard-constitution.md`：L4 挂靠 + 已知洞 2 行（alias 洞已修 + rm 族洞开放）
- 正则净增 4（提取器 3 + 文案常量 1）——理由（每轮三问 2）：alias 定义位检出面无法用现有模式覆盖（现有正则全部词面/落点向，无 alias 语义）
- 载荷递归不改既有判定语义：judgeScriptPayload 升级仅加深递归层级，exam/corpus 全量零翻转实证

## 验证

- **失败证据固化（5a）**：探针修前实测 S2-S6 prod 全 ALLOW / wv 全放（S5 除外）存档 PR Verification 节；正式测试文件对修前代码跑红（stash 舞步输出随 PR）
- 三面回归：prod 22 例（负门 8 + carve-out 7 + 等价性不变量 7）/ wv 9 例（正判 4 + fail-closed 2 + carve-out 3）/ 分类器 4 例（双指纹 + 层归类）
- **等价性不变量**：7 载荷 ×「alias 包裹判词 === 直接执行判词」全过——alias 通道不得强于直接执行（设计承诺的机械化）
- 全仓 `npx vitest run` 367 文件全绿（含 guard-touchstone 双库 exam、guard-v2-real-replay、classify 回归）；`npx tsc --noEmit` 通过
- 指纹表同步（每轮三问 3）：FINGERPRINTS +2 与分类回归测试同 PR，文案常量从源头 import（非手抄）
