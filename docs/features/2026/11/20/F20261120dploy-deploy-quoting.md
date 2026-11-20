---
id: F20261120dploy
title: "部署脚本远端命令串转义：本地展开的 $(…) 让每次部署死在半部署态"
summary: "deploy/ecs/deploy.sh 中枢段的多行 `$SSH \"…\"` 里，内层双引号未转义、`$(readlink …)` 未转义，导致字符串在本地被截断、命令替换在**本机**执行（拿到空串），远端收到的是 `[ = \"/var/lib/otter-buddy/data\" ]` 这种语义已错位的判断，必然报错退出。位置在文件换装之后、服务重启之前——所以每次部署都会停在「文件已换、进程还是旧的」的半部署态。修复后按原样交给远端执行，并加一条静态测试守住这类转义（内层引号必须 `\\\"`、命令替换必须 `\\$(`）。"
change_type: fix
capability_test: "tests/deploy/ecs-deploy-ssh-quoting.test.ts（切出全部 `$SSH \"…\"` 命令串，静态判定内层引号与 `$(` 是否转义；在未修复的脚本上 3 条红、修复后 4 条绿）"
intent:
  problem: "部署脚本用 `$SSH \"多行命令\"` 把整段交给远端 bash，因此这段字符串会先被本地 bash 处理一遍。中枢段里 `echo \"FATAL: …\"` 的双引号没转义、`$(readlink …)` 也没转义：字符串在第一个内层引号处被本地截断，`readlink` 在**本机**执行（`/opt/otter-buddy/data` 在 Mac 上不存在，得到空串），远端最终执行的是 `[ = \"/var/lib/otter-buddy/data\" ]`，报 unary operator expected 并落到 FATAL 分支退出。更贵的是时序：这段在 rsync 换装之后、systemctl restart 之前，所以失败时线上已是「文件新、进程旧」的半部署态，而报错信息指向远端 data 目录，读日志的人会去查远端环境而不是查这行引号。"
  solution: "把那段的三个内层双引号转义为 `\\\"`，并把 `$(readlink …)` 转义为 `\\$(…)`，让整段字符串原样到达远端、命令替换在远端执行。同时新增静态测试：按 `$SSH \"` 切出所有远端命令串，断言其内部不含未转义的内层引号、不含未转义的 `$(`，并对 data symlink 那条断言 `\\$(readlink …)` 形态在位。"
  expected_effect: "部署不再停在半部署态：中枢段能走完换装→重启→探活。转义缺失这类「本地看起来对、远端拿到残渣」的改动会在 CI 里红，而不是等下一次生产部署才暴露。"
  verify_by:
    type: static_only
created_in_conversation: 0401284f-dff7-4927-af60-3516a984529d
tags: [deploy, bash, quoting, ops, regression-guard]
modules:
  - process
causal_links:
  - {type: "supplements", id: "F20261119dploy", note: "那笔修的是部署通道的依赖分区与 App unit 纳入；本笔修的是同一脚本里的引号转义"}
  - {type: "supplements", id: "F20261119mgfix", note: "那段多行 data symlink 校验是随该笔迁移演练修复进来的，转义缺陷一并带入"}
  - {type: "complements", id: "F20261120ctopd", note: "拓扑文档纠正的同一天：部署脚本的行为与文档描述的「两个 unit 一次覆盖」必须真的成立"}
---

# 部署脚本远端命令串转义（F20261120dploy）

## 症状

生产部署第一次执行即失败：

```
bash: line 1: [: =: unary operator expected
FATAL: data symlink 建链/属主校验失败（readlink 目标不符或 otter 不可写）
```

现场核对 `ls -ld /opt/otter-buddy/data` → 符号链接**是对的**（`-> /var/lib/otter-buddy/data`），属主也对。也就是说报错信息说的那件事根本没发生。

## 根因

脚本中枢段是「把一整段命令塞进远端 bash」的写法：

```bash
| $SSH "cat > /tmp/otter-deploy.tgz \
    && … \
    && if [ -e ${REMOTE_CODE}/data ] && [ ! -L ${REMOTE_CODE}/data ]; then \
         echo "FATAL: …" >&2; exit 1; \
       fi \
    && sudo ln -sfn /var/lib/otter-buddy/data ${REMOTE_CODE}/data \
    && [ "$(readlink ${REMOTE_CODE}/data)" = "/var/lib/otter-buddy/data" ] \
```

这段字符串**先被本地 bash 处理**，于是：

1. `echo "FATAL: …"` 的内层双引号把字符串在本地提前截断——后续整段不再是「一个参数」，而是若干被拼接的词；
2. `"$(readlink …)"` 的 `$(` 没转义 → 在**本机**执行。本机没有 `/opt/otter-buddy/data`，`readlink` 输出空串；
3. 远端收到的是 `[ = "/var/lib/otter-buddy/data" ]` → `unary operator expected` → 非零 → 落 FATAL 分支 `exit 1`。

## 为什么这次才炸

检查本身是随迁移演练那笔修复加进来的（此前脚本这段没有 data symlink 校验）。加了之后**每次部署都会死在同一处**，且死在 `rsync` 换装之后、`systemctl restart` 之前——线上留下「文件已换、进程仍旧」的半部署态。这个状态危险在于：`/api/ping` 仍然 200（旧进程还在服务），看起来像没事。

## 修复

| 位置 | 修复前 | 修复后 |
| --- | --- | --- |
| FATAL 提示 | `echo "FATAL: …"` | `echo \"FATAL: …\"` |
| symlink 校验 | `[ "$(readlink …)" = "…" ]` | `[ \"\$(readlink …)\" = \"…\" ]` |
| 兜底 FATAL | `echo "FATAL: …"` | `echo \"FATAL: …\"` |

## 防复发

`tests/deploy/ecs-deploy-ssh-quoting.test.ts`：按 `$SSH "` 切出脚本里**全部**远端命令串（含单行形态），对每段静态判定——

1. 内部不得有未转义的内层双引号（否则字符串被本地截断）；
2. 内部不得有未转义的 `$(`（否则命令替换在本地执行）；
3. data symlink 那条必须是 `\$(readlink ${REMOTE_CODE}/data)` 形态。

实测有效性：把脚本退回未修复版本，该测试 **3 红 1 绿**；修复后 **4 绿**。切分逻辑本身也有「至少切出一段且含 readlink」的断言，防止切分失效后测试空跑成假绿。

## 验证

修复后重跑真实部署：

| 检查 | 结果 |
| --- | --- |
| 部署输出 | `中枢依赖闭包完整` → `/api/ping ok` → `App 就绪：manifest 0.6.1` → `deploy done` |
| 中枢监听 | `127.0.0.1:3000`（此前 `*:3000`） |
| App 监听 | `127.0.0.1:31130` / `:31131` |
| 公网 3000 | 连接被拒（安全组，与部署前一致） |
| `app.<域名>` | `manifest.json` 200 |
| 鉴权日志 | 两侧 401 计数 0 |
| 来源闸三态 | 回环+声明式头 → 放行；无身份 → 401；带 `X-Forwarded-For` → 401 |
