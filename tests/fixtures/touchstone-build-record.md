# 试金石语料库 · 构建记录（guard-touchstone 双库）

- 任务：一步到位方案 `bash-guard-one-shot-plan.md` v3 §四 的工程化第一步（派工单·守卫修复獭 2026-10-12 17:15）
- 交付：`guard-touchstone-allow.json` + `guard-touchstone-block.json` + `touchstone-recheck-diff.md` + `touchstone-exclusions.md` + 本记录
- 裁决标准：**v3 §3.2.1 证明演算三条规则**（检视獭点名：不得把方案修订前的矛盾烧进语料）
- 性质：纯数据交付，不改生产代码。**双库未冻结入库**——差异清单 76 条须大獭+检视獭双签、重大语义分歧呈搭档拍板后才进 git（契约：进库冻结，追加须双签）

---

## 一、规模数字

### 1.1 来源全集（反查契约执行结果）

| 来源 | 原始量 | 反查/提取 | 归一去重贡献 |
|---|---|---|---|
| ① guard_intercept 结构化事件全量 | 1533 条（framework 规则命中 1010 / orchestrator bounce 复述 522） | 反查成功 904（exact 链不通，走 commandHead 前缀+时间窗模糊反查；旧 schema 539 条经 description「命令前缀」补召回） | 880 unique |
| ② 台账 67 条人工裁决（10-09） | 67（ALLOW 49 / BLOCK 14 / SKIP 4） | 全量入流；42 条 commandHead 120 字符截断经 invoke_events 恢复全文，8 条恢复失败→剔除 | 67 |
| ③ 影子观察 21 条（guard-observed-rulings） | 21（residual-block 18 / rescue-terminal 3） | 全量入流 | 21 |
| ④ 各轮 PR 真实语料段（replay-928） | 5 | 全量入流 | 5 |
| ⑤ 合成逃逸探针（synthetic） | 68 | 全量入流 | 68 |
| **合计（去重后 unique）** | | | **1006** |

- 去重口径：归一化命令精确去重（主仓根→`/repo`、worktree 名→`wt`、workspace uuid→`wsid`、外仓→`/ext/*`），同一命令多事件命中保留最早锚点；跨对话样本照收（56 条命令命中 ≥2 事件，已并）
- 多事件重复合并：56 条；事件级 → 命令级压缩：904 反查成功事件 → 880 unique（guard_intercept 侧）

### 1.2 五路分流（1006 守恒：727+107+76+56+40）

| 去向 | 条数 | 说明 |
|---|---|---|
| **放行试金石**（guard-touchstone-allow.json） | **727** | 真实数据误拦存量 → 必须 100% 终局正面 ALLOW |
| **拦截试金石**（guard-touchstone-block.json） | **107** | 其中 synthetic_probe 逃逸探针 / shadow_case / real_command 真实主仓写 / **residual_face 7 条**（§3.3-① 如实钉） |
| **复裁差异清单**（待双签） | **76** | git push/pull 语义分歧 40 + git add 索引写归类 28 + 台账复裁差异 8 |
| **剔除清单** | **56** | O-2 依赖悬置 47 + SKIP 4 + 截断反查不到 2+ + 其他（详见剔除清单文档） |
| 附录（非写维度，不入分母） | 40 | kill/sleep 族纯进程操作命令，写判定域=证明无写但非误拦存量（防分母注水） |

### 1.3 交叉校验（防「把误拦钉成规范」）

- healing 台账【误报】定性 75 事件（今日 26 条族 + 历史散落）与裁决逐条交叉：**冲突 9 条 → 逐条审读全部翻 ALLOW**（草稿器 bug 所致，见 §三），终态冲突 0
- 影子 residual-block 18 条修复面：**17 条终局翻 ALLOW**（#1438 修复面收编的语料实证），1 条（new Function 游戏脚本评测）归残余面
- 原台账 SKIP 4 条维持剔除身份；CI 断言口径（双库 SKIP=0）随入库一并固化

---

## 二、方法论（裁决怎么出来的）

1. **反查**：healing_events → commandHead/description 前缀 → invoke_events(assistant_toolcall).arguments.command 全文（时间窗 ±30min + 前缀匹配）；截断条目经 ledger-pending 原始前缀二次恢复
2. **草稿裁决器**：按 §3.2.1 三条规则程序化出 verdict 草稿 + 规则引证（exec 类扫描 / 写证据落点收集 / 只读正向证明 / 隐式写词面 / 段级 cwd / heredoc 数据体剥离 / `$()` 递归）
3. **獭审**：簇级复核 + 高风险集逐条审读（交叉冲突 9 + 未知形态 53 + 抽检双池各 12）+ override 表留痕（每条 override 带依据）
4. **诚实边界**：程序化部分只出草稿，最终 verdict 以獭审为准；裁决器 15 个 bug 在审读中发现并修复（见 §三），未修的不入库

## 三、裁决期发现并修复的判据 bug（15 项，血泪记档）

| # | bug | 影响 | 修法 |
|---|---|---|---|
| 1 | `=>` 箭头函数被当重定向 | node/python 纯计算误判写 | REDIR lookbehind 排除 `=` |
| 2 | `json.dumps` 误配 `json.dump` | 只读序列化误判写 | 词界断言 |
| 3 | perl -pi 的 `-e` 脚本被当写路径 | 写目标解析错 | 取段内最后路径参数 |
| 4 | 赋值溯源缺失（`p='x'` + `open(p)`） | 载荷写路径解析失败→误不可证 | 简单赋值溯源表 |
| 5 | `git -C <path> <op>` 形态漏判 | 隐式写漏收集 | GIT_C 正则 + cwd 等价 cd |
| 6 | `open()` 不看模式（缺省=只读） | 只读 open 误判写 | 模式参数判定（w/a/x/r+ 才计写） |
| 7 | 词首正则尾部 `\b` 吞掉 `node -e`/`python3 -c` | 纯计算大量落「未识别」 | 备选自带边界 |
| 8 | 树外 cwd（/tmp 等）相对路径误判主仓 | /tmp 写误拦 | cwd 位置判相对路径归属 |
| 9 | 漏 `/repo/.otter/workforms` 运行时区 | workforms 写误判主仓 | 对齐 OTTER_RUNTIME_REGIONS 三区 |
| 10 | 首词判定只看整条开头（cd 前缀吞掉） | cd 前缀纯计算误不可证 | 逐段扫描 |
| 11 | env 赋值前缀形态（`F=x; python3 ...`）不识别 | 误不可证 | 首词正则剥赋值前缀 |
| 12 | cp/mv 写目标取首参数（应取末参数） | `cp db /tmp/x` 被冤拦 | 写命令族参数语义分流 |
| 13 | 裸词路径（`cp a b`）不算路径字面量 | known-gap 修复面样本被冤拦 | 裸词计入 |
| 14 | 精确 `/repo` 路径没算树内 | 主仓 git reset 漏拦 | `p == "/repo"` 归树内 |
| 15 | glob（`claim-*.md`）不算路径字面量 | 工作区清理被冤拦 | glob 形态计入（override 承接） |

## 四、残余面与边界（不许隐入声称）

- **残余面 §3.3-①（7 条，residual_face 如实钉）**：game/kelp 脚本评测 `new Function(...)`（构造可调用）、worktree 正道 `execSync` 工具链——真实误拦但规则 2 fail-closed 仍拦。**不是逃逸**：钉 BLOCK 是防未来放宽被误当修复面（沿 guard-observed-rulings residual-block 惯例）；能力演进放行须重新裁决
- **cwd 口径边界**：无 cd 形态按「主仓根」约定裁决（corpus harness 口径，与 #1433 shadow 一致）。会话态真实 cwd 不可事后反查的条目带 `cwd 口径注记`（TS-cb4cc057 / TS-dd48cc62 等）；有 healing 误报定性佐证的（病灶 B perl 族）按 worktree 会话态裁 ALLOW 并注记——**v2 实现须以运行时真实 cwd 判定**（方案能力 5 的段级 cwd 是命令内推断，真实 cwd 是运行时事实，两层都要）
- **O-2 悬置（47 条剔除）**：script_file_exec 写维度依赖「读脚本文件内容判定」的拍板。攻击脚本（attack-rename-channel）双路皆 BLOCK 已入拦截池；运维脚本族（otter-buddy.sh / alpha.sh / service.sh 等）悬置待拍板——O-2 纳入后按内容复裁归池
- **引号语境**：探针/issue 正文里以字符串数据存在的写形态（`REDIRECT_PATTERN` 探针、gh issue body 引用样例）按调用点语义不构成写证据 → ALLOW；**v2 窄提取必须引号语境感知**，这些条目就是它的测试压力（放行池内含）

## 五、验证

- 守恒：727+107+76+56+40 = 1006 ✓（unique 全量去向可数）
- 误报定性交叉：终态冲突 0（9 条审读后全部归位）
- SKIP 防稀释：双库 verdict 二值、SKIP 0；SKIP 4 原生条目在剔除清单 D 节
- 抽检：双池各 12 条随机抽检 + 全部「不可证」类 15 条逐条审读（审出 bug #12/#13/#15 与引号语境类）

## 六、下一步（本步之后）

1. **双签**：复裁差异清单 76 条交大獭+检视獭双签；git push/add 语义分歧呈搭档拍板（O-1 同场）
2. 双签毕 → 双库进 `tests/fixtures/` 冻结（进库冻结契约生效）+ CI 断言（SKIP=0、verdict 二值、双库全量跑）
3. O-2 拍板后：47 条悬置脚本族复裁归池
4. 之后按方案 §七 开发顺序进入能力补全 1→6（每步全量试金石复跑）

## 七、产物索引

- `guard-touchstone-allow.json`（727 条，tests/fixtures 就绪格式）
- `guard-touchstone-block.json`（107 条，含 kind 四分类）
- `touchstone-recheck-diff.md`（76 条差异 + 复裁统计，双签件）
- `touchstone-exclusions.md`（56 条剔除 + 残余面 7 条立册）
- 构建脚本与中间产物：`extract-touchstone-{raw,a2,b,c1,c2,c3,c4,e,h}.py`、`touchstone-raw-a*.json`、`touchstone-samples-*.json`、`touchstone-recover-d*.json`、`touchstone-final-f.json`（全部工作区留档可复跑）
