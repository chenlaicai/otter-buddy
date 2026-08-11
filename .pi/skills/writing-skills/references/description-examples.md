# description-examples.md

合规与违规 description 示例对照（F20260811sktp 铁律 + 三段式契约）。

## 合规示例

### technique skill

```
✅ name: requirement-analysis
   description: >-
     Use when: 搭档要求分析需求/设计方案/做技术方案.
     Not for: 已有方案要求写代码 → code-implementation. 闲聊讨论 → companion.
     Output: 结构化技术方案文档（按产出模板）.
```

**为什么合规**：
- 三段式齐全（Use when / Not for / Output）
- Use when 是具体触发条件，不是流程总结
- Not for 明确指向替代 skill
- Output 是交付物契约

### 含安全前置的 skill（例外 1）

```
✅ name: worktree-isolation
   description: >-
     Precondition: MUST trigger BEFORE modifying or committing any git-tracked file.
     Use when: 准备提交任何 git 追踪文件（代码、文档、配置、lockfile）.
     Not for: 非 git 追踪文件（memory、.env）. 功能开发 → code-implementation.
     Output: worktree + commit + PR.
```

**为什么合规**：
- Precondition 段使用 MUST BEFORE 强制语序——属例外 1，不算流程总结
- 三段式齐全

### 元 skill（例外 2 能力摘要）

```
✅ name: writing-skills
   description: >-
     Use when: 搭档要求新建或重写 skill.
     Not for: 使用已有 skill → 直接调用. 修改 SYSTEM.md → 不在范围.
     Output: 合规 SKILL.md + manifest 同步 + 通过 lint.
     能力摘要：创建或修改 otter skill 的元技能（含铁律、三段式、模板、lint）.
```

**为什么合规**：
- 末尾"能力摘要"是一句话价值说明，禁具体步骤——属例外 2
- 三段式齐全

### fallback skill（豁免三段式）

```
✅ name: companion
   description: >-
     Default mode when no other skill matches. Unstructured collaboration: discussion,
     brainstorming, thinking through ideas. Not a process — a conversation.
```

**为什么合规**：
- companion 作为默认 fallback，三段式会变同义反复（Use when: 不匹配任何其他 skill）
- lint 对 companion 豁免三段式 marker 校验
- 但 description 仍清晰说明触发与边界

## 违规示例

### 内容描述偏流程总结

```
❌ name: requirement-analysis
   description: "Transform vague user intent into a clear technical plan."
```

**为什么违规**：
- 偏内容描述，LLM 看不到具体触发条件
- 没有指向替代 skill 的 Not for
- 没有声明 Output 契约
- 改写：见上方合规示例

### 流程细节塞进 description

```
❌ name: code-implementation
   description: "Turn a technical plan into code through 8 steps: worktree setup,
   requirement review, terminology check, implementation, testing, self-check, commit, PR."
```

**为什么违规**：
- 8 步流程是 SKILL.md 体的内容，不是 description
- LLM 会按 description 行动跳过 read SKILL.md
- 改写：
   ```
   ✅ Use when: 搭档要求按方案实现功能/写代码/写测试.
      Not for: 无方案的需求分析 → requirement-analysis. 小改动 → worktree-isolation.
      Output: 代码 PR（含测试、对抗审视通过）.
   ```

### 职责过宽（什么都能做）

```
❌ name: do-everything
   description: "Use when: 写代码、调 bug、做方案、查历史、记产出、闲聊.
      Not for: nothing. Output: anything."
```

**为什么违规**：
- Use when 罗列 6 个不相关场景 = 一个 skill 试图做 6 件事
- Not for: nothing 说明边界缺失
- 改写：拆成多个 skill

### 安全前置丢失

```
❌ name: worktree-isolation
   description: "Use when: 准备提交 git 追踪文件. Not for: ... Output: ..."
```

**为什么违规**：
- 丢了 `MUST trigger BEFORE` 的强制语序
- LLM 可能在已经修改文件后才触发
- 改写：见上方"含安全前置"合规示例
