#!/usr/bin/env bash
# 部署脚本（双 unit 收口）——从本机把构建产物推上 ECS 并重启服务。
# 用法：在【本机】仓库根跑 bash deploy/ecs/deploy.sh
# 传输统一走 .otter/deploy-keys/ecs-ssh.sh（ssh 管道 + 远端 sudo tar 解包）——
# 单一路径单一身份（admin），不做 rsync 直连双分支。
#
# 线上是两个独立 systemd unit，一次部署必须两段都覆盖（漏一段 = 「部署成功但 App 还是旧版」）：
#   1. otter-buddy      —— 中枢（/opt/otter-buddy，dist/ + web + docs）
#   2. colink-agent-app —— CoLink App 扩展（/opt/colink-agent-app，独立 unit，内部端口 31130）
#
# 两段的成功判据都是「实际服务对外声明的版本 == 源清单版本」，而不是「命令 exit 0」。
# 第二段失败时中枢已经换装——这是**半部署**状态：回滚见 deploy/ecs/README.md（App 侧
# 每次部署留备份，中枢侧检上一版 commit 重跑本脚本）。
#
# 边界：只管代码与配置面；数据迁移是后续 migrate-* 脚本职责，不碰 /var/lib/otter-buddy
# 与 /var/lib/colink-agent-app。
set -euo pipefail

# 部署密钥 helper 与仓同目录（.otter/deploy-keys，gitignore）。在 worktree 里跑时该目录
# 只存在于主仓，因此按「相对当前目录 → 主仓根」两级探测，避免在 worktree 里跑直接失败。
DEPLOY_KEY="${DEPLOY_KEY:-.otter/deploy-keys/ecs-ssh.sh}"
if [ ! -f "${DEPLOY_KEY}" ] && git rev-parse --git-common-dir >/dev/null 2>&1; then
  MAIN_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
  [ -f "${MAIN_ROOT}/.otter/deploy-keys/ecs-ssh.sh" ] && DEPLOY_KEY="${MAIN_ROOT}/.otter/deploy-keys/ecs-ssh.sh"
fi
if [ ! -f "${DEPLOY_KEY}" ]; then
  echo "找不到部署密钥 helper（${DEPLOY_KEY}）——见 deploy/ecs/README.md 的前置说明" >&2
  exit 1
fi
SSH="sh ${DEPLOY_KEY}"
REMOTE_CODE="/opt/otter-buddy"
REMOTE_APP="/opt/colink-agent-app"
REMOTE_APP_PORT="31130"
LOCAL_APP_DIR="./extensions/colink-agent-app"

# macOS 的 resource fork（._*）与 .DS_Store 不是内容，带上线会让文档同步整片报
# Missing frontmatter（实证：一次带上 7914 个 ._*，同步 errors 刷屏）。
export COPYFILE_DISABLE=1

# 本地构建（dist/ 生成；模型下载失败不阻断——云端嵌入走 off 开关）
npm run build

# App 版本取自源清单的**顶层** version 行：锚定四空格缩进 + 语义化版本三段，
# 且必须恰好命中一行——清单里还有 extensionPoint 的 version（1.0.0），宽松正则会把它们
# 一起捞进来，用错版本号去探活就是「部署成功却永远等不到」。
APP_VERSION_MATCHES=$(grep -cE "^    version: '[0-9]+\.[0-9]+\.[0-9]+',$" "${LOCAL_APP_DIR}/src/manifest.mjs" || true)
if [ "${APP_VERSION_MATCHES}" != "1" ]; then
  echo "源清单顶层 version 行命中 ${APP_VERSION_MATCHES} 条（期望恰好 1 条），终止部署" >&2
  exit 1
fi
EXPECTED_APP_VERSION=$(sed -nE "s/^    version: '([0-9]+\.[0-9]+\.[0-9]+)',$/\1/p" "${LOCAL_APP_DIR}/src/manifest.mjs")
echo "== 目标 App 版本：${EXPECTED_APP_VERSION}"

# ── 第一段：中枢 ─────────────────────────────────────────────
# 打包（排除本地数据/依赖/模型/密钥目录、本地 config 与 macOS 垃圾文件）→ ssh 管道 → 远端原子换装
tar --exclude='./.git' --exclude='./node_modules' --exclude='./data' --exclude='./models' \
    --exclude='./.otter' --exclude='./.claude' --exclude='./.githooks' \
    --exclude='./config/config.yaml' \
    --exclude='./web/node_modules' \
    --exclude='._*' --exclude='.DS_Store' \
    -czf - ./ \
  | $SSH "cat > /tmp/otter-deploy.tgz \
      && sudo rm -rf ${REMOTE_CODE}.new \
      && sudo mkdir -p ${REMOTE_CODE}.new \
      && sudo tar -xzf /tmp/otter-deploy.tgz -C ${REMOTE_CODE}.new \
      && sudo rsync -a --delete --exclude node_modules --exclude data ${REMOTE_CODE}.new/ ${REMOTE_CODE}/ \
      && sudo rm -rf ${REMOTE_CODE}.new /tmp/otter-deploy.tgz \
      && sudo mkdir -p /var/lib/otter-buddy/data \
      && sudo ln -sfn /var/lib/otter-buddy/data ${REMOTE_CODE}/data"

# 远端：装生产依赖 → 依赖闭包校验 → 重启 → 探活。
# npm ci 在这台机的 onnxruntime-node 安装脚本上会因二进制源不可达而失败（云端本就关闭嵌入），
# 失败时退回「按 lock 就地安装 + 跳过安装脚本」——就地安装不会重建已装的 native 模块
# （better-sqlite3 等），比让 npm ci 半途留下残缺 node_modules 安全。
$SSH "cd ${REMOTE_CODE} \
  && { sudo /opt/node24/bin/npm ci --omit=dev --silent \
       || { echo '⚠ npm ci 失败（已知嵌入二进制源不可达），改按 lock 就地安装并跳过安装脚本' >&2; \
            sudo /opt/node24/bin/npm install --omit=dev --no-audit --no-fund --no-save --ignore-scripts --silent; }; } \
  && for dep in \$(sudo /opt/node24/bin/node -e \"const p=require('${REMOTE_CODE}/package.json');console.log(Object.keys(p.dependencies||{}).join(' '))\"); do \
       sudo test -f ${REMOTE_CODE}/node_modules/\$dep/package.json \
         || { echo \"中枢生产依赖缺失：\$dep\" >&2; exit 1; }; \
     done \
  && echo '中枢依赖闭包完整' \
  && sudo systemctl restart otter-buddy \
  && for i in \$(seq 1 45); do curl -fsS http://127.0.0.1:3000/api/ping && echo && exit 0; sleep 2; done \
  && echo 'health check failed: /api/ping not ready in 90s' >&2; exit 1"

echo "== 中枢就绪（/api/ping ok）"

# ── 第二段：CoLink App 扩展 ─────────────────────────────────
# 与中枢同源发布：把中枢里那份扩展目录同步到独立 unit 的目录。
# 关键：**排除 node_modules**——App 有自己的生产依赖（如 SVG 转图用的 sharp），
# 随目录 --delete 会把已装依赖一起删掉，服务还能起来（manifest 探活看不见），
# 但运行到该能力时才炸。依赖只靠安装步骤管。
$SSH "set -e
  ts=\$(date +%Y%m%d%H%M%S)
  sudo cp -a ${REMOTE_APP} ${REMOTE_APP}.bak-\${ts}
  sudo rsync -a --delete --exclude node_modules ${REMOTE_CODE}/extensions/colink-agent-app/ ${REMOTE_APP}/
  sudo ls -1dt ${REMOTE_APP}.bak-* 2>/dev/null | tail -n +4 | sudo xargs -r rm -rf
  echo \"备份：${REMOTE_APP}.bak-\${ts}\""

# 装生产依赖（就地安装，不做 npm ci 的全量重建——服务在跑，重建失败会连旧依赖一起没有）。
$SSH "cd ${REMOTE_APP} && sudo /opt/node24/bin/npm install --omit=dev --no-audit --no-fund --no-save --silent"

# 生产依赖闭包校验：清单声明的每个 dependency 必须在 node_modules 里真的存在。
# 判据取「目录 + package.json 存在」而不是 require.resolve——ESM-only 包（exports 不含
# require 条件）在 require.resolve 下会假报缺失，而我们要判的是「装没装上」。
# 这一条是「装完看一眼」的机械化：缺包不会让探活失败，只会在用到时炸。
$SSH "for dep in \$(sudo /opt/node24/bin/node -e \"const p=require('${REMOTE_APP}/package.json');console.log(Object.keys(p.dependencies||{}).join(' '))\"); do \
    sudo test -f ${REMOTE_APP}/node_modules/\$dep/package.json \
      || { echo \"App 生产依赖缺失：\$dep\" >&2; exit 1; }; \
  done; echo 'App 依赖闭包完整'"

# 重启 + 版本核对：以「实际服务的 manifest 版本 == 源清单版本」为成功判据。
# 解析必须走 JSON 而不是行内正则——manifest 是一行 JSON，贪婪正则会把 extensionPoint
# 里的 version（1.0.0）当成 App 版本，探活于是永远等不到。
$SSH "sudo systemctl restart colink-agent-app \
  && for i in \$(seq 1 30); do \
       v=\$(curl -fsS -m 3 http://127.0.0.1:${REMOTE_APP_PORT}/manifest.json 2>/dev/null | /opt/node24/bin/node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{process.stdout.write(String(JSON.parse(s).version??\"\"))}catch{}})'); \
       if [ \"\$v\" = '${EXPECTED_APP_VERSION}' ]; then echo \"App 就绪：manifest \${v}\"; exit 0; fi; \
       sleep 2; \
     done; \
     echo \"App 探活失败：期望 ${EXPECTED_APP_VERSION}，实际 \${v:-无响应}\" >&2; exit 1"

echo "deploy done — 中枢 /api/ping ok，App manifest ${EXPECTED_APP_VERSION} 在跑"
