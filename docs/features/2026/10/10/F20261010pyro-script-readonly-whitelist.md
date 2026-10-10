---
id: F20261010pyro
title: 脚本只读载荷白名单补位——python open 读写模式固化 + collections/statistics/math 只读面 + node stdin 流消费（closes #1416）
summary: 10-10 晨间六连拦（healing 90d8307f 等，00:25-00:50Z）根因修复。issue 描述的「open() 缺省模式被当写」经复现核实已在早期修复处理（pythonOpenModesReadOnly）；真根因是三处枚举白名单缺词——①keys.update 不在 PY_READONLY_METHODS ②Counter 不在 PY_READONLY_CALLS ③process.stdin 不在 node process 负向白名单且 on 不在 NODE_READONLY_METHODS。修复=词表补位（update/add/most_common/elements、Counter/defaultdict/OrderedDict/math 族、on、stdin）+ 9 例测试（放行 4 + 拦截负门 5，借壳写形态全拦）。对齐搭档拍板的统一判定核方向（fact 17b1447f）：词表补位是旧链止血，判定核收编才是根治路径。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
status: implemented
modification_class: narrow-fix
intent:
  problem: "每日体检/日常取证的只读脚本载荷（json.load(open()) 解析、Counter 统计、stdin 流消费）被 main_write 误拦六连——枚举白名单追不上真实命令形态"
  expected_effect: "三类只读形态放行 + 写语义负门全拦（open('w')/writeFileSync 借壳/eval/exec 借壳）——误拦消除零漏拦代价"
  verify_by:
    type: behavior_check
capability_test: "tests/frameworks/agent/bash-safety-guard.test.ts"
change_type: feature
tags: [guard, false-positive, whitelist, script-payload]
causal_links:
  - F20261009gwte（写落点求值器方案 v2——统一判定核方向源头）
  - F20261010gshw（影子接线——本形态也是「真误拦候选」的预期高频来源）
  - issue #1416（本次修复对象）
---

# 脚本只读载荷白名单补位（#1416）

## 背景

10-10 晨间 00:25-00:50Z 六连拦（healing_events 90d8307f / 84f36e21 / 74b90294 / dbe4f743 / 86a4e81b / 15401327，均 ruleId=main_write）：每日体检解析 `data/guard-replay-candidates-*.json` 的**只读** python/node 载荷被「主仓写」误拦。

## 根因分析（复现核实，非读码断言）

用 healing commandHead + invoke_events 反查恢复完整命令后逐 token 二分：

1. **issue 描述的 open() 问题已在早期修复**——`python3 -c "json.load(open('data/x.json'))"`（缺省/显式 'r'）今晨形态探针全 PASS（pythonOpenModesReadOnly 门）。issue 描述基于 commandHead 截断的观察，归因偏差
2. **真根因 = 三处枚举白名单缺词**：
   - `keys.update(x.keys())`——`update` 不在 PY_READONLY_METHODS（事件 dbe4f743）
   - `dict(Counter(str(x.get(...)) for x in d))`——`Counter` 不在 PY_READONLY_CALLS（dbe4f743/86a4e81b）
   - `process.stdin.on('data',c=>d+=c)`——`stdin` 不在 node process 负向白名单、`on` 不在 NODE_READONLY_METHODS（90d8307f）
   - 另一条事件（15401327 `node -e '…require("./dist/…bash-safety-guard.js")…'`）是进程名模式面（命令含守卫自身路径），归因不同不在本 PR 范围

## 修复（词表补位——每词注明为什么只读安全）

| 词表 | 新增 | 只读依据 |
|---|---|---|
| PY_READONLY_METHODS | `update` / `add` / `most_common` / `elements` | set/dict 原地聚合非写盘（Counter 探查面）；popitem 等写语义不引入 |
| PY_READONLY_CALLS | `Counter` / `defaultdict` / `OrderedDict` / `math` / `ceil` / `floor` / `sqrt` | collections 只读聚合器构造面；写盘/执行由方法门拦（update 已入）；math 纯计算无 IO |
| NODE_READONLY_METHODS | `on` | EventEmitter 监听器注册——回调体内写调用仍被方法门/写词门拦 |
| node process 负向白名单 | `stdin` | 流消费面（process.stdin.read() 的 .on 形态）；stdout/stderr 先例同列 |

## 设计取舍（对齐统一判定核方向）

**为什么词表补位而非判定核收编**：搭档拍板的架构方向（fact 17b1447f）——统一判定核 + 规则声明式。理想终态是「脚本载荷语义判定」收编进求值器（写落点求值已正确处理 open 读写模式），旧链白名单退役。但求值器仍在影子观察期（F20261010gshw，判据未达标不切换），旧链还在生产岗位上——**止血只补词不修结构**（旧链终将退役，不值得投入架构级改造）；观察期达标 + 切换后，这类枚举滞后问题随旧链退役自然消解。

**为什么这些词安全**（fail-closed 论证）：每个词的写面对应物都**不在**词表——update/add 是内存集合操作（磁盘写走 open/write 由其他门拦）；Counter 构造无 IO；on 注册回调不执行体；stdin 是读流。借壳形态（回调内 writeFileSync/eval/exec、Counter 体内 os.system）实测全拦（负门 5 例）。

## 机制识别检查点

无命中：纯词表常量扩充 + 测试，无新配置/状态/定时/信号/存储/决策持久化/跨模块协议。Modification-Class: narrow-fix。

## #1423 对抗审视处置（r1，检视矬1360 报告 c36ade75）

| 发现 | 级别 | 处置 | 说明 |
|---|---|---|---|
| ① import dbm 双路漏拦（dbm.open 缺省 'c' 创建可写 + db['k']='v' 赋值写无调用名门） | S2 fail-open | **已修（一行）** | dbm 补进危险模块名单（与 shelve/sqlite 同族同性质，import 面整体拒——模块门一并兜住赋值写形态）；负门 2 例进库（缺省 'c' 拦 + 赋值写拦）+ 正道不误伤 1 例。既有漏洞+本 PR 边际扩口（.update 入白名单）都闭合 |

检视确认面（不重复）：归因反转成立（open 模式门早已有）、借壳对抗 23/23 全拦、回调体写盘拦得住、架构取舍如实。

**已知取舍记录**：`db['k']='v'` 形态的赋值写无调用名门——本修经模块门兕住 dbm 族；其他模块的字符串赋值写面（如有）属「缺省 mode 语义错配」结构性缺口家族，根治靠求值器收编（与枚举滞后同源，反向印证 fact 17b1447f 方向）。

## 验证

| 验证项 | 结果 |
|---|---|
| 新增测试 | 12/12（初版 9：放行 4+借壳负门 5；r1 处置 +3：dbm 缺省 'c' 拦/赋值写拦/正道不误伤） |
| 事件原样复跑 | 六连拦 5 条 main_write 相关全 PASS（15401327 属进程名模式另案）|
| 写语义负门 | 全拦（含 #1240 heredoc 负门保持）|
| 全仓 | 5334/5334（基线 5324 + #1420 后含增量）|
| eslint | 0 error |

## 影响范围

- 生产行为：三类只读脚本载荷从误拦变放行（误拦消除）；拦截面零削弱（负门证明）
- 代码：`src/frameworks/agent/bash-safety-guard.ts`（4 词表 +11 词）+ `tests/…/bash-safety-guard.test.ts`（+9 例）

## 风险与遗留

- **枚举滞后是结构性问题**——本修是止血不是根治；下次新形态（pandas 新 API 等）还会缺词。根治路径 = 求值器观察期达标 → 切换 → 旧链白名单退役（架构方向已定）
- 15401327 形态（命令含守卫自身 dist 路径触发进程名模式）不在本 PR——属「进程名模式吞路径」家族（大獭 10-10 已归类的独立线）
