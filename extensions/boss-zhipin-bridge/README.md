# BOSS 直聘桥接 → otter-buddy

> otter-buddy 的招聘消息接入扩展（F20260804rbrg）。
> 把 BOSS 直聘上的新 HR 消息**批量转发**到 otter-buddy 的"💼 求职助手"对话。

## 它做什么

- 每 30-35 分钟自动扫描一次 BOSS 聊天页（minimized window，你基本无感）
- 扫到有未读消息的会话 → 自动 click 触发 BOSS 调 historyMsg → 抓全文
- 把一批新消息**打包成一条**推到 otter，大獭一次 invoke 处理整批（分类、起草、入库）
- 桥接状态（反爬、登录失效、otter 不可达等）也推到同一对话，critical 立即通知
- otter 不可达时：badge 红"!" + Chrome 系统通知 + 本地缓冲补发

## 边界（明确不做）

- **绝不替你回复 BOSS** — 扩展只读不写
- **绝不模拟任何修改 BOSS 状态的 API**（发消息、标已读等）

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions`
2. 右上角打开"开发者模式"
3. 点"加载已解压的扩展程序"
4. 选这个目录：`extensions/boss-zhipin-bridge`

### 2. 配置 otter 连接

1. 在 otter-buddy 的 `config/config.yaml` 加：

   ```yaml
   inbound:
     recruiting:
       apiKey: "随机长字符串"  # openssl rand -hex 32 生成
   ```

2. 重启 otter-buddy
3. 打开扩展 options 页（chrome://extensions → 该扩展 → "详细信息" → "扩展程序选项"）
4. URL 默认 `http://localhost:3010/api/inbound/events`（端口看你的 otter 实际配置）
5. 把 config.yaml 里的 apiKey 复制到 options 页的 X-Inbound-Key 框
6. 点"保存配置" → "测试连接"，应该返回"连接成功"

### 3. 让扩展开始工作

- 登录一次 BOSS 直聘（`https://www.zhipin.com/web/geek/chat`），让 cookie 就位
- 第一次 alarm 触发（最多 30 分钟后）会自动开 minimized window 开始扫描
- 或者点扩展图标，立即扫描一次

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| options 页"测试连接"失败 | otter-buddy 没起 / apiKey 不匹配 / URL 错 | 启 otter-buddy，确认 apiKey，确认端口 |
| options 页显示 `PAUSED` | BOSS 反爬触发 about:blank | 打开 BOSS 聊天页手动操作一次，扩展会自动检测恢复 |
| options 页显示 `BUFFER N` | otter 临时不可达，本地缓冲 N 条 | 等 otter 恢复后自动补发 |
| options 页 scan-zero ≥ 3 | BOSS 改版导致 `.friend-content` 失效 | 来这里 issue，更新选择器 |
| 一直没消息（连续 48 次 scan-ok-0） | BOSS 消息系统异常 或 网络断了 | 手动开 BOSS 网页验证 |
| otter 收到 status 但招聘消息一直没进 | content script 注入失败 / BOSS login 过期 | 检查 BOSS 页能否正常登录 |

## 隐私

- 扩展只在 `zhipin.com/web/geek/chat*` 注入 content script
- webRequest 监听只看 `zhipin.com/wapi/zpchat/` 路径（聊天 API），不看其他流量
- 所有数据只发送到你配置的 otter URL（默认 localhost），不发送到任何第三方
- 本地数据存在 `chrome.storage.local`，options 页"清空本地数据"可一键清理

## 设计文档

完整设计在 otter-buddy 仓库：`docs/features/2026/08/04/F20260804rbrg-recruiting-bridge.md`
