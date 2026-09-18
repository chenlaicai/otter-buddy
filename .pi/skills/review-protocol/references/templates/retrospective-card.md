# 模板：复盘报告卡（retrospective-card）

**何时用**：一项工作收尾后向搭档汇报——事故复盘、特性上线总结、阶段性回顾。与决策通报卡的区别：复盘卡**不一定需要拍板**——分「通报型」（无需操作，title 写「仅供知晓」）和「求拍板型」（整改措施需批准，带按钮）。

**怎么填**：
1. title 承载 3 秒层结论（`复盘：XXX · 结论一句 · 等你拍板 / 仅供知晓`）
2. 3 秒层：发生了什么 + 结论 + 要搭档做什么（拍板 or 无需回）
3. 30 秒层：时间线（适合 SVG 或紧凑列表）/ 根因 / 整改措施表（措施 + 状态）
4. 完整版：`<details>` 折叠案发现场数据 / 时间线细节 / 锚点
5. 求拍板型：整改选项按钮走 `otterCard.submit`；通报型：无按钮或单「已知悉」按钮
6. 颜色只用设计 token；事故警示用 `var(--caramel-*)`，已闭环用 `var(--teal-*)`

**完整示例**（写卡前必调 `get_html_card_contract` 核对最新契约）：

```html-card title="复盘：9/15 修复漏 commit 事故 · 根因是验证缺失 · 整改求拍板"
<style>
.rp{font-family:inherit;color:var(--ink);line-height:1.6}
.exec{background:var(--otter-50);border-left:4px solid var(--caramel-400);padding:14px;border-radius:8px;margin-bottom:16px}
.verdict{font-size:16px;font-weight:700;margin-bottom:6px}
.meta{font-size:12px;color:var(--ink-3);line-height:1.8}
h4{margin:12px 0 6px;font-size:13.5px;color:var(--otter-700)}
ul{margin:6px 0;padding-left:20px}
li{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
th{background:var(--otter-100);padding:7px;text-align:left;font-weight:600;border:1px solid var(--line)}
td{padding:7px;border:1px solid var(--line);vertical-align:top}
.done{color:var(--teal-600);font-weight:600}
.todo{color:var(--caramel-500);font-weight:600}
.acts{display:flex;gap:10px;margin-top:14px;padding-top:14px;border-top:2px solid var(--line)}
.btn{flex:1;padding:11px 0;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.btn-n{background:var(--paper);color:var(--ink);border:1.5px solid var(--line)}
.btn-r{background:var(--teal-500);color:#fff}
details summary{cursor:pointer;padding:8px;background:var(--otter-100);border-radius:6px;font-weight:600;font-size:13px}
code{background:var(--otter-100);padding:2px 6px;border-radius:4px;font-size:11px}
</style>
<div class="rp" data-height="800">

<div class="exec">
  <div class="verdict">开发獭宣称「已 push」实际只 staged——检视空转一轮</div>
  <div class="meta">
    <b>根因</b>：push 无报错 ≠ 成功，缺 headRefOid 验证环节<br>
    <b>置信度</b>：高（证据链完整：git status + headRefOid 交叉验证）<br>
    <b>要你做什么</b>：拍板是否把「OID 验证」写进 skill 硬约束（下方按钮）
  </div>
</div>

<h4>时间线</h4>
<ul>
  <li>16:34 开发獭 rebase 后修完 7 个检视发现，staged</li>
  <li>16:42 宣称「已 force-with-lease push」并发处置 comment</li>
  <li>17:05 检视獭查 PR：headRefOid 未变，修复停在本地 index——delta 复核 blocked</li>
  <li>17:12 补 commit + push，OID 验证通过，复核恢复</li>
</ul>

<h4>整改措施</h4>
<table>
  <tr><th>措施</th><th>状态</th></tr>
  <tr><td>小獭派工模板加「push 后必查 gh pr view --json headRefOid」</td><td class="done">已落地</td></tr>
  <tr><td>web 端改动必跑 <code>cd web && npx tsc --noEmit</code>（vitest 不覆盖类型）</td><td class="done">已落地</td></tr>
  <tr><td>把两条写进 code-implementation skill 硬约束（本卡求拍板项）</td><td class="todo">待拍板</td></tr>
</table>

<details>
  <summary>📂 完整版：案发现场 / 锚点</summary>
  <ul>
    <li>证据链：<code>gh pr view 955 --json headRefOid</code> = 560a93e6（rebase 版）vs worktree git status 9 文件 staged</li>
    <li>锚点：对话 <时间> <事件> · PR #<编号></li>
  </ul>
</details>

<div class="acts">
  <button class="btn btn-r" onclick="otterCard.submit({summary:'同意：两条验证写进 skill 硬约束',data:{choice:'approve'}})">同意写入 skill</button>
  <button class="btn btn-n" onclick="otterCard.submit({summary:'不用写 skill，派工模板提示即可',data:{choice:'prompt-only'}})">保持提示即可</button>
</div>

</div>
```

**自检清单**：
- [ ] title 能看出「是通报还是要拍板」？
- [ ] 时间线只留关键节点（≤6 条），细节进了 `<details>`？
- [ ] 整改措施有状态标识（已落地 / 待拍板）？
- [ ] 通报型没堆多余按钮，求拍板型按钮 summary 人话可读？
- [ ] 根因是系统性根因（流程缺失），不是「某某獭粗心」？
