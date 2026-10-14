---
id: F20261014nirw
title: "node import()/require() 目标只读豁免：旧链 nodeBodyReadOnly 放行 + 求值器不披露为写落点（#1432）"
summary: "守卫误拦修复：node -e 纯只读模块加载探针（await import('./src/…') / require('./src/…')）在 session cwd=主仓时被 main_write 双链误拦（healing b4471a4f 旧链 + 026b37ee 求值器 shadow 同判，10-12 现场）。import/require 的纯字符串字面量目标是模块解析（固有只读，加载≠写落点）——双侧豁免：旧链 nodeBodyReadOnly 认 import 字面量目标 + Promise 链方法（then/catch/finally）；求值器披露循环跳过 import/require 目标字面量。动态拼接目标不豁免（目标不可静态判定）；危险模块词面禁、写词面、真写控制组负门全部不变。"
change_type: fix
capability_test: "tests/frameworks/agent/guard-v2-real-replay.test.ts「#1432 node import/require 只读豁免回放」（1432-A1/A2 双侧钉住 + A3 require 形态 + B1/B2/B3 负门 6 用例）；tests/frameworks/agent/write-target-evaluator.test.ts「#1432：node import/require 目标只读豁免」（放行侧 2 + 负门 2 + 伪路径回归钉子 1）"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
intent:
  problem: "node 只读 import 形态被判主仓写：`node -e \"const { scanStopWords } = await import('./src/usecases/signal/stop-word-scanner.ts').catch(e=>null)\"`（session cwd=主仓）被 main_write 拦截——import() 固有只读语义（模块解析不写目标），与 #1416（python open() 读模式误拦）同族不同形态。根因双侧：① 旧链 nodeBodyReadOnly 可调用名白名单不含 import、require 目标限定 fs/util/path——只读豁免不生效，预闸不跳过 main_write 保守判定；② 求值器相对路径字面量披露循环把 import/require 目标当写落点 push 进 targets（消费侧 mainHits 按主仓命中即拦）。实证：基线（98e3d3d5）裸命令+sessionCwd=主仓实测 A1/A3 均 BLOCK，修复后 ALLOW，B1/B2/B3 负门前后一致 BLOCK（stash 对照）。"
  expected_effect: "import('字面量')/require('字面量') 目标加载形态旧链放行（只读探针/取证日常可用）；求值器不再把模块解析目标披露为写落点（shadow EVAL_GAIN 噪声同源消除）。不变面：动态拼接目标（require('./a/'+p)）保持拦；import 掩护真写（writeFileSync 词面）保持拦；require('child_process') 危险模块保持拦；c062 负门（import 主仓绝对路径字面量 → 求值器回落旧链）不动。验证断言（issue #1432）：修复合入后 30 天内 healing_events 新增「commandHead 含 import( 或 require( 且 ruleId=main_write」误拦 = 0。"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/write-target-evaluator.ts
  - tests/frameworks/agent/guard-v2-real-replay.test.ts
  - tests/frameworks/agent/write-target-evaluator.test.ts
---

## 问题与根因

### 现象（10-12 晨 healing 双链现场）

`node -e "const { scanStopWords } = await import('./src/usecases/signal/stop-word-scanner.ts').catch(e=>null)"`（session cwd=主仓）被双链误拦：

- **b4471a4f**（guard_intercept main_write，2026-10-12T01:02:01Z）：旧链拦截
- **026b37ee**（shadow_eval same_block，同命令同秒）：求值器同判 BLOCK（targetPaths=`/Users/…/./src/usecases/signal/stop-word-scanner.ts`）

### 根因（双侧）

1. **旧链 nodeBodyReadOnly 白名单不含 import/require 目标加载**：require 目标限定 fs/util/path；bare 调用名白名单无 import——只读豁免不生效，oneLinerReadOnly 预闸不跳过 main_write 保守判定（写落点解析到主仓）。
2. **求值器披露循环把模块解析目标当写落点**：相对路径字面量披露（「不进门判定，只读路径绝不构成拦截依据」）实为消费侧 mainHits 的拦截面——import('X')/require('X') 的目标 X 固有只读，不该进 targets。

### 附带发现处置

healing ab74f9a2 的 targetPaths 伪路径 `[t.path,`（数组字面量片段）在当前 main（98e3d3d5）**已不可复现**（穷举 7 种候选形态均不出伪路径，提取逻辑在此前 PR 已演化）；原命令全文在事件存储处已截断。处置：write-target-evaluator.test.ts 加回归钉子（数组/对象字面量片段不得产生含 `[`/`,` 的 target），防复发，不空修。

## 修复设计

| # | 落点 | 改动 | 口径 |
|---|---|---|---|
| 1 | bash-safety-guard.ts nodeBodyReadOnly | import/require 目标表达式必须整体是纯字符串字面量（含拼接/变量/嵌套调用一律不豁免）；bare 白名单 +import；NODE_READONLY_METHODS +then/catch/finally | 纯字面量目标=模块解析（固有只读）；动态拼接目标不豁免 |
| 2 | write-target-evaluator.ts 披露循环 | isModuleLoadLiteralTarget：字面量处于 `import(`/`require(` 纯目标位置（前接词边界排除 foo.import(/foo.require( 方法调用，后随 `)` 才算纯目标）→ 不披露为 target | 动态拼接目标的字面量片段仍披露（保守面） |
| 3 | 回放用例 | guard-v2-real-replay.test.ts 1432-A1/A2（旧链+求值器双侧钉住）、A3、B1/B2/B3 负门 | 真实现场形态（裸命令 + sessionCwd=主仓） |

### 与 c062 负门的边界（不动）

求值器形态 B「主仓绝对路径字面量一律回落旧链（字面量防线不破）」保持原样：`import('/repo/x.js')` 仍回落（unevaluated），最终由旧链豁免放行——回落≠拦截，两口径自洽（write-target-evaluator.test.ts c062 用例不改）。

### touchstone 冻结语料取舍（供检视獭复核）

issue 方案 3 的「回放用例双侧钉住」落在 guard-v2-real-replay.test.ts（该文件即真实拦截数据回放回归，与 issue 语义同构）。**未追加** guard-touchstone-allow.json（763 条冻结语料）：追加须双签+呈报且动 meta 守恒（count/硬数字/double_sign），回归保护已由行为测试完整覆盖；若检视獭认为须进冻结语料，双签流程另行走。

## 验证

- **闭环对照（stash 前后实测）**：基线 A1 现象命令/A3 require 形态 BLOCK（复现现场）→ 修复后 ALLOW；B1 动态拼接/B2 真写掩护/B3 危险模块前后一致 BLOCK
- **求值器侧**：A1 形态 evaluated targets 空（基线含主仓路径）；c062 回落负门不动
- **全量回归**：tests/frameworks/agent/ 58 文件 1503 测试全绿；全量套件 5511 passed + 3 failed（tests/game/game-harness-tools.test.ts 3 例，stash 对照确认**基线既有失败**、与本改动无关）
