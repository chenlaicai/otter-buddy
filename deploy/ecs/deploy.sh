#!/usr/bin/env bash
# 部署脚本（阶段 6a + 双 unit 收口）——从本机把构建产物推上 ECS 并重启服务。
# 用法：在【本机】仓库根跑 bash deploy/ecs/deploy.sh
# 传输统一走 .otter/deploy-keys/ecs-ssh.sh（ssh 管道 + 远端 sudo tar 解包）——
# 单一路径单一身份（admin），不做 rsync 直连双分支。
#
# 线上是两个独立 systemd unit，一次部署必须两段都覆盖（漏一段 = 「部署成功但 App 还是旧版」）：
#   1. otter-buddy      —— 中枢（/opt/otter-buddy，dist/ + web + docs）
#   2. colink-agent-app —— CoLink App 扩展（/opt/colink-agent-app，独立 unit，内部端口 31130）
#
# 边界：只管代码与配置面；数据迁移是后续 migrate-* 脚本职责，不碰 /var/lib/otter-buddy
# 与 /var/lib/colink-agent-app。
set -euo pipefail

SSH="sh .otter/deploy-keys/ecs-ssh.sh"
REMOTE_CODE="/opt/otter-buddy"
REMOTE_APP="/opt/colink-agent-app"
REMOTE_APP_PORT="31130"
LOCAL_APP_DIR="./extensions/colink-agent-app"

# macOS 的 resource fork（._*）与 .DS_Store 不是内容，带上线会让文档同步整片报
# Missing frontmatter（2026-11-19 实证：一次带上 7914 个 ._*，同步 errors 刷屏）。
export COPYFILE_DISABLE=1

# 本地构建（dist/ 生成；模型下载失败不阻断——云端嵌入走 off 开关）
npm run build

# App 扩展版本取自源清单，部署后用它核对「真正在跑的版本」，而不是「我以为发上去的版本」
EXPECTED_APP_VERSION=$(sed -n "s/^[[:space:]]*version: '\([0-9][0-9.]*\)',.*/\1/p" "${LOCAL_APP_DIR}/src/manifest.mjs" | head -1)
if [ -z "${EXPECTED_APP_VERSION}" ]; then
  echo "无法从 ${LOCAL_APP_DIR}/src/manifest.mjs 解析版本号，终止部署" >&2
  exit 1
fi
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
      && sudo rm -rf ${REMOTE_CODE}.new /tmp/otter-deploy.tgz"

# 远端：装生产依赖 + 重启 + 探活（/api/ping 就绪即中枢部署成功）
$SSH "cd ${REMOTE_CODE} && sudo /opt/node24/bin/npm ci --omit=dev --silent \
  && sudo systemctl restart otter-buddy \
  && for i in \$(seq 1 45); do curl -fsS http://127.0.0.1:3000/api/ping && echo && exit 0; sleep 2; done \
  && echo 'health check failed: /api/ping not ready in 90s' >&2 && exit 1"

echo "== 中枢就绪（/api/ping ok）"

# ── 第二段：CoLink App 扩展 ─────────────────────────────────
# 与中枢同源发布：直接把中枢里那份扩展目录同步到独立 unit 的目录，先留备份再换装。
# 备份保留最近 3 份（可回滚），避免备份目录无限膨胀。
$SSH "set -e
  ts=\$(date +%Y%m%d%H%M%S)
  sudo cp -a ${REMOTE_APP} ${REMOTE_APP}.bak-\${ts}
  sudo rsync -a --delete ${REMOTE_CODE}/extensions/colink-agent-app/ ${REMOTE_APP}/
  sudo ls -1dt ${REMOTE_APP}.bak-* 2>/dev/null | tail -n +4 | sudo xargs -r rm -rf
  echo \"备份：${REMOTE_APP}.bak-\${ts}\""

$SSH "sudo systemctl restart colink-agent-app \
  && for i in \$(seq 1 30); do \
       v=\$(curl -fsS -m 3 http://127.0.0.1:${REMOTE_APP_PORT}/manifest.json 2>/dev/null | sed -n 's/.*\"version\":\"\([0-9][0-9.]*\)\".*/\1/p'); \
       if [ \"\$v\" = '${EXPECTED_APP_VERSION}' ]; then echo \"App 就绪：manifest \${v}\"; exit 0; fi; \
       sleep 2; \
     done; \
     echo \"App 探活失败：期望 ${EXPECTED_APP_VERSION}，实际 \${v:-无响应}\" >&2; exit 1"

echo "deploy done — 中枢 /api/ping ok，App manifest ${EXPECTED_APP_VERSION} 在跑"
