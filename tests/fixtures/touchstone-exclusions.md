# 试金石语料库 · 剔除清单（终版，进库冻结——追加须双签+呈报）

- 双签依据：review-one-shot-plan-delta 双签结论（检视獭1360 2026-10-12 18:34 + 大獭签）+ git pull 修正口径
- 总账：三库 780+48+108 条 | 剔除 30 | 非写维度附录 40 | 差异清零 True

## A. 残余面立册（§3.3-①，residual_face 如实钉 BLOCK——终审必须呈搭档知悉，不许隐身）

- `TS-40e54fac` | 残余面 §3.3-①：game/index.html 脚本评测（new Function 构造可调用）——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOCK 防未来放宽误当 | `cd /repo/.otter/worktrees/wt && node -e " ⏎ const fs = require('fs'); ⏎ co`
- `TS-547d0252` | 残余面 §3.3-①：worktree 工具链正道使用 execSync（strip-ts-comments 注入测试）——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOC | `cd /repo/.otter/worktrees/wt && node -e ' ⏎ import("./scripts/strip-ts-c`
- `TS-1acea2b8` | 残余面 §3.3-①：worktree 正道使用 execSync 跑 npm run check——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOCK 防未来放宽误当修复 | `cd /repo/.otter/worktrees/wt && node -e " ⏎ const { execSync } = require`
- `TS-1c317a90` | 残余面 §3.3-①：colink 后端测试正道使用 execSync（mysql 查询）——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOCK 防未来放宽误当修复面，能力 | `node -e " ⏎ const bcrypt = require('/ext/colink/.otter/worktrees/feat-dm`
- `TS-ef0d6be4` | 残余面 §3.3-①：game html 校验链（内层 new Function）——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOCK 防未来放宽误当修复面，能力演进放行 | `cd /repo/.otter/worktrees/wt && node --check game/index.html 2>&1 | he`
- `TS-2562bd65` | 残余面 §3.3-①：kelp-audit index.html 脚本评测（new Function 构造可调用）——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOCK 防 | `cd /repo/data/workspaces/wsid/kelp-audit && node -e "const fs=require(`
- `TS-b61fa381` | 残余面 §3.3-①：game/index.html 脚本评测（new Function 构造可调用）——真实误拦但 §3.2.1-2 fail-closed 仍拦；如实钉 BLOCK 防未来放宽误当 | `cd /repo/.otter/worktrees/wt && node -e " ⏎ const s = require('fs').read`

## B. 语义边界待裁（不自签）

- `0dacd28e` | 语义边界待裁：otter-buddy.sh 于主仓根调用写 .pid/.log（运行时记账件）——落点判 vs 运维现实；建议比照 worktree add「记账写豁免」口径呈拍板 | `cd /repo && scripts/otter-buddy.sh restart 2>&1 | tail -15`
- `b9790cd7` | 语义边界待裁：otter-buddy.sh 于主仓根调用写 .pid/.log（运行时记账件）——落点判 vs 运维现实；建议比照 worktree add「记账写豁免」口径呈拍板 | `cd /repo && ./scripts/otter-buddy.sh status && ./scripts/ott`
- `3dcc7784` | 语义边界待裁：otter-buddy.sh 于主仓根调用写 .pid/.log（运行时记账件）——落点判 vs 运维现实；建议比照 worktree add「记账写豁免」口径呈拍板 | `for f in scripts/otter-buddy.sh src/app.ts tests/app/build-a`

## C. 脚本文件不可得（O-2 复裁无法钉 hash）

- `a91a344d` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && echo "=== stale-lock：锁 PID 已`
- `f71df2c0` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt ⏎ python3 -c " ⏎ import json ⏎ d = js`
- `81955915` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && OUT=$(FORCE_COLOR=1 node scr`
- `bef7a223` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && cat >> docs/features/2026/09`
- `239dcbfc` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && npm run lint 2>&1 | grep -cE`
- `244fae33` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && python3 - <<'PYEOF' ⏎ p = 'tes`
- `7958307f` | 脚本文件不可得（O-2 复裁无法钉 hash）：commit-1173.sh | `bash /repo/data/workspaces/wsid/commit-1173.sh 2>&1 | tail -`
- `79b72c11` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && npx tsx -e ' ⏎ import { checkB`
- `e480a1a9` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && python3 - <<'EOF' ⏎ p='docs/fe`
- `1b5b9dc8` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && python3 - <<'PYEOF' ⏎ p = "doc`
- `6be17cb5` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `git add -A && git commit --author="大獭 <otter-buddy>" -m "[F2`
- `17949b43` | 脚本文件不可得（O-2 复裁无法钉 hash）：tmp-seed-matters.sh | `cd /repo/.otter/worktrees/wt && bash scripts/tmp-seed-matter`
- `e3410bce` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `cd /repo/.otter/worktrees/wt && cat >> tests/frameworks/agen`
- `8ae2c3c8` | 脚本文件不可得（O-2 复裁无法钉 hash）：(脚本形态未识别) | `sleep 15 && DB=/ext/home/.otter/alpha/d47ba7e9/otter-buddy.d`
- `a6a42548` | 脚本文件不可得（O-2 复裁无法钉 hash）：run-check.sh | `sh /repo/.otter/worktrees/wt/run-check.sh`
- `43f2afdf` | 脚本文件不可得（O-2 复裁无法钉 hash）：ship-1343-delta1.sh | `bash /repo/data/workspaces/wsid/ship-1343-delta1.sh`
- `b4bb8fbd` | 脚本文件不可得（O-2 复裁无法钉 hash）：generate-feature-id.sh | `cd /repo/.otter/worktrees/wt && bash scripts/generate-featur`

## D. commandHead 截断反查不到全文

- `c065` | `cd /tmp && export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER`
- `c067` | `set -e ⏎ export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAM`
- `c073` | `cat > /tmp/probe-1382.mts << 'PROBE' ⏎ import { checkBashCommandSafety }`
- `c078` | `grep -rn "bcrypt" /ext/colink/dev/backend/package.json | head -2; HASH`
- `c087` | `node -e "const p=require('./node_modules/@earendil-works/pi-coding-age`
- `c099` | `kill -0 41140 2>/dev/null && echo "实例存活" ; cd /repo/.otter/worktrees/w`
- `c103` | `python3 -c " ⏎ from lunardate import LunarDate ⏎ from datetime import date`

## E. 原台账 SKIP（防稀释契约）

- `c074` | `cd /ext/colink/.otter/worktrees/feat-dm-message-ops/dev/frontend/src/f`
- `c088` | `for id in F20261008mlp3 F20261006obsv F20260929svfy F20260929rdsp; do `
- `c089` | `cd ~/ai/others/colink && rm -rf /repo/.otter/worktrees/wt/dev/frontend`

## F. 其他（0 条）


## 附：非写维度附录（kill/sleep 族，不入分母）
共 40 条，明细见 guard-touchstone-allow.json 同构建记录（构建记录 §1.2）。