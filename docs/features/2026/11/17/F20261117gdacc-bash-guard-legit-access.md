---
id: F20261117gdacc
title: bash 守卫放行部署公开只读与格式化管道：#1892 colink 部署 7 连拦收口
change_type: fix
created: 2026-11-17
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/guard-intercept-classify.test.ts
  - tests/guard/replay/cases-2026-10-29.ts
summary: "#1892：colink-agent-app 部署 7 次被 bash 守卫误拦（凭证目录只读 x4 + 下载即执行 x3），獭反复变体重试而非升级，#844 同型复现。根因：两处判定面过宽——①cred_dir_access 对 .ssh/.gnupg/.aws 任何访问一刀切，目录列举/公钥/known_hosts/config 等无凭证内容的正当只读也被拦；②download_exec 把「curl 管道进 python3 -m json.tool（格式化模块）」当作「管道进解释器执行下载内容」。方案（C 最小改动）：①cred_dir_access 加「公开只读」口径——写操作恒拦、私钥/credentials 读取恒拦，仅放行目录列举（ls）、公钥（.pub）、known_hosts、ssh config；②download_exec 排除 `python3 -m json.tool` 格式化模块出解释器判定（裸 python3/python -c 吃 stdin 当脚本执行仍拦）。真负门零弱化。"
tags: [guard, bash-safety, replay, deployment]
intent:
  problem: "bash 守卫两处判定面过宽：凭证目录任何访问一刀切（正当只读被拦）+ download_exec 把格式化模块管道误判为执行下载内容，导致自有项目部署高频误拦，獭反复变体重试而非升级，侵蚀守卫引导信任"
  expected_effect: "部署前只读确认（ls ~/.ssh / cat *.pub / grep known_hosts / cat config）与 curl|python3 -m json.tool 格式化管道放行；私钥/credentials 读取、凭证目录写操作、curl|sh、bash <(curl …)、curl|python3 -c 等真负门继续拦截，零弱化"
  verify_by:
    type: static_only
capability_test: "guard-intercept-classify 新增公开只读/边界/格式化负门用例 + replay 回放 2 条改判用例（ls/config）全绿 + 既有下载执行/凭证/主进程 kill 负门全绿——tests/guard/replay/replay.test.ts 与 guard-intercept-classify.test.ts 机械可测"
---

# bash 守卫放行部署公开只读与格式化管道：#1892 colink 部署 7 连拦收口

## 问题（现场）

2026-11-13 07:20–08:40，同一獭为部署 extensions/colink-agent-app 连续 7 次被 bash 守卫拦截（近 6h 内）：
- 凭证目录（cred_dir_access）x4：ls ~/.ssh、cat id_ed25519_local.pub、grep known_hosts 找主机、ls /tmp 找部署密钥
- 下载即执行（download_exec）x3：curl manifest.json 管道进 python3 -m json.tool（格式化，非执行远程脚本）

与 #844（已关闭）同一模式复现：正当部署诉求无出路，獭反复变体重试而非升级。

## 根因

两处判定面过宽：

1. `cred_dir_access` 对 `.ssh/.gnupg/.aws` 任何访问一刀切——目录列举、公钥、known_hosts、config 等无凭证内容的正当只读也被拦（读公钥不泄私钥）。
2. `download_exec` 把「curl 管道进 python3 -m json.tool（格式化模块）」当作「管道进解释器执行下载内容」——管道目标是格式化而非执行远程脚本。

## 方案（搭档拍板 2026-11-17：明确才拦，不明确一律放通；不叠加判断规则）

### ① cred_dir_access 黑名单収口（只拦明确两项，其余放通）

不再白名单判定、不再叠加静态规则。命中凭证路径后只拦两类明确危险：
1. **明确读已知私钥/凭证本体**：`id_rsa / id_ed25519 / id_ecdsa / id_dsa / id_xmss`（非 .pub）、`.pem`、`.key`、`credentials`、`secring.gpg`。
2. **明确写凭证目录**：`cp/mv/rm/install/tee/chmod/chown/chattr/truncate/ssh-keygen/touch/ln/rsync/dd/unlink`、`sed/gawk/awk/perl/ruby -i / --in-place` 就地改写、任何 `>`/`>>` 重定向。

其余（`ls`、公钥 `.pub`、`known_hosts`、`ssh config`、自定义钥匙名、递归 grep、解释器动态写等无法明确判定的形态）**一律放通**。

### ② download_exec 排除格式化模块 + 解释器形态收口

管道解释器判定排除 `python3 -m json.tool`（读 stdin 输出格式化 JSON，非执行下载内容），`env` / `env -i` / `env -u` / `--ignore-environment` 等前缀均正确处理。裸 `python3` / `python -c` / `env … python3` 吃 stdin 当脚本执行仍拦。

## R8.5 准入三问

1. **决策者变了么**：变了——搭档 2026-11-17 拍板「明确才拦，不明确一律放通；不允许叠加判断规则」，取代 delta 迭代中的静态白名单思路。
2. **靠自觉还是靠守卫**：**机械可测**——classify 新增「明确两项仍拦 + 不明确放通」用例 + replay 全量回放（含既有负门）锁行为。
3. **深潜成本降了吗**：降——部署前只读确认不再被物理拦截，獭无需变体重试；且规则简化（不再白名单/私密 token 扫描）。

## 验证

- [x] guard 相关 7 测试文件 239/239 通过（含 replay、classify、bounce、lexer/model/sanitizer、架构边界）
- [x] replay 3 条改判：`ls ~/.ssh`、`sed ssh config`、`.ssh 词面 grep` 从 block 改 allow（#1892 现场同形态 / 搭档拍板「词面即拦废止」）；既有 curl|sh、进程替换、curl|python3 -c、主进程 kill 等负门全部仍 block
- [x] 明确两项负门未弱化：`cat id_rsa`（含混合 `cat id_rsa known_hosts`、`cat id_rsa; ls`）仍 block；`sed -i / --in-place / gawk -i / perl -i / rsync / unlink / ssh-keygen / echo >>` 仍 block

## 影响

- colink 类自有项目部署的只读确认与 manifest 格式化管道放行（#1892 现场恢复）
- 明确负门保留：已知私钥/凭证读取、凭证目录写、远程脚本执行（含管道进裸 python）继续拦截
- 不明确形态（自定义钥匙名、递归 grep、解释器动态写、词面 `.ssh`）按搭档拍板一律放通——静态守卫不再逐形态叠加规则