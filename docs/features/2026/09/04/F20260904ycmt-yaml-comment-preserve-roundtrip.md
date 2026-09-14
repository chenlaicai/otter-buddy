---
id: F20260904ycmt
title: config.yaml round-trip 保留注释：updateDefaultModelInYaml 改用 parseDocument
summary: |
  settings API 切换默认模型时 yaml.load+yaml.dump 全量序列化会丢掉 config.yaml 全部 52 行注释（约占 40%）。
  修复：updateDefaultModelInYaml 改用 yaml 包（eemeli/yaml，已在依赖中）的 parseDocument Document 模型
  原位改值后 toString 写回，注释原样保留；lineWidth: 0 + flowCollectionPadding: false 对齐原最小 diff 语义。
  round-trip 后与变更无关的行逐字节不变（实测真实 config.yaml 仅 default 行变化）。
change_type: fix
created: 2026-09-04
created_in_conversation: e9b71eec-679e-4380-947d-8e641c4b90d5
tags: [config, settings-api, yaml, comment-preservation]
modules: [src/frameworks/config-service.ts, tests/frameworks/config-service.test.ts]
issue: 391
---

## 背景

`updateDefaultModelInYaml`（src/frameworks/config-service.ts:147）是 settings API 切换默认模型的写入路径
（F20260824cfgs 确立 config.yaml 为默认模型唯一真相源时引入）。原实现：

```ts
const raw = yaml.load(...) as RawConfig;
raw.llm.default = alias;
const content = yaml.dump(raw, { lineWidth: -1, noRefs: true });
```

`js-yaml` 的 load→dump 是数据级 round-trip：注释、空行、引号风格、key 顺序等全部丢失。真实
config/config.yaml 有 52 行注释（约占 40%，人工维护对齐 config.yaml.example），每次切换默认模型注释全部被抹掉。

已知限制历史：
- F20260824cfgs（父特性，引入机制时把「YAML 注释丢失」列为已知限制，关联本 issue #391）
- F20260831wxsp（微信补写路径已先改为文本追加避注释丢失，但 settings API 路径未修）

## 改动

`src/frameworks/config-service.ts — updateDefaultModelInYaml`（函数签名、原子写、校验语义全部不变）：

1. 解析：`yaml.load` → `yaml 包 parseDocument`（Document 模型保留源注释；js-yaml@5 无此 API，实测确认）。
   新增 import：`import { parseDocument } from "yaml"`。
2. 错误处理：`doc.errors.length > 0` 时抛 `config.yaml 解析失败: <msg>`——对齐原 `yaml.load` 对坏 YAML
   的抛错行为，且抛在写入前（坏输入不落盘）。
3. 提前 return 语义不变：`doc.getIn(["llm", "default"]) === alias` → return，不写文件。
4. 改值：`doc.setIn(["llm", "default"], alias)`——llm 块缺失时自动创建中间节点，对齐原
   `if (!raw.llm) raw.llm = {}` 语义（实测验证）。
5. 序列化：`yaml.dump(lineWidth: -1)` → `doc.toString({ lineWidth: 0, flowCollectionPadding: false })`：
   - `lineWidth: 0`：禁长行折行，对齐原 `lineWidth: -1`
   - `flowCollectionPadding: false`：保持 flow 序列原格式（`["text"]` 不变 `[ "text" ]`）——
     不加此选项会产生 8 行无关 diff（实测发现）
6. write-to-temp + rename 原子写路径原样保留。

`RawConfig` 接口保留：`validate`/`loadConfig` 等其余读路径继续用 js-yaml load，本修复不扩大解析行为变化面。

## 验证

1. 单测 33 全绿（30 既有回归 + 3 新增）：`npx vitest run tests/frameworks/config-service.test.ts`
   - 新增「#391 注释保留」describe：注释行数 round-trip 前后不变（块注释+行内注释）、具体注释存活断言、
     flow 序列不变形断言、llm 块缺失时 setIn 自动创建、坏 YAML 抛错且不落盘（不写 tmp、不 rename）
   - 既有 3 测回归通过：原子写路径（tmp+rename）、无需更新提前 return（零写入）、alias 校验抛错
2. tsc --noEmit 0 error；eslint（改动两文件）0 error
3. 真实 config.yaml 端到端：52/52 注释存活，`diff` 仅 1 行变化（`default: "glm"` → `"mimo"`），
   input/strengths 等 flow 行逐字节不变
4. **最简实现检查**：parseDocument + setIn + toString 共 ~10 行核心改动，复用已装依赖 yaml@2.9，
   无新库（阶梯第一步「仓库已有实现」即命中——frontmatter-parse.ts 已在用 yaml 包）。确认已最简。
5. **pre-existing 声明**：无——全量相关测试通过，无失败需要声明与本次变更无关。

## 关联

- Issue: [#391](https://github.com/chenlaicai/otter-buddy/issues/391)
- 父特性: F20260824cfgs（config.yaml 唯一真相源，当时把注释丢失列为已知限制）
- 相关: F20260831wxsp（微信补写路径文本追加方案，同属注释保留主题）
- 前置确认: #390——settings-controller.ts:57-58 先写文件后改内存的调用顺序是好的，本修复不动
