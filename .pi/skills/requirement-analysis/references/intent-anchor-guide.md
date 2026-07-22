# Intent Anchor Guide

Intent anchors are the user's original words, quoted verbatim. They serve as the authoritative source for what was actually requested.

## Why Intent Anchors Matter

- Paraphrasing loses modifiers and constraints
- Design decisions must trace back to what the user said, not what we interpreted
- When disagreements arise, intent anchors are the tiebreaker

## How to Extract Intent Anchors

1. **Read the user's request** — identify statements that carry requirements, constraints, or preferences
2. **Quote verbatim** — do not paraphrase, summarize, or editorialize
3. **Preserve modifiers** — words like "必须", "不要", "只", "最" carry critical constraints
4. **Note the source** — record where the anchor came from (conversation, document, etc.)

## Intent Anchor Table Format

| ID | 用户原话 | 关键修饰语 | 解读 | 来源 |
|----|---------|-----------|------|------|
| UA-1 | "..." | ... | ... | 对话 |
| UA-2 | "..." | ... | ... | 文档 |

## Traceability

Every design decision in the output plan should be traceable to one or more intent anchors. If a design choice cannot be traced to an anchor, question whether it is needed.

## Common Mistakes

- **Paraphrasing**: "用户想要一个新功能" ← lost all specifics
- **Dropping modifiers**: "需要支持多语言" ← original said "必须支持中英日三种语言"
- **Interpreting as anchor**: "用户需要性能优化" ← user actually said "页面加载太慢了"
- **Missing implicit anchors**: User says "和之前一样" → need to find what "之前" refers to
