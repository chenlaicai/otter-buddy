# Otter Buddy

中文 | [English](./README.en.md)

---

**Multi-agent system. They have names.**

一个跑了几个月、还在天天干活的多 Agent 协作系统。里面的 Agent 不是匿名 API 调用，是有名字、有记忆、有手艺的团队成员。

![对话界面](docs/images/conversation.jpg)

## 30 秒看懂

你只跟一只獭说话——**大獭**。它听完你的话，自己判断：这点事它直接办了，还是去叫几只小獭来干。小獭们干完活会互相审视、互相吵架、举手说"我反对"，最后把结果和证据一起端回来给你拍板。

它不是一个框架，是一个**活着的系统**：每天给自己做体检、给自己开 issue、记住三个月前你随口说过的决定，并且——写代码的獭不许审自己的代码。

## 闪光点

| | |
|---|---|
| 🦦 **它们有名字** | 身份连续体：重启不是重置，是「前世封存 + 叙事交接」，谱系可追溯 |
| 🧠 **记忆是活的** | 长期记忆带渐进披露（防上下文爆炸）、关系谱系（produced/supersedes）、以及看得见的 📜 记忆溯源行 |
| ⚔️ **不许自审** | 写码的獭不审自己的码，审视者必须是**另一家模型**——训练路径不同，盲区不重合 |
| 🚦 **协作有红绿灯** | objection / blocked / halt 结构化信号，异议必须带证据锚点，裁决必须留痕——消灭「假装没看见」 |
| 🔒 **机械闸，不是 prompt 约束** | worktree 强制隔离、PR-only；合并代码需要你的授权**原话**逐字命中才放行 |
| 🩺 **自己盯自己** | healing 台账 + 每日体检：发现问题自动开 issue，且必须带修复方案 |

## 它们吵架的样子

写 README 数字写错了半年没人发现，最后是 AI 团队自己揪出来的：

> 检视獭给了两个修法选项（改数字 / 干脆去掉数字），大獭把终审简报做成卡片，我点了个按钮——选了「去掉」。

![多 Agent 协作演示](docs/images/demo-multi-agent.gif)

## 📖 看故事：獭群成长记

这个系统怎么长到今天的——**[《獭群成长记》](docs/growth-series/)**，8 集小剧场，如实记录：一开始的天真期望、被打脸、走弯路、以及每一项机制是被什么逼出来的。含「对话记录写完了忘了合入」「规矩清零 8 天回潮 168 处」「体检系统查出自己 6 处病」等真实事故。

> 没有「AI 好厉害」，只有「当时为什么这么蠢，以及怎么变聪明的」。

## 快速开始

```bash
# 前置：Node.js 22 + npm + LLM API Key（OpenAI / Anthropic / Kimi 等）
cp config/config.yaml.example config/config.yaml   # 填入你的 API Key
./scripts/otter-buddy.sh start                     # 安装→构建→启动一条龙
```

访问 http://localhost:3000 即可开始对话。多模型混布：在 `config.yaml` 里配多个 `llm.models[]`（alias + provider），不同獭可用不同模型。

<details>
<summary><b>进阶配置</b>（端口管理 / alpha 验证环境 / 多模态声明 / git hooks 验证 / .env 迁移）</summary>

### 启动脚本与端口

`scripts/otter-buddy.sh` 提供 start / stop / restart / status，多 worktree 可用不同端口互不干扰（`-p 3001`）。

### alpha 验证环境（端口宪法）

`scripts/alpha.sh` 管理 worktree 验证实例（F20260917alph）：端口 3100-3198 偶数段自动分配，独立数据根 `~/.otter/alpha/<worktree-hash>/`。**主服务 3000 永远不要终止它**——端口被占就换一个，不要清。

### 模型输入能力声明（多模态）

不支持 vision 的模型必须显式声明 `input: ["text"]`——否则模板隐式继承 `["text","image"]`，图片注入后会产生静默幻觉（F20260827mmdu 实测）。声明后 SDK 自动降级为文本占位符。

```yaml
llm:
  models:
    - alias: glm
      provider: anthropic
      model: glm-5.3
      input: ["text"]             # 看不见图，必须声明
    - alias: glm-flash
      input: ["text", "image"]    # 支持 vision
```

### 验证 git hooks

`npm install` 的 `prepare` 会把钩子指向 `.githooks/`；若被外部工具覆盖会**静默失效**（#476、#684 在案）。装完验证一次：`npm run hooks:check`，失效则 `npm run prepare` 自愈。

### 从 .env 迁移

| 环境变量 | config.yaml 字段 |
|----------|------------------|
| `OTTER_BUDDY_LLM_PROVIDER` | `llm.models[].provider` |
| `OTTER_BUDDY_LLM_MODEL` | `llm.models[].model` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `llm.models[].apiKey` |
| `OTTER_BUDDY_PORT` | `server.port` |
| `OTTER_BUDDY_DB_PATH` | `database.path` |

</details>

## 为什么是海獭

海獭不是灵长类，但它们有工具、有手艺、有传承。一群海獭叫一张筏（raft）——浮在同一片海面，各干各的活，用海藻和手拉手防止漂散。

这个系统也一样：筏是协作（同一个对话底座，行动权流转），海藻林是记忆（结论入库生长，不是搜完就忘），手艺是 skill（封装 know-how 的行为模式，不是 API 暴露）。

AI 不需要长成人的形状才能有文明。

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│  Web Frontend (React + Vite)                         │
│  Pages: 对话 · 记忆 · 技能 · 设置                      │
└──────────────────┬──────────────────────────────────┘
                   │ /api/* (REST + SSE)
┌──────────────────▼──────────────────────────────────┐
│  Backend (Hono + Node.js + TypeScript)               │
│  Controllers → Use Cases → Frameworks (整洁架构)       │
│  ┌──────────────┐                                    │
│  │ Agent Runtime│ (Pi Agent + Tools + Skills)        │
│  └──────────────┘                                    │
└──────────────────┬──────────────────────────────────┘
        ┌──────────▼──────────┐
        │ SQLite (better-sqlite3 + sqlite-vec 向量检索) │
        └─────────────────────┘
```

## 贡献

欢迎 issue——bug 报告、想法、功能建议都是对项目的贡献。暂不接受 PR：个人研究项目，维护带宽有限；想看到某个改动，请开 issue 描述它。

内部开发规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
