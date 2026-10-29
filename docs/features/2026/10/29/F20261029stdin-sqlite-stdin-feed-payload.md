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
   - 自身 heredoc 体：引号定界=绝对数据入列；裸定界符按 **bash 实义重建**（见下）后入列，含未转义展开 → 不可证；
   - here-string（`<<<`，含 fd 前缀形 `0<<<`）：字面值入列，动态值 → 不可证；
   - 输入重定向 `<` / `<>`（含 fd 前缀形 `0<`/`0<>`）：文件内容静态不可知 → 不可证（`/dev/null` 除外=空输入）。数字前缀归一后按 fd 分流：fd 0/缺省=stdin 语义；fd≠0 不馈 sqlite3 SQL 输入（stdin=fd 0），`2</dev/null` 等非 stdin 形态不误伤。
2. **同一判读接口**：入列内容与 argv SQL 共用既有 ATTACH 正则 + 行首点正则（一条语义一个接口，不复制判据）。
3. **fail-closed 出口**：不可证馈体 → `{target:null, readOnly:false}` → `argv-write-uncovered`（UNPROVABLE_TEETH，能力 4 词面证不可洗白）；主库只读/内存不豁免。
4. 双层防裸定界符插值：模型层「heredoc 裸定界符体按危险通道递归」先拾走含插值体（`script-path-dynamic`，同在 UNPROVABLE_TEETH），求值器 opaque 判定兜底——两层同在 fail-closed 面。
5. **裸 heredoc 静态化语义（r1 严重 3，bash 实义重建 `bashHeredocEffective`）**：反斜杠只在 `$`、反引号、`\`、换行四符前是引用符——`\$`→`$`、`` \` ``→`` ` ``、`\\`→`\`、反斜杠+换行=续行（一并删除、两物理行接一逻辑行）；其余 `\x` 反斜杠字面保留（bash 同款）。单趟扫描同时判「含未转义展开」：裸 `$`/反引号 = 运行时展开（值可伪造行首点/换行）→ 不可证 fail-closed；否则重建**有效输入文本**（sqlite3 实际收到的字节）供 dot/ATTACH 判读——不按原始体判读（原始体会把 bash 已接续掉的物理行当真实行首 =静态良性误拦）。bash/sqlite3 对照见「独立审视处置」附表。
6. **sqlite3 段首识别（r1 严重 2）**：与 feed/写面共享归一基座 `resolveExecHead`（跳赋值前缀/wrapper/分发器 + 版本名归一），argv 解析与 stdin 馈体提取共用同一 headIndex（`sqliteDatabaseTarget` 收 headIndex 参数）；名字比对按归一名 `sqlite` 反向认族（canonicalExecName 版本剥离会把 sqlite3 尾 3 当版本吃掉——覆盖 sqlite3/SQLITE3/sqlite3.40/路径形/busybox sqlite3 全形态）。

**取舍**：
- `< file` 输入重定向整体 fail-closed：覆盖完整（否则换 `<` 即绕过）但误伤 `sqlite3 db < query.sql` 类良性流；正道=SQL 入 argv（`sqlite3 db "SELECT …"`）或 heredoc 直供（静态体照常放行）。选覆盖（宁可误拦微增不可漏放，与 interpreterFeedReadOnlyFlag 同哲学）。
- cat+heredoc 管道馈体不收内容（即便体是字面量）：与 #1308 契约（F20260109cphr）一致——管道馈体载荷不入求值、fail-closed 保守面，不为 sqlite3 单开例外（一条语义一个接口）。
- 裸 heredoc 转义语义按 bash 实义重建（详见方案 5）；**`\\$y`（偶数反斜杠后 `$`）维持 fail-closed 的常量政策**：bash 对照实证 `$y` 是真展开（y 值运行时可注入换行/行首点），值不可静态重建 → 不可证，与 y 是否设置无关（r1 复审将其归「静态良性」不成立，依据见处置节）。

# 验证

- **失败用例证据（before-fix）**：新增 12 个 stdin 用例在未修实现上全部红（`Tests 12 failed | 234 passed`）——缺口真实可复现。
- **after-fix**：`write-target-evaluator.test.ts` + `bash-safety-guard.test.ts` 全绿（`Tests 834 passed`），含 10 个 fail-closed 用例（echo dot/printf dot/echo ATTACH/cat 不透明/echo 动态/heredoc 引号 dot/here-string ATTACH/here-string 动态/`<` 重定向/`<>` 读写重定向）+ 5 个放行用例（echo/printf SELECT、heredoc 引号/裸定界符静态、here-string 静态）+ 披露保持（树外库写照常入账）+ argv 回归钉。
- **试金石 judge 考试**：guard-touchstone-exam/corpus 全绿（9/9），题库零翻转（corpus 无 sqlite3 stdin 条目）。
- **全量扫描**：`--pool=threads` 全套 `77 failed | 7156 passed | 99 skipped`——失败签名逐一核对为环境限制（105 处 `git init`/`.git` mkdir EPERM 落沙箱临时目录，与 #1688「嵌套沙箱禁 .git 创建」同族；模块缺失 2 处、kill EPERM 1 处），无一涉及本变更面；绑定证据为 CI 全套。
- typecheck（tsc --noEmit）零错误；eslint 三个改动文件零告警。
- **r1 delta 后回归**：`write-target-evaluator.test.ts` + `bash-safety-guard.test.ts` `853 passed`（834 基线 + 19 个 r1 回归钉：fd/wrapper/续行攻击 9 例（求值器 reason + 生产 guard 非空双钉）、裸 heredoc 转义奇偶 2 例、续行良性 1 例、fd/wrapper 良性 6 例、wrapper 落点披露 1 例）。
- **bash 对照实证**（2026-10-29 本机，`bash -c $'…'` + cat heredoc 实测）：`x\\$y`（y 未设）→ 实收 `SELECT 'x\';`、y=INJECTED → 实收 `SELECT 'x\INJECTED';`（真展开注入面）；续行 `SELECT 'a\`+换行+`.system touch x'` → 实收 `SELECT 'a.system touch x'`（接行无行首点）；`x\\\$y`（三反斜杠）→ 实收 `SELECT 'x\$y';`（字面）；`\`+换行+`.system touch /tmp/pwn` → 实收 `.system touch /tmp/pwn`（真 dot 命令）。测试用例均以此表两侧（良性/恶意）建钉。
- 环境记录：vitest forks 池在本沙箱 kill EPERM（与 #1688 验证节同款 F-4 类已知限制），故本地全量用 `--pool=threads`；`git init` 类测试夹具在沙箱下必红属环境固有，非本变更引入。

# 独立审视处置

r1（检视獭-1686，kimi；报告 file 97b30b10）：3 严重——全部处置：

1. **严重 1（fd 前缀形态绕过）**：词法层双 fd 分支（scanOperator/scanWord）补形态完整识别——`<<<`（here-string 单 op）、`<<`/`<<-`（heredoc 走 scanHeredoc，不再拆成 `0<`+假 heredoc 馈体蒸发/拆段）；`sqliteRedirectFeed` 数字前缀归一后按 fd 分流（fd 0/缺省=stdin，fd≠0 不馈 stdin）。攻击侧（`0<<<"ATTACH…"`/`0<file`/`0<>file`/`0<<` heredoc dot）与良性侧（`0<<<'SELECT 1'`/`0<<'EOF'` 静态体）双向钉，求值器 reason + 生产 guard 非空双钉。
2. **严重 2（wrapper 识别域缺）**：sqlite3 段首识别换 `resolveExecHead` 归一基座，argv 解析与 stdin 馈体提取共用同一 headIndex（无 `words.slice(1)` 半修）；wrapper+管道/heredoc/here-string 生产链回归钉齐，`env sqlite3 /tmp/t.db` 落点披露恢复。
3. **严重 3（裸 heredoc 转义不等价 bash）**：改 bash 实义重建（方案 5），dot/ATTACH 判读跑在有效输入文本上；续行误拦消除、续行恶意面（接出真行首点）保持拦截。
   - **分类分歧（有据保留）**：复审将 `\\$y`（偶数反斜杠+`$y`）归「静态良性」——bash 对照实证不成立：y 未设实收 `SELECT 'x\';`、y=INJECTED 实收 `SELECT 'x\INJECTED';`，即 `$y` 是真展开注入面（y 含换行可伪造行首点），按复审自身取舍条款「无法精确重建的转义形态 opaque fail-closed」维持 fail-closed；奇数反斜杠（`\\\$y`）实收字面 `\$` 已修成不误拦。若复审坚持放行，请给出 y 值静态可证的依据再议。

# 影响与负向验收

- 良性 stdin SQL 流保持放行：`echo 'SELECT 1' | sqlite3 :memory:`（及 printf/heredoc/here-string 静态形态）→ evaluated 空写目标。
- 树外数据库写照常披露：`echo 'SELECT 1' | sqlite3 /tmp/t.db` → `/tmp/t.db` 写目标入账（不隐去事实）。
- argv 通道既有行为回归钉不动（#1490 全部用例保持绿）。
- 负向面可控：fail-closed 新增面 =「不透明 stdin 馈体 + 输入重定向」，正道绕行明确（argv SQL / heredoc 直供静态体）。
- **残余风险（已知边界，不在本 issue 面）**：①其余词表命令（curl/wget/dd/sed/perl/ruby/tar/unzip/rsync 等）的 wrapper 形态（`env curl -o` 等）仍裸 argv0 识别——本 PR 前既有边界，#1686 只收 sqlite3 面，如需收口另立 issue；②fd≠0 的 heredoc 体仍按 stdin 保守判读（`2<<EOF` 等怪形可能误拦，方向安全）；③基名非 `sqlite3`/归一名非 `sqlite` 的孤例形（如 `sqlite3beta`）未覆盖（与修前同域）。
