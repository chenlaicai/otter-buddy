---
id: F20260828fper
title: 飞书权限名订正：contact:user.base:readonly → contact:contact.base:readonly
summary: 飞书手册与代码注释中的权限名笔误（user vs contact 一字之差）导致按手册配置无效；实测 API 确认飞书必需权限为 contact:contact.base:readonly 系列，本次全量订正并补排查 FAQ。
change_type: fix
created_in_conversation: 08a924c4-9c68-43b4-9360-56f9b251e84f
---

# 飞书权限名订正（F20260828fper）

## 背景

搭档按 #488 交付的用户手册（feishu-setup.md）配置权限后，姓名快照依然全空。排查路径：

1. 日志实锤：8/27 全天 `Feishu user info query failed`，code **99991672**（权限拒绝）
2. 直接实测：拿应用 tenant_access_token 调 `GET /open-apis/contact/v3/users/{open_id}`，返回同样的 99991672
3. 关键证据：错误信息列出的必需权限清单为 `contact:contact.base:readonly` / `contact:contact:access_as_app` / `contact:contact:readonly` / `contact:contact:readonly_as_app`——**清单中不存在 `contact:user.base:readonly`**

结论：#488 手册写的权限名是笔误（user ↔ contact），按手册开通的权限对 API 无效。这不是配置遗漏，是文档源头错误。

## 改动

| 文件 | 处数 | 内容 |
|------|------|------|
| `docs/user-guide/feishu-setup.md` | 5+1 | 权限表/多人识别提示/调试器指引/FAQ 各处权限名订正；FAQ 新增一行「开了权限仍不显示姓名」排查路径（核对权限名 → 发版 → 日志验证 `Feishu user name resolved`） |
| `src/frameworks/feishu/user-info-client.ts` | 1 | 头注释权限名订正 + 注明笔误来源与实测必需清单（代码逻辑零改动） |
| `config/config.yaml.example` | 1 | 权限清单注释订正（审视修复：首轮漏改，grep --include="*.yaml" 不匹配 .yaml.example 后缀所致） |

总计 8 处订正（手册 5 + FAQ 1 新增 + 代码注释 1 + config.example 1；历史特性文档不改，见排除项）。

## 排除项

- **历史特性文档（F20260826fuid）不改**（搭档终审意见）：特性文档是「来时路」——当时写错了就保留错误，本次新建 F20260828fper 订正正是特性 chain 的存在意义。曾同步勘误 3 处已回退。
- 代码逻辑零改动：`user-info-client.ts` 只改注释，不发版不影响行为

## 验证

- [x] `grep -rn "contact:user.base:readonly"` 全仓仅余合理引用（FAQ/特性文档/注释中作为对比展示「不要用」的旧名）
- [x] 权限名以实测 API 错误返回为准（log_id 20260828100352479CBCCFE0AF8E4E49A9 可复查）
- [ ] 搭档侧验证：开通 `contact:contact.base:readonly` + 发布版本后，发一条飞书消息，日志出现 `Feishu user name resolved`

## 教训

文档中的权限名/API 名必须从官方错误返回或文档实测核对，不能凭记忆写——一字之差（user vs contact）让搭档按手册配置无效还以为是自己操作问题。#488 交付时的「推荐权限」清单没有经过 API 实测验证。
