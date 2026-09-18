# 模板：方案对比卡（option-comparison-card）

**何时用**：议题的核心是「多条路选一条」——技术选型、实施路径、资源分配。与决策通报卡的区别：决策通报卡是「问题→根因→方案→拍板」全链路，方案对比卡是**选项本身是主角**（问题背景已被搭档熟知，只需把选项摆清楚）。

**怎么填**：
1. title 承载 3 秒层结论（`对比：XXX · 推荐 X · 等你拍板`）
2. 3 秒层：推荐 + 一句理由 + 置信度
3. 30 秒层：选项对比表为主体（维度打分 / 取舍矩阵），推荐行高亮 + 行内可放星级；分歧如实呈现
4. 完整版：`<details>` 折叠各方案的细节论证 / 数据 / 锚点
5. 操作区：选项按钮 + 「再讨论」入口（summary 写清楚搭档选的是什么）
6. 颜色只用设计 token；推荐用 `var(--teal-*)`，警示用 `var(--caramel-*)`

**完整示例**（写卡前必调 `get_html_card_contract` 核对最新契约）：

```html-card title="对比：memory 检索加速三方案 · 推荐 B（增量索引）· 等你拍板"
<style>
.oc{font-family:inherit;color:var(--ink);line-height:1.6}
.exec{background:var(--otter-50);border-left:4px solid var(--teal-500);padding:14px;border-radius:8px;margin-bottom:16px}
.verdict{font-size:16px;font-weight:700;margin-bottom:6px}
.meta{font-size:12px;color:var(--ink-3);line-height:1.8}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
th{background:var(--otter-100);padding:7px;text-align:left;font-weight:600;border:1px solid var(--line)}
td{padding:7px;border:1px solid var(--line);vertical-align:top}
.rec{background:var(--teal-300);font-weight:600}
.warn{color:var(--caramel-500);font-weight:600}
h4{margin:12px 0 6px;font-size:13.5px;color:var(--otter-700)}
.acts{display:flex;gap:10px;margin-top:14px;padding-top:14px;border-top:2px solid var(--line)}
.btn{flex:1;padding:11px 0;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.btn-n{background:var(--paper);color:var(--ink);border:1.5px solid var(--line)}
.btn-r{background:var(--teal-500);color:#fff}
details summary{cursor:pointer;padding:8px;background:var(--otter-100);border-radius:6px;font-weight:600;font-size:13px}
code{background:var(--otter-100);padding:2px 6px;border-radius:4px;font-size:11px}
</style>
<div class="oc" data-height="800">

<div class="exec">
  <div class="verdict">推荐 B（增量索引）——效果 90%、成本 1/3、可回退</div>
  <div class="meta"><b>置信度</b>：中（B 未在生产数据压测过）· <b>风险</b>：中——召回率可能掉 2-3%</div>
</div>

<table>
  <tr><th style="width:16%">维度</th><th>A 全量重建</th><th>B 增量索引 ⭐</th><th>C 换向量库</th></tr>
  <tr><td><b>检索提速</b></td><td>+95%</td><td class="rec">+90%</td><td>+97%</td></tr>
  <tr><td><b>工作量</b></td><td>3 天</td><td class="rec">1 天</td><td>5 天</td></tr>
  <tr><td><b>可回退</b></td><td>✅</td><td class="rec">✅</td><td><span class="warn">❌ 换库难回</span></td></tr>
  <tr><td><b>召回率风险</b></td><td>无</td><td class="rec">掉 2-3%</td><td>未知</td></tr>
  <tr><td><b>被否理由</b></td><td>成本过高</td><td class="rec">—</td><td>不可逆 + 过度工程</td></tr>
</table>

<h4>獭间分歧</h4>
<p class="meta">检视獭主张 A（「一步到位免后患」）；开发獭主张 B（「先验证增量效果，不够再上全量」）——大獭采 B：B 验证不过再升 A 只多花 0.5 天，反之 A 过度投入不可逆。</p>

<details>
  <summary>📂 完整版：压测数据 / 锚点</summary>
  <ul>
    <li>压测：10 万条记忆，A 建索引 42min / B 增量单次 &lt;200ms</li>
    <li>锚点：<code>&lt;R 编号&gt;</code> 调研报告 · issue #&lt;编号&gt;</li>
  </ul>
</details>

<div class="acts">
  <button class="btn btn-n" onclick="otterCard.submit({summary:'选 A：全量重建（3 天，一步到位）',data:{choice:'A'}})">选 A</button>
  <button class="btn btn-r" onclick="otterCard.submit({summary:'选 B：增量索引（1 天，可回退）⭐ 推荐',data:{choice:'B'}})">选 B ⭐</button>
  <button class="btn btn-n" onclick="otterCard.submit({summary:'选 C：换向量库（5 天，不可逆）',data:{choice:'C'}})">选 C</button>
  <button class="btn btn-n" onclick="otterCard.submit({summary:'都不选，再讨论',data:{choice:'discuss'}})">再讨论</button>
</div>

</div>
```

**自检清单**：
- [ ] 表格维度是搭档关心的（成本/风险/可回退），不是实现细节堆砌？
- [ ] 被否方案的否决理由在表里或表下可见？
- [ ] 獭间分歧双方观点都摆了？
- [ ] 有「再讨论」出口（搭档不满意三个选项时不被二选一绑架）？
- [ ] title 里能看出推荐项？
