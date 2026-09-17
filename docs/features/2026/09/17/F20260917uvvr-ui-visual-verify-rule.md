---
id: F20260917uvvr
title: UI 视觉变更真机自查硬规则：把「亲眼截图验证」写进 code-implementation 自检
summary: 右键菜单「打开所在目录」历经 PR #888（功能）→#972（Safari 拦截）→#1005（containing block 定位）三轮才修复——前两轮靠代码推理+DOM 断言交付，没亲眼看过渲染结果，搭档被迫充当「眼睛」实机验证。根因是流程缺位：海獭有截图和看图能力，但 skill 里没有「起真实浏览器复现」这条标准动作。修法：code-implementation 自检新增硬规则——布局/弹层/定位类变更必须起 dev server + 无头浏览器复现真实 UI 状态（面板展开/窗口尺寸），截图 + getBoundingClientRect 数值取证后交付；「DOM 存在 ≠ 可见」。
change_type: prompt   # 方案/设计文档：本变更主体是 prompt 层（skill 自检规则文本），无代码逻辑变更
created_in_conversation: acf4e2d3-d0ae-4e93-90d8-a9d1f1f602b1
tags: [skill, code-implementation, ui-verification, css-containing-block, lesson]
intent:
  problem: "UI 布局类改动靠代码推理+单元测试交付，无真实浏览器渲染验证——PR #972 无头验证时右栏关闭漏检 containing block，搭档实机截图才定位，三轮返工"
  expected_effect: "布局/弹层/定位类变更交付前附真实浏览器截图+rect 数值证据；弹层不可见类问题不再只用 DOM 存在性断言交付"
  verify_by:
    type: behavior_check
    detail: "下一个涉及弹层/定位的 UI PR（如左栏右键菜单 Portal 化 issue）交付时，Verification 节附截图路径与 getBoundingClientRect 取证；skill lint 通过（lint-skills 0 error）"
modules: [.pi/skills/code-implementation/SKILL.md]
created_at: 2026-09-17
---

# UI 视觉变更真机自查硬规则

## 背景（意图锚）

搭档原话：

> 这个右键打开所在目录的问题反复修了好几次，我在思考，明明你自己有截图能力、也有看图能力，为什么无法自己真实启动一个进场然后真实去看 ui 效果呢，比你各种猜然后还要我配合做这做那的

## 事故链复盘

| 轮次 | PR | 交付依据 | 漏掉什么 |
|------|-----|---------|---------|
| 1. 功能上线 | #888 | 单测通过 | 搭档机器上 Safari 弹原生菜单——自定义菜单根本没触发 |
| 2. Safari 拦截修复 | #972 | 无头脚本验证「拦截生效」 | 验证时**右侧栏关闭**，没覆盖真实 UI 状态；搭档反馈「还是不行」 |
| 3. 定位实锤 | #1005 | 探针取 `getBoundingClientRect` | 菜单 DOM 存在但 left=3130 飞出视口——`aside.glass` 的 backdrop-filter 成为 containing block，fixed 退化 |

每一轮的共同点：**验证手段摸不到渲染层**——单测断言 DOM、脚本断言事件，但没有一轮「亲眼看过菜单在屏幕上的位置」。这类问题（containing block、stacking context、视口钳位）是代码推理的盲区：它不写在代码里，写在渲染结果里。

## 修法

code-implementation skill 自检（步骤 6）新增硬规则段落「UI 视觉变更的真机自查」，要点：

1. **触发**：布局/弹层/定位/样式变更，含疑似「UI 不生效」类 bug 修复
2. **动作**：起真实实例 → 无头浏览器复现搭档真实 UI 状态（面板展开/收起、窗口尺寸、浏览器类型）→ 截图 + `getBoundingClientRect()` 数值取证 → 截图存对话工作区，PR Verification 节附路径
3. **禁止**：弹层「不可见」类问题只用 DOM 存在性断言交付——DOM 存在 ≠ 可见（#1005 现场：菜单渲染成功但飞出视口 1300px）
4. **原则**：代码推理猜不出渲染结果，单测全绿不能替代亲眼看

与既有硬规则同构（db 迁移真启动验证 #962、pre-existing 门禁 #614）——都是「演练全绿 ≠ 真环境触达」的同类教训，这是第三次踩，不可再有第四次。

## 改动范围

| 文件 | 说明 |
|------|------|
| `.pi/skills/code-implementation/SKILL.md` | 自检步骤新增「UI 视觉变更的真机自查」硬规则段落 |

纯 prompt 层规则文本变更，无代码逻辑改动，无测试变更。

## 验证

- 规则文本插入位置：步骤 6 自检首条硬规则（废弃资源清理之前），与既有硬规则段落格式一致
- `npm run lint:skills` 0 error（见 PR Verification 节）
- 行为验证：下一个弹层/定位类 UI PR 交付时按此规则执行（intent.verify_by 已声明）
- 负面向条目：本变更破坏的旧契约 = 「单测通过即可交付 UI 变更」的默认预期——这是有意的收紧，代价是 UI 类 PR 交付成本上升（需起浏览器），收益是消灭「搭档当眼睛」类返工
- 已过最简检查：不新增脚本/工具（Playwright 调用是执行期动作，不需要仓库新增依赖作为本规则的前置——实现者用当时可用的截图能力即可），只加一段规则文本
