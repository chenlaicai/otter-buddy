---
id: F20260916fndv
doc_type: feature
change_type: feature
capability_test: "n/a: 纯路径解析机制收口，无 LLM 行为 golden 场景可回归；行为由单测覆盖：getRepoRoot 定位（cwd 非项目根 + 锚语义 + 缓存）+ prompt-template-reconciler 默认 templateDir（cwd 非项目根仍读到真模板）+ healing 模板加载（cwd 非项目根不触发回退告警）"
title: "运行时资源路径统一解析：cwd 相对路径收口为基于代码位置的 repoRoot 定位"
summary: "全仓 8 处运行时读文件从 resolve(process.cwd(), …) 收口到统一模块 src/frameworks/repo-root.ts 的 getRepoRoot()——基于 import.meta.dirname 向上逐级探测含 package.json 且 name === \"otter-buddy\" 的目录。非项目根 cwd 启动（systemd WorkingDirectory、容器 ENTRYPOINT）时 prompt 模板、config.yaml、terminology seed 等不再静默失败或回退。注入参数 override（templateDir / identityPromptDir / configPath / promptPathOverride）优先，仅默认值走新机制；缺失降级语义（warn 级别、回退行为）原样保留，不引入 fail-fast。"
feature_id: F20260916fndv
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-09-16
intent:
  problem: "8 处运行时读文件依赖 process.cwd()，非项目根 cwd 启动时静默失败（config 读不到 throw、prompt 模板 ENOENT 回退内置文案、对账跳过），部署形态（systemd/容器）下问题隐性爆发"
  expected_effect: "任意 cwd 启动均基于代码位置定位仓库根，资源文件路径稳定可预期"
  verify_by:
    type: static_only
modules:
  - frameworks/repo-root
  - usecases/scheduler
  - usecases/daily-review
  - usecases/paper-trading
  - usecases/recruiting
  - frameworks/config
  - bootstrap
  - frameworks/db/memory
tags:
  - path-resolution
  - cwd-independence
  - deployment
  - issue-429
---

## 背景

issue #429：全仓 8 处运行时读文件依赖 `resolve(process.cwd(), …)`，非项目根 cwd 启动（systemd WorkingDirectory、容器 ENTRYPOINT）时静默失败或回退：

| 位置 | 资源 | 失败形态 |
|---|---|---|
| scheduler-service.ts:1389,1443 | prompts/scheduled/self-healing-analysis.md | ENOENT → 回退内置文案 |
| prompt-template-reconciler.ts:98 | prompts/scheduled/ | 目录不可读 → 对账跳过 |
| ensure-daily-review-scheduler.ts:149 | prompts/scheduled/daily-review.md | ENOENT → throw（fail loud） |
| ensure-paper-trading-scheduler.ts:110 | prompts/scheduled/paper-trading-daily.md | ENOENT → throw（fail loud） |
| ensure-recruiting-conversation.ts:56 | prompts/contexts/RECRUITING_INTAKE.md | ENOENT → DomainError |
| config-service.ts:332 | config/config.yaml | ENOENT → throw（启动失败） |
| platforms.ts:563 | config/config.yaml（weixin 幂等写回） | ENOENT → 写回落空 |
| platforms.ts:102 | prompts/identity/（identityPromptDir 默认） | 目录不存在 → 身份 prompt 缺失 |
| seed-terminology.ts:26 | data/terminology/seed-terminology.json | ENOENT → throw |

已有先例：stock-tools.ts:250 用 `resolve(import.meta.dirname, "../../../../..")` 定位 repoRoot，不依赖 cwd——但写死层级数，目录结构调整即失效。

## 方案

### 核心机制：src/frameworks/repo-root.ts

```ts
getRepoRoot(): string  // 模块级 memo 缓存
```

从 `import.meta.dirname`（即 src/frameworks/ 或 dist/src/frameworks/）**向上逐级探测**含 `package.json` 且 `name === "otter-buddy"` 的目录。

**为什么逐级探测而不是写死相对层级**（如 stock-tools 的 `"../../../../.."`）：
- 兼容两种布局：vitest 直跑 src/（向上 2 级）vs tsc 编译产物 dist/src/frameworks/（向上 4 级）——写死数字需分支判断，逐级探测天然兼容
- 未来目录结构调整（新增/减少层级）不破坏定位
- name 匹配防止误停在 monorepo 子包或 node_modules 里碰巧有 package.json 的目录

**为什么不用 `createRequire(import.meta.url).resolve('otter-buddy/package.json')`**：
包未发布到 registry、自引用解析依赖包管理器安装布局（experimental 语义），文件系统探测是唯一不依赖外部布局的稳定方案。

**fail-soft 边界**：探测 10 级内无锚 → 退回 `process.cwd()`（保持旧行为，不引入 fail-fast——#429 方案决策③：不改变缺失时的降级语义）。

### 收口原则

- 9 处 cwd 相对路径全部改走 `resolve(getRepoRoot(), …)`
- **注入参数 override 优先**：`opts.templateDir`、`identityPromptDir`、`configPath`、`promptPathOverride` 显式传入时仍用传入值，仅默认值走新机制
- **降级语义原样保留**：healing 模板缺失仍 warn + 回退内置文案；对账目录不可读仍 warn + 跳过；daily-review / paper-trading / recruiting 仍 fail loud throw；config 仍启动失败——只是「路径解析」本身不再因 cwd 而失真

## 影响范围

- 新增：`src/frameworks/repo-root.ts`（约 60 行）、`tests/frameworks/repo-root.test.ts`（4 用例）
- 修改 8 个文件各 1-3 行（import + resolve 调用点 + Why 注释）
- 修改 `eslint.config.mjs` restrictedFrameworks 正则：负向前瞻加 `repo-root` 豁免——
  repo-root 是纯路径常量模块（零依赖，只读自身代码位置与 package.json），usecases 运行时
  资源定位需在不破坏依赖方向的前提下使用，与 D39 的 `@frameworks/logger` 豁免同性质
  （logger 也是零业务依赖的基础设施工具）。不豁免的替代方案（每层复制一份探测逻辑、
  或经依赖注入从 bootstrap 传入 repoRoot）都引入不必要的复杂度或改动面。
- 测试新增 3 用例：repo-root 自身 4 条（含 cwd 非项目根）、reconciler 默认 templateDir cwd 非项目根 1 条、healing 模板 cwd 非项目根 1 条

## 取舍

| 选项 | 结论 | 理由 |
|---|---|---|
| 逐级探测 vs 写死层级 | 逐级探测 | 兼容 src/dist 双布局 + 抗目录结构调整 |
| 文件系统探测 vs createRequire 自引用 | 文件系统探测 | 不依赖包管理器布局，语义可预期 |
| memo 缓存 vs 每次探测 | memo | 进程生命周期内 repoRoot 不变，逐次探测纯浪费 |
| fail-soft vs fail-fast | fail-soft | #429 方案决策③显式要求保留降级语义 |
| 动 stock-tools.ts 先例 | 不动 | 它工作正常且层级写死当前正确，非本 issue 范围（YAGNI） |

## 已知边界

- 仓库被复制到不含 package.json 的目录运行（如只拷 dist/ + prompts/）：逐级探测失败 → 退回 cwd → 行为与改动前一致（fail-soft 兜底）
- `import.meta.dirname` 需 Node 21.2+/22+——与 stock-tools 既有先例同口径，仓内运行时已要求 Node 22+
- worktree 场景：worktree 根有独立 package.json（name 相同），getRepoRoot 定位到 worktree 根——测试运行场景下正确（模板/配置就在 worktree 内）

## 验证

- `npx vitest run` 全量 3153/3153 通过（259 文件）
- `npx tsc --noEmit` 通过
- ESLint 0 errors
- 新增测试锚定 #429 核心场景：process.chdir 到临时目录（模拟 systemd WorkingDirectory）后 getRepoRoot / reconciler 默认 templateDir / healing 模板加载均能正确定位
