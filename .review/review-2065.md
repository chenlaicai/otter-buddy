# 对抗审视报告：PR #2065（merge_pr 跨仓解析，#2037）

## 审查者
检视獭-mrprs（对抗审视，异体执行）

## 审查结论
**需要修改**（2 个严重发现；单账号环境——gh 登录即 PR 作者，request-changes 物理不可达，按 adversarial-review skill 单账号降级规则以 --comment 留痕，结论以本行结论词为准，合入拦截靠 CI check 红 + 大獭编排纪律）

## 上轮处置确认
| 上轮发现 | 处置终态 | 证据 |
|---------|---------|------|
| 无（首轮审阅） | — | — |

## 模型多样性
- 审查方模型：glm（GLM-5.3，系统注入）
- 被审查方模型：未在本次任务输入中提供，未核实
- 是否异模型：未核实（大獭编排层可确认）

## 本轮焦点与防锚定披露
**独立焦点声明**（按后果最重原则，先于作者清单组织）：
1. **安全语义**：narrow-fix 声明下四闸（授权/时间/短话术/闭环）判定语义零改动的核对——合入不可逆，任何闸语义被悄悄改变是本 PR 最高后果失败模态
2. **合入对象错配面**：repo 入参引入的解析与号核对完备性——合错 PR 是本修复攻击面内后果最重的方向
3. **审计可回查完整性**：同号跨仓 PR 授权语境的唯一回查能力

**作者清单比对披露**：派工单「重点攻击面」四条（正则边界/号核对完备性/四路径覆盖/审计 repo 完整性+注入面）与本焦点 ②③ 完全重合，B1/B2 由基础维度覆盖；清单未含 ①（narrow-fix 语义核对），已补查。清单经派工单物理先见（顺序不可达「先独立后读清单」），恢复方式＝按后果最重原则独立组织焦点后再核清单；比对结果＝重合、无清单引导出的遗漏项，未感到方向性锚定。

## 基础维度检查
| 维度 | 结论 | 证据 |
|------|------|------|
| B1. CI 状态 | **失败** | check job ✗（run 45810908797 / job 139878233131）；guard-macos ✅ / golden-selftest ✅ / e2e ✅（`gh pr checks 2065`）。本地复跑：merge-pr-tool 46/46、interface-adapters+closure 886/886、tsc --noEmit 0 错误（2026-11-26 19:31-19:33，worktree c089f14e9）。→ 发现 1 |
| B2. 文档完整性 | **不一致** | 特性文档存在（docs/features/2026/11/26/F20261126mrprs-merge-pr-cross-repo-resolution.md）；intent 块 ✅；设计取舍声称「ToolContext 无工作区路径数据源」核实属实（src/usecases/ports/agent-tools.ts:127-145 @ c089f14e9，字段清单无路径类字段）；验证数字与本地复跑一致。但「审计 title 加 repo」声明与实现不符 → 发现 2 |
| B2.5 方案前提 | 通过 | 修法直击 issue 根因（gh cwd 解析 → 显式 --repo）；「工作区 remote 回退」三层收敛两层的事实边界如实披露为「未实现 + 属事实边界」，代价未包装成收获 |
| B3. 全链路验证 | 通过（验证深度合理） | 真实命令双向复验（本獭重跑，2026-11-26 19:35，主仓 cwd）：`gh pr view 4052 --json state` → `Could not resolve to a PullRequest`；`gh pr view 4052 --repo colink-group/CoLink --json state,headRefName` → `{"state":"OPEN",...}`——与 PR body 声称逐字一致。全链（view→闭环→审计→merge）由单测 stub 覆盖；真实跨仓 merge 端到端未跑（合入不可逆，不应真合 CoLink#4052）——该验证深度合理 |
| B4. 变更标识一致性 | 一致 | F20261126mrprs 在 commit（c089f14e9）/ PR title / 特性文档 id 三处一致。Modification-Class=narrow-fix 核对：diff 无新配置字段/枚举/开关、无新状态生命周期、无新定时任务、无新信号类型、无新持久化、无新决策分支（repo 参数为既有工具入参扩展，纯运行时透传）、无新跨模块调用路径（闭环脚本传参为既有路径加参）——七项清单零命中，声明成立 |
| B5. 撞车检查 | 无发现 | open PR 清单（2066/2064/2043/2023/2017）无同 issue #2037 引用、无 tool-factory.ts / check-pr-review-closure.mjs 重叠 |
| B6. Intent 块 | 通过 | frontmatter 含 intent.problem/solution/expected_effect/verify_by |
| B7. Golden Gate | 不适用 | 硬代码改动（工具 TS + 脚本），verify_by=behavior_check，非 prompt/skill/协议层 |
| B8. 体积预算 | 不适用 | diff 不触 prompts/scheduled/*.md |
| B9. 证据包核验 | 通过 | Rollback 段 ✅；Verification 含失败用例证据（修复前 4 红 + 真实 gh 404 现场）✅；机器锚点与 agent 陈述分层标注 ✅。抽样复验：46/46、886/886、tsc 0、真实 gh 双向全部本獭重跑复现 ✅。判别力三查：断言 `toContain('--repo')` 直接对照 bug 形态（旧实现不带 --repo 必红），判别力由断言逻辑确认；「修复前红」状态未本地复现（须 revert 改码，检视者只读边界），标注为推演确认 |

## 严重发现

### 发现 1：CI check job 红——check-pr-tests 测试弱化声明闸拦截（B1）
- **位置**：PR body「测试改动声明」段；触发源 `scripts/check-pr-review-closure.mjs`（-4/+13，验收装置文件）
- **事实与影响**：CI run 45810908797 check job 失败（exit 1）。本 PR 改动验收装置文件且含删除行，`check-pr-tests` 闸要求 PR body 测试改动声明段含「方向：收紧/放宽」字段（放宽时须理由）；现声明段仅列用例数。CI 红期间分支保护挡合入。
- **证据**：CI 日志（job 139878233131）：`[check-pr-tests] 测试/验收装置路径出现删除行 1 个文件：[验收装置] scripts/check-pr-review-closure.mjs（-4 / +13）` + `✗ 声明段缺「方向：收紧」或「方向：放宽」字段`；本地复现：`node scripts/check-pr-tests.mjs --base origin/main`（worktree c089f14e9）输出同判定
- **处置**：本 PR 修复（严重不可延后；声明段方向值与理由由作者设计）

### 发现 2：审计 title 未加 repo——PR body 与特性文档声明均与实现不符（B2/B3）
- **位置**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:1240` 与 `:1245` @ c089f14e9（title 模板），对照同函数 `:1241`/`:1246`（content 已含 repoDesc）
- **事实与影响**：PR body「审计带 repo」段声称「linked_resources content、**title** 与 warn 日志加 repo 字段」；特性文档「修法」第 4 条声称「审计 **title**/content 与 warn 日志加 repo」。实际 diff 中 `buildMergeAuditRecord` 仅 content 两处加了 `repoDesc`（:1241/:1246），title 两处模板（:1240/:1245）均不含 repo。影响：①审计记录 title 维度上同号跨仓 PR 仍不可区分——恰是 PR/文档自身声明的防御目标（「同号 PR 在不同仓库同名，审计不含 repo 则授权语境无法唯一回查」）；②交付声明与 diff 不符，削弱证据链可核性（机械可数）。测试同步缺口：新增审计用例仅断言 content 与 warn，未断言 title。
- **证据**：`grep -n '合入授权记录\|合入授权拒绝记录' src/interface-adapters/agent-runtime/tools/tool-factory.ts` → :1240/:1245 title 无 repo，:1241/:1246 content 有 repoDesc；PR body「审计带 repo」段原文；特性文档「修法」第 4 条原文
- **处置**：本 PR 修复（严重不可延后；补 title 或订正两处声明属作者设计域）

## 建议发现

### 发现 3：URL 号核对防线在号不可解析形态下静默失效（焦点：错配面/边界条件）
- **位置**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:1033-1035` @ c089f14e9（URL 正则可选组），`:1400-1401`（号核对逻辑）
- **事实与影响**：号核对仅当正则捕获组 `pull\/(\d+)` 命中才发生。用例级攻击实证（函数体逐字提取自 :1030-1041 复刻运行，35 用例）：`pulls/123`（复数 typo）、`pull/abc`、`pull//123`、`pull/-5`、`issues/456` 等形态均解析为 `{repo:"o/n"}`——repo 被接受、urlPrNumber 静默丢失、号核对不发生。设计立场是「URL 捎带号时核对防看错链接传错号（合入不可逆，宁可多一次往返）」，号捕获失败时该防线消失且无任何提示。错配触发条件：prNumber 显式传错 + repo 传 typo 形态 URL 双失误同时发生（repo 部分仍从 URL 正确提取）。既有测试未覆盖 typo URL 形态。
- **证据**：攻击脚本输出（节选）：`"https://github.com/o/n/pulls/123" → {"repo":"o/n"}`、`"https://github.com/o/n/pull/abc" → {"repo":"o/n"}`、`"https://github.com/o/n/issues/456" → {"repo":"o/n"}`；对照正常形态 `"https://github.com/o/n/pull/123/commits" → {"repo":"o/n","urlPrNumber":123}`
- **更好/更差判断**：作者须回答——改了让系统变好 / 变更差
- **处置**（由作者按决策树选定）：更好 → 本 PR 修复 / 建 issue #N（论证本 PR 无法承载）；更差 → 反驳（须附证据）

### 发现 4：闭环脚本 docs-only 豁免在跨仓场景恒失效，行为与本仓不对称（焦点：正确性）
- **位置**：`scripts/check-pr-review-closure.mjs:153-158` @ c089f14e9（fetchChangedPaths 用本地 git），`:187-198`（main 内豁免段与 catch）
- **事实与影响**：docs-only 豁免判定用 `git diff ${baseRef}...${headRefOid} --name-only` 在**本地仓**执行。跨仓 PR 的 headRefOid 不存在于本地仓 → git diff 必然报错 → catch 分支「跳过 docs-only 豁免」→ 走 review 判定。结果：跨仓 docs-only PR 永远无法享受豁免（会被要求检视回执），与本仓 docs-only PR 行为不对称；偏移方向为 fail-closed（不构成绕过面）。本 PR 未在特性文档残留表记录此不对称。
- **证据**：脚本 :153-158（execFileSync "git" diff 本地执行）、:189（fetchChangedPaths 调用点）、:196-197（catch → 跳过豁免）；跨仓 PR headRefOid 与本地仓对象库无交集为 git 语义事实
- **更好/更差判断**：作者须回答——改了让系统变好 / 变更差
- **处置**（由作者按决策树选定）：同上

### 发现 5：裸 repo URL（仓库主页）被格式拒绝（焦点：边界条件/输入宽容）
- **位置**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:1033` @ c089f14e9（URL 正则要求 name 段后跟随 `/`）
- **事实与影响**：`https://github.com/o/n`（无尾斜杠、无 pull 段）不匹配 URL 正则（要求第三段斜杠），落入 owner/name 格式校验被拒；`https://github.com/o/n/`（尾斜杠）却通过。从浏览器地址栏复制的仓库主页 URL 属常见输入形态，会被结构化报错引导重传。报错文案引导路径（owner/name / 整条 PR URL）清晰，功能可绕行。
- **证据**：攻击脚本输出：`"https://github.com/o/n" → {"error":...}`、`"https://github.com/o/n/" → {"repo":"o/n"}`
- **更好/更差判断**：作者须回答——改了让系统变好 / 变更差
- **处置**（由作者按决策树选定）：同上

## 焦点维度结论
| 焦点 | 结论 |
|------|------|
| 安全语义（narrow-fix 声明核对） | **无发现**：checkApprovalGates（时间闸+短话术闸）零改动（diff 无涉）；闭环谓词 checkReviewClosure 零改动（脚本仅 fetchPrReviewData 加参）；授权原话闸零改动；审计判定（何时写/reasonCode）零改动，仅字段扩展；执行顺序变化（repo 校验先于 partnerApproval 空检查）属参数校验层，不涉授权判定 |
| 合入对象错配面 | 发现 3（号核对完备性缺口）；URL 提取产物受 `[\w.-]` 白名单约束，无注入面 |
| 审计可回查完整性 | 发现 2（title 层缺口）；content/warn 层已覆盖，四条审计写入路径（成功/approval_not_found/gateRejection/merge 失败）全带 repo ✅ |
| 四条 gh 路径覆盖 | **无发现**：tool-factory.ts:1048（状态门 view）/ :1329（诊断 view）/ :1389（merge）/ :1299-1301（闭环脚本 node 调用）+ 脚本内 fetchPrReviewData 全部条件携带 --repo，无漏改的 gh 调用（全仓 grep 核对） |
| 注入/绕过面 | **无发现**：execFile 参数数组传递无 shell 拼接；repo 白名单字符集；闭环脚本 --repo 缺参 fail-closed（exit 2）；URL 尾拼第二 URL / 编码斜杠等怪形态均被白名单挡住 |

## 维度扫视结论
| 维度 | 类型 | 结论 |
|------|------|------|
| B1. CI 状态 | 基础 | 失败（发现 1） |
| B2. 文档完整性 | 基础 | 不一致（发现 2） |
| B2.5 方案前提 | 基础 | 通过 |
| B3. 全链路验证 | 基础 | 通过 |
| B4. 变更标识一致性 | 基础 | 一致（narrow-fix 七项清单零命中） |
| B5. 撞车检查 | 基础 | 无发现 |
| B6. Intent 块 | 基础 | 通过 |
| B7. Golden Gate | 基础 | 不适用（硬代码） |
| B8. 体积预算 | 基础 | 不适用 |
| B9. 证据包核验 | 基础 | 通过（抽样复验全复现） |
| 正确性 | 焦点 | 发现 4 |
| 边界条件 | 焦点 | 发现 3、发现 5 |
| 安全性 | 焦点 | 无发现（narrow-fix 语义核对通过） |
| 架构合规 | 扫视 | 无发现（子步骤函数抽出符合既有结构；resolveTargetRepo export 供测试引用） |
| 测试覆盖 | 焦点 | 发现 2/3 各含对应测试缺口；5 新用例对四条 gh 路径与缺省零变化有判别力 |
| 可维护性 | 扫视 | 无发现 |

## 附：验证证据清单（本獭独立执行）
1. `npx vitest run tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts` → 46/46（19:31）
2. `npx vitest run tests/interface-adapters/ tests/scripts/check-pr-review-closure.test.ts` → 886/886（19:33）
3. `npx tsc --noEmit` → 0 错误
4. `gh pr checks 2065` → check ✗ / guard-macos ✅ / golden-selftest ✅ / e2e ✅
5. 真实 gh 双向：主仓 cwd `gh pr view 4052` → 404；`gh pr view 4052 --repo colink-group/CoLink` → OPEN（19:35，与 PR body 声称逐字一致）
6. resolveTargetRepo 边界攻击 35 用例（函数体逐字提取复刻，/tmp/review-2065-attack/attack.mjs）→ 发现 3/5 证据
7. `node scripts/check-pr-tests.mjs --base origin/main` 本地复现发现 1 的闸判定

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 检视獭-mrprs

---

# Delta 复核报告（第一轮处置，commit 7572766db）

## 审查结论
**通过（delta 复核）**——五条发现处置终态全部达成（单账号环境，approve 物理不可达，以 --comment 留痕，结论以本行为准）

## 上轮处置确认
| 上轮发现 | 处置终态 | 证据（本獭独立验证） |
|---------|---------|------|
| 发现 1（CI 声明闸） | 修复+delta 确认 | PR body「测试改动声明」段已补「方向：收紧 + 理由」；本地 `node scripts/check-pr-tests.mjs --base origin/main --pr-body-file` → 「OK（测试/验收装置改动声明已登记）」 |
| 发现 2（审计 title 缺 repo） | 修复+delta 确认 | tool-factory.ts:1246/:1252 title 两处补 `${repoDesc}` @ 7572766db；新增用例 d3 断言 `linkArg.title` 含 repo（merge-pr-tool.test.ts:835-843） |
| 发现 3（URL 号静默丢失） | 修复+delta 确认 | 正则收紧 @ tool-factory.ts:1034-1039：攻击复跑（函数体逐字提取复刻 34 用例）实证 pull/abc、pulls/abc、pull//123、pull/-5、pulls/ 空号五形态全部显式拒绝；pulls/123 复数形态号可解析走核对（处置强于初轮主张）；基线形态（PR URL/后缀/大小写/前导零/查询参数）零回归；判别用例 d1 三形态钉住 |
| 发现 4（跨仓 docs-only 豁免不对称） | 登记+不修裁决（残留表收编） | 特性文档残留表新增行（diff @ 7572766db），fail-closed 方向理由如实 |
| 发现 5（裸 URL 被拒） | 修复+delta 确认 | 正则放宽 @ tool-factory.ts:1034：`https://github.com/o/n` → `{repo:"o/n"}`、`https://github.com/colink-group/CoLink` → 合法；`https://github.com/o`（仅 owner）→ url[2] 守卫拒绝；用例 d2 钉住 |

## Delta 独立验证清单
1. `npx vitest run tests/.../merge-pr-tool.test.ts` → 49/49 ✅
2. `npx tsc --noEmit` → 0 错误 ✅；eslint 改动文件 0 错误 ✅
3. resolveTargetRepo delta 版边界攻击 34 用例（逐字复刻自 :1030-1042 @ 7572766db）→ 处置形态全符合声明，无基线回归
4. check-pr-tests 本地闸复跑 → 声明已登记 ✅

## Delta 观察（不构成新发现，如实记录）
- `issues/456` 形态行为未变（repo 接受、号丢弃、无提示）——归类修正：issues 号无 PR 号语义，属宽容接受族，不在发现 3「PR URL 捎带号」主张域内（初轮报告将其列入证据清单属归类扩大化，本獭修正）；`pulls123`（粘连）、裸 `pull` 段同族，形态极怪
- CI check 红（run 45813628480）= **behind main** freshness 闸：main HEAD 2bc17e6cb > merge base 533598278——需作者 rebase/merge main 重推后 CI 重跑，非发现 1 回归、非 delta 处置缺陷；guard-macos/golden-selftest 已绿，e2e pending
- `.review/review-2065.md`（初轮报告）随 delta commit 进入分支历史——无功能影响，作者侧知悉即可

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 检视獭-mrprs
