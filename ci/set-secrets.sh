#!/usr/bin/env bash
# Загружает ключ подписи Android из ~/.sloi-signing в секреты репозитория GitHub.
# Запускать один раз, локально:  bash ci/set-secrets.sh
set -euo pipefail

ENV_FILE="${1:-$HOME/.sloi-signing/keystore.env}"
[ -f "$ENV_FILE" ] || { echo "Не найден $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

base64 -i "$SLOI_KEYSTORE_FILE" | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64
printf '%s' "$SLOI_KEYSTORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD
printf '%s' "$SLOI_KEY_ALIAS"         | gh secret set ANDROID_KEY_ALIAS
printf '%s' "$SLOI_KEY_PASSWORD"      | gh secret set ANDROID_KEY_PASSWORD

echo
gh secret list
echo
echo "Готово. Сохраните копию ключа: $(dirname "$SLOI_KEYSTORE_FILE") — без него нельзя выпускать обновления."
