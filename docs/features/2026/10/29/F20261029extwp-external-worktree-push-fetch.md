---
id: F20261029extwp
title: "external-linked worktree 管理写面 push/fetch 收窄放行（#1694）"
summary: "外部仓已登记隔离 worktree 的 push/fetch 走既有授权分支放行（fetch 补 worktree-gitdir 域），branch/worktree 生命周期管理面维持拒绝；受保护分支拦截由守卫窄规则独立保障。"
change_type: fix
capability_test: "n/a: 守卫授权策略纯代码改动，无 prompt/LLM 行为触发语义变更"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-29T14:45:00+08:00
causal_links:
  from: [F20261027gscv]
---

# 预注册

- 预期：最新 main 对 `cd /Users/orca/ai/others/colink/.otter/worktrees/dm-action-overflow && git push https://github.com/colink-group/CoLink.git fix/dm-action-overflow` 拦截（issue #1694 案发现场，09:47 与 14:02 两轮实测均拦）。
- 修复面：`evaluateManagementWrite` 对 `external-linked` 目标的无条件 `return null` 短路——push/fetch 收窄放行，branch/tag/worktree 生命周期管理面维持拒绝。
- 反例：不存在的目标/未登记 worktree 的 push/fetch 仍恒拒（`resolveTarget` → external 判定失败 → 无 grant）。
- 非目标：不动受保护分支窄规则（PROTECTED_PUSH_BRANCHES 语义不变）；不动树写面（add/commit #1682 已放行）；不动本地 branch/tag/worktree 管理面（外部仓生命周期归该仓自身工具链管，见 issue #1682 原拒绝边界）。

# 问题与根因

- 现象：跨仓 worktree（对话目标仓 ≠ otter-buddy 主仓）内 commit 成功但 push 被拦——「直接 Git 命令未获当前执行域授权」（issue #1694，commit `26bc4f5ee` 落上成功、push 恒拒）。
- 根因：`src/frameworks/agent/git-execution-policy.ts` `evaluateManagementWrite` 首行 `if (target.kind === "external-linked") return null;`（#1682 引入，当时树写面尚未打通故整体短路）把 push/fetch 一并短路——push 本可走 `grant("push", …, PUSH_DOMAINS)`，fetch 同理。#1685/#1688 打通外部 worktree 识别与路径解析后，管理写面的授权范围决策一直未跟上。
- 影响：`worktree-isolation` skill 第 5 步「推送并创建 PR」在跨仓场景完全断流——commit 能落、push 恒拒，PR 交付只能请搭档手动 push 兜底。卡点交付实证：CoLink 迁移分支 `fix/dm-action-overflow`（commit 26bc4f5ee 就绪）。

# 方案与取舍

**机制判定（issue 驱动前置检查）：无新机制，narrow-fix**——授权机制（grant/profile/指纹）、受保护分支窄规则（`checkNarrowRules` → `protectedPushHit`）均已存在，本次只把 external-linked 从无条件短路改为进入既有 fetch/push 授权分支，不新增任何判定面。

1. **放行面收窄**（`evaluateManagementWrite`）：external-linked 目标仅放行 `fetch` 与 `push` 两个子命令；`branch`/`worktree` 等生命周期管理面维持 `null`（拒绝）——外部仓的分支/工作树管理不归宿主守卫授权，归该仓自身工具链。
2. **fetch 域补 worktree-gitdir**：FETCH_HEAD 写入 worktree 私有 gitdir（`.git/worktrees/<name>/FETCH_HEAD`），外部仓 fetch 与 linked worktree fetch 同语义——domains 用 `["worktree-gitdir", ...FETCH_DOMAINS]`。`grant()` 对 external-linked 已携带外部仓 repoRoot + worktreeName + externalWorktreeRoot（F20261027gscv grant 结构），profile 规则生成自动落外部仓路径，宿主仓 .git 不入白名单（测试钉）。
3. **push 受保护分支双闸不动 + r1 纵深加固**：`checkNarrowRules` 窄规则在守卫入口先于 grant 判定执行、纯文本判定不分 cwd/target kind——`git push origin main` 在 external worktree cwd 下仍拦（测试钉）。r1 加固：grant 层自身也拒受保护 dst（`PROTECTED_PUSH_BRANCH_NAMES` 同口径词表）+ 隐式目标 fail-closed（见下）。远端权限（GitHub branch protection）是第二道闸，本地放行不改变远端拒绝。
4. **fetch 对 external 的理由**：fetch 是纯拉取动作（写本地 refs/remotes + objects），是 rebase/merge 前置正道；不放 fetch 会把跨仓场景的同步也断掉（worktree-isolation 步骤 3「先 fetch 再 worktree add」在跨仓续作时同样需要）。

**取舍**：
- 放行 push 的爆炸半径 = 该 worktree 已登记分支上**词级可见的非受保护 refspec**（r2 口径：裸 push/HEAD 省略目标 fail-closed，dst 受保护名拒绝；push 天然受远端权限 + 守卫窄规则 + grant 层三层闸，feature 分支 push 是 skill 明文要求的常规交付动作）。
- branch/worktree 管理面维持拒绝而非同款放行：本地分支/工作树生命周期操作（`git branch -d`、`git worktree remove`）在外部仓无「已登记 feature 分支」的对应锚定概念，放行需另立授权锚点——超窄修范围，且前世档案已实证本地 .git/refs 写在沙箱恒拒（环境项），放行也无实效。维持 issue #1682 原拒绝边界。
- `PUSH_DOMAINS` 导出：测试引用它做词表断言（防词表漂移=静默放行面漂移），单一真相源。

# 验证

- **before-fix（失败证据）**：HEAD 基线上 `git push origin HEAD:feature`（external cwd）无 grant——由存量测试「外部管理写 %s 不授权」（fetch/push 在列）钉住，本 PR 将该断言翻转为放行并保留 branch/worktree 拒绝。
- **after-fix 单元**：`git-sandbox-policy.test.ts` + `bash-guard-gsbx-phase2.test.ts` 122 passed——含：①external fetch/push/URL-remote push/`push -u` 获授权（repoRoot=外部仓、domains 正确含 config-lock、宿主 .git 不入规则）②branch/worktree 管理面仍拒 ③隐式目标 7 形态拒（裸 push/HEAD 省略/受保护 dst）④external cwd push main 仍拦（守卫负门）⑤115 存量回归钉。
- **集成（macOS 本机绑定，非 CI）**：`git-sandbox-integration.test.ts` 新增「#1694 外部仓隔离 worktree 可 fetch/push feature 分支（-u 形态）」——macOS-only（非 mac 整文件 skip，CI Ubuntu 从不执行）；**验证债务**：当前本机嵌套沙箱禁 `git init`（EPERM）无法真跑，首次 macOS 非嵌套环境（搭档机或后续环境）补跑；探针级验证已过（tsx 直调 evaluateGitExecution 六形态行为符合预期）。
- **pre-existing 基线对照（硬门禁证据）**：HEAD 基线（改动 stash 式恢复后复跑）`tests/frameworks/agent/` 全量 32 failed | 2493 passed——32 个失败（bash-sandbox smoke/file-tool-guard 真执行/grdl-g1 git init/dynwash-door git init/integration git init）在含改动版本上失败名单完全一致，均为环境性失败，与本变更无关。
- typecheck + eslint 改动文件零告警（CI 绑定）。
- **最简实现检查**：已过——单函数 8 行改动 + 导出常量，无新模块/新依赖/新判定面；更少代码=不写代码（维持现状），但那是 bug。

# 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 断言①跨仓 feature push | policy 单测「-u origin fix/dm-action-overflow 获授权」+ 集成用例（macOS 本机绑定） | PASS |
| 断言②受保护分支仍拦 | gsbx-phase2「#1694 external worktree cwd push main → 仍拦」+ 既有 main/HEAD:main/bash -c 族 | PASS |
| 断言③管理面仍拒 | policy 测试「外部管理写（branch/worktree 生命周期面）不授权」 | PASS |
| 守卫回归 | CI 全套 tests/frameworks/agent/ + touchstone corpus/exam | 全绿 |
| r1 隐式目标拒 | policy「隐式 push 目标 7 形态拒」（裸 push/HEAD 省略/受保护 dst） | PASS |
| 生产回放 | CoLink 分支 fix/dm-action-overflow push（PR 合入后实测） | push 成功 |

# 独立审视处置

检视獭-1694（kimi，异模型）r1 四严重发现全采纳：

1. **`push -u` 主流程缺 config 写域（采纳，修复）**：`worktree-isolation` 正道 `git push -u origin <branch>` 需写 `.git/config`（upstream 登记）+ `config.lock`——新增 `EXTERNAL_PUSH_DOMAINS = [...PUSH_DOMAINS, "config-lock"]`（config-lock=既有域，grantToProfileRules 映射 `config\.lock$`；config 本体写由 push 进程在锁保护下完成，锁域足彰）。policy 用例补 `git push -u origin fix/dm-action-overflow` 放行断言（domains 钉 config-lock）。
2. **「CI 真跑集成测试」声明失实（采纳，文档修正）**：CI runner=Ubuntu，`git-sandbox-integration.test.ts` 是 macOS-only（非 mac 整文件 skip）——集成用例在 CI 从未执行，「CI 绑定」表述错误。修正：PR body/特性文档改为「macOS 本机绑定」；真沙箱验证依赖本机，当前本机嵌套沙箱禁 `git init` 无法跑（EPERM），验证债务如实登记（见验证节）。另 115→122 计数同步修正。
3. **隐式 push 绕过受保护分支判定（采纳，修复+加严）**：裸 `git push`/`git push origin`/`git push origin HEAD` 实际目标由 upstream/push.default/HEAD 指向决定，可指向受保护分支——external push 加「目标词级可见」门（`externalPushRefspecVisible`）：①必须存在显式 refspec；②refspec=HEAD/HEAD:dst 省略目标名拒；③dst 含受保护名拒（纵深防御，主拦面仍=守卫 protectedPushHit）；④多余位置词/动态词 fail-closed。比 linked 严一档——新开的门从最窄开始，linked 的同类收紧属存量面起另题。7 个隐式/受保护形态用例钉死。
4. **commit 缺 Modification-Class 声明（采纳，r1 commit 补齐）**：`Modification-Class: narrow-fix`（修法决策树①既有语义内修——push/fetch 授权机制既有，本次只收窄 external-linked 进入既有分支）。

建议提醒（B5 撞车）：#1691 重叠两文件，后合入方 rebase 重验——登记入遗留，合入时按序处理。

**delta 第 1 轮（mimo-pro 接续，4 条）处置**：
- **D-1 config-lock 单端点（采纳，r2 修复）**：`config\\.lock$` → `config(\\.lock)?$` 双端点（照 packed-refs 先例）——push -u 落 config 走 lock+rename，rename 目标=本体，单端点 upstream 登记 EPERM；profile 规则断言钉死双端点。
- **D-2 PR body 证据段失实残留（采纳，同步）**：CI 绑定→macOS 本机绑定、114→130、c00bb37f→24c8bd4e。
- **D-3 gate 与守卫语义 7 处分歧（采纳，r2 镜像修复）**：剥 `+` force 前缀 / 首冒号取 dst / lowercase / 精确集合匹配不拆路径段（`fix/main` 合法分支不再误拒，`+main`/`Main` 拒）；PUSH_VALUE_FLAGS 收敛为 `-o`/`--push-option`（同守卫）——`--repo`/`--force-with-lease` 不再吞 refspec 位。11 拒绝形态 + 4 合法形态用例双向钉死。
- **D-4 爆炸半径文档口径（采纳）**：改为「词级可见非受保护 refspec」表述（上文已同步）。
