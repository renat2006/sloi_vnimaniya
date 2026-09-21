#!/usr/bin/env bash
set -euo pipefail

HOST="${SLOI_HOST:-ubuntu@195.209.218.212}"
KEY="${SLOI_KEY:-$HOME/.ssh/privatekey-1015937.pem}"
DIR="/opt/sloi"

echo "→ отправляю файлы на $HOST:$DIR"
rsync -az --delete -e "ssh -i $KEY" \
  --exclude '.git' --exclude '.claude' --exclude '*.pem' --exclude 'deploy.sh' \
  ./ "$HOST:$DIR/"

echo "→ перезапускаю сервис"
ssh -i "$KEY" "$HOST" 'sudo systemctl restart sloi && sleep 1 && systemctl is-active sloi'

echo "→ проверяю"
ssh -i "$KEY" "$HOST" 'curl -s http://127.0.0.1:4173/presence/health'
echo
echo "готово: https://sloi.renat.site"
