# Tool Description Standard（F20260811sktp Part B）

otter 工具 description 标准化规范。**纯开发者文档**——不进 SDK prompt 注入路径（工具 description 由 SDK 直接消费，本文件给维护者查阅 + lint 引用）。

## 5 元素（按需启用）

| 元素 | 强制 | 用途 |
|---|---|---|
| **What** | 必写 | 一句话能力描述 |
| **When** | 必写 | 触发场景，含中文关键词 |
| **Not for** | 推荐 | 边界，指向替代工具 |
| **Output** | 推荐 | 调用后返回什么 |
| **GOTCHA / TIP / BOUNDARY** | 至少一条 | 常见误用 / 推荐用法 / 边界声明 |

> **"至少一条"原则**：纯查询工具（如 `get_active_participants`）可能没有 GOTCHA，写 TIP 或 BOUNDARY 即可。不为凑 GOTCHA 而生造陷阱。

## inline label 模式

仿 clowder-ai `cat-cafe-skills/refs/mcp-tool-description-standard.md`：

| Label | 含义 | 例 |
|---|---|---|
| `GOTCHA:` | 常见误用 | "GOTCHA: 不要把 HTML 卡片写在 speak 之外的文本里——搭档看不到。" |
| `TIP:` | 推荐用法 | "TIP: 首次检索用 detail_level=summary 扫描，相关条目再 get_memory_detail 取全文。" |
| `BOUNDARY:` | 边界声明 | "BOUNDARY: workspace_* 只操作 sandbox，不影响项目代码。" |
| `WORKFLOW:` | 多步流程 | "WORKFLOW: search → get_memory_detail → 整合呈现。" |

## 长度预算

| 工具类型 | 建议长度（Unicode code points） |
|---|---|
| 简单查询（无副作用） | 50-200 |
| 常规工具 | 200-500 |
| 多步流程 / 多约束 | 500-800 |

**上限**：≤ 800 code points。lint warning 不阻断，但超长说明约束过多，应该：
- 把详细规则移到工具 execute 返回值（如 `get_html_card_contract`）
- 或留 SYSTEM.md 全局段
- description 只留指针："详见 get_html_card_contract 工具"

**下限**：无硬性下限。但 What + When 至少 30 code points。

## 错误返回约定（F20260811sktp B2）

错误返回必须使用 `errorResponse(text)`（不是 `textResponse("[错误] xxx")`）：

```typescript
import { errorResponse } from "./tool-helpers";

return errorResponse("[错误] 未知的模型别名「${alias}」。可用模型：${available}");
```

文案保留 `[错误]` 前缀（人类可读），同时 `errorResponse` 设 `isError: true`（机器可识别），通过 otter-hooks 的 `tool_result` handler 透传到 Anthropic API 的 `tool_result.is_error`。

**何时用 errorResponse**：所有错误返回（参数错、状态错、权限错、未找到）。
**何时不用**：成功路径的系统控制信号（如 speak 成功的"[系统控制信号] 发言已提交"——这不是错误）。

## GOTCHA 实例（otter 不可逆操作）

| 工具 | GOTCHA |
|---|---|
| `create_otter` | 创建即自动加入当前对话。在场已有同名参与者时拒绝创建（避免重名混乱）。 |
| `dissolve_otter` | **解散不可逆**——session 和上下文永久丢失。不能解散自己（会留下孤儿 session）。dissolve 后 participant 记录若未更新仅留警告（不阻断，otter 已销毁）。 |
| `restart_otter` | **前世 session 封存不可逆**——新世上下文为空，靠 summary 注入。小獭只能重启自己，大獭可重启任意 otter。 |
| `speak` | 卡片必须完整写在 body 参数内——写在 speak 之外文本里的卡片搭档看不到，系统会检测并拒绝。HTML 卡片规则详见 `get_html_card_contract` 工具。 |
| `create_linked_resource` | fact ≤ 500 字符；长内容（方案、设计文档）必须先 write 写文件再创 file 资源。 |

## 反例与正例

### 反例 1：流程细节塞 description

```
❌ description: "结束发言并指定下一位发言者。发言内容在 body 里。
   HTML 卡片规则：必须用 ```html-card 围栏，可携带表单/按钮，写交互卡片前必须调 get_html_card_contract...
   系统自愈标记：<healing>[issues] 块格式 type/severity/description/suggestion..."
   # 1500+ 字符塞三件事
```

**改写**：description 只留指针，详细规则移到工具或 SYSTEM.md：
```
✅ description: "结束发言并指定下一位发言者。发言内容全部放在 body 里...
   GOTCHA: 卡片必须完整写在 body 参数内（写在 speak 之外的卡片搭档看不到）——
   卡片规则详见 get_html_card_contract 工具。
   WORKFLOW: 调用成功后回合立即终止（terminate=true），系统调度下一位发言者。"
```

### 反例 2：无 When / GOTCHA

```
❌ description: "邀请指定 Otter 加入当前对话。"
```

**改写**：
```
✅ description: "邀请指定 Otter 加入当前对话.
   When: 需要拉入不在场的 Otter 加入协作时.
   Not for: 创建新 Otter → create_otter. 解散 → dissolve_otter.
   Output: 参与者加入成功的确认.
   GOTCHA: 被邀请的 Otter 必须已存在（用 create_otter 创建过），否则加入失败."
```

### 反例 3：纯查询硬凑 GOTCHA

```
❌ description: "...GOTCHA: 别在错误时机调用。"
   # 生造陷阱，无信息量
```

**改写**：用 TIP / BOUNDARY 代替：
```
✅ description: "获取当前对话所有活跃参与者.
   When: 需要知道场上有谁、可用什么名字传行动权.
   Output: otterId / otterName / status / joinedAtTurnNumber 列表.
   BOUNDARY: 只读，不修改状态. speak 的 talkingStonePassedTo 用 otterName;
   invite/dissolve 用 otterId."
```
