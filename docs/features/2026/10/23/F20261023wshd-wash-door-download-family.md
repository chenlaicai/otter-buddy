---
id: F20261023wshd
title: 词面证洗白第三门收口——curl/wget/dd 族 dyn/未覆盖形态不进能力 4 豁免（M-a38446f9）
summary: curl/wget/dd 族目标槽不可静态钉的形态被 proveNoWrite 词面证洗成正面 ALLOW 或被提取器静默断言无写（探针实证：dyn 槽洗白、dd of= 动态槽静默跳过、默认落盘未钉 basename 静默断言、argv0 伪目标，含附着/内联词法变体）；收口为「目标槽不可证 → argv-write-uncovered（不进词面证豁免）+ 未钉 basename 落目录性写面」，与 #1619 tar/unzip/rsync 族同哲学。
change_type: fix
capability_test: "n/a: 纯 A 类求值器行为修复，无 LLM 参与行为"
intent:
  problem: "#1619 delta 实测暴露「能力 4 词面证对 argv 写面族工具内写语义全盲」的洗白门（proveNoWrite 洗白 uncovered-cmd/dynamic-path → 正面 ALLOW），当时只收 tar/unzip/rsync 族的口。本单基线探针（/tmp/probe-wash2-baseline.ts）实证 curl/wget/dd 族同门四形态：W1 `wget -P \"$D\"` dyn 落盘槽落 dynamic-path 被洗白 ALLOW；W2 `dd of=\"$D\"` 动态 of= 槽被静默跳过 → evaluated 空集**正面断言无写**（比洗白更早的放水门）；W3 默认落盘未钉 basename（动态 URL 操作数）同被静默断言（ROOT cwd 实写主仓漏拦）；W4 downloadWriteTargets 收到含 argv0 的 words，basename(argv0) 伪造写目标（ROOT 下侥幸挡 W3，WT 下漏）"
  expected_effect: "dyn/未知形状目标槽统一 argv-write-uncovered（UNPROVABLE_TEETH 在册，词面证不可洗）；dd 末位 of= 语义（后写覆盖）判读；未钉 basename 落盘目录目录性写面（ROOT 拦/工作区豁免/造-执对前缀配对）；argv0 不入位置参数。良性形态（显式输出文档/不落盘探测/纯读/已知操作数）不误拦"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-23
from:
  tasks:
    - "M-a38446f9"
---

# 词面证洗白第三门收口——curl/wget/dd 族（M-a38446f9）

## 背景与病灶

#1619（F20261022mxwv）delta 修复时实测暴露**第三扇放水门**：能力 4 词面证（proveNoWrite）对
argv 写面族的工具内写语义全盲——extractor 报出的「落点不可证」（uncovered-cmd/dynamic-path）
会被词面证洗成正面 ALLOW。当时只收了 tar/unzip/rsync 族的口（目标槽不可静态钉 →
argv-write-uncovered 入 UNPROVABLE_TEETH）。本单按同族对称原则收 curl/wget/dd 族。

**基线复现（探针 /tmp/probe-wash2-baseline.ts，先基线后修法）**：四形态实证——

| # | 形态 | 基线行为 | 机制 |
|---|---|---|---|
| W1 | `wget -P "$D" http://x/f`、`curl -o`（缺值） | **ALLOW（放水）** | dyn 落点 → dynamic-path → 被词面证洗白（`-P`/裸 `-o` 不在 ARG_TARGET_FACE 词面） |
| W2 | `dd of="$D"` | **ALLOW（放水）** | 动态 of= 词被 `raw===null` 静默跳过 → evaluated 空集**正面断言无写** |
| W3 | `curl -O "http://x/$F"`、`wget "http://x/$F"` | ROOT cwd **ALLOW（放水）** | 动态 URL 操作数不入 posArgs → 默认落盘 basename 未钉却零目标断言 |
| W4 | `wget http://x/f`（一切默认落盘形态） | 目标列表含 `/repo/wget` **伪目标** | evalExtendedWriteTargets 传含 argv0 的 words，argv0 被当 URL 位置词 |

W3/W4 耦合：W4 的伪目标（basename(argv0) 落 cwd）在 ROOT cwd 下**侥幸**挡住 W3——修 W3 前
必须同步修 W4，否则 ROOT 回归放水。

## 修法（与 #1619 同哲学：目标槽不可证不得正面断言无写，也不得进词面证豁免）

- **W1**：下载族 dynTarget → `argv-write-uncovered`（原 dynamic-path 会被词面证洗白）——
  UNPROVABLE_TEETH 在册（#1619 建立），洗白口不可达
- **W2**：dd of= 槽位按 **parts 首字面量钉形状**（`of="$D"`/`"of=$D"` 首 lit 为 `of=`）+
  **末位 of= 相关词语义**（dd 操作数后写覆盖）：末动态/未知形状 → argv-write-uncovered；
  已知名称操作数（if=/conv=/bs=/count=/skip=/seek=/status=/iflag=/oflag=）与无 name=value
  形状的已知词（dd 拒识报错即无写，可证）不误伤
- **W3**：默认落盘（curl remoteName / wget 无输出文档）+ 未钉 basename 操作数 → 写面=
  **落盘目录的目录性写面**（saveDir ?? cwd，dirWrite 语义）——不正面断言无写：ROOT cwd 目录
  即主仓 → 拦；工作区 cwd 豁免 → 放（无新增误拦）；造-执对按前缀配对兜同名下载
  （`wget --header "$H" … && . ./build.sh` 保守拦：动态词可能是同名 URL）。显式输出文档
  （-O/-o）/不落盘（--spider/--dry-run）无此写面，不误伤
- **W4**：downloadWriteTargets 调用面统一 `words.slice(1)`（与造-执对面同口径，argv0 不入
  位置参数）

**不军备化（#1513 之尺）**：dd 操作数名称封闭集（POSIX 十个：if/of/bs/cbs/ibs/obs/conv/count/
skip/seek，其中 of= 为落点槽单独判读 + GNU 扩展 status/iflag/oflag），非穷举追变体；
下载族未引入新值位表——W3 的目录性写面让「未钉」本身成为保守正确答案（无需猜值位归属）。

## delta r1（检视獭1625 对抗审视处置，2026-10-23）

初轮结论 request-changes：**S1 严重——附着形态 dyn 输出槽漏收**（检视獭独立焦点，矩阵外）：
`-o"$D"`/`-o="$D"`/`--output="$D"`/`-O"$D"` 等附着/内联形态整词 evaluated=null，进不了分离
形态的 dynTarget 通路——ROOT 下正面断言无写、WT 下造-执对攻击链复活（`curl --output="$D" u
&& . ./g.sh` ALLOW 实证），同语义不同词法形态安全语义分叉。另 S2（`--output-dir`+`-O` 组合
同族失真）、S3（dd 封闭集缺 cbs/ibs/obs，「全集」宣称与实现不符）。

处置（大獭 L1 裁定全收）：

| 发现 | 修法 | 钉 |
|---|---|---|
| S1 附着/内联 dyn 写槽 | **dynWordSlot 旗标形状判读**（parts 首字面量钉形状，ddOfSlot 同手法，不建值位表）：动态余部=写槽值（curl -o"$D"/--output="$D"、wget -O"$D"/-P"$D" 等）→ dynTarget；=不可解析簇续/动态旗标名（-q"$D" 可藏 o 写槽、--header"$H" 可拼出任意旗标）→ 保守 dynTarget；=非写旗标值位（-e"$H"、--header="$H"）→ 精确跳过不误伤 | S1×3 钉（含造-执对链与不误伤对照） |
| S2 curl --output-dir | 与 wget --directory-prefix 同语义收编（curl man 证实 -O/--remote-name/-o 同受，节内全适用）：值 dyn → dynTarget；静态目录 + 输出文档相对名两钉（原名+前缀名，保守两向覆盖 wget -P×-O 不确定面） | S2×3 钉 |
| S3 dd 封闭集 | cbs/ibs/obs 一行补齐 + 文档「全集」宣称订正 | S3 钉 |

**诚实边界②改写（原切割被检视獭驳回、大獭认可驳回——订正）**：S1 不是建值位猜测模型，是
**已在册解析形态的 dyn 版本对齐**（静态簇走查/长旗标语义本就在代码里，dyn 词法形态同语义
对齐），#1513 之尺红线不动。内联形态（`--header="$H"`）值位归属旗标名已钉（getopt 语义）
→ 精确判读；分离值的纯动态词（`--header "$H"`）仍保守入未钉操作数（无法区分值位/URL）。

### Verification（delta r1 证据链）

- 修复前红证：矩阵 16 passed | 5 failed（S1×3/S2/S3 全红=附着词法放水面实证）；探针
  /tmp/probe-s1-parts.ts 钉死附着形态 parts 形状
- 修复后绿证：wash-door 矩阵 **21/21**（delta r1 新增 8 钉）；守卫域 77 文件 2122 passed |
  6 skipped；全仓 **422 文件 6782 passed | 6 skipped** 零回归；检视獭探针材料 /tmp/wshd-probe/
  保留供 delta 复核

## Verification（证据链）

- **修复前红证**：矩阵 6 passed | 7 failed（W1×2/W2×3/W3/W4 全红=放水面实证；绿 6=放行侧
  对照不误伤）；基线探针先行钉死四形态主张
- **修复后绿证**：wash-door 矩阵 **13/13**；守卫域全量 **77 文件 2114 passed | 6 skipped**
  （含 touchstone 三池零翻转——corpus 实查 curl 仅 1 形态（`curl -sL --max-time 20` 纯读）不涉）；
  全仓 **422 文件 6774 passed | 6 skipped** 零回归

## 行为收紧披露（fail-closed 方向，非回归）

- `wget -P "$D" …`（动态落盘目录）ALLOW → **BLOCK**（落点不可证，运行时 $D 可为任意目录）
- `dd of="$D"`、`dd "$X"`（动态/未知形状操作数）ALLOW → **BLOCK**（同上）
- `wget --header "$H" http://x/f && . ./build.sh`（WT）ALLOW → **BLOCK**（动态词可能是同名
  URL 下载造-执对——保守拦）；同链异地执行（`. /other/g.sh`）不误伤（钉）
- 显式输出文档/不落盘探测/纯读/已知操作数形态**判定全部不变**（放行侧回归钉 12 条）

## 剩余风险与非目标（诚实边界）

- dd 「无 name=value 形状的已知词 = dd 拒识报错即无写」依赖 dd 操作数全为 name=value 的语义
  （POSIX dd 无无名操作数）；若某变体接受无名词，该形态回落成漏——已核 GNU/BSD dd 一致拒绝
- W3 保守面：**分离值的纯动态词**（如 `--header "$H"`）仍无法静态区分是旗标值还是 URL 操作数
  ——保守入未钉操作数（不建值位猜测模型，#1513 之尺）；带执行链时同目录保守拦，纯下载无
  执行链时工作区豁免保持（无误拦）。**内联形态**（`--header="$H"`）值位归属已钉，精确判读
  不误伤（delta r1 订正——原边界一刀切含内联形态，不实）
- curl `--next` 多节语义未建模（--output-dir 节内适用的边界不钉）——单节形态全覆盖，多节
  组合保守侧行为未逐节核
- sed/perl/ruby 族 dyn 槽走 dynamic-path 但由 INPLACE_FACE 词面兜住不洗白（探针 X1/X2 实证
  BLOCK）——不在本单射程，维持现状
- 词面证洗白是通用机制：未来新写面族若词面 regex 漏收，同门仍会开——根治（dynamic-path 整体
  入 UNPROVABLE_TEETH）属语义池变更，需独立评审，不在本单射程（已向大獭报备建议排期）
