---
id: F20261117gdacc
title: bash 守卫放行部署公开只读与格式化管道：#1892 colink 部署 7 连拦收口
change_type: fix
status: implemented
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

## 方案（C 最小改动：只放行公开只读 + 格式化模块，真负门零弱化）

### ① cred_dir_access 公开只读口径（检视 delta 后：私钥/写先拦）

命中凭证路径后分层（顺序即判定优先级）：
1. **写操作恒拦**：`cp/mv/rm/install/tee/chmod/chown/chattr/truncate/ssh-keygen/touch/ln/rsync/dd/unlink`、`sed/gawk/awk -i` 就地改写、任何 `>`/`>>` 重定向。
2. **私钥/凭证本体恒拦**：`id_rsa/id_ed25519/id_ecdsa/id_dsa/id_xmss`（非 .pub）、`.pem`、`.key`、`credentials`——先于公开只读判定，防「私钥+公开文件」混合命令整串放行。
3. **仅放行公开只读**：目录列举（`ls … ~/.ssh`）、公钥（`*.pub`）、`known_hosts`、`ssh config`。
4. 其余（未识别读形态/authorized_keys/secring.gpg 等）默认拦。

### ② download_exec 排除格式化模块

管道解释器判定排除 `python3 -m json.tool`（读 stdin 输出格式化 JSON，非执行下载内容）。裸 `python3` / `python -c` 吃 stdin 当脚本执行仍拦。

## R8.5 准入三问

1. **决策者变了么**：没有。方案 C 是口径细化（公开 vs 私密、格式化 vs 执行），不新增放行面外机制。
2. **靠自觉还是靠守卫**：**机械可测**——classify 新增公开只读/边界/格式化用例 + replay 全量回放（含既有负门）锁行为。
3. **深潜成本降了吗**：降——部署前只读确认不再被物理拦截，獭无需变体重试。

## 验证

- [x] guard 相关 6 测试文件 238/238 通过（含 replay 147/147、classify、bounce）
- [x] replay 2 条改判：`ls ~/.ssh`、`cat/sed ssh config` 从 block 改 allow（#1892 现场同形态）；既有 curl|sh、进程替换、curl|python3 -c、主进程 kill 等负门全部仍 block
- [x] 检视 delta 回归钉：混合命令（`cat id_rsa known_hosts` / `cat id_rsa; ls`）仍 block；写动词扩容（sed -i / gawk -i / rsync / unlink）仍 block；`sed -n` 读态 ssh config 仍放行

## 影响

- colink 类自有项目部署的只读确认与 manifest 格式化管道放行（#1892 现场恢复）
- 真负门零弱化：私钥/凭证读取、凭证写、远程脚本执行（含管道进裸 python）继续拦截