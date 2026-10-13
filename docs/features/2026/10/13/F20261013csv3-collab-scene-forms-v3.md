---
id: F20261013csv3
title: "协作现场形态落地 v3：第一性原理重构——折叠态增密 + unfurl 去网络赌博 + 供给纪律"
summary: "针对「重构后毫无优化感」的实证排查（unfurl 41% 静默失败、89% 发言纯文本、折叠态信息密度为零），从第一性原理重推三条设计原则：①任何形态的渲染不得依赖实时网络（数据先行，渲染是已备数据的纯函数）；②折叠态必须承载有效信息摘要；③形态供给从软约定升级为显式信号机制。单 PR 交付：ArtifactCard 增密、UnfurlCard 落库持久化+gh 结构化取数、简报卡分级展开默认、折叠态摘要行、工具调用显式信号开关。"
change_type: feature
intent:
  problem: "unfurl 41% 静默失败（渲染时实时抓取超时/无 og，退纯文本且无人察觉）、折叠态信息密度为零（HtmlCard 折叠只有标题、ArtifactCard 只有类型徽章）、形态供给靠软约定（L2 议题卡被埋折叠态、工具调用过程无显式信号）"
  expected_effect: "已抓取 URL 卡断网可渲染（读库）；同一条消息不再有两种渲染命运（三态显式：ok/pending 骨架/failed 卡）；PR 产物卡显示 diff stat+状态徽章；importance=high 简报卡默认展开；工具调用明细可通过开关批量投影查看"
  verify_by:
    type: behavior_check
capability_test: "tests/api/unfurl.test.ts"
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
causal_links:
  - "F20261008csfw"
  - "F20261008csf1"
  - "F20261009csp2"
  - "F20261009csf3"
tags: [web, collab-scene, forms, ux]
modules: [web/src/pages/conversation, src/interface-adapters/http/controllers, src/frameworks/db]
---

# 协作现场形态落地 v3

## 背景

搭档原话（意图锚）：

> 「之前系统做了重构，中间协作栏用很多种卡片。但这几天我实际体验，感觉毫无优化。你排查下现状是什么情况」（10/13 14:48）
> 「海獭根本都不用新版本的发言卡片，这才是核心。以及，是否是新版本的卡片并无法满足海獭的展示需求？现在基本都是文本消息，需要我看时也还是 文本嵌入html 这种老做法」（10/13 15:00）
> 「url卡片难道就是把一个 url链接转为 卡片 吗？ 那我认为这不对吧，这全靠网络好就展示、网络不好就还只是url？这个是你所谓的卡片吗？我感觉不太对」（10/13 15:01）
> 「当初是说各种产物卡片。那现在感觉 Url这种也基本就是混在文本消息中，这跟一开始你画的效果图也不一致呀」（10/13 15:01）
> 「你先出完整优化方案。都要从第一性原理出发来分析和设计。然后一次Pr中做好这些，向最终效果靠齐！」（10/13 15:13）

## 第一性原理推导

### 排查实证（数据先行，非推测）

| 事实 | 证据锚点 |
|---|---|
| unfurl 请求 41% 失败（133 次中 55 次 404） | data/logs/otter-buddy.log 逐条统计（10/13 实测） |
| 失败主因：服务器抓 github.com 直连超时（本机需代理，scutil --proxy 显示 127.0.0.1:7897，但服务进程 env 无代理变量——node dist/src/main.js 裸启动） | curl 实测 8s 超时；unfurl-controller.ts:58 fetch 无 proxy agent |
| 失败后静默降级为普通文本链接（看不出失败过） | UnfurlCard.tsx 失败分支渲染与未接特性前一致 |
| 89% 发言是纯文本（10/10 以来 627 条 speak 仅 70 条带 html-card） | DB 实测 entries 表 |
| 预设类采用率 55%（178 条带卡发言中 ~98 条用 wrap/section/kv） | DB 实测 body LIKE |
| ArtifactCard 折叠态只有「徽章+一行标题」，宪法承诺的「diff 统计/首段摘要/结论数字」无像素兑现 | ArtifactCard.tsx:7-11 注释自述数据源只有 title+URL+时间 |
| 效果图（10/8 双中心原型）里产物卡是展开的彩色卡片，与实现的折叠态观感差距即搭档体感来源 | 工作区效果图 vs 实现 |

### 三条设计原则（从「展示系统到底该保证什么」重推，非从现状补丁反推）

**P1：渲染不得依赖实时网络——「数据先行」原则。**
同一条消息不应有两种渲染命运。卡片形态是**数据的展示属性**，不是网络运气的函数。凡需要外部数据的形态（链接预览、PR 元数据），数据必须在登记/抓取时**落库持久化**，渲染是已备数据的纯函数。抓取失败是**登记时的显式状态**（卡片显示「预览不可用+原因」），不是渲染时的静默消失。推论：unfurl 当前「渲染时实时抓取+失败静默退文本」的架构在原则上不成立，必须翻转为「**发送时预抓取落库+渲染读库**」（首次渲染亦不触网；懒抓取仅为历史消息兜底补位，允许异步但结果必须落库复用）。

**P2：折叠态必须承载有效信息——「折叠压面积不压信息」原则。**
折叠的设计意图是控制时间线**面积占用**，不是清零信息密度。折叠态应显示该条目的核心摘要（类型+关键字段+一行内容），展开态显示全部。「折叠后只剩一行标题」等于折叠态信息量为零——所有卡混成一排灰条，用了卡和没用卡在扫读层面无差别，这正是「毫无优化感」的直接机制。效果图的信息层级（徽章/封面/diff stat/摘要段）要按「折叠态保骨架、展开态保全貌」重新分配。

**P3：形态供给是契约，不是祈祷——「供给纪律」原则。**
形态映射表（什么场景出什么形态）当前只存在于 prompt 软约定，89% 退化纯文本证明软约定不足以对抗退化。但纪律的手段**不是**机械拦截（高成本、易误伤、与「六形态平权+表达自由」冲突），而是**显式信号**：默认展开参数让简报/汇报类卡「需要被看时真的展开」，显式信号开关让系统/工具条目有自己的受控展示位——把「用户该看什么」从隐式运气变成显式选择。带卡率统计纳入观察（数据说话），暂不上拦截闸。

### 与被否路径的差异（先找反对）

检索历史未发现「折叠态增密/unfurl 持久化」的否决记录。宪法（F20261008csfw）确立「不点开就有信息增量」为链类目标——本方案是该目标的兑现而非背离；P1 实现时的「失败降级渲染普通链接」在当时是合理渐进，现在被实证为「静默失败掩盖特性存在感」，翻转时机成熟。

## 目标

T1: unfurl 去网络赌博——抓取结果落库持久化，渲染读库；GitHub 链接走 `gh` CLI 结构化取数（PR/issue 标题/状态/diff stat，零网页抓取）；**发送时预抓取**（发言含裸链 → send-entry 钩子异步抓取，渲染当下读库，不阻塞发送）
T2: ArtifactCard 增密——PR 卡展示 diff stat + 首行摘要；file/fact 卡展示内容摘要行
T3: 折叠态增密——普通卡折叠态显示「类型徽章+首行摘要」，不再只有 title
T4: 简报/汇报类卡默认展开——契约支持 importance 分级，议题汇报/决策简报/排查结论类默认展开，其余维持折叠
T5: 显式信号开关——时间线保留 invoke/system/yield 边界条目现状不动；新增「过程明细」开关，开启后把 SessionModal 的折叠工具明细搬到时间线以紧凑卡形式展示（默认关闭；entries 批量投影数据通路；开关组件内存态刷新即回默认）

## 非目标

- 不做机械带卡率拦截闸（高成本易误伤，违反 P3 的纪律手段选择；先以 T4/T5 显式信号观察带卡率变化）
- 不改 invoke_events 存储与 fold 逻辑（F20260914rtsp 已定型，T5 复用 fold 纯函数，仅新增读取投影与展示位）
- 不做产物链第二层视图（宪法预留项，不在本批）
- 不改卡片预设类库本身（预设已在用，问题不在样式）
- 不动右栏（个体运行态正交维度，9 月重构已完成）

## 方案设计

### T1: unfurl 落库 + gh 结构化取数

**数据模型**（migration.ts 追加幂等建表，与 otter_configs 同模式）：

```sql
CREATE TABLE IF NOT EXISTS unfurl_cache (
  url TEXT PRIMARY KEY,
  title TEXT, description TEXT, image TEXT, site_name TEXT, host TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'og',        -- 'og' | 'github-api' | 'failed'
  error TEXT,                                -- source='failed' 时的原因
  fetched_at TEXT NOT NULL   -- 应用层 ISO 8601 写入（不设 SQL DEFAULT，防混格式回归——R2）
)
```

**抓取流程**（unfurl-controller.ts 重构）：
1. **发送时预抓取**（S1 修正——兑现 P1「首次渲染不依赖实时网络」）：发言/消息提交时 send-entry 钩子异步扫描裸链 → 触发抓取落库（不阻塞发送），渲染当下读库已有数据
2. 渲染时查 cache → 命中（含 failed 记录，7 天内）直接返回——渲染不再触网
3. 未命中且钩子漏抓（历史消息/导入数据兜底）：懒抓取补位（允许异步），结果写 cache 后返回——**P1 的诚实表述：首次渲染允许异步，但结果必须落库复用，失败必须显式**
4. 抓取分路：GitHub 任意 URL（PR/issue/文件/仓库主页，S2 修正——不止 PR）走 `gh` CLI（`gh pr view`/`gh issue view`/`gh api` 结构化取数）；其余 URL 走现有 og 抓取
5. 结果（含失败）写 cache 后返回

**失败不再静默**：source='failed' 时前端渲染「链接卡（预览不可用：原因摘要）」紧凑样式，而非退回纯文本——失败也是显式状态（P1 原则）。

**消费方声明（⑥，S3 修正——读口有两个，影响范围表同步补读侧）**：unfurl_cache 读口一：UnfurlCard 经 GET /api/unfurl；**读口二：LinkedResource 列表接口读侧 join 投影**（T2 产物卡 diff stat 数据源）——前端不直读 DB，由后端在返回 linked_resources 时 join unfurl_cache 中对应记录。写口仅 unfurl-controller 抓取流程。

**fetched_at 时间格式（A2 采纳）**：统一应用层 ISO 8601 写入（与 send-entry.ts 惯例一致），不用 SQL `datetime('now')`（空格格式与 ISO 跨格式比较会产生字典序偏移）；7 天 failed 窗口比较同层进行。

**成功记录 TTL（A3 采纳）**：og 静态元数据（标题/截图）永久缓存可接受；**github-api 结构化记录（PR 状态/diff stat）单独 TTL 24h**——「显示 open 实已 merged」是信息负增量，随时间衰减。过期后重抓（stale-while-revalidate：先返回旧值同时后台刷新，**刷新结果下次渲染生效，不做实时推送**——R4 采纳，声明口径）。命中判定三分支：og 永久 / failed 7 天窗口 / github-api 24h-SWR。

**代理问题**：gh CLI 路径天然绕开（用户本机 gh 已配好网络，且服务进程内调 gh CLI 已有先例：tool-factory.ts:705 等——S 审查修正 1.4，架构上无阻碍）；og 抓取路径（非 GitHub 链接）在实现阶段验证进程网络出口，若主服务经 PM2/脚本启动带代理则自愈，否则在 og fetch 处支持 `OTTER_UNFURL_PROXY` 环境变量（dispatcher 用 Node 内置 fetch 的 dispatcher 参数，不新增 undici 直接依赖——R1 采纳）。**未决：主服务实际网络出口待实现阶段实测**。

### T2: ArtifactCard 增密（S3 修正——join 键与数据可得性）

- **PR 卡**：join 键为 **resource.url ↔ unfurl_cache.url**（非标题——LocalLinkedResource 有独立 url 字段 mappers.ts:180，title 是文字）。数据可得性：**登记 PR 产物时触发 unfurl 预抓取**（与 T1 共用钩子，登记侧补挂），历史产物/钩子漏抓的 fallback：渲染时 join 落空则显示「未抓取」态并触发一次懒抓取补位。展示「+additions −deletions」+ 状态徽章（open/merged/closed）
- **file/fact 卡**：展示 content 首行（≤80 字）摘要行——数据已在 linked_resources.content，纯渲染层工作

### T3: 折叠态摘要行

HtmlCard 折叠态 header 下增加一行摘要：从卡片 HTML 提取首个文本节点（strip tags 后 ≤60 字）+ title 已有。实现位置：MessageList.tsx 的 html-card 渲染分支 / HtmlCard.tsx 折叠态组件。**摘要提取过滤（A4 采纳）**：跳过 script/style/textarea 子树，纯标点/空白结果视同为空——**防退化**：摘要提取失败/为空时保持现状（只有 title），不为摘要而摘要。

### T4: importance 分级展开默认

- 契约扩展：html-card 围栏新增可选属性 `importance="high"`（缺省 normal）；**解析归属 `html-card.ts` 的 `parseMetaAttr` 扩展（R2 采纳——非 remark-html-card-index.ts）**；解析失败/非法值按缺省 normal 处理（R3 采纳——降级路径显式声明）
- 渲染：importance=high 的普通卡**默认展开**（活类卡已默认展开，不变）
- **预算边界（A5 采纳）**：importance 不豁免 `CARD_MAX_PER_MESSAGE`（一条消息最多 2 卡）——预算优先，第 3 张 high 卡仍降级为源码块（与现行超限行为一致），契约写明
- prompt 侧（speak 工具描述 + 卡片契约 + SYSTEM.md 议题汇报段）：议题汇报卡/决策简报/排查结论三类**必须**带 importance="high"；其余卡禁止滥用（契约写明「high 是给搭档的注意力欠条，滥用=稀释」）
- **派工模板（R5 采纳）**：otter-summon skill 的派工 systemPrompt 模板加入「议题汇报/决策简报/排查结论卡需标 importance=high」默认指令——机制有效性依赖作者采用率
- 机械约束维持最小：不校验谁该用 high，只在每日体检带卡率统计中并列 high 卡占比（观察用）

### T5: 显式信号开关（S3/S4/S5 修正——数据通路+规模更正+状态语义统一）

- **现状事实（MessageList.tsx:767-805 核实）**：invoke_start/invoke_end/yield 居中条目与 system 消息**本就渲染在时间线上**——边界条目**保留现状不动**
- **数据通路（S4 修正——不是纯展示层）**：invoke_events 明细当前唯一通路是 GET /api/invokes/:id/events（仅 SessionModal 消费），时间线 DTO 不含 events。新增：**entries 批量投影**（GET entries 时带 `?includeEvents=true` query 开关，后端按 invoke 批量 join，避免前端 N+1——一页 50 条消息十几个 invoke，逐 invoke 请求不可接受）；**投影字段清单（R3 采纳——防 payload 撑爆响应）**：每条 event 仅投影 tool name / duration / status / error 摘要（≤200 字符截断），每 invoke 上限 20 条；`foldInvokeEvents` 纯函数直接复用，SessionModal 调用不动
- 新增「过程明细」开关（默认关）：开启后时间线 invoke 边界条目下展开紧凑工具明细折叠组
- **开关状态语义（S5 修正——设计与验收统一）**：组件内存态（非 localStorage——「localStorage 刷新重置」是技术性错误），**刷新即回默认关**；设计与验收口径一致为「刷新后状态不保持」（符合 R4 限制声明本意）
- 影响范围更正：T5 涉及**后端数据层**（entries 批量投影）+ 前端展示层，非纯前端开关

## 影响范围

| 模块 | 影响 |
|---|---|
| web MessageList/HtmlCard/ArtifactCard/UnfurlCard | 四个渲染组件改动（T2/T3/T4） |
| ChatView | 开关状态与过滤（T5） |
| unfurl-controller + migration.ts + 新 repository | 后端抓取翻转+建表（T1） |
| speak 工具描述/卡片契约工具/SYSTEM.md | prompt 文本（T4） |
| linked_resources 登记链路 | M | T2 登记侧补预抓取触发钩子（R1 修正——非零改动） |

## 风险与约束

- **unfurl_cache 无界增长**：单对话 URL 量小（实测 url 类产物全库 15 条，裸链渲染触发量级相当）；failed 记录 7 天重试窗口防永久黑化；**github-api 记录 24h TTL**（A3——PR 状态陈旧是信息负增量）；og 记录永久缓存。退役条件见四问④
- **gh CLI 不在 PATH 的环境**（部署到其他机器）：github-api 路径失败 → 落 failed 记录走显式失败卡，不阻塞 og 路径
- **gh 进程执行面**（mimo S2）：仅 execFile 参数数组禁 shell、路径段 encodeURIComponent、owner/repo 白名单字符集、输出上限 1MB——URL 来源完全用户可控，攻击面属本方案新增，必须设防
- **预抓取竞争**（mimo S1）：渲染快于落库是常态——pending 三态+骨架轮询覆盖，最坏 6s 超时落失败卡，不静默
- **importance=high 滥用稀释**：契约文字约束+体检观察，暂不机械拦截（与非目标一致）
- **T5 开关改变时间线密度认知**：默认关=现状，用户主动开才变化，无默认行为回归

## 不兼容更新

无。unfurl_cache 为新表；importance 属性缺省向后兼容；T5 默认关。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| unfurl 数据持久化位置 | 新表 unfurl_cache | 塞入 linked_resources.content / 内存 LRU | linked_resources 是产物登记不是渲染缓存，语义错位；内存缓存重启即失效，违反 P1「同一条消息不应有两种渲染命运」 |
| 抓取时机 | 发送时预抓取（全 body 落库路径共用钩子）为主 + 懒抓取兜底 | 纯懒抓取（渲染时触发） | 纯懒抓取使首次渲染仍依赖实时网络，与 P1 自相矛盾（审视 S1）；预抓取把网络等待挪出发言当下，渲染读库 |
| 首次渲染竞争 | API 三态（ok/failed/pending）+ 前端骨架轮询 | 二态 + 404→失败卡 | 预抓取未完成是常态（渲染毫秒级 vs 抓取秒级），「进行中」误报「失败」会制造新的不信任（mimo S1） |
| T5 数据通路 | entries 批量投影（query 开关） | 前端逐 invoke N+1 / SessionModal 复用 | 一页十几个 invoke，N+1 不可接受；DTO 不含 events，纯前端开关不成立（mimo S4） |
| PR diff stat 数据源 | 后端读侧 join unfurl_cache（github-api 记录）+ 登记侧触发预抓取 | 登记时写入 content | 数据单源；渲染是已备数据的函数（P1）；join 落空有「未抓取」fallback |
| GitHub 元数据获取 | gh CLI（全部 GitHub URL 类型：PR/issue/文件/仓库主页） | undici ProxyAgent 抓 og / Octokit / 仅 PR 走 gh | gh 自带认证+用户已配网络，且拿到的是结构化数据（远比 og 丰富）；进程级代理问题一并绕过；非 PR 链接若走 og 仍可能超时（审视 S2），统一走 gh 消灭该缺口 |
| 失败处理 | 显式失败卡（预览不可用+原因） | 退回纯文本链接（现状） | 静默失败=特性存在感归零（实证 41% 失败无人察觉）；显式失败让「网络/配置问题」可被发现和修复 |
| 供给纪律手段 | 显式信号（分级展开+开关）+观察 | 机械拦截闸（强制带卡率校验） | 拦截高成本易误伤，与表达自由冲突；显式信号把「该看什么」变显式选择，观察数据足够再上闸不迟 |
| 折叠态信息分配 | 折叠保骨架（徽章+摘要行），展开保全貌 | 默认展开（效果图原样）/ 维持纯 title | 默认全展开时间线面积失控（宪法「混排可扫读」前提）；纯 title 实证=零信息量 |

## 机制预算四问（机制识别检查点命中：新增持久化存储 unfurl_cache 表 + 新增 schema 字段 importance + 新增配置开关 T5）

① **谁需要它**：unfurl_cache——UnfurlCard 渲染链路（用户的时间线观感，实证 41% 失败率的受害者）；importance 属性——议题汇报/决策简报的读者（搭档），「需要我看时真的展开」的原话诉求；T5 开关——想追溯过程的用户（搭档排查问题时的显式信号诉求）。
② **失败后果**：unfurl_cache 写失败→降级现状（实时抓取），用户可感知但无新损害；importance 被滥用→high 卡稀释注意力，用户可感知（靠契约文字+观察兜底）；T5 开关状态错乱→展示过滤错误，刷新可恢复，无数据损害。
③ **后续机制**：unfurl_cache 可能出错的方向——脏数据（og 变更后陈旧，7 天 failed 窗口已覆盖 failed 类；成功记录的 og 变更属可接受陈旧，退役条件④覆盖）、表膨胀（量小已论证）；importance——滥用趋势若失控，退役/加闸路径在④；T5——纯前端状态，无新状态机。
④ **退役条件**：unfurl_cache——若未来 unfurl 改为「登记时抓取」架构（渲染零后端依赖），本表退化为登记字段可删；importance——若 high 卡占比 >50%（稀释实证）则回收为白名单制；T5 开关——若开启率趋零（体检埋点观察）则移除开关恢复单一时态。

## 验证

| 目标 | 验收 |
|---|---|
| T1 | 断网环境下重开对话，已抓取的 URL 卡正常显示；发送含裸链的发言（user 与 speak 均覆盖）后，URL 卡 ≤6s 内显示（预抓取落库+pending 轮询），**pending 期间显示加载骨架而非失败卡**；github PR 裸链 unfurl 显示标题+状态+diff stat；github 非 PR 链接（issue/文件/仓库）同样走 gh 路径出结构化卡；失败 URL 显示显式失败卡（非纯文本）；unfurl_cache 表有记录且重复请求不重复抓取；**恶意 URL（shell 元字符/flag 注入）不触发命令执行**（execFile 参数数组+白名单字符集） |
| T2 | PR 产物卡显示 diff stat；file/fact 卡显示摘要行 |
| T3 | 折叠态卡显示摘要行；无文本卡（纯样式卡）不显示空摘要行 |
| T4 | importance=high 卡默认展开；缺省卡维持折叠 |
| T5 | 开关开→过程明细折叠组显示（entries 批量投影，无 N+1）；关→现状；**刷新后回默认关（组件内存态，与设计声明一致）** |

测试设计：unfurl 缓存读写 repository 单测 + controller 集成测（mock gh/og，含 pending 三态与恶意 URL 注入用例）；UnfurlCard/ArtifactCard/HtmlCard 折叠态快照测；importance 解析（**html-card.ts parseMetaAttr**——A1 修正归属）单测；T5 filter 逻辑单测 + entries 批量投影集成测。alpha.sh 起隔离实例人工验证断网/代理场景。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/db/migration.ts | M | unfurl_cache 幂等建表 |
| src/frameworks/db/schema.ts | M | 表定义入 schema（新库直建） |
| src/frameworks/db/conversation/sqlite-unfurl-cache-repository.ts（新） | A | 缓存读写 |
| src/interface-adapters/http/controllers/unfurl-controller.ts | M | 查缓存→gh/og→写缓存流程翻转 + pending 三态（ok/failed/pending，mimo S1）+ execFile 安全边界（mimo S2）（fetch 锚点实为 212 行——R6 采纳） |
| src/interface-adapters/http/controllers/entry-controller.ts + entries usecase | M | entries 批量投影 includeEvents 开关（T5 数据通路——mimo S4，非纯前端） |
| src/interface-adapters/http/controllers/key-info-controller.ts + manage-key-info usecase | M | 读侧 join unfurl_cache 投影（T2 产物卡 diff stat 数据源——mimo S3 ⑥修正） |
| src/usecases/conversation/send-entry.ts | M | 发送时预抓取钩子：sendUserEntry 与 createSpeakEntry **共用扫描函数**（user/speak 裸链均覆盖——mimo S6 修正），body 落库后异步触发 |
| web/src/pages/conversation/UnfurlCard.tsx | M | 读缓存渲染+显式失败卡+pending 骨架轮询（mimo S1） |
| web/src/pages/conversation/ArtifactCard.tsx | M | diff stat/摘要行 |
| web/src/pages/conversation/HtmlCard.tsx | M | 折叠态摘要行+importance 展开 |
| web/src/lib/html-card.ts | M | parseMetaAttr 扩展 importance 属性（R2 采纳——解析归属更正） |
| .pi/skills/otter-summon/SKILL.md | M | 派工模板加 importance=high 默认指令（R5 采纳） |
| web/src/pages/conversation/ChatView.tsx / MessageList.tsx | M | T5 开关与过滤 |
| src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts | M | importance 契约文档 |
| SYSTEM.md（注入模板源） | M | 议题汇报段带 importance="high" 要求 |
| speak 工具描述 | M | 形态映射 TIP 补 importance 规则 |

## 实现偏差记录（实现阶段补）

1. **unfurl_cache DDL 补三列**（state TEXT / additions INTEGER / deletions INTEGER）：方案 DDL 与 T2 数据流存在张力——T2 要求 PR 卡 diff stat 来自 join 投影，但原 DDL 无结构化列可存。按数据流要求补列（schema.ts + migration.ts 同步），除此之外严格按方案 DDL。
2. **gh CLI 无 `--` 终止符语义**：方案写「`--` 终止符放在 gh 子命令位置参数之前」——gh CLI 实际不支持通用 `--` 终止符（会报 unknown flag）。改为：execFile 参数数组（无 shell）+ owner/repo 白名单 [a-zA-Z0-9._-] + number `^\d+$` 归一，gh 不会把位置参数解析成 flag。安全等效（参数数组本身无注入面），实现偏差记录于此。
3. **foldInvokeEvents 迁入 contract 层**（api-contract/api/invoke-event-fold.ts）：T5 后端批量投影与前端 SessionModal 需同源 fold 逻辑——web/src/lib/invoke-event-fold.ts 保留 re-export（既有导入路径不变）。
4. **预抓取钩子拆出文件**（send-entry-unfurl-scan.ts）：send-entry.ts 超 max-lines 阈值（450），scanBareUrls + triggerUnfurlPrefetch 拆出独立纯函数文件（便于单测是顺手收益）。
