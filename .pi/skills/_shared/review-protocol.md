# 对抗审视协议

PR 创建（或方案落盘）后，交付不算完成——必须经独立审视。

## 代码 PR 审视协议

适用于 code-implementation 完成后的 PR 审视。

### 1. 召唤检视獭

召唤检视獭（见 `otter-summon` skill）。小獭只有 read 权限、且 cwd 是主仓（相对路径会解析到主仓旧代码），systemPrompt 中必须：

- 要求其先 read `adversarial-review` skill 再动手
- 附上审视对象：`gh pr diff` 全文（大 PR 可落盘成文件后给绝对路径；落盘到仓库外如 /tmp，勿写入 worktree 污染 git status）
- 附上 worktree 的绝对路径——静态核验（对照测试文件、周边代码）必须以 worktree 内文件为准；主仓是 PR 合入前的旧代码
- 附上本次测试与构建的运行结果（标注为实现者自报），供其静态核验
- 附上 PR 描述全文（`gh pr view --json body` 输出）——delta 审视时需核对 Discovered Issues 节的 issue 链接落实情况

### 2. 处置审视报告

收到审视报告后，先校验报告合规性（含"本轮焦点"声明、发现分级、file:line 引用）——不合规直接打回重做，不合规报告不进入处置流程。然后按 `adversarial-review/references/author-response-protocol.md` 的**作者处置协议**逐条回应：

- 接受并修复
- 反驳（必须附证据，空驳回等同未处置）
- 部分接受
- 呈搭档裁决

不照单全收，也不空口驳回。反驳在对话内直接发给原检视獭，证据交换不消耗审视轮次。

### 3. 复审循环

修复后更新 PR，重新走审视（systemPrompt 不可更新：在消息中把新 diff 发给检视獭，或 dissolve 后重建）。第 2 轮起是 **delta 审视**——重建材料：上述全部材料 + 上轮发现清单 + 你的逐条处置 + 修复 diff + **更新后的 PR 描述**（delta 审视需核对 Discovered Issues 节的 issue 落实）（轮次结构与检视者职责定义见 `adversarial-review/references/review-loop.md`）

### 4. 收敛与终止

审视循环按收敛判据运转（`adversarial-review/references/review-loop.md`）：不设轮数上限，自然终止于"修复验证全部通过 + 无阻断回归"；对立僵局 / 移动靶 / 僵尸循环任一信号 → 停止循环，呈搭档裁决。搭档作为决策者随时可加开检视轮或直接拍板。

### 5. 终审

审视通过 → 呈搭档终审，交付才算完成。

审视者必须独立于实现者——自己写自己审等于没审。搭档明确表示"跳过审视/不用审"时，记录该决策后放行。

---

## 方案审视协议

适用于 requirement-analysis 完成后的方案审视。

### 1. 召唤检视獭

召唤检视獭（见 `otter-summon` skill），其 systemPrompt 中必须：

- 要求先 read `adversarial-review` skill 再动手
- 附上方案全文，或方案文件在 worktree 内的绝对路径（小獭 cwd 是主仓，相对路径会解析到主仓旧代码）

### 2. 处置审视报告

收到审视报告后先校验合规性（含"本轮焦点"声明、发现分级、file:line 引用），不合规直接打回重做——与代码 PR 审视同款门禁。然后按 `adversarial-review/references/author-response-protocol.md` 的**作者处置协议**逐条处置：

- 接受并修订
- 反驳（必须附证据，空驳回等同未处置）
- 部分接受
- 呈搭档裁决

不照单全收——检视者 fresh eyes 但上下文浅，误读要靠你的证据驳回；也不空口驳回。纯技术取舍你自行拍板并记录理由；涉及产品方向、资源投入或对外承诺的，呈搭档拍板（修复 / 接受 / 搁置）

### 3. 复审循环

按结论修订方案并复审。第 2 轮起是 **delta 审视**：把上轮发现清单 + 你的逐条处置 + 修订 diff + **更新后的方案文档**（delta 审视需核对非阻断发现是否写入待办/决策史节，标注段落定位）发给检视獭（轮次结构与检视者职责定义见 `adversarial-review/references/review-loop.md`）。复审按收敛判据运转：不设轮数上限，自然终止于"修复验证全部通过 + 无阻断回归"；对立僵局 / 移动靶 / 僵尸循环任一信号 → 呈搭档裁决。

### 4. 决策史回写

决策史回写文档——每道题的结论和理由留痕。

以上走完，方案才算定稿，才可进入实现阶段。搭档明确表示"跳过审视/不用审"时，记录该决策后放行。
