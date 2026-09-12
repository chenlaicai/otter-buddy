---
id: F20260912wdsp
title: worktree 目录规范：跟项目根走，路径定为 .otter/worktrees/
summary: 搭档发现系统 worktree 一直开在 .claude/worktrees/ 下（Claude Code workflow 演化的历史遗留名，与运行时无关），且该约定从未成文。分析三个候选位置（跟项目根走 / 跟对话工作区走 / 中心化 data/worktrees/）后定为「跟项目根走 + 改名 .otter/worktrees/」：worktree 生命周期跟 PR 走不跟对话走，repo 内 + gitignore 是 git 社区常见模式，改名一次性付清命名语义成本。存量 worktree 不迁移（搭档决策：避免影响其他对话在途工作）。
change_type: prompt
capability_test: "n/a: 路径约定是 skill 文本与工具描述字符串变更，无可采样行为断言点；既有 capability 测试不涉及 worktree 路径"
created_in_conversation: ffe5461a-8041-410b-937c-e0eae77b8958
tags: [worktree, skills, convention, repo-hygiene]
intent:
  problem: "worktree 目录位置无成文规范，实际落在 .claude/worktrees/（历史遗留名，系统不用 Claude，读到的人都会疑惑）；对话工作区方案有结构性缺陷未被显式排除，未来存在被误选的风险"
  expected_effect: "worktree-isolation skill 与工具描述中的路径统一为 <项目根>/.otter/worktrees/，约定成文；新 worktree 开在新路径，存量自然衰减"
  verify_by:
    type: behavior_check
    detail: "新创建的 worktree 出现在 <项目根>/.otter/worktrees/ 下；.gitignore 含 .otter/；grep 全仓 .pi/prompts 无 .claude/worktrees 活引用残留（历史文档与测试数据除外）"
modules:
  - .pi/skills/worktree-isolation/SKILL.md
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - .gitignore
---

# worktree 目录规范：跟项目根走，路径定为 .otter/worktrees/

## 背景

> 搭档原话（2026-09-12）：「前几天我发现一个问题，那就是本系统的 worktree 都开到了 .claude 下，我也忘了当时提没提 issue。你来处理下，咱们海獭系统的 worktree 规范中应该要写清楚，但我目前也没具体方案。你分析一下，看咱们要用哪个目录来放 worktree 好一点，大概有几个思路，一个是跟着所处理的项目根目录走，一个跟着海獭系统每个对话的工作区目录走。可能也有其他方案」
> 拍板（同日）：「按你说的做，但你不要去动现有的，没必要、避免影响其他对话正在进行的工作」

事实核查：

1. **issue 从未登记过**——全量搜索 issue 列表（worktree/.claude 关键词），目录位置问题无记录，搭档记忆中"忘了提没提"的答案是没有提。
2. **路径无代码硬编码**——全仓 grep `.claude/worktrees`，src/ 下仅 1 处（tool-factory.ts:673 sync_docs 工具的参数描述字符串），其余全部是：skill 文本约定（worktree-isolation SKILL.md 步骤 1/3）、历史特性文档（不可变铁律 F20260831dgim）、测试数据字符串、git 元数据（.git/worktrees/*/gitdir）。
3. **`.claude/` 是历史遗留名**——本项目最早从 Claude Code workflow 演化而来，`.claude/` 是 Claude Code 的约定配置目录；后来自研 pi-ai SDK + `.pi/` 目录 + 自有 skill 系统，worktree 路径一直沿用未动（9/10 对话已确认过一次来历，当时定性为低优先级）。
4. **既有跨项目先例**——处理外部项目（如 EchoAgent）时 worktree 开在 `<该项目根>/.claude/worktrees/`，即「跟项目根走」实际一直在运行，只是从未成文。

## 目标

- T1: worktree 目录位置成文，写入 worktree-isolation skill，消除约定漂移空间
- T2: 路径语义正名——脱离 `.claude/` 历史遗留名，定为 `<项目根>/.otter/worktrees/`
- T3: 全部活规范引用同步（skill + 工具描述字符串），不留双轨

## 非目标

- **不迁移存量 worktree**（搭档显式决策）：14 个现存 worktree 留在 `.claude/worktrees/` 原位，随各自 PR 合入后由 post-merge-cleanup 自然清理，不做 `git worktree move`
- 不改历史特性文档中的路径引用（历史文档不可变铁律 F20260831dgim）
- 不改测试中的路径字符串（测试数据，非行为规范）
- 不引入中心化 worktree 管理服务/自动 GC 机制

## 方案设计

**规范正文**：worktree 一律创建在 **`<被处理项目根>/.otter/worktrees/<name>`**，分支基于最新 `origin/main`。`.otter/` 加入项目 `.gitignore`（与 `.claude/` 现行处理一致——运行时产物目录，git 追踪内容为零）。

**为什么是「跟项目根走」——三方案对比**：

| 维度 | A. 跟项目根走（选定，改名 `.otter/worktrees/`） | B. 跟对话工作区走（`data/workspaces/<对话ID>/worktrees/`） | C. 中心化（`data/worktrees/<项目slug>/`） |
|---|---|---|---|
| 生命周期归属 | ✅ 跟 PR/项目走，对话归档/断线不影响 | ❌ **对话归档时 removeWorkspace 连窝端**（manage-conversation.ts:113），在途工作被物理删除 | ⚠️ 中心目录自身清理策略不明，引入新的状态 |
| 跨对话/跨 session 接手 | ✅ 天然无感 | ❌ 断线重开或换 session 后对话 ID 变化，旧 worktree 成孤儿（本次 kimi 配额断线即为活例） | ✅ 无感 |
| git 生态亲和 | ✅ worktree 元数据本就在主仓 `.git/worktrees/`；repo 内 + gitignore 是社区常见模式 | ⚠️ 路径混入对话 ID，肉眼不可读 | ⚠️ 同左 |
| 认领协议兼容 | ✅ `git worktree list` + mtime 判在途正常工作（git 位置无关） | ✅ 同左 | ✅ 同左 |
| 项目侵入性 | 一行 gitignore | 零侵入 | 零侵入 |

**为什么顺手改名 `.otter/`**：规范是新写的，写一个名不副实的路径，每个读到的人都会再问一次"为啥是 .claude"（搭档 9/10 已问过一次）。趁成文一次性付清命名成本。备选 `.pi/worktrees/` 否决：`.pi/` 是被 git 追踪的框架资产目录，运行时产物不与之混放。

**B 方案的边界启示**（写入 skill 认知）：对话工作区（data/workspaces/）适合放草稿、临时文件等「可丢弃物」，不适合放交付中资产（未合入的 worktree、特性文档）。生命周期错配是结构性缺陷，改名/加保护都救不了。

## 影响范围

- `.pi/skills/worktree-isolation/SKILL.md`：步骤 1（环境验证路径）、步骤 3（创建命令）——活规范的唯一路径出处
- `src/interface-adapters/agent-runtime/tools/tool-factory.ts:673`：sync_docs root_dir 参数描述中的示例路径
- `.gitignore`：新增 `.otter/`
- 其他 skill（code-implementation / review-protocol / adversarial-review 等）均以「worktree 绝对路径」抽象表述引用，无路径字面量，**不需要跟改**
- 存量 14 个 worktree：行为无影响，路径不变，post-merge-cleanup 照常工作（它读 `git worktree list`，位置无关）

## 风险与约束

- **双轨过渡期**：新 worktree 在 `.otter/worktrees/`、存量在 `.claude/worktrees/` 并存一段时间。风险低：认领协议与清理流程都以 `git worktree list` 为准（位置无关）；历史文档里的旧路径仅作历史记录。过渡期自然衰减，无需要额外机制
- 改 tool-factory.ts 字符串仅影响工具描述文本，不涉及运行时逻辑，无兼容性风险

## 不兼容更新

无。（旧路径继续可用——存量 worktree 不受任何影响；新约定只是新建时的规范路径。）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 目录位置 | 跟项目根走 | 跟对话工作区走 | 生命周期归属是判据：worktree 跟 PR 走，对话会归档/断线；removeWorkspace 删除是对话区方案的硬否决 |
| 目录名 | `.otter/worktrees/` | 维持 `.claude/` / `.pi/worktrees/` | 语义正名 + 不污染 git 追踪的框架目录 |
| 存量迁移 | 不迁移（搭档决策） | `git worktree move` 批量迁移 | 避免影响其他对话在途工作；自然衰减足够，迁移收益配不上并发风险 |
| 规范落点 | worktree-isolation SKILL.md | SYSTEM.md 红线章节 | 路径是操作细节非安全红线；skill 是 worktree 操作的单一真相源 |

## 验证

- 新建 worktree 落在 `<项目根>/.otter/worktrees/` 下（本特性文档所在的 worktree 即第一个按新规范创建的实例，已验证）
- `.gitignore` 生效：`git check-ignore .otter/` 通过、`git status` 不出现 .otter/
- `grep -rn '\.claude/worktrees' .pi/ prompts/ src/` 无活规范引用残留（历史文档、测试数据除外）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| .pi/skills/worktree-isolation/SKILL.md | 修改 | 步骤 1/3 路径改为 .otter/worktrees/，并补一段目录位置规范说明 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | :673 描述字符串示例路径同步 |
| .gitignore | 修改 | 新增 .otter/ |
| docs/features/2026/09/12/F20260912wdsp-worktree-directory-spec.md | 新增 | 本文档 |
