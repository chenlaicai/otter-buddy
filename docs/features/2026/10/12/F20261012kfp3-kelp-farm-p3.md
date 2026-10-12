---
id: F20261012kfp3
title: "獭之传说·上线 P3：GitHub Pages 部署 + README 首屏游戏入口"
summary: "P3 上线交付（搭档口径「咱们先上线」，场景精绘后置）：① .github/workflows/deploy-game.yml 将 game/ 部署到 GitHub Pages（Pages 站点已通过 API 启用 build_type=workflow，免去搭档手动开 Settings）；② README.md / README.en.md 首屏新增「先玩 3 分钟」游戏区块（映射表+截图+直达链接）；③ docs/images/kelp-farm-game.png 镜湖终战截图入仓作 README 配图。GIF 录制与场景精绘同押后——现在录制精绘后即作废，避免双倍工作。"
change_type: feature
capability_tags: [game, readme-growth]
capability_test: "n/a: 本交付为部署 workflow + 文档/图片内容（game/ 纯静态内容产品延续，零运行时依赖、不进主系统构建/测试面），验证 = ① deploy-game.yml 结构走查（actions/configure-pages@v5 + upload-pages-artifact@v3 + deploy-pages@v4 标准三件套、paths 过滤 game/**+workflow 自身、concurrency group pages）② Pages 站点 API 返回 build_type=workflow 且 html_url=https://chenlaicai.github.io/otter-buddy/ ③ 合入后 push 触发 deploy run 成功 + URL 可访问（人工验收）④ README 双语区块链接与配图路径一致"
intent:
  problem: "P0-P2（#1422/#1427/#1435）游戏本体交付完毕并合入 main，但访客从 README 点不到游戏——方案 F20261009oqtd §7 的 P3（README 集成 + Pages 部署）未落地，游戏没有对外 URL，获客闭环断在最后一公里。"
  expected_effect: "① 合入 main 后 Actions 自动把 game/ 部署到 https://chenlaicai.github.io/otter-buddy/ ；② README 访客首屏看到游戏入口（3 秒可理解+一键直达）；③ 后续 game/ 任何改动 push 到 main 即自动重新部署。"
  verify_by:
    type: human_judge
    reason: "部署类交付，端到端验收=人工：合入后打开 https://chenlaicai.github.io/otter-buddy/ 能玩（T1）；从 README 点击入口直达游戏（T2）；README 双语区块展示正常（T3）。前置静态验证已完成：workflow 结构走查、Pages API 启用确认（build_type=workflow）、skip 链接为绝对 URL 不会 404（game/index.html:50）。"
created: 2026-10-12
created_in_conversation: cb80d695-bce9-4b83-9f2a-98618242acd0
causal_links:
  - F20261009oqtd   # 方案 v2（§7 分期 P3 定义：README 集成 + GIF + Pages 部署）
  - F20261012kfp2   # P2 镜湖终战（直接前驱，#1435 已合入）
---

# 獭之传说·上线 P3：GitHub Pages 部署 + README 首屏游戏入口

## 背景

方案 F20261009oqtd §7 分期：P0（#1422）✓ → P1（#1427）✓ → P2（#1435）✓ → **P3 README 集成 + GIF + Pages 部署**。P2 试玩通过并合入后，搭档拍板 P3 口径（原话）：「直接开始推进p3，场景精绘后续再优化，咱们先上线」。

据此收窄 P3 范围：

| 项 | 本 PR | 理由 |
|---|---|---|
| Pages 部署 workflow | ✅ | 上线必需 |
| README 首屏游戏入口 | ✅ | 上线必需 |
| 场景精绘/视觉包装增强 | ❌ 押后 | 搭档明示后置 |
| GIF 录制 | ❌ 押后 | 与精绘绑定——现在录制精绘后即作废，双倍工作；首版先用静态截图 |

## 目标

- 合入 main 后游戏自动上线 `https://chenlaicai.github.io/otter-buddy/`
- README 双语首屏有游戏入口：3 秒理解 + 一键直达
- game/ 后续改动 push main 即自动重部署

## 非目标

- 场景精绘、GIF 录制（P3 后续批次）
- 游戏内容变更（P2 冻结版直接部署）
- html-card-play 对话内可玩卡复用（方案 P3 候选，本 PR 不带）

## 方案设计

### 1. Pages 部署 workflow（新增 `.github/workflows/deploy-game.yml`）

标准 GitHub Pages Actions 三件套：

- 触发：`push main`（paths 过滤 `game/**` + workflow 自身）+ `workflow_dispatch` 手动兜底
- `actions/configure-pages@v5` → `upload-pages-artifact@v3`（path: game）→ `deploy-pages@v4`
- `concurrency: group: pages` 防并发部署互踩

**实施前置项消除（方案 §实施前置两项之②）**：方案记录「Pages 启用依赖搭档操作（Settings → Pages 手动设 Source=GitHub Actions）」——实际经 `gh api -X POST repos/.../pages -f build_type=workflow` 可直接启用，已由大獭完成（返回 `html_url=https://chenlaicai.github.io/otter-buddy/`，无需搭档手动操作）。

### 2. README 首屏游戏区块（README.md / README.en.md 同步）

位置：对话界面截图之后、「30 秒看懂」之前——访客视觉动线上第一屏可及。

内容三件：映射一句话（8 点位能力对照）+ 镜湖终战截图 + 直达链接。标题「先玩 3 分钟，再读文档」承方案 §4.5 的 3 分钟序章锚点。

### 3. README 配图（`docs/images/kelp-farm-game.png`）

P2 截图取证中的镜湖终战帧（农场全景 + 终战对话框同框，同时呈现两层卖点），复用既有素材零录制成本。

## 影响范围

- `game/` 零改动（P2 冻结版原样部署）
- 主系统 `src/`、`web/`、测试面零接触
- README 为纯文档新增区块；workflow 为新增文件不改 ci.yml

## 取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| GIF vs 截图 | 截图先行 | 精绘后置则 GIF 必重录，避免双倍工作；截图已够 3 秒传达 |
| Pages 手动启用 vs API 启用 | API | 实测可行，直接消除方案已知前置项，少一次人工环节 |
| 部署触发 paths 过滤 | `game/**`+workflow | 避免无关 push 触发部署；`workflow_dispatch` 兜底手动重发 |

## 验证

1. deploy-game.yml 结构走查：三件套 action 版本、paths 过滤、concurrency、permissions（contents:read / pages:write / id-token:write）齐全
2. Pages API 启用确认：`build_type=workflow`、`html_url` 正确（实测已过）
3. `game/index.html:50` skip 链接为绝对 URL，Pages 域下不 404
4. **合入后人工验收（T1-T3）**：URL 可玩 / README 入口直达 / 双语展示正常
