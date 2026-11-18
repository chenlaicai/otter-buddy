#!/usr/bin/env bash
# 中枢代码部署脚本（阶段 6a）——从本机把构建产物推上 ECS 并重启服务
# 用法：在【本机】仓库根跑 bash deploy/ecs/deploy.sh
# 边界：只管代码与配置面；数据迁移是 6b 的 migrate-* 脚本职责，本脚本不碰 /var/lib/otter-buddy 内容
set -euo pipefail

SSH="sh .otter/deploy-keys/ecs-ssh.sh"
REMOTE_CODE="/opt/otter-buddy"

# 前置：本地构建（dist/ 生成；模型下载失败不阻断——云端嵌入走 off 开关）
npm run build

# 推代码：仓库内容（含 dist/src、web、package*.json、scripts），排除本地数据/依赖/模型
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude 'models' \
  --exclude '.otter' --exclude '.claude' --exclude '.githooks' \
  --exclude 'config/config.yaml' \
  -e "ssh -i $(grep -o '\-i [^ ]*' .otter/deploy-keys/ecs-ssh.sh | awk '{print $2}' || true)" \
  ./ "admin@60.205.214.148:${REMOTE_CODE}/" || {
    # rsync 直连不可达时回落 ssh 管道（deploy-key 脚本封装的场景）
    tar --exclude='./.git' --exclude='./node_modules' --exclude='./data' --exclude='./models' \
        --exclude='./.otter' --exclude='./.claude' --exclude='./.githooks' \
        --exclude='./config/config.yaml' -czf - ./ \
      | $SSH "cat > /tmp/otter-deploy.tgz && sudo rm -rf ${REMOTE_CODE}.new && sudo mkdir -p ${REMOTE_CODE}.new && sudo tar -xzf /tmp/otter-deploy.tgz -C ${REMOTE_CODE}.new && sudo rsync -a --delete --exclude data --exclude node_modules ${REMOTE_CODE}.new/ ${REMOTE_CODE}/ && sudo rm -rf ${REMOTE_CODE}.new /tmp/otter-deploy.tgz"
  }

# 远端：装生产依赖 + 重启 + 探活
$SSH "cd ${REMOTE_CODE} && sudo /opt/node24/bin/npm ci --omit=dev --silent \
  && sudo systemctl restart otter-buddy \
  && sleep 3 \
  && for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:3000/api/ping && break; sleep 2; done \
  && systemctl is-active otter-buddy"

echo "deploy done — /api/ping ok, service active"
