---
id: F20261028sqldb
title: "sqlite3 CLI 数据库参数写落点判定（#1490）"
summary: "sqlite3 的 FILENAME 可能创建/写入数据库；现纳入既有写落点求值器，显式只读、内存库放行，动态文件槽 fail-closed。"
change_type: fix
capability_test: "n/a: A 类静态命令求值与生产守卫行为，无 prompt/LLM 行为触发语义改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-28T14:28:00+08:00
causal_links:
  from: [F20261015smrj]
---

# 预注册

- 预期：最新 main 对主仓内 `sqlite3 ... "CREATE TABLE..."` 正面 ALLOW。
- 修复面：sqlite3 数据库参数槽，按文件可能创建/写入披露；显式只读与内存库不误伤。
- 反例：生产链已 BLOCK 则只补证据，不硬造修复。
- 非目标：不扩展 node/python 外置脚本判读，不泛化未实证的数据库 CLI。

# 问题与根因

`sqlite3 [OPTIONS] [FILENAME [SQL...]]` 的 FILENAME 是数据库文件，不只是 SQL 文本的附属参数。main 的 `evalExtendedWriteTargets` 无 sqlite3 通道，CREATE/INSERT/无 SQL 均 evaluated 空落点，生产守卫 ALLOW。

真实行为探针：普通 `SELECT` 也会创建不存在的库文件；`-readonly` 对不存在文件报错而不创建。因此不能靠 SQL 动词猜只读，安全基线按数据库参数可能写处理。

# 方案与取舍

- 复用既有 `evalExtendedWriteTargets` → `evalPath` → 主仓落点链；不新增规则、状态、配置或第二套判定。
- `-readonly`、URI 最后一个 `mode=ro`、`:memory:` / `file::memory:` / `mode=memory` 无文件写。
- URI 最后一个 mode 决定读写，防 `mode=ro&mode=rw` 洗白。
- 数据库参数动态/未知、未知选项值、非法 URI 编码 → `argv-write-uncovered`，不进入词面证豁免。
- SQL 参数不是路径：$CID/$i 等运行时插值不误报数据库未知；数据库参数复用既有 resolveTargetArgWord 同命令赋值溯源。
- `-hexkey`、双值 `-pagecache` / `-lookaside` 按 sqlite3 help 对齐；未收录旗标不猜值槽。
- `:memory:` / 只读主库载荷含 ATTACH（DATABASE 可选）或任一行首 dot 命令 → fail-closed；不枚举会漏词的 dot 黑名单，实测 .backup/.system/.log/.clone 等可创建其他文件。
- SQLite URI path 先百分号解码再判落点，防字面树外、真实树内错位。
- 树外数据库仍披露写事实，但不命中主仓。
- 历史只读回归两条收紧为显式 `-readonly` / `mode=ro`：这是有真实行为依据的测试修正，不删除原查询覆盖；新增普通 SELECT 可能建库的负向钉。

机制检查：仅复用现有纯函数和参数求值通道；narrow-fix。

# 验证

修前生产探针：主仓 CREATE、INSERT、SELECT、无 SQL 全 ALLOW；只读/内存/树外也 ALLOW。新增求值器测试首跑 5 failed / 192 passed，复现缺失写落点和动态槽洗白。

初轮修后定向：`write-target-evaluator`、`bash-safety-guard`、`guard-v2-real-replay` 3 文件 850 passed / 6 skipped，但 CI 试金石失败，未请求终审。

独立 r1 后：补选项表、载荷负门、URI 解码与赋值溯源；试金石 4 条主仓普通 SELECT 重裁翻红，2 条 /tmp INSERT 保留 ALLOW 但纠正「无写」理由，1 个已闭合 cond 缺口移除（无新增缺口键）。定向 5 文件 **864 passed / 6 skipped**；全量 **7293 passed / 6 skipped**；`npx tsc --noEmit`、lint/build 通过。

| 场景 | 预期 |
|---|---|
| 主仓 CREATE/INSERT/普通 SELECT/无 SQL | 披露数据库写落点，生产 BLOCK |
| `-readonly` / URI `mode=ro` | 无写落点，ALLOW（SQLite 写语句自身报错） |
| 内存库 | 无文件写，ALLOW |
| 树外 CREATE | 披露树外写，主仓规则 ALLOW |
| 动态数据库参数 / 未知选项值 / 非法 URI 编码 | argv-write-uncovered，fail-closed |
| `:memory:` ATTACH、只读主库写 dot-command | argv-write-uncovered，不能豁免旁路写 |
| 同命令 H=~/db && sqlite3 $H | 家目录写正面求值，非主仓 ALLOW |
| 带值选项 / URI 百分号 | 不错位数据库槽 / 按解码后真实落点 |
| URI ro→rw | 按末位 rw 披露写 |

最简检查：单命令语义辅助函数 + 既有求值通道，无新依赖/IO/机制面；已过最简检查。

# 独立审视处置

首轮 3 严重、2 建议全部采纳：试金石重裁与 CI 缺口配套；选项槽完整化与未知旗标回落；主库豁免不遮 ATTACH/写 dot-command；URI 百分号解码；移除重复用例。新增树外写真值与 SQL 插值不误报用例。Delta 残留补 ATTACH 无 DATABASE 后，改为 dot 行首整族不可证，覆盖 .log/.clone/.trace 与未来命令。最新定向 872 passed/6 skipped，全量 7301 passed/6 skipped。

# 影响与负向验收

普通 sqlite3 查询主仓数据库需显式 `-readonly` 或 `file:...?mode=ro`，避免无意建库。未改变主仓外写、内存库或显式只读连接。无 DB schema/生产副本启动、无 UI/prompt 变更，Golden Gate 不适用。
