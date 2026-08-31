---
id: F20260831dgi2
title: data 运行时目录补全 .gitignore（attachments/weixin 凭证防泄）
summary: 附件管线（F20260827mmdu）与微信通道（#569）引入的 data/attachments 与 data/weixin 未同步 .gitignore，导致用户上传媒体与 bot_token 凭证以未追踪文件形式出现在 git status；补全忽略规则堵住凭证入库风险。
change_type: fix
created: 2026-08-31
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
tags: [gitignore, security, attachments, weixin, credentials]
modules: [.gitignore]
---

## 背景

搭档发现主目录 `git status` 出现不该出现的运行时文件与图片。排查结论：

```
?? data/attachments/   ← 用户上传媒体（当天下午微信发图入库：175KB JPEG）
?? data/weixin/        ← 微信账号凭证（accounts.json 含 bot_token 明文 + context-tokens.json + sync-buf.json）
```

根因：两条管线合入时均未同步 .gitignore——

1. **F20260827mmdu 多模态附件管线**引入 `data/attachments` 存储目录（config-service 默认 `./data/attachments`），特性文档未提及 .gitignore 更新（事后核对该文档 0 处提及 gitignore）
2. **#569 微信通道**引入 `data/weixin` 运行时状态目录，同样未同步

风险定级：`data/weixin/accounts.json` 含 **bot_token 明文**——一旦被 `git add -A` 顺手提交并推送，凭证即入库。当前实测 `git ls-files data/` 仅 `terminology/seed-terminology.json`（bootstrap 故意追踪），**确认未泄露**，属风险堵漏而非事故修复。

## 改动

`.gitignore` 新增两段（带出处注释，pattern 命名与既有段一致）：

```gitignore
# Inbound media attachments (user-uploaded images/voice/files — runtime user data,
# introduced by multimodal attachments pipeline F20260827mmdu)
data/attachments/

# Weixin channel runtime state (bot_token credentials, context tokens, sync
# cursor — credentials must never enter git; introduced by weixin channel #569)
data/weixin/
```

不采用 `data/*` 全量忽略 + 白名单反例外的原因：既有规则体系按目录逐条忽略（sessions/metrics/workspaces），保持一致性；terminology 种子文件的既有追踪不受影响。

## 验证

- worktree 内 `git status --porcelain` 干净（新增目录不再出现于未追踪清单）
- 主目录 `git ls-files data/` 复核：仅 terminology/seed-terminology.json，无凭证/媒体文件被追踪
- 追溯确认：全 git 历史无 data/weixin、data/attachments 路径提交（本次未运行全历史 grep，依据 ls-files 现状 + 两条管线 PR diff 范围判断；若需绝对确认可 `git log --all -- data/weixin` 复核）

## 影响

- 未追踪文件只是「风险敞口」，无历史泄露需要清理（token 无需轮换）
- 既有 data/ 追踪文件（terminology 种子）不受影响
- 后续新增运行时目录的管线，.gitignore 同步应作为合入检查项（教训记录，见流程备注）
