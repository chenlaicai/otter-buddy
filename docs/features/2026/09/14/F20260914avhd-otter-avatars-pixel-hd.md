---
id: F20260914avhd
title: 海獭头像 v2：48×48 高清像素重制与头像框放大
doc_type: feature

# 记忆索引
summary: |
  海獭头像 v2：像素密度 25×25 → 48×48 重画全部 11 款，新增海獭物种辨识铁律（胡须/宽扁口鼻/低位圆耳）、
  主题元素包覆式大构图（占比 ≥1/3）、移除水波纹；大獭主题从墨锭+袖笔+折扇改为乌纱官帽+捧官印
  （搭档 9/14 拍板）。生成管线沉淀为脚本（画獭-像素 glm-flash 手写 SVG + 大獭独立校验），
  替换 GLM-Image 图像 API 路线（风格不一致、成本高）。头像框 32→36px 对标微信观感。

# 因果链路
causal_links:
  from: [F20260826avtr]

# 元数据
change_type: feature
capability_test: "n/a: 纯静态资产替换 + 组件尺寸参数，无 LLM 行为；逻辑验证走 web 单测（vitest）"
created_in_conversation: 55e5468a-d204-4b80-a253-60c4708def4f
tags: [avatar, web-ui, pixel-art, otter-identity, pixel-hd]
modules: [web/public/avatars/, web/src/components/OtterAvatar.tsx, web/src/pages/conversation/MessageList.tsx, web/src/pages/conversation/RightPanel.tsx]
created_at: 2026-09-14
---

# 海獭头像 v2：48×48 高清像素重制 + 头像框放大

## 背景

搭档 9/14 反馈旧版头像（F20260826avtr，25×25 网格）"像素比较低，不太好看"。当天先试 GLM-Image 图像生成路线（Q 版贴纸风批量 6 款 + 前期风格探索 13 张），被搭档否决：**风格不一致、AI 感重、单张成本高**（免费额度 19 张耗尽，续作需充值）。

转向路线：**LLM 手写像素 SVG**——SVG 本质是代码，风格一致性靠设计规范硬约束，零 API 成本（画獭-像素，glm-flash，走 Coding Plan 额度）。

## 方案设计

### 设计规范 v2.4（设计师生成-评审迭代产物，大獭执笔）

- **网格**：viewBox 192、逻辑 48×48（每格 4px），shape-rendering="crispEdges"
- **调色板**：白名单 19 色（§2 基础 7 色 + §4 各款主题色），校验脚本零出列
- **海獭物种辨识铁律**（v2.1，一票否决）：胡须每侧 3 根深墨辐射、口鼻宽 ≥2/3 脸宽、宽扁鼻头、低位小圆耳（区别于熊/猫/海豹）；自检题"遮住主题元素还是海獭吗"
- **小尺寸可辨性**（v2.2）：主题元素 36px 下必须一眼认出，细长/多部件（折扇毛笔）弃用，大色块简单轮廓（官印/葫芦/月牙）优先
- **包覆式大构图**（v2.3）：主题元素占画面 ≥1/3（格数+描边 footprint 口径），允许溢出头部轮廓（月牙抱头/荷叶盖顶）
- **水波纹移除**（v2.4，搭档拍板）：下沿干净收边，背景纯米纸色

### 款式主题（11 款）

| 款 | 主题 | 变更说明 |
|---|---|---|
| 大獭 datu | 乌纱官帽（圆顶+帽翅抵两缘）+ 双爪捧大红印 | **主题更换**：旧款墨锭+袖笔+折扇 → 搭档反馈"帽子用官帽好看、折扇毛笔看不出是啥" |
| 用户 user | 金皇冠（三珠圆润）+ 派单卷轴 | 沿用主题重画 |
| 九款小獭 | 獭祭鱼/竹笠/朱结/眠月/抱贝/衔竹/墨痕/莲叶/葫芦 | 意象全部沿用，按新规范重画（元素做大、包覆式构图） |

### 生成管线（可复用资产）

- `workspace/pixel-set/`：design-spec.md（规范真相源）、gen_batch.py + otterlib.py（网格→SVG 生成器）、preview.py（PNG 光栅，曾有 36px 渲染顺序 bug 已修）、validate.py（合规校验）
- 工作流：大獭出规范 → 画獭-像素（glm-flash）按规范手写 → 大獭独立校验（XML/调色板/坐标/体积）→ glm-4.6v API 盲测物种辨识（辅助信号）→ 搭档过目定稿
- 迭代记录：v3（无胡须被评"看不出是海獭"）→ v4（+物种铁律，盲测海豹 75%）→ v5（官帽+官印，头缩小）→ v6（包覆式大构图，搭档过）→ 终版（去水波纹）

## 变更影响分析

**后端**：无。**前端**：
- web/public/avatars/*.svg ×11 全量替换（同名顶替，前端零逻辑改动；文件 6.0-11.7KB，均 <15KB）
- OtterAvatar.tsx 默认 size 32→36（消息流头像）
- MessageList.tsx 用户头像 w-8 h-8 → w-9 h-9
- RightPanel.tsx 参与者列表 28→32

**兼容性**：otter-avatars.ts 的分配逻辑（大獭固定/用户固定/hash 池/localStorage override）完全不动。

## 取舍

- **SVG 直上 vs PNG**：SVG 矢量在 Retina（2x/3x）下锐利渲染，无需多分辨率资产；36px 布局尺寸下矢量渲染远优于位图缩放
- **獭祭鱼鱼身色**：浅青与獭头蓝灰同系、对比度最低（搭档已过目接受）；备选方案（反白）留档
- **GLM-Image 路线废弃**：风格一致性无法保证（6 张三种画风）、成本高；教训入记忆

## 验证

- validate.py（画獭）：xmllint 11/11、调色板零出列、坐标 4 倍数、零重叠、行合并完备
- 大獭独立复验：ElementTree 解析 + 调色板白名单 + 体积 + 波纹残留扫描，ALL PASS
- 搭档终审：montage.png 全家福过目拍板（16:36 "ok就这样"）
