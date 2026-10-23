---
id: F20261023imts
title: IM 页前端组件测试补齐：先名后码流程 + 覆盖确认状态机（issue #1079）
summary: web/src/pages/im/index.test.tsx 落地 19 用例三路覆盖——①流程状态机（微信+飞书 idle→naming→connecting 转换、取消/返回、Enter 提交、名字保留）②覆盖确认弹层（同号命中两态文案、覆盖执行删旧建新、两步错误语义 delete 失败弹层保留 vs provision 失败回 idle、不覆盖取消）③账号列表 assistantLine 投影（已建线 title+预览/暂无消息、未建线与投影缺失回落异常指引）。web 全量 76 文件 778 用例绿 + tsc 零错误。
change_type: tests
capability_test: "web/src/pages/im/index.test.tsx 19 用例：绿 = 三路行为固化；若状态机转换/覆盖错误语义/投影回落被改坏，对应路径用例红（牙齿自证：改坏 confirmOverwrite 的 delete 失败分支 toast 文案即红）。回归口径：cd web && npx vitest run src/pages/im/index.test.tsx；全量口径：npx vitest run（76 文件 778 用例）+ npx tsc --noEmit"
intent:
  problem: "issue #1079（PR #1075 检视 D3）：IM 页重写后（F20260921imux 先名后码两步流程 + 同号覆盖确认）无前端组件测试覆盖——流程状态机、覆盖确认弹层两步错误语义、账号列表 assistantLine 投影均无回归防线。"
  expected_effect: "IM 页三路行为的回归在组件测试红灯拦截：状态机非法转换/覆盖错误语义合并误导（S1 历史 bug 类型）/投影回落文案漂移不再依赖人工验收。"
  verify_by:
    type: capability_test
    detail: "19 用例全绿 + web 全量 778 用例绿 + tsc 零错误（本地实跑）；三路径用例数 ≥ issue 正文清单（状态机 7 / 弹层 7 / 列表 5）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [tests, web, im, tech-debt]
modules: [web]
---

# IM 页前端组件测试补齐：先名后码流程 + 覆盖确认状态机（issue #1079）

## 1. 来源

issue #1079（P2 tech-debt，PR #1075 检视 D3（检视imux））。关闭标准（清账批次契约）：三路覆盖（流程状态机/覆盖确认弹层/账号列表投影）组件测试合入 + web vitest 全绿；验证断言：三路径用例数 ≥ 正文清单。

## 2. 方案设计

单测试文件 `web/src/pages/im/index.test.tsx`，按 issue 三路组织 describe。测试惯例对齐仓库既有实践（OtterProfileCard.test.tsx）：@testing-library/react（render/fireEvent/screen），`vi.mock` 静默 Toast 与二维码子组件（stub 暴露「模拟扫码确认」按钮直触 `onLoginConfirmed` 回调，把 ImPage 内部 handleLoginConfirmed 同号识别/建线路径拉进测试面），`vi.spyOn(api, ...)` 桩网络层。

### 三路用例清单（19 用例，对齐关闭标准「≥ 正文清单」）

| 路 | issue 正文清单 | 用例 | 数 |
|---|---|---|---|
| ① 流程状态机 | idle→naming→connecting 转换、取消/返回路径 | 微信：idle→naming / 空名 disabled / naming→connecting / Enter 提交 / 返回名字保留 / 取消回 idle；飞书：同款两步+返回+取消 | 7 |
| ② 覆盖确认弹层 | 同号命中展示、覆盖执行、两步错误语义（delete 失败 vs provision 失败） | 已建线文案「且已建助理线」/ 未建线文案「但未完成建线」/ 覆盖执行（删旧→建新→弹层关）/ delete 失败（toast「未做任何变更」+弹层保留+provision 不执行）/ provision 失败（toast「旧账号已清理」+回 idle）/ 不覆盖取消 / 无冲突直建 | 7 |
| ③ 账号列表 | assistantLine 投影渲染（已建线/未建线两态） | 空态 / 已建线 title+预览 / 已建线无消息「暂无消息」/ 未建线回落 / 投影缺失回落 | 5 |

## 3. 设计取舍

**机制判定**：纯测试增量（无新机制、无行为变更），机制识别检查点全项不命中——判定结论：无机制预算，四问不适用。

**Mock 面取舍**：二维码子组件（QRCodeLoginCard/FeishuQRCodeLoginCard）内部有自己的轮询与登录会话逻辑，属独立测试面——本单按 issue 范围 stub 掉，只验证 ImPage 与其的集成点（lineName 传递、onLoginConfirmed 回调），不做子组件内测（超范围）。

**弹层断言口径**：覆盖确认弹层用 `role="dialog"` 定位（源码带 `aria-label="同号覆盖确认"`），两步错误语义断言 toast 文案 + 弹层保留/关闭 + 后续 API 调用面（provision 是否执行）三重证据，单靠文案断言会漏行为回归。

## 4. 影响范围

纯新增测试文件，零生产代码改动。被测面：web/src/pages/im/index.tsx 现行为固化，不改行为。

## 5. 验证（验收标准断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 三路用例数达标 | `cd web && npx vitest run src/pages/im/index.test.tsx` | 19 passed（状态机 7 / 弹层 7 / 列表 5 ≥ 正文清单） |
| web vitest 全绿（关闭标准） | `cd web && npx vitest run` | Test Files 76 passed / Tests 778 passed |
| 类型无漂移 | `cd web && npx tsc --noEmit` | exit 0 零输出 |
| 测试有牙（负向自证） | 改坏 confirmOverwrite delete 失败分支 toast 文案后复跑 | 「两步错误语义 · delete 失败」用例红（本地验证过：mock 时序问题 5 红→修复后 19 绿，测试确实咬住行为） |

**最简检查**：已过最简阶梯——单文件 19 用例直测现状，无新依赖（@testing-library/react 仓库已有），无 helper 抽象（3 个本地小函数 enterNaming/enterConnecting/stubThenRender 即够）；确认已最简。

**开发期实录**：首轮 14/19（5 红全在路③）——根因是测试写法错（stubAccounts 在 render 后覆盖 mock，而数据在 mount 时已拉取），非生产代码问题；改为 stub 前置 + waitFor 后 19/19 绿。
