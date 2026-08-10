# 海獭署名约定

无论大獭还是小獭，在以下三处署名以标识责任主体。

## 身份获取规则

- **大獭**（Claude Code 主进程）：身份为"大獭"，从 MEMORY.md 或用户指令中确认
- **子 agent**（检视獭、开发獭等）：身份由父 agent 在启动时通过 prompt 显式指定，格式示例："你是检视獭，对 PR #N 进行对抗检视"
- **缺失身份时**：子 agent 不得自行猜测，必须向父 agent 确认后再执行署名操作

## 署名位置

1. **Commit author**：用 `--author` 参数指定当前海獭身份，格式 `名号 <otter-buddy>`
   - 大獭：`git commit --author="大獭 <otter-buddy>"`
   - 开发獭：按召唤时的 name 署名，例如 `开发獭-需求名 <otter-buddy>`（连字符是名号的一部分，非邮箱格式）
2. **PR description**：末尾署名行使用 `commit-convention.md` 的 PR Description 模板，`[海獭名号]` 替换为实际名号
3. **Review report**：使用 `adversarial-review/SKILL.md` 的"产出模板"章节，`[海獭名号]` 替换为实际名号
