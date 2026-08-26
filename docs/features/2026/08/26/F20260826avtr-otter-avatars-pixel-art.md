---
id: F20260826avtr
title: otter-avatars-pixel-art
doc_type: feature

# 记忆索引
summary: |
  海獭头像系统：11 张像素风半身像 SVG（kimi 绘制，搭档验收定稿）接入 web UI。
  大獭固定 datu.svg，用户固定 user.svg，小獭按 otterId 确定性 hash（FNV-1a）落入九款随机池。
  改造 OtterAvatar 组件与 MessageList 内联头像为 img 渲染，保留颜色系统用于边框/名字色。

# 因果链路
causal_links:
  from: []

# 元数据
status: development
change_type: feature
capability_test: "n/a: 纯前端 UI 组件变更（头像渲染），无 LLM 参与行为；逻辑验证走 web 单测（vitest）"
tags: [avatar, web-ui, pixel-art, otter-identity]
modules: [web/src, web/public]

# 时间
created_at: 2026-08-26
created_in_conversation: c16c990b-cd3a-4516-9171-ec8268a8919e
---

# 海獭像素头像系统

## 背景

海獭团队与用户此前无头像：OtterAvatar 组件为首字母+渐变色圆形。搭档提出需求：
大獭固定 1 款、小獭 9 款（进场随机分配）、用户 1 款。经四轮风格迭代
（卡通→水墨 v1 熊感→v2 日式感→kimi 线条水墨→系统图标风→像素风），
搭档拍板**像素大配饰版**定稿。

## 方案设计

### 资产

11 张 SVG（25×25 网格、8px/格，单张 2.9–3.4KB）放入 `web/public/avatars/`：

| 文件 | 意象 | 分配 |
|------|------|------|
| datu.svg | 大额墨+袖笔+折扇 | 大獭固定 |
| user.svg | 大皇冠+派单卷轴 | 用户固定 |
| otter-01-yu.svg | 獭祭鱼（抱大鱼） | 随机池 |
| otter-02-zhuli.svg | 竹笠（巨斗笠罩头） | 随机池 |
| otter-03-zhujie.svg | 朱结（中国结带穗） | 随机池 |
| otter-04-mianyue.svg | 眠月（大月牙+闭眼） | 随机池 |
| otter-05-baobei.svg | 抱贝（大扇贝） | 随机池 |
| otter-06-xianzhu.svg | 衔竹（粗竹枝） | 随机池 |
| otter-07-mohen.svg | 墨痕（墨斑+粗墨笔） | 随机池 |
| otter-08-lianye.svg | 莲叶（大荷叶盖头） | 随机池 |
| otter-09-hulu.svg | 葫芦（红绳束腰葫芦） | 随机池 |

### 分配逻辑

`web/src/lib/otter-avatars.ts`：

- 大獭：优先 `otter.type === 'big'` 判断（生产 otterId 为 UUID，无法枚举硬编码；检视发现 2）；
  历史大獭 ID（o1/big-otter）仅在 type 不可得时兜底 → `/avatars/datu.svg` 固定
- 用户 → `/avatars/user.svg` 固定
- 小獭 → `fnv1a(otterId) % 9` 确定性 hash 落入九款池。
  确定性设计：同一 otterId 刷新不变（避免「换页换脸」），不同 ID 分布均匀
  （测试覆盖 500 ID 全 9 款命中且无单款超 40% 集中）

### UI 改造

- `OtterAvatar.tsx`：首字母渐变圆 → `<img src=avatar>` 圆形裁切 +
  2px 颜色系统边框（保留多獭色彩区分能力，← D-UI-1）；加载失败降级回
  首字母渐变圆（检视发现 3）；新增可选 `type` 参数透传大獭身份
- `MessageList.tsx` MessageItem：内联 img 改为复用 `OtterAvatar` 组件
  （检视发现 4，消除双路径），用户消息用 user.svg
- RightPanel / Modals / OtterProfileCard：调用点透传 `otter.type`

## 验证

- 单测 `otter-avatars.test.ts`：7 个用例（大獭固定/池匹配正则/确定性/覆盖性/分布均匀性/相邻打散/用户头像）全过
- `tsc --noEmit` 通过（改动文件经主仓环境验证，worktree 未装依赖）
- 11 张 SVG XML 校验通过

## 影响范围

- 右侧栏参与者列表、消息列表头像、獭资料卡、邀请弹窗
- 原「首字母+渐变」头像不再显示；颜色系统保留（边框/名字色/身份条）

## 取舍

- **确定性 hash vs 真随机**：选确定性——真随机每次刷新换脸，视觉身份不稳定；
  搭档原话「随机分配」的意图是「每只小獭随机归宿」，而非「每次刷新随机」。
  确定性 hash 同时保证：同 otterId 稳定、跨 ID 均匀、相邻 ID 打散。
- **保留颜色系统**：头像统一像素风后，边框/名字色仍按原颜色池区分多獭，
  双重编码（图像+颜色）提升密集消息流的识别效率。
