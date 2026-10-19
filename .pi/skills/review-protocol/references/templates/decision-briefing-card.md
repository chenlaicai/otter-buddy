# 模板：决策通报卡（decision-briefing-card）

**何时用**：L2 决策呈搭档拍板——代码 PR 终审、方案终审、审视僵局呈裁决。一个议题一份卡，不每问一卡。

**怎么填**：
1. title 承载 3 秒层结论（`议题：XXX · 建议 X · 等你拍板`）——折叠态唯一可见，必须能独立支撑决策
2. 3 秒层：这是什么事（一句话） + 结论 + **要你干什么**（必填：拍板/合入/知晓/无） + 风险 + 置信度
3. 30 秒层：背景 ≤3 行 + 方案与关键决策（含被否方案 + 否决理由，推荐行高亮）+ **当前情况**（状态一览：做到哪/验证程度/刻意没做的，数字带来源，完成状态分级）+ **后续事项**（逐条列残留/排期/衍生/留观，分流「需要你介入/不需要你介入」，没有就写「无」）+ 獭间分歧 + 推荐理由
4. 完整版：`<details>` 折叠案发现场 / 锚点
5. 操作区：每个选项一个按钮，`otterCard.submit` 回执
6. 颜色只用设计 token（`var(--otter-*)` 等），不写死色值；不要前置色块

**完整示例**（写卡前必调 `get_html_card_contract` 核对最新契约）：

```html-card title="议题：说人话失败整改 · 建议方案 B（模板库）· 等你拍板"
<style>
.rd{font-family:inherit;color:var(--ink);line-height:1.6}
.layer{margin-bottom:16px;padding:14px;border-radius:8px}
.exec{background:var(--otter-50);border-left:4px solid var(--teal-500)}
.key{background:var(--paper);border:1px solid var(--line)}
.verdict{font-size:16px;font-weight:700;margin-bottom:6px}
.meta{font-size:12px;color:var(--ink-3);line-height:1.8}
h4{margin:12px 0 6px;font-size:13.5px;color:var(--otter-700)}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
th{background:var(--otter-100);padding:7px;text-align:left;font-weight:600;border:1px solid var(--line)}
td{padding:7px;border:1px solid var(--line);vertical-align:top}
.rec{background:var(--teal-300);font-weight:600}
ul{margin:6px 0;padding-left:20px}
li{margin:3px 0}
.acts{display:flex;gap:10px;margin-top:14px;padding-top:14px;border-top:2px solid var(--line)}
.btn{flex:1;padding:11px 0;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.btn-n{background:var(--paper);color:var(--ink);border:1.5px solid var(--line)}
.btn-r{background:var(--teal-500);color:#fff}
details summary{cursor:pointer;padding:8px;background:var(--otter-100);border-radius:6px;font-weight:600;font-size:13px}
code{background:var(--otter-100);padding:2px 6px;border-radius:4px;font-size:11px}
</style>
<div class="rd">

<div class="layer exec">
  <div class="verdict">「说人话」反复失效 → 落地「三层汇报文档」规范</div>
  <div class="meta">
    <b>风险</b>：低——纯 prompt 文档改动，不动代码<br>
    <b>置信度</b>：高（5 个案发现场实测 + 搭档两次反馈对齐）<br>
    <b>要你干什么</b>：从 A/B/C 选一个实施路径（下方按钮）
  </div>
</div>

<div class="layer key">
<h4>背景</h4>
<p>全库 19 条「说人话」命中里搭档发了 7 条全是求救；该词在 prompt 规范零命中——是海獭临场补丁，质量忽高忽低。</p>

<h4>方案选项对比</h4>
<table>
  <tr><th>方案</th><th>做什么</th><th>关键取舍</th><th>成本</th></tr>
  <tr><td><b>A 轻量 prompt</b></td><td>只改规范文档</td><td>快但依赖自觉，易回弹</td><td>0.5 天</td></tr>
  <tr class="rec"><td><b>B 模板库 ⭐</b></td><td>沉淀 3 个汇报模板</td><td>质量稳定，需真实议题迭代</td><td>1.5 天</td></tr>
  <tr><td><b>C 工具链</b></td><td>自动检测议题套模板</td><td>最稳但当前过度工程</td><td>3 天</td></tr>
</table>
<p class="meta"><b>被否方案</b>：前置色块（搭档评「很低级也很难看」）；每问一小卡（搭档评「难道每个问题就做一张卡片吗」）</p>

<h4>当前情况</h4>
<p>规范文档 3 处改动完成（<code>decision-briefing.md</code> 主变更）；自检清单 6/6 过；CI：不适用（纯文档）。<b>完成状态</b>：自检完成——独立审视未跑，不算已验证。</p>

<h4>后续事项</h4>
<p><b>需要你介入</b>：拍板方案选项（上方按钮）。</p>
<p><b>不需要你介入</b>：另两个模板（复盘卡/方案对比卡）随真实议题迭代——獭排期自盯。<b>刻意没做</b>：工具链自动检测（方案 C 的内容，本期不做）。</p>

<h4>獭间分歧</h4>
<p>无——两獭对齐，无悬置异议。</p>

<h4>推荐：方案 B</h4>
<p><b>理由</b>：A 依赖自觉会回弹，C 过度工程，B 是甜点。<b>最大风险</b>：模板不适配所有议题——缓解：先跑 3-5 个真实议题迭代再固化。</p>
</div>

<details>
  <summary>📂 完整版：案发现场 / 锚点</summary>
  <ul>
    <li>9/15 01:26「发电机」卡：决策请求埋最后一段</li>
    <li>9/11 07:18 session 池化：400+ 字技术细节，决策点塞末行</li>
    <li>锚点：<code>analysis/&lt;分析文档路径&gt;</code> · &lt;特性编号&gt;</li>
  </ul>
</details>

<div class="acts">
  <button class="btn btn-n" onclick="otterCard.submit({summary:'选 A：轻量 prompt（0.5 天）',data:{choice:'A'}})">选 A</button>
  <button class="btn btn-r" onclick="otterCard.submit({summary:'选 B：模板库（1.5 天）⭐ 推荐',data:{choice:'B'}})">选 B ⭐</button>
  <button class="btn btn-n" onclick="otterCard.submit({summary:'选 C：工具链（3 天）',data:{choice:'C'}})">选 C</button>
</div>

</div>
```

**自检清单**（发出前过一遍）：
- [ ] title 单独读能否支撑决策？（折叠态唯一可见）
- [ ] 六要素齐了吗？（这是什么事 / 要你干什么 / 背景 / 方案与关键决策 / 当前情况 / 后续事项）
- [ ] 「要你干什么」在 3 秒层且明确（拍板/合入/知晓/无）？
- [ ] 结论是否在最前？（没有技术细节铺垫）
- [ ] ≥3 个选项用了表格？推荐行高亮？
- [ ] 被否方案和否决理由写了？
- [ ] 当前情况的数字带来源？完成状态有分级（已验证/自检/未验证）？
- [ ] 后续事项分流（需要你介入 / 不需要你介入）？没有时显式写「无」？
- [ ] 按钮 onclick 走 `otterCard.submit` 且 summary 人话可读？
- [ ] 没有前置色块、没有写死色值？
