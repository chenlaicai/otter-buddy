---
title: 远程文件面对齐（阶段 7 PR-B）
id: F20261120rfile
date: 2026-11-20
module: session
change_type: feature
summary: |
  落实 #1868 阶段 7 PR-B：RemoteExecutionEnv 补齐 SDK 文件面，
  read/write/edit 与 bash 一样物理落到所选 connector 设备，不再显式
  not_supported。协议 v2 新增 file.* 动作族与句柄资源协议（二进制/目录/
  行读取器），connector 侧新增 FileActionExecutor 复用本地台账五态恢复；
  watch 与 listFiles 显式禁用并验证调用方降级路径。
intent:
  problem: "PR-A 后远程对话只有 bash 真落设备；SDK read/write/edit 走文件面显式 not_supported，等于远程对话编码工具面不可用"
  expected_effect: "对话选择 connector 后 SDK read/write/edit/bash 全链在该设备工作区执行；写动作幂等可恢复；reader 类有状态资源经句柄协议可用；watch/listFiles 显式禁用且 SDK 有降级路径"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/frameworks/execution/remote-env-conformance.test.ts：pi-durable env conformance 子集（reader/exec）经回环通道全过"
      - "tests/frameworks/execution/remote-execution-env.test.ts：路径跨机映射、base64、错误码还原、禁用面"
      - "tests/frameworks/execution/connector-file-e2e.test.ts：真 WSS 上 DurableSession write/edit/read/bash(git) 全链物理落设备目录"
      - "tests/connector/file-action-executor.test.ts：文件动作/台账/幂等/句柄生命周期"
capability_test: "tests/frameworks/execution/connector-file-e2e.test.ts"
---

# F20261120rfile：远程文件面对齐（阶段 7 PR-B）

## 背景

PR-A 交付了远程 shell.exec 与协议 v2 双栈，但 RemoteExecutionEnv 文件面
全部显式 not_supported——远程对话的 read/write/edit 不可用。本切片补齐
文件面，让「界面选 B、编码工具全链在 B」成立。附件传输与定时任务离线语义
仍属后续切片。

## 交付

### 协议 v2 文件动作族

- 无状态动作：file.read / file.readBinary / file.write / file.append /
  file.truncate / file.rename / file.remove / file.mkdir / file.stat /
  file.list / file.exists / file.canonicalPath / file.absolutePath /
  file.joinPath / file.createTempDir / file.createTempFile / file.flush。
- 句柄资源协议（有状态读取器）：file.openReader（二进制）、
  file.openDirReader、file.openLineReader 配 readerRead / readerScanLines /
  readerInfo / dirReaderNext / lineReaderRead 与共享 file.resourceClose；
  句柄随会话更替与进程下线全量关闭。
- 二进制内容 base64 上线；FileInfo/LineScan/TextLine 均为 JSON 安全线形。
- 版本协商沿用 hello 交集；file.* 与 reader 族 minVersion=2，v1 会话
  下行即拦（fail-closed），v1 六动作零回归。
- 错误面：FileError code 经 action.result 的 errorCode 透传，hub 侧还原为
  SDK FileError（aborted→interrupted，其余域错误→failed）。

### hub 侧 RemoteExecutionEnv 文件面

- 路径跨机映射：相对路径相对 hub cwd 解析后映射设备工作区后缀；hub 工作区
  内绝对路径同样映射；工作区外绝对路径与 ~/file:// 特殊形态按设备侧语义
  保留/解析（与 PR-A 的 cwd 契约同源）。
- absolutePath/canonicalPath/joinPath 作为远程动作在设备侧解析，设备路径
  语义（符号链接、分隔符）不走 hub 近似。
- openBinaryReader/openDirReader/openLineReader 返回句柄代理，read/info/
  scanLines/next/readLine 逐次过通道；close 幂等。
- watch 与 listFiles 显式 not_supported：SDK 对二者均有契约化降级
  （listFiles 可选、调用方回退自有遍历；env.watch 无生产调用方），
  并有测试锚定降级路径可用。

### connector 侧 FileActionExecutor

- 直接复用 NodeExecutionEnv（每动作以设备工作区根为 cwd 构造）+ 既有
  SqliteActionLedger 记账：actionId 用 hub 下发值，conversationId/invokeId/
  toolCallId 归因透传。
- 写类动作（write/append/truncate/rename/remove/mkdir）落台账五态：
  write/append 记 contentHash+contentBytes 供开机清扫 hash 核对；
  write 保持原子写（同目录临时文件 rename、symlink 跟随、mode 保留、
  broken link 逐级解析），与中枢 local 语义对齐。
- 读类动作不入账（与 local 一致：幂等只读不写台账）。
- 每类读器句柄表 + 会话更替/下线全量关闭；未知句柄回 invalid，close 幂等。
- 优雅下线顺序保持：先取消 shell 进程组，再关闭读器句柄，再台账收尾。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 文件动作粒度 | 每方法一动作 + 句柄族 | 单 file.op 泛型 | 白名单/台账/类型逐点对齐既有六动作风格 |
| 路径解析位置 | 设备侧（远程动作） | hub 侧模拟 | 符号链接/~/分隔符语义只有设备侧正确 |
| 读器 | 句柄资源协议实现 | 全部禁用 | read 工具硬性依赖 openBinaryReader，禁用即工具死 |
| watch/listFiles | 显式 not_supported | 自建事件流协议 | 无生产调用方/契约自带降级，事件流协议属过度工程 |
| 写恢复 | 复用台账 hash 核对 | 传输层重放 | 五态纪律：崩溃后 hash 定真假，不盲重放 |

## 机制识别检查点

- 新增持久化存储：否（复用 remote_action_requests 与 connector 台账）。
- 新增状态生命周期：是（读器句柄的打开/使用/关闭/会话更替清理）。
- 新增信号/消息格式：是（file.* 动作族与句柄动作的 input/result 线形）。
- 新增决策分支：是（路径跨机映射、版本闸覆盖新动作族）。
- 新增跨模块路径：是（SDK 工具 → RemoteExecutionEnv → WSS → connector 文件执行器）。

## 验收标准

| 场景 | 预期 |
|---|---|
| 对话选 B 的 write/edit/read | 物理写读 B 的设备工作区；hub/A 同路径无文件 |
| 二进制内容 | base64 往返字节级一致 |
| 路径形态 | 相对/工作区内绝对/设备绝对/~/file:// 与 NodeExecutionEnv 语义一致 |
| 写动作崩溃/重放 | 台账 hash 核对 + actionId 幂等，不重写已成功文件 |
| read 工具 | openBinaryReader 句柄链（info/read/scanLines/close）全过 |
| watch/listFiles | 显式 not_supported；listFiles 调用方回退 listDir 遍历可用 |
| v1 会话 | 六动作不变；file.* 与 reader 族下行即拦 |
| 断线/优雅下线 | 沿用五态收尾；句柄随会话更替关闭 |

## Verification

- `tests/connector/file-action-executor.test.ts` 9 例：写读全链/台账五态与 hash/幂等重放/域错误直通/路径解析/三类读器句柄生命周期/closeAllResources/输入校验。
- `tests/frameworks/execution/remote-execution-env.test.ts` 13 例：跨机路径映射（相对/工作区内绝对/设备绝对）、base64 二进制字节级还原、FileError 还原、句柄链、cleanup 关柄、v1 会话闸、五态登记归因。
- `tests/frameworks/execution/remote-env-conformance.test.ts`：pi-durable env conformance 15/15 过（binary reader ×5、dir reader ×4、exec ×6）；watch 9 例排除（显式禁用面，SDK 无生产调用方）。
- `tests/frameworks/execution/connector-file-e2e.test.ts`（capability_test）：真 WSS 上 DurableSession 驱动 write/edit/read/bash(git init+commit+log) 全绿，文件物理落设备工作区、hub 同路径无文件、双侧五态落账。
- `tests/connector/action-dispatcher.test.ts` +3 例：file 路由/无执行器兜底/写类幂等快路径；白名单用例改用真未知类型（file.write 入白名单后原用例语义失效已修）。
- 闸：tsc 零错误；eslint 零警；`npm run build:connector` + 闭包检查 PASS；`npm run lint:docs` 1100 docs OK；check-pr-anchor-discipline PASS。
- 全量 vitest：6768 过，4 个存量失败（game/mahjong 视觉件，基线 commit 同败——环境依赖，与本切片无关）。

## Rollback

Revert 本切片即恢复文件面 not_supported 过渡态；协议 v1 行为不变。
无数据库 schema 变更；已入账台账与登记行保留为历史证据。
