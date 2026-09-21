#!/usr/bin/env bash
set -euo pipefail

[ -f .deploy.env ] && . ./.deploy.env

HOST="${SLOI_HOST:-}"
KEY="${SLOI_KEY:-}"
DIR="${SLOI_DIR:-/opt/sloi}"

if [ -z "$HOST" ]; then
  echo "Укажите адрес сервера: SLOI_HOST=user@host ./deploy.sh"
  echo "Или создайте файл .deploy.env со строками SLOI_HOST= и SLOI_KEY="
  exit 1
fi

SSH=(ssh)
[ -n "$KEY" ] && SSH=(ssh -i "$KEY")

echo "→ отправляю файлы на $HOST:$DIR"
rsync -az --delete -e "${SSH[*]}" \
  --exclude '.git' --exclude '.claude' --exclude '*.pem' \
  --exclude 'deploy.sh' --exclude '.deploy.env' --exclude 'sloi.db*' \
  ./ "$HOST:$DIR/"

echo "→ перезапускаю сервис"
"${SSH[@]}" "$HOST" 'sudo systemctl restart sloi && sleep 1 && systemctl is-active sloi'

echo "→ проверяю"
"${SSH[@]}" "$HOST" 'curl -s http://127.0.0.1:4173/presence/health'
echo
echo "готово"
