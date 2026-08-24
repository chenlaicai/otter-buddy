---
id: F20260821kgts
title: lint-gates-wiring
doc_type: feature

summary: |
  把 lint:skills / lint:tool-manifest 接入 pre-commit + CI，并把 hook 里其余三个 gate
  （lint-tests / lint-capability-docs / lint:docs）一并接进 CI（#366 PR-2，两轮对抗检视后扩围）。
  动机：校验脚本不挂 hook 或 CI 形同虚设（尽调 #19），且只挂 hook 会被 --no-verify 绕过（#14：纪律≠机制）。
  机制：CI 分两个 step（零构建依赖的 gate 放 build 前，lint:docs 依赖 dist 放 build 后）；
  二轮检视后追加 lint 脚本自身加固（skills 数量 ratchet、tools:"*" 白名单、豁免 ratchet）。
  门禁闭合依赖 main branch protection（已开，含 enforce_admins）。

causal_links:
  from:
    - F20260811sktp

status: implemented
change_type: feature
tags: [lint, ci, engineering-hygiene]
modules:
  - .githooks/pre-commit
  - .github/workflows/ci.yml
capability_test: "n/a: 纯工程接线（A 类），无 LLM 参与行为"
---

# F20260821kgts: lint-skills / lint-tool-manifest 接入 pre-commit + CI

## 背景与需求

### 问题描述

#366 尽调 #19（工程卫生）：`lint-skills` / `lint-tool-manifest` 两个校验脚本已存在于 `package.json` scripts，但不挂任何 hook 或 CI——依赖开发者手动运行，形同虚设。

### 根因分析

脚本产出（F20260811sktp、F20260820a4rt）只落在了脚本本身，没有接线到强制执行点。

### 数据实锤

- `package.json` 有 `lint:skills` / `lint:tool-manifest` 两个 script。
- `.githooks/pre-commit` 此前未包含它们。
- `.github/workflows/ci.yml` 此前未包含它们。

## 方案设计

### 技术方案

1. `.githooks/pre-commit` 在既有 lint 链（lint:docs / lint-capability-docs / lint-tests）之后追加 `npm run lint:skills` 与 `npm run lint:tool-manifest`。
2. `.github/workflows/ci.yml` 分两个 step 接线（对抗检视后从两个 gate 扩到五个）：
   - build 前：`lint:skills` / `lint:tool-manifest` / `lint-tests` / `lint-capability-docs`——只读源文件，零构建依赖，前置获得快速反馈。
   - `npm run check`（= build）之后：`lint:docs`——复用 dist 编译产物（单一真相源），必须排在 build 后。
3. 定位：本地 hook 是快速反馈层，CI 是信号层。`--no-verify` 可绕过本地 hook；门禁语义 = CI + main branch protection（required status check `check`，strict，enforce_admins 已开启）。
4. 二轮检视后追加 lint 脚本自身加固（红队攻防发现的静默绿路径）：
   - `lint-skills.mjs`：MIN_SKILLS=9 数量下限 ratchet（防"删光 skills + 清空 manifest"静默绿）；必填字段检查收紧（`name: 0` 曾双重绕过）；references 校验扩展到 markdown 链接形态。
   - `lint-tool-manifest.mjs`：`tools: "*"` 全放行仅限白名单 WILDCARD_ALLOWED_TYPES（现仅 big）；工具注册表正则容忍单/双/反引号；错误消息从 tool-factory.ts 修正为实际扫描的 agent-runtime/tools 目录（注释与实现漂移）。
   - `lint-tests.mjs`：allow-ddl 豁免文件数 ratchet（上限 2，新增须显式上调）；扫描范围扩到 `.mts`。

本档为 Wave 0 清理类共用薄档，PR-1（skills 页"建设中"标注）后续作为 Part B 补入。

### 目标

- T1: pre-commit 阻断 skill 契约 / tool manifest 违规提交。
- T2: CI 在 PR 上独立执行全部五个 lint gate，绕过本地 hook 也会在 CI 暴露。

### 成功标准

- CI workflow 含 lint gate step，且在当前 main 内容上通过（警告不阻断，符合脚本既有语义）。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 本地 hook 生效 | 在 pre-commit 接线后提交 | pre-commit 输出两个 lint 的通过信息 |
| AT-2 | CI 生效 | push 分支开 PR | CI workflow 出现 lint gate step 且绿 |

### 能力测试映射

无（纯工程接线，A 类）。

## 实现细节

### 代码修改

- `.githooks/pre-commit`：追加两行 lint 命令，带 F 编号注释。
- `.github/workflows/ci.yml`：新增「Run fast lint gates」step（四命令，build 前）+「Run docs frontmatter lint gate」step（build 后）。
- `scripts/lint-skills.mjs` / `lint-tool-manifest.mjs` / `lint-tests.mjs`：二轮加固（见技术方案第 4 点）。

### 逻辑变更

接线部分无行为变更；lint 脚本加固收紧了既有检查（当前内容全部通过，无既有违规被新拦）。

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| .githooks/pre-commit | 修改 | 追加 lint:skills / lint:tool-manifest |
| .github/workflows/ci.yml | 修改 | 新增两个 lint gate CI step（五个 gate 全接） |
| scripts/lint-skills.mjs | 修改 | 数量 ratchet + 必填字段收紧 + references 链接形态 |
| scripts/lint-tool-manifest.mjs | 修改 | wildcard 白名单 + 引号容错 + 消息纠正 |
| scripts/lint-tests.mjs | 修改 | 豁免 ratchet + 扫 .mts |

## 验收结果

### 测试结果

- 主仓当前内容：`npm run lint:skills` 通过（9 skills，7 warnings，警告不阻断）；`npm run lint:tool-manifest` 通过。
- CI 验证见本 PR checks。

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 hook 生效 | 首次提交时本机 `core.hooksPath` 被绝对路径覆盖，hook 实际未执行（对抗检视发现）；已修回相对值 `.githooks`，扩围提交时 pre-commit 完整跑通（含 build + 全部 lint） | ✅（修复后） |
| T2 CI 生效 | PR CI checks 含 lint gate step 且通过 | ✅ |

## 对抗审视记录

三路独立 agent 对抗检视（机制有效性 / 范围遗漏 / 副作用回归），关键发现与处置：

1. 本机 `core.hooksPath` 为绝对路径指向 `.git/hooks`（仅 sample 文件）→ pre-commit 全部失效（含既有禁推 main 保护）。处置：修回相对值 `.githooks`（package.json `prepare` 的预期状态；相对值在 worktree/主仓各自解析，实测确认）。AT-1 首次证据作废，以修复后的实际执行为准。
2. 接线不对称：本 PR 论据"纪律≠机制"同样适用于 hook-only 的 lint-tests / lint-capability-docs / lint:docs，且 12 PR 排期无人承接。处置（用户拍板）：扩围，四个全接进 CI。
3. main 无 branch protection / required checks → "CI 不可绕过"表述过强。处置（用户拍板）：文档降级为"CI 是信号层，门禁依赖 protection"；protection 由 owner 开启（required check: `check`）。
4. 已验证无问题：exit code 语义（警告不阻断）、yaml 在 dependencies、CI 路径 git-tracked 齐全、新增 lint 耗时 ~1.2s（占 build 21.4s 约 6%）、lint-skills 对 `.pi/skills` 不存在时 readdirSync 抛 ENOENT 属报错丑非功能问题（既有，不本 PR 修）。

### 第二轮（门禁链路完整性 / F 文档真实性 / 红队攻防）

5. **enforce_admins=false 是残留绕过口**：owner 是 admin，`git push origin HEAD:main` 可绕过全部 required checks，与本 PR"机制≠纪律"立意冲突。处置（用户拍板）：已开启 enforce_admins（同批补 require linear history 未开，维持现状）。
6. **hooksPath 修复不稳定**：文档声称"已修回相对值"后，`core.hooksPath` 又在 2026-08-24 08:01 被某来源写成绝对路径（shell rc / package.json 均排除，覆盖者不明），hook 再次全失效。处置：再修回相对值并记为观察项——`npm ci`/`npm install` 的 `prepare` 每次都会重置回相对值 `.githooks`，是事实上的自愈通道；若再次复现需排查本机工具。
7. **红队静默绿路径**（处置：本 PR 全套加固，见技术方案第 4 点）：skills 整体清空静默绿（→ MIN_SKILLS ratchet）；`tools: "*"` 无约束（→ 白名单）；豁免标记可注释化（→ 改为豁免数量 ratchet，注释位置不约束——标记无论在哪都是信任标记，ratchet 让新增豁免必须改 lint 脚本、进 diff 过 review）。
8. **已验证不可行的攻击**：`--no-verify` + PR 注入（CI 覆盖 hook 全部 gate 且用 head.sha checkout）；fork PR（无 secrets 引用、无 pull_request_target、PR_TITLE 走 env 无注入面）；manifest 删/坏（均报错退出 1）；非 admin 直推（required check 拒）。
9. **已知残留限制（记录不改）**：字符串拼接绕过 DDL 正则（`db.exec("CREATE " + "TABLE…")`）无法机械零误判拦截，留 review；required check 名 `check` 与 CI job 名是弱耦合字符串，job 改名须同步 protection 配置；CI fail-fast 下 `npm run check` 失败会 skip lint:docs（第二类错误晚一轮暴露，本地 hook 全量跑可提前发现）。
10. **文档口径修正（本轮检视自身发现）**：protection 实际已开启但文档曾按"待开启"口径写，已更新；lgts→kgts 改名（commit-msg 门禁拦下首字符 l）此前只在 commit message 有记录，现补入本档。

## 设计决策

- lint gate 分两段：零构建依赖的四个放 build 前快速反馈；`lint:docs` 依赖 dist（单一真相源）放 build 后。
- 门禁三层结构：本地 hook（快速反馈，可被 --no-verify 绕过）→ CI（信号层，覆盖 hook 全部 gate 的超集）→ branch protection（门禁层：required check `check` + strict + enforce_admins，admin 亦不可直推）。protection 属 repo 设置，2026-08-24 已开启。
- ratchet 优于标记位置约束：豁免/下限类约束（MIN_SKILLS、MAX_ALLOW_DDL_FILES）让"扩权"必须改 lint 脚本本身——改动进 diff、过 review，比约束标记写在哪更可靠。
- 本机 hooksPath 约束：必须保持相对值 `.githooks`。绝对值会让 linked worktree 与主仓解析到同一（可能为空的）hooks 目录，静默摘除全部 hook。2026-08-24 曾发生一次来源不明的覆盖（见对抗审视记录 6），`npm install` 的 prepare 是自愈通道。
