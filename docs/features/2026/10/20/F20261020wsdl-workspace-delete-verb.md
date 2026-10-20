---
id: F20261020wsdl
title: workspace_delete 工作区删除动词——临时件回收机械路径（#1484，sandbox 语义增删对称）
summary: 对话工作区只有 read/write/list/info 四动词、无删除入口，shell 直删又被「主仓 data 目录运行时保护」守卫拦（workspaces 归保护类）——临时件回收无机械执行路径，合入善后 skill 的工作区步骤每次都要搭档手动贴命令（issue #1484 案发现场：10-14 评估 14 项临时件约 1MB 无路径回收）。修法走 issue 排查方向 1（工具层补删除动词，比守卫开白名单正统——不碰守卫威胁模型）：WorkspaceGateway 增 deletePath（安全边界与读写同构，resolveSafe 拒穿越/拒 symlink 逃逸，另拒删工作区根；目录须 recursive=true 才整树删），workspace_delete 工具动词挂进 workspace 工具族，注册面五处同步（manifest workspace 块 / session-helpers 大小獭 fallback / query-otter-profile）；synthesis 只读白名单刻意不收（删除是写）。
change_type: feature
capability_test: tests/interface-adapters/agent-runtime/tools/workspace-tools.test.ts
intent:
  problem: "对话工作区无删除入口，shell 直删被「主仓 data 运行时保护」守卫拦——临时件回收无机械执行路径，合入善后的工作区清理步骤每次都要搭档手动贴命令（#1484）"
  expected_effect: "workspace_delete 动词经注册面五处就位后，獭可在对话工作区内机械回收临时件（非空目录须 recursive 显式声明；穿越/symlink 逃逸/根删除一律拒）；演练判据：工具面可调 + 实测回收一个临时文件成功"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
---

## 问题陈述

issue #1484 案发现场（2026-10-14，搭档授权「你自行评估还清理干净工作区」）：评估出 14 项临时件（约 1MB）待回收，执行无路径——

1. workspace 工具面仅 read / write / list / info 四个动词，没有删除入口
2. shell 直删命中「主仓 data 目录运行时保护」守卫（对话工作区位于 data/ 之下，守卫把 workspaces 列为保护类，指引「确需清整主仓数据时报告搭档人工执行」）
3. 后果：合入善后 skill 的工作区步骤（post-merge-cleanup 步骤 8「时效性清理，自主执行不请示」）没有机械执行载体，每次都要搭档手动贴命令；临时件持续累积

语义矛盾点：workspace_* 工具自称 sandbox，却无增删对称的删除能力。

孪生单 #1524（P2，对话工作区缺少删除入口）同根因，UI 入口形态待产品侧定——本特性先把工具面（issue #1484 关闭标准认可的二选一路径之一）落地，UI 形态留 #1524。

## 根因

无缺陷根因——是能力缺口：workspace 工具族（`createWorkspaceTools` 注册面）从未提供删除动词；`WorkspaceGateway` 端口只有整区回收（`removeWorkspace`，随对话归档走），无单条目删除。守卫对 data/workspaces 的保护口径本身没错（那是防 shell 误删主仓数据的粗粒度防线），缺的是一个带沙箱边界校验的正规删除通道。

## 机制判定（修法决策树，动手前）

机制识别检查点：新增配置字段/枚举/开关、状态生命周期、定时任务、信号类型、持久化存储、记住结果的决策分支——全否；**「跨模块调用路径」字面命中**（新增 `deletePath` 网关方法，tool→gateway 新调用段）——论证不涉净新增机制：`deletePath` 是既有 `WorkspaceGateway` 端口内的方法级扩展，调用方向与 `workspace_write` 完全同构（同一 `createWorkspaceTools` 注册点、同一 `resolveSafe` 安全边界、同一 ToolContext 闭包模式），无新契约/新机制层；新工具动词属既有工具族内「缺啥补啥」。→ **修法①既有语义内修（narrow-fix）**，Modification-Class: narrow-fix，轻对抗（不召预审獭），PR 常规对抗审视照走。

## 设计取舍

1. **走 issue 排查方向 1（工具动词），不走方向 2（守卫开白名单）**——守卫的 workspaces 保护类是防 shell 误删的粗防线，开白名单要在守卫威胁模型上凿洞且口径难收（子路径白名单、嵌套 decoy 都是新判据）；工具层删除自带 resolveSafe 沙箱边界，安全口径与读写一次继承。issue 原文亦判「1 更正统」。
2. **删工作区根硬拒绝**（`deletePath` 网关层 throw，工具层空 path 提前报错）——整区回收是 `removeWorkspace`（对话归档）的事；单条目删除动词拿到根删除能力就是误操作放大器。防线放网关层（安全边界所在），工具层错误提示只是体验。
3. **目录删除防误删语义：非空目录必须 `recursive: true`**——默认只能删文件和空目录，整树删除要显式声明；错误信息带补救提示（「pass recursive=true」），agent 可自愈。
4. **lstat 口径判类型**——symlink 按链接本身删除、不跟随目标（删链接不该连坐目标）；symlink 逃逸形态由 resolveSafe 既有 realpath 校验拒绝（与读写同源，fail-closed）。顺带这也天然挡掉「删 symlink 指向的工作区外文件」。
5. **synthesis 只读白名单刻意不收**（SYNTHESIS_READ_ONLY_TOOL_WHITELIST 不加）——白名单走正道（只列安全项），删除是写操作，摘要合成路径永远不该碰。
6. **post-merge-cleanup skill 步骤 8 不改文本**——该步骤本就要求「自主执行不请示」，缺的只是执行载体；工具 description 里写明「When: 回收工作区沙箱内的临时件/草稿（合入善后清整、时效性清理）」即承担场景引导（场景型 know-how 归工具 description 的增长纪律）。skill 文本改动会牵动软代码全套验证（intent/golden gate/锚点重放），与本次硬代码收益不成比例，留给后续需要时单独走。

## 影响范围

- 新增面：`WorkspaceGateway.deletePath`（接口 + `NodeWorkspaceGateway` 实现）、`workspace_delete` 工具动词、`config/tool-manifest.json` workspace 块、`session-helpers` 大小獭 fallback 两处、`query-otter-profile` 工作区组
- 不动面：synthesis 只读白名单（不收删除）、守卫判定链（write-target-evaluator 的 data/workspaces 排除区口径不变）、`removeWorkspace` 整区回收、UI/API（workspace-api，#1524 产品形态另议）
- 行为变化：工具面从 4 个 workspace 动词变 5 个（白名单长度钉同步：big 36→37、small 31→32）

**负面向验收（刹车二）**：本次变更没有绕过任何既有保护——①它不放宽守卫任何放行面（shell 直删 data/workspaces 照拦）；②删除自身带三层边界（resolveSafe 穿越/逃逸拒、根删除拒、非空目录默认拒）；③唯一「破坏性能力」增量被关在沙箱单对话边界内。反向风险（新增 rm 能力本身）由上述边界 + 不可逆 GOTCHA 描述（引导先 workspace_list 确认）对冲。

## 验证

- 单测：deletePath 网关套件 10 例（tests/frameworks/file-system/node-workspace-gateway.test.ts：删文件/删空目录/非空默认拒/recursive 整树/根保护（空路径与 .）/穿越拒/symlink 逃逸拒/symlink 链接本身 lstat 口径/不存在报错/recursive 树内嵌套 symlink 不跟随目标（检视建议 1 补钉））+ workspace_delete 工具面 8 例（tests/interface-adapters/agent-runtime/tools/workspace-tools.test.ts：注册面/删文件/删空目录/非空带补救提示/recursive 整树/空 path 拒/穿越透传/不存在报错），真实 NodeWorkspaceGateway + tmpdir 全绿；coding-tools.test.ts 白名单长度钉三处同步（big 36→37、small 31→32、undefined 同步 37）
- 回归：全量 vitest 410 files / 6525 passed + 6 skipped，唯一失败为 `cursor-zero-guard.test.ts` 5s 超时 flaky（已知族 #1366/#1555，本 diff 不涉该模块；**pre-existing 基线对照证据**：该文件隔离复跑 worktree 侧 9/9 绿、main 基线（766a2c97）9/9 绿——全量并发下的间歇性超时，非自引入）
- `tsc --noEmit` 零报
- **最简实现检查**：已过——仓库已有实现（`fs.rm`/`fs.unlink` 原生，无新依赖）；安全校验全部复用 `resolveSafe` 既有基座不重写；网关返回 `{deleted: kind}` 是删除时 lstat 的免费副产物（省掉工具层二次 stat）。确认无更简等义实现
- **issue 验证断言的实测演练**（工具面核对 + 回收一个临时文件）需新代码进运行实例后执行——随合入后 build+重启做，届时在 issue #1484 留痕后关闭（关闭标准 2）
