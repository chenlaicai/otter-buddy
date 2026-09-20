---
title: GFM autolink 全角尾巴修正：IM 出站链接点不开根治
id: F20260920alnk
summary: 裸 URL 后紧跟全角标点/中文时 GFM autolink 把它们吸进 URL，IM 侧链接点不开（搭档多次实证）。修复：projectForChannel 投影层新增 trimAutolinkTrailing——remark 解析定位 autolink 区段，尾部非法字符剥离，替换为尖括号 autolink 形态；微信 markdownToPlain 补剥壳规则。position 局部替换零改写原文。
change_type: fix
created: 2026-09-20
created_in_conversation: 804600de-080e-4241-8253-a2e42600114d
tags: [im, feishu, weixin, rendering, autolink, gfm, markdown, projection]
modules:
  - src/entities/conversation/message-body-projection.ts
  - src/interface-adapters/weixin/weixin-gateway-adapter.ts
  - tests/entities/conversation/message-body-projection.test.ts
  - tests/interface-adapters/weixin/weixin-gateway-adapter.test.ts
from: [F20260812fmdr, F20260917cvid]
---

# GFM autolink 全角尾巴修正：IM 出站链接点不开根治

## 1. 问题

搭档多次实证：獭发言中的 PR 链接（如 `https://github.com/chenlaicai/otter-buddy/pull/1053）。本地偶发的`）在 IM 侧（飞书/微信）点击打不开——链接尾巴吸入了「）。本地偶发的」这段中文。

## 2. 根因（已实证）

**GFM autolink 规范的边界设计**：对 `https://` 起头的裸 URL，停止条件只有空白字符和 `<`。中文、全角标点（`）。：，、`）不属于停止集，全部被吸入 URL。

本地最小复现（remark 15 + remark-gfm 4）：

```
输入: 双绿（https://github.com/x/pull/1053）。本地偶发
输出: link.url = "https://github.com/x/pull/1053）。本地偶发"
```

对照：纯 CommonMark（无 GFM）不会 autolink 裸 URL；半角右括号 `)` 会被 GFM 正确排除在链接外（半角标点在 ASCII 边界处理范围内）。

**受影响链路**：LLM speak body → `projectForChannel`（entity 层信道投影）→ 飞书 `post + md`（CommonMark 0.31 + GFM 子集渲染）→ 链接尾巴带中文。Web 前端 ReactMarkdown + remarkGfm 同样受影响（但 Web 端用户可以手动复制 URL，痛感较低；本次修复投在投影层，Web 端收到的是已修剪文本）。

## 3. 方案

### 3.1 修在投影层，一处覆盖两个 IM 通道

`projectForChannel`（message-body-projection.ts）在 `humanizePlaceholders` 之后新增 `trimAutolinkTrailing(humanized)` 步骤——服务端出站前统一修剪，飞书/微信同时受益。

### 3.2 position 精准替换，非全文重排

初版试过 `remark().stringify(file)` 全文序列化，会改动原文其他部分（round-trip 风险：表格分隔符、强调标记等被 normalize）。终版只用 link 节点的 `position.offset` 做区段替换：

```
（https://github.com/x/pull/1053）。本地偶发的
                          ↑ 命中合法尾字符
→ （<https://github.com/x/pull/1053>）。本地偶发的
```

- URL 尾部从后往前剥离直到命中 RFC 3986 合法尾字符（`[A-Za-z0-9\-_~.!$&'()*+,;=:@#%/?]`）
- 区段替换为 CommonMark 尖括号 autolink `<url>`——`>` 是明确的链接结束边界，任何渲染器解析都不会越界
- 剥离的尾巴原样保留在链接后方，阅读连续
- 原文其余部分零改动（position 替换天然局部性）
- 解析失败/无命中时原样返回（尽力而为，不阻断出站）
- 快速路径：文本不含 `https?://` 时直接返回，无解析开销

### 3.3 微信纯文本降噪适配

`markdownToPlain`（weixin-gateway-adapter.ts）新增一条规则：`<url>` 剥壳保裸 URL（微信纯文本自动识别可点），插在 `[text](url)` 规则之后。

### 3.4 显式排除项

- 尾部干净的 URL 不做显式化（避免无差别尖括号噪音）
- 英文括号 URL（`wiki/Page_(disambiguation)`）：`(` `)` 都在 RFC 3986 合法尾字符集内，按 GFM 原语义保留——不越权改写

## 4. 实现清单

| 文件 | 改动 |
|------|------|
| `src/entities/conversation/message-body-projection.ts` | 新增 `trimAutolinkTrailing`（export）+ `URL_TRAILING_CHAR` 常量；`projectForChannel` 流水线插入修剪步骤（附件路径与直返路径都消费修剪后文本） |
| `src/interface-adapters/weixin/weixin-gateway-adapter.ts` | `markdownToPlain` 新增尖括号 autolink 剥壳规则 |
| `package.json` | 新增依赖 `unist-util-visit@^5.1.0`（remark 生态遍历） |
| `tests/entities/conversation/message-body-projection.test.ts` | 新增 8 用例：实证场景/全角标点族/中文粘连/干净不动/语法零改动/快速路径/行首 offset=0/集成 |
| `tests/interface-adapters/weixin/weixin-gateway-adapter.test.ts` | 新增尖括号剥壳用例 |

### 实现中的陷阱记录

- **falsy-zero 陷阱**：position 校验初版写 `!pos?.start?.offset`——行首链接（offset=0）被误判为无位置信息而跳过修剪。改为 `== null` 显式判空后，行首场景（`https://example.com/pull/1053下一句`）才真正生效。测试用例「中文直接粘连」专门锁死此边界。
- **stringify round-trip 陷阱**：初版用 stringify 全文重排，`*em*` `_strong_` 等原文标记被 normalize 改写。position 局部替换根治。

## 5. 测试与验证

- `tests/entities/conversation/message-body-projection.test.ts`：58 passed（原 50 + 新增 8）
- `tests/interface-adapters/weixin/weixin-gateway-adapter.test.ts`：7 passed（原 6 + 新增 1）
- 全量：3670 passed（3669 原有 + 1 微信新增；主仓 tsc 干净）
- 搭档实证场景端到端验证：`projectForChannel("CI 双绿（https://github.com/x/pull/1053）。说明")` 输出含 `<https://github.com/x/pull/1053>）。说明`

## 6. 审视处置记录

检视獭：检视1056（mimo，异体模型）。发现 1 严重 + 3 建议，处置如下：

- **S1（严重）CI 红：PR 标题缺 `[im]` 模块标签** → 已修：`gh pr edit` 补标签，新 CI run 通过。
- **D1（建议）parser 实例每次新建** → 已采纳：模块级 `AUTOLINK_PARSER` 复用（processor 链构建开销摊平）。
- **D2（建议）飞书 post+md 对 `<url>` 尖括号 autolink 渲染兼容性未实测** → 已知限制：CommonMark 0.31 规范内语法（飞书 md 标签声明的支持集），本地无法实测飞书渲染——合入后首条带链接消息人工验一眼即可，验出问题回滚成本为单 commit revert。
- **D3（建议）URL_TRAILING_CHAR 含 `*`/`'` 子分隔符偏保守** → 采纳为后续跟进：精度优化（ICU/URL 库引入）成本高于收益，当前保守集在「全角剥离 + 英文括号保留」两端实证正确，不为此引入依赖。

检视獭独立实证项：全角/中文剥离、英文括号保留、行首 offset=0、已有尖括号不误伤——均用 remark 解析验证通过。

## 7. 关联

- `from: F20260812fmdr`——飞书 markdown 渲染链的下游问题，本文档修其链接边界缺陷
- `from: F20260917cvid`——同会话顺手修的 CI flaky（浮点断言），无依赖关系仅时间关联
