---
id: F20261020kbpa
title: kill-by-pid 工作根校验误伤 alpha 实例修复——合法根扩为多根（工作根 + alpha 规范数据根）
summary: 修复 restart-service.mjs kill-by-pid 的 --project 校验只认 otter 工作根单根、把 alpha 规范数据根（~/.otter/alpha/<hash>）误拒在外，致 alpha 实例「停」无合法出路（issue #1580）：合法根扩为多根与 resolvePortEntry 口径统一，主进程保护/非根本身/cwd 归属校验全部保留。
created_at: 2026-10-20
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
type: bugfix
change_type: fix
intent:
  problem: "alpha 规范数据根（~/.otter/alpha/<hash>）不在 kill-by-pid 工作根校验的合法根内，alpha 实例受控终止通道被堵死（启有 alpha.sh，停无合法出路）"
  expected_effect: "kill-by-pid 对 alpha 数据根内进程放行（exit=0 受控 SIGTERM），alpha 根外与根本身仍拒绝，主进程/自身/父进程拒绝与 cwd 归属校验不变式一条不弱；单测全绿，含 #1580 失败证据/回归/fail-closed 用例与 wiring/双源等值对齐锁定"
  verify_by:
    type: behavior_check
related: F20261008hcpa, F20260917alph, F20261014alps
---

# kill-by-pid 工作根校验误伤 alpha 实例修复

## 问题现象

issue #1580 现场（2026-10-20 17:53-18:30，对话 a23f0f4a）：按 alpha.sh 规范起复刻环境验证 e2e 后终止实例，两条通道全部失败：

1. 裸 `kill 92894 92896` → 主进程保护守卫拦截（合理但误伤自起 dev 进程）
2. 受控通道 `node scripts/restart-service.mjs kill-by-pid 92894 --project ~/.otter/alpha/8f113208` → 拒绝：`--project 必须在 otter 工作根 (/Users/orca/ai) 之下且非根本身`

alpha 实例「启」有 alpha.sh，「停」无任何合法出路。搭档定性：「alpha的启停肯定都是常用的操作啊，为啥会杀不死？……这是守卫的严重问题」。

## 根因分析

`scripts/restart-service.mjs` 的 `assertKillByPidSafe`（F20261008hcpa 引入）只接受单个 `allowedRoot`（= `path.resolve(otterRoot, "..")`，主仓运行时 = /Users/orca/ai），projectDir 须落在其下且非根本身。而 alpha.sh 的 `alpha_root_dir()` 把隔离实例数据根定义在 `~/.otter/alpha/<worktree-hash>/`——不在 otter 工作根之下，单根校验把 alpha 实例的受控终止通道整个堵死。

同文件 `resolvePortEntry` 的 --add 路径早已是 `allowedRoots` 数组口径（#1250 检视处置 S1），kill-by-pid 侧单根与其不一致——口径差就是缺口所在。

## 修复设计（修法决策树① narrow-fix）

**机制识别检查点判定**：逐项核对（新增配置/状态生命周期/定时任务/信号格式/持久化存储/被记住的决策分支/跨模块调用路径）全不命中——本修复只改既有校验的合法路径集合判定，纯运行时临时判定不落任何存储。走修法决策树①（既有语义内修：缺啥补啥），Modification-Class: narrow-fix。

1. `assertKillByPidSafe` 的 `allowedRoot` 单根参数 → `allowedRoots` 多根数组，任一根之下且非任一根本身即合法。**「口径统一」限定为参数口径（allowedRoots 数组语义）**：`resolvePortEntry` 对 roots 与 projectDir 另做 realpath 归一与存在性校验，本函数保持纯词法——缺 realpath 的偏差方向是误拒非放行，安全无洞
2. 主流程传双根：otter 工作根 + `~/.otter/alpha`（alpha.sh 规范数据根的父根，`<hash>` 级目录落在其下）
3. 空 `allowedRoots` → 拒绝（fail-closed，新增用例锁定）

**安全不变式全保留（负面向声明）**：mainPid 拒绝、selfPid/selfPpid 拒绝、「非根本身」语义（任一根本身仍拒）、lsof cwd 归属校验（PID 的 cwd 必须在声明 projectDir 下）一条未动。本变更未绕过任何既有保护——唯一变化是合法路径集合从 1 个根扩为 2 个根；alpha 数据根是 alpha.sh 自定义的隔离实例专用根（独立数据根设计见 F20260917alph），不含主仓数据/主进程。

**主进程保护覆盖范围（明示，检视 A3）**：`kbMainPid` 只读主仓 `.otter-buddy.pid`，保护对象是 otter-buddy 主进程（不可被 kill-by-pid 终止，mainPid E2E 实测在）；alpha 实例自身起的 node 进程不在 mainPid 保护面内，其受控终止恰是本单修复意图。alpha 实例如需同等主进程保护属独立增强项，不在本单范围。

## 验证

**失败证据固化（bugfix 硬规则）**：修复前先在 `tests/scripts/restart-service-kill-by-pid.test.ts` 追加 3 条 #1580 用例跑测试记录失败态，第 4 条 fail-closed 为修复后补（检视獭-1583 S1 计数勘误后口径）：

- **1 条失败证据（case1）修复前必红**：`1 failed | 11 passed`（修复前 it 总数 12 = 既有 9 + 新增 3）——`expect(assertKillByPidSafe(base)).toEqual({ ok: true })` 实得 `{ ok: false, error: "--project (…/alpha/8f113208) 必须在 otter 工作根 (…/fake-otter-workroot) 之下且非根本身" }`，与 issue 现场报错同款模板、语义一致（issue 现场无 projectDir 括注，根值随调用位置变，不称「逐字」）
- **2 条回归锁定（case2/case3）修复前天然绿**（单根下 alpha 路径全被拒 ⇒ `ok===false` 断言必真），作用是锁定「非根本身」与「授权面不外溢」语义在多根化后不被破坏，不是失败证据
- **1 条 fail-closed 锁定（case4）**：空 allowedRoots 拒绝，新增锁定
- 修复后全绿（初验 13 passed → delta 增补 wiring/双源等值对齐用例后 15 passed）

CLI 端到端对照（实弹冒烟，issue 验证断言形态）：

| 形态 | 修复前（main 版脚本） | 修复后 |
|---|---|---|
| `kill-by-pid <pid> --project ~/.otter/alpha/test-1580-smoke`（真实进程 cwd 在 alpha 路径下） | 拒绝 exit=1（报错与 issue 现场同款模板） | **SIGTERM 成功 exit=0；实弹终止 PID 56525（wrapper），其孤儿 node 进程 56528 后续经修复后通道清杀 exit=0，二次验证通道可用** |
| `--project ~/.otter/evil-dir`（alpha 根外） | 拒绝 | **仍拒绝** exit=1（授权面不外溢） |
| `--project ~/.otter/alpha`（alpha 根根本身） | 拒绝 | **仍拒绝** exit=1（非根本身语义保留） |

测试面：`tests/scripts/` 12 files 166 passed；eslint 通过。

**最简实现检查**：已过——阶梯：仓库已有 `resolvePortEntry` 的 allowedRoots 数组口径（复用同一语义而非新造白名单机制）→ 无 stdlib/依赖可选项 → 实现 = 参数数组化 + `Array.prototype.some` 一次遍历判定，无新文件无新依赖。未走「配置文件声明 alpha 根」等重方案（引入持久化配置 = 机制净新增，收益不成比例）。

**取舍与观察项**：

- worktree 形态差（pre-existing，非本次引入）：脚本的 `path.resolve(otterRoot, "..")` 在主仓运行时 = /Users/orca/ai（工作根），在 worktree 内运行时 = `.otter/worktrees`（worktree 兄弟目录算工作根内）。既有语义本单不扩面不修；真实防线是 cwd 归属校验，风险有限。若要治本应把工作根锚定为固定配置或仓外约定——留给后续观察，不在 #1580 范围。
- issue #1580 评论补录的现场 2（data_destructive 误拦 `~/.otter/alpha/<hash>` 数据根清理）属守卫规则族（#1418 data_destructive 豁免面同根因），归「守卫单一求值器终态」大特性统一收口，不在本单关闭标准（受控终止通道）内——已归口 #1418。

## 测试改动声明（PR body 用）

- 方向：测试增强——新增 4 条 #1580 用例（1 条失败证据 + 2 条回归锁定 + 1 条 fail-closed 锁定），既有 9 条用例断言不变，仅入参 `allowedRoot` → `allowedRoots: [...]` 适配新签名（签名变更属修法决策树①的实现细节，断言语义逐条未动）。
- 检视增补（delta）：wiring 覆盖用例（调用点双根构造提为导出函数 `killByPidAllowedRoots` 并单测锁定）+ 双源**等值**对齐断言（alpha.sh `alpha_root_dir()` 提取根与生产根严格相等比对，检视 A4/D2）。
