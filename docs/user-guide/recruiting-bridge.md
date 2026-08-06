# 求职助手使用指南

> 让海獭帮你感知 BOSS 直聘上的初步沟通消息（HR 寒暄、要简历、面试邀请、拒信），
> 自动分类、起草回复、记录接触过的公司，每天 9:07 给摘要。
> 你只看海獭的摘要和起草，**自行决定**是否复制回复回 BOSS。

## 这是什么

otter-buddy 多了一个 **"💼 求职助手"专用对话**。你不用再频繁打开 BOSS 直聘看有没有人找你——海獭替你看，看完分类整理好告诉你。

技术上是双边架构：**Chrome 扩展**（boss-zhipin-bridge）跑在你电脑里扫 BOSS，把新消息**批量转发**到 otter-buddy；**otter-buddy 的大獭**收到后做分类/起草/记忆。

## 前置条件

- otter-buddy 在你电脑上能正常跑
- Chrome 浏览器（Safari 不行，因为这套扩展只在 Chrome 验证过）
- 你在 Chrome 里**登录过** BOSS 直聘
- 你已能通过飞书或 Web 看到与海獭的对话

## 配置步骤（5 分钟）

### 第 1 步：otter-buddy 加配置

打开 otter-buddy 的 `config/config.yaml`，加一段：

```yaml
inbound:
  recruiting:
    apiKey: "随机长字符串"  # 用 `openssl rand -hex 32` 生成
```

**保存后重启 otter-buddy**。重启后你会看到日志里有 `Recruiting conversation created`——这是海獭自动建好"💼 求职助手"专用对话了。

### 第 2 步：装 Chrome 扩展

1. Chrome 打开 `chrome://extensions`
2. 右上角"开发者模式"开关打开
3. 点"加载已解压的扩展程序"
4. 选 otter-buddy 仓库里的 `extensions/boss-zhipin-bridge` 目录

### 第 3 步：配置扩展连接

1. 在 `chrome://extensions` 找到"BOSS 直聘桥接 → otter-buddy"扩展
2. 点"详细信息" → "扩展程序选项"（或右键扩展图标 → 选项）
3. 填表：
   - **otter URL**：`http://localhost:3010/api/inbound/events`（端口看你的 otter 实际配置，默认 3010）
   - **X-Inbound-Key**：粘贴第 1 步 config.yaml 里那个 apiKey
4. 点"**测试连接**"——应该看到绿色"连接成功"
5. 点"**保存配置**"

### 第 4 步：登录 BOSS

在 Chrome 里打开 `https://www.zhipin.com/web/geek/chat`，确认能直接进聊天页（不是登录页）。如果需要登录，登录一次。

### 第 5 步：让它跑

不需要做任何事——扩展装好后，**第一次 alarm 触发（最多 30-35 分钟后）会自动开始扫描**。

如果想立刻验证：
- 在扩展 options 页点"**立即扫描一次**"——会显示扫描进度（开 BOSS tab → 等 SPA 加载 → 扫 DOM → 模拟点击未读 → 等响应 → 推送）
- 或在 Chrome 地址栏点扩展图标（图标是只灰色小图标）

## 怎么看效果

扫描到新消息后：
- 在 otter-buddy 的"💼 求职助手"对话里会出现 `[招聘消息批次·BOSS直聘...]` 系统消息 + 大獭的分类回复
- 如果你绑定了飞书，**飞书也会收到推送**
- 大獭会按 5 类分类、起草回复（标 `[确认]`/`[调整]`/`[仅提醒]`）、把新公司入库到 memory

定时摘要（每天 9:07）：
- 大獭会汇总"今日 N 条新消息：X 面试邀请、Y 要简历、Z 寒暄"
- 给"建议处理顺序"

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 扩展 options"测试连接"失败 | otter 没起 / apiKey 不匹配 / URL 错 | 启 otter-buddy，确认 apiKey 一致，端口对（3010 不是 3000） |
| options 页显示 `PAUSED` | BOSS 反爬触发 about:blank | 手动开 BOSS 聊天页操作一次，扩展会自动检测恢复 |
| options 页显示 `BUFFER N` | otter 临时不可达，本地缓冲 N 条 | 等 otter 恢复后自动补发 |
| options 页 `scan-zero ≥ 3` | BOSS 改版导致 `.friend-content` 失效 | 来这里 issue，更新选择器 |
| 一直没消息（连续 48 次 scan-ok-0） | BOSS 没新消息 或 网络断了 | 手动开 BOSS 网页验证 |
| otter 收到 status 但招聘消息一直没进 | content script 注入失败 / BOSS 登录过期 | 检查 BOSS 页能否正常登录；在 BOSS tab 上 Cmd+R 刷新 |
| 大獭回复"未分类"或乱分类 | 角色提示词被挤出上下文 | 一般不会发生；若发生，告诉大獭"重新看你的 systemPrompt" |
| Chrome 重启后扩展消失 | 扩展文件路径变了（比如 worktree 删了） | 重新加载扩展，路径选 `extensions/boss-zhipin-bridge` |

## 边界（明确不做）

- **绝不替你回复 BOSS** — 扩展只读不写。大獭起草的回复是给你**参考**的，你自己复制粘贴回 BOSS。
- **绝不模拟发消息、标已读等修改 BOSS 状态的 API** — 避免封号
- **Safari 不支持** — 这套扩展只在 Chrome 验证过

## 隐私

- 扩展只在 `zhipin.com/web/geek/chat*` 注入 content script
- webRequest 监听**只看** `zhipin.com/wapi/zpchat/` 路径（聊天 API），不看其他流量
- 所有数据只发送到**你配置的 otter URL**（默认 localhost），不发送到任何第三方
- 本地数据存在 `chrome.storage.local`，options 页"清空本地数据"按钮可一键清理

## 求职结束后

你拿到 offer 了，不需要这个功能了：
1. 在 `chrome://extensions` 关掉或卸载 BOSS 桥接扩展
2. 在 otter-buddy 的 `config.yaml` 删掉 `inbound.recruiting` 段，重启
3. （可选）在 otter Web UI 把"💼 求职助手"对话归档（archive）

memory 里的求职接触记录会保留——你想回顾"我接触过哪些公司"还能查到。

## 设计文档

完整技术设计（含 4 轮审视决策史）：`docs/features/2026/08/04/F20260805rbrg-recruiting-bridge.md`
