# 分层堆叠图骨架范本

首例「说话治理全景」（2026-11-20）抽象出的可抄骨架。适用：系统分几层、各层职责/状态。
**用法**：抄下方网格与 SVG 骨架 → 替换层数与文字 → 按 diagram skill 质检门过一遍。

## 网格坐标（骨架先行，先算后写）

| 元素 | 规则 | 首例值（4 层） |
|---|---|---|
| 画布 | viewBox `0 0 680 H`，H = 标题区 72 + 层区 + 底部区 | 470 |
| 标题 / 副标题 | x=24；y=28（16px bold）/ y=50（12px ink-3） | 同左 |
| 层条 | x=24，宽 632，高 58，间距 12；第 n 层 y = 72 + (n-1)×70 | y = 72/142/212/282 |
| 层名 | x=层x+16，y=层y+24（13px bold） | 同左 |
| 层描述 | x=层x+16，y=层y+44（11.5px ink-3） | 同左 |
| 状态徽章 | rect x=576 宽 64 高 24 rx=12，y=层y+16；文字居中 y=层y+32 | 同左 |
| 强调层 | stroke 换 `var(--caramel-500)` + stroke-width=2，底 `var(--otter-50)` | 缺口层 |

层数增减只改 viewBox H 与各层 y，其余不动。

## 可抄 SVG 骨架（2 层示例，含箭头 marker 复用）

```html
<svg viewBox="0 0 680 250" width="100%" xmlns="http://www.w3.org/2000/svg" style="font-family:inherit">
  <!-- 第一行 text = 结论句（折叠摘要可提取）；卡片 title 自成结论（检索占位只保留 title） -->
  <text x="24" y="28" font-size="16" font-weight="700" fill="var(--ink)">一句话结论：本图说明什么</text>
  <text x="24" y="50" font-size="12" fill="var(--ink-3)">副标题：范围/视角补充，一行以内</text>

  <!-- 层 1（常规层：paper 底 + line 描边） -->
  <rect x="24" y="72" width="632" height="58" rx="8" fill="var(--paper)" stroke="var(--line)"/>
  <text x="40" y="96" font-size="13" font-weight="700" fill="var(--ink)">L1 层名</text>
  <text x="40" y="116" font-size="11.5" fill="var(--ink-3)">职责/内容标签，不是段落</text>
  <rect x="576" y="88" width="64" height="24" rx="12" fill="var(--teal-300)"/>
  <text x="608" y="104" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">状态</text>

  <!-- 层 2（强调层：caramel 描边加粗 + otter-50 底，用于缺口/风险/重点） -->
  <rect x="24" y="142" width="632" height="58" rx="8" fill="var(--otter-50)" stroke="var(--caramel-500)" stroke-width="2"/>
  <text x="40" y="166" font-size="13" font-weight="700" fill="var(--ink)">L2 层名</text>
  <text x="40" y="186" font-size="11.5" fill="var(--ink-3)">职责/内容标签</text>
  <rect x="576" y="158" width="64" height="24" rx="12" fill="var(--caramel-400)"/>
  <text x="608" y="174" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">缺口</text>

  <!-- 底部流向（可选）：小框 + 统一 marker 箭头，单一左→右流向 -->
  <path d="M 40 224 L 100 224" stroke="var(--ink-3)" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--ink-3)"/>
    </marker>
  </defs>
</svg>
```

## 出卡围栏

````
```html-card title="<结论句>" importance="high" chip="图解"
<div class="wrap">
  <!-- 上面的 SVG -->
</div>
```
````

- `importance="high"` 默认展开（图的感知动词是「看」）；`chip="图解"` 覆盖缺省「简报」角标
- 节点 >12 个就分层分组或拆图；文字是标签不是段落，段落放图外正文
