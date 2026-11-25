#!/bin/bash
# [CLAUDE v2.8] Actualiza el motor en la VM si hay commits nuevos en main.
# No usa "git reset --hard": los archivos de estado que escribe el motor (y que están en el repo)
# no se sobrescriben nunca con la copia vieja de GitHub.
set -euo pipefail
APP=/opt/kraken-cloud
cd "$APP"
git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$APP" || git config --system --add safe.directory "$APP"
git fetch -q origin main
NEW=$(git rev-parse origin/main)
OLD=$(cat .deployed_sha 2>/dev/null || git rev-parse HEAD)
[ "$NEW" = "$OLD" ] && exit 0

echo "[kraken-update] $(date -Is) $OLD -> $NEW"
git checkout -q origin/main -- . \
  ':(exclude)public/trading_state.json' \
  ':(exclude)functions/anastasia_trading_state.json'
# archivos borrados en GitHub (salvo los de estado)
git diff --name-only --diff-filter=D "$OLD" "$NEW" 2>/dev/null | grep -v -e '^public/trading_state.json$' -e '^functions/anastasia_trading_state.json$' | while read -r f; do rm -f -- "$f"; done || true
if git diff --name-only "$OLD" "$NEW" | grep -q -e '^package.json$' -e '^package-lock.json$'; then
  npm install --omit=dev --no-audit --no-fund
fi
echo "$NEW" > .deployed_sha
chown -R kraken:kraken "$APP"
# si cambió el propio instalador, se vuelve a aplicar (idempotente)
if git diff --name-only "$OLD" "$NEW" | grep -q '^deploy/gcp_vm_setup.sh$'; then bash deploy/gcp_vm_setup.sh; fi
[ -f functions/.env ] && systemctl restart kraken.service
echo "[kraken-update] motor reiniciado con $NEW"
