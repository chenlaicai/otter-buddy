> ⚠️ **External PRs are not accepted.** This is a personal research project. Please open an issue instead — bug reports, ideas, and feature suggestions are all welcome.
> 暂不接受外部 PR，这是个人研究项目。请开 issue 描述你的想法。

---

## Summary

Describe the intent of this change and the user-visible or system-level impact.

## Why

Explain the motivation for this change.

## What Changed

-

## Affected Areas

- [ ] `src/*`
- [ ] `tests/*`
- [ ] Configuration or build tooling
- [ ] Documentation

## Risks

-

## Rollback

How to roll this back (revert commit / feature flag / manual steps). For changes touching `docs/` only, write "纯文档，revert 即回滚".

## 证据分层声明（改系统状态的交付必须填写，纯 docs/ 交付可写「纯文档豁免」）

验证证据逐项标注分层（机器锚点与 agent 陈述分开列，禁止混排）：

- **机器锚点**（可点开复验）：PR 编号 / commit sha / `file:line` / CI run 链接 / 命令输出
- **agent 陈述**（显式标「未复验」）：无机器锚点支撑的断言，标注 [未复验]

## Verification

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test`
- [ ] Manual verification completed
- [ ] **证据分层已标注**（改系统状态的交付必须）：机器锚点与 agent 陈述（标未复验）分开列，无混排冒充已验证
- [ ] **Intent 块存在**（软代码改动必须）：特性文档 frontmatter 有 intent 块（problem + verify_by）
- [ ] **Golden Gate 已跑且 fail 已处置**（软代码改动必须）：results.jsonl 有该 PR 的执行记录，fail 行已复跑通过/修复再跑/申诉留痕

## Discovered Issues

Issues found but not fixed in this PR. Each must have a GitHub issue link (`#NNN`) — created via `gh issue create`. Verbal "已记录" without a link is not acceptable.
If none, write "无".

## Notes

Anything reviewers should pay special attention to.

---

<!-- 署名行（创建时必填）：将下方 [海獭名号] 占位符整体替换为实际署名獭的名号（如「大獭」「检视獭-903fin」），禁止保留占位符原样或改写成「[海獭名号: xxx]」字段填空格式。未署名的 PR 不得创建。 -->

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by [海獭名号]
