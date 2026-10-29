---
id: F20261029stdin
title: "sqlite3 stdin/heredoc 投递载荷判读收口（#1686）"
summary: "argv 通道外的 stdin 载荷（管道/heredoc/here-string/输入重定向）收进 sqlite3 既有 dot/ATTACH 同一判读；不透明馈体 fail-closed，静态良性不误伤。"
change_type: fix
capability_test: "n/a: A 类静态命令求值与生产守卫行为，无 prompt/LLM 行为触发语义改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-29T12:20:00+08:00
causal_links:
  from: [F20261028sqldb, F20261028runfa]
---

# 预注册

- 预期：最新 main 对 `echo '.system touch /tmp/pwn' | sqlite3 :memory:` 正面 ALLOW（检视獭 28 向量矩阵实测，issue #1686 现场）。
- 修复面：sqlite3 载荷判读的 **stdin 通道**（管道馈体 / heredoc 体 / here-string / 输入重定向），与 argv 通道（F20261028sqldb 已收）同一 dot/ATTACH 判读。
- 反例：生产链已 BLOCK 则只补证据，不硬造修复。
- 非目标：不动其它 CLI/解释器的 feed 判读（interpreterStdinFeedContent 族语义不变）；不收编 cat+heredoc 管道馈体内容（#1308 契约）；不做运行时文件读取（fsContentPlan 语义不外溢）。

# 问题与根因

- 现象：`echo '.system …' | sqlite3 :memory:` 经求值器判 ALLOW——SQL 载荷经 stdin/heredoc 投递时，argv 通道的 dot/ATTACH 拦截不生效（issue #1686，锚点：PR #1684 review #5 检视獭第四轮复核「诚实记录」节，r3 起连续两轮提出）。
- 根因：`sqliteDatabaseTarget` 的 `payloads` 只收 argv（-cmd 值 + 尾部 SQL 参数），stdin 载荷从不入列；`echo … | sqlite3 :memory:` 的 sqlite3 段只见 `:memory:` → readOnly → 无写目标 → 放行。属**预存洞**（argv 修复使其相对更显眼），攻击者换通道即绕过 #1684 的收口。
- 放大面：dot 命令是 CLI 控制面（.system/.output/.open/.clone…整族），与主库落点正交——即便主库 `:memory:`/`-readonly`，stdin 载荷里的行首点命令仍可写任意文件/执行 shell；ATTACH 语句可外挂写库文件。

# 方案与取舍

**机制判定（issue 驱动前置检查）：无新机制，narrow-fix**——不动配置面/存储面/生命周期/新模块，全部落在既有 `sqliteDatabaseTarget` 载荷判读语义内（`sqliteStdinFeed` 提取器复用 `segmentStdoutContent` 同基座）。

1. **stdin 载荷收编**（`sqliteStdinFeed`）：
   - 管道馈体：`echo/printf` 静态重建（`segmentStdoutContent`，与 `interpreterStdinFeedContent` 同收窄）→ 入 `payloads` 同判；
   - 自身 heredoc 体：引号定界=绝对数据入列；裸定界符含插值（未转义 `$`/反引号）→ 不可证（插值可运行时伪造行首点/换行）；
   - here-string（`<<<`）：字面值入列，动态值 → 不可证；
   - 输入重定向 `<` / `<>`：文件内容静态不可知 → 不可证（`/dev/null` 除外=空输入）。
2. **同一判读接口**：入列内容与 argv SQL 共用既有 ATTACH 正则 + 行首点正则（一条语义一个接口，不复制判据）。
3. **fail-closed 出口**：不可证馈体 → `{target:null, readOnly:false}` → `argv-write-uncovered`（UNPROVABLE_TEETH，能力 4 词面证不可洗白）；主库只读/内存不豁免。
4. 双层防裸定界符插值：模型层「heredoc 裸定界符体按危险通道递归」先拾走含插值体（`script-path-dynamic`，同在 UNPROVABLE_TEETH），求值器 opaque 判定兜底——两层同在 fail-closed 面。

**取舍**：
- `< file` 输入重定向整体 fail-closed：覆盖完整（否则换 `<` 即绕过）但误伤 `sqlite3 db < query.sql` 类良性流；正道=SQL 入 argv（`sqlite3 db "SELECT …"`）或 heredoc 直供（静态体照常放行）。选覆盖（宁可误拦微增不可漏放，与 interpreterFeedReadOnlyFlag 同哲学）。
- cat+heredoc 管道馈体不收内容（即便体是字面量）：与 #1308 契约（F20260109cphr）一致——管道馈体载荷不入求值、fail-closed 保守面，不为 sqlite3 单开例外（一条语义一个接口）。
- 裸定界符 heredoc 含 `\$` 转义不误判为插值（转义后是字面量，静态可判）。

# 验证

- **失败用例证据（before-fix）**：新增 12 个 stdin 用例在未修实现上全部红（`Tests 12 failed | 234 passed`）——缺口真实可复现。
- **after-fix**：`write-target-evaluator.test.ts` + `bash-safety-guard.test.ts` 全绿（`Tests 834 passed`），含 10 个 fail-closed 用例（echo dot/printf dot/echo ATTACH/cat 不透明/echo 动态/heredoc 引号 dot/here-string ATTACH/here-string 动态/`<` 重定向/`<>` 读写重定向）+ 5 个放行用例（echo/printf SELECT、heredoc 引号/裸定界符静态、here-string 静态）+ 披露保持（树外库写照常入账）+ argv 回归钉。
- **试金石 judge 考试**：guard-touchstone-exam/corpus 全绿（9/9），题库零翻转（corpus 无 sqlite3 stdin 条目）。
- **全量扫描**：`--pool=threads` 全套 `77 failed | 7156 passed | 99 skipped`——失败签名逐一核对为环境限制（105 处 `git init`/`.git` mkdir EPERM 落沙箱临时目录，与 #1688「嵌套沙箱禁 .git 创建」同族；模块缺失 2 处、kill EPERM 1 处），无一涉及本变更面；绑定证据为 CI 全套。
- typecheck（tsc --noEmit）零错误；eslint 三个改动文件零告警。
- 环境记录：vitest forks 池在本沙箱 kill EPERM（与 #1688 验证节同款 F-4 类已知限制），故本地全量用 `--pool=threads`；`git init` 类测试夹具在沙箱下必红属环境固有，非本变更引入。

# 独立审视处置

（待对抗审视后回填）

# 影响与负向验收

- 良性 stdin SQL 流保持放行：`echo 'SELECT 1' | sqlite3 :memory:`（及 printf/heredoc/here-string 静态形态）→ evaluated 空写目标。
- 树外数据库写照常披露：`echo 'SELECT 1' | sqlite3 /tmp/t.db` → `/tmp/t.db` 写目标入账（不隐去事实）。
- argv 通道既有行为回归钉不动（#1490 全部用例保持绿）。
- 负向面可控：fail-closed 新增面 =「不透明 stdin 馈体 + 输入重定向」，正道绕行明确（argv SQL / heredoc 直供静态体）。
