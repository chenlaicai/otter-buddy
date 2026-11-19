#!/usr/bin/env bash
# 中枢代码部署脚本——从本机把构建产物推上 ECS 并重启服务。
# 用法：在【本机】仓库根跑 bash deploy/ecs/deploy.sh
# 传输统一走 .otter/deploy-keys/ecs-ssh.sh（ssh 管道 + 远端 sudo tar 解包）——
# 单一路径单一身份（admin），不做 rsync 直连双分支。
# 边界：只管代码与配置面；数据迁移是后续 migrate-* 脚本职责，不碰 /var/lib/otter-buddy。
set -euo pipefail

SSH="sh .otter/deploy-keys/ecs-ssh.sh"
REMOTE_CODE="/opt/otter-buddy"

# 前置：本地构建（dist/ 生成；模型下载失败不阻断——云端嵌入走 off 开关）
npm run build

# 打包（排除本地数据/依赖/模型/密钥目录与本地 config）→ ssh 管道 → 远端原子换装
tar --exclude='./.git' --exclude='./node_modules' --exclude='./data' --exclude='./models' \
    --exclude='./.otter' --exclude='./.claude' --exclude='./.githooks' \
    --exclude='./config/config.yaml' \
    --exclude='./web/node_modules' \
    -czf - ./ \
  | $SSH "cat > /tmp/otter-deploy.tgz \
      && sudo rm -rf ${REMOTE_CODE}.new \
      && sudo mkdir -p ${REMOTE_CODE}.new \
      && sudo tar -xzf /tmp/otter-deploy.tgz -C ${REMOTE_CODE}.new \
      && sudo rsync -a --delete --exclude node_modules --exclude data ${REMOTE_CODE}.new/ ${REMOTE_CODE}/ \
      && sudo rm -rf ${REMOTE_CODE}.new /tmp/otter-deploy.tgz"

# 远端：装生产依赖 + 重启 + 探活（/api/ping 就绪即部署成功）
$SSH "cd ${REMOTE_CODE} && sudo /opt/node24/bin/npm ci --omit=dev --silent \
  && sudo systemctl restart otter-buddy \
  && for i in \$(seq 1 45); do curl -fsS http://127.0.0.1:3000/api/ping && echo && exit 0; sleep 2; done \
  && echo 'health check failed: /api/ping not ready in 90s' >&2 && exit 1"

echo "deploy done — /api/ping ok, service active"
