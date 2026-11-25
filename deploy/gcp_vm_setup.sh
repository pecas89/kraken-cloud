#!/bin/bash
# ==============================================================================
# KRAKEN // Instalación en Google Compute Engine (e2-micro, Ubuntu 22.04/24.04)
# [CLAUDE v2.8] Se usa como "startup-script" de la VM: es idempotente (se puede repetir sin romper nada).
#
# Qué hace:
#   1. Swap de 1 GB (la e2-micro tiene 1 GB de RAM).
#   2. Node.js 22, git y Caddy (HTTPS automático con Let's Encrypt).
#   3. Descarga el motor desde GitHub (repo público) en /opt/kraken-cloud.
#   4. Servicio systemd "kraken" (se reinicia solo si se cae). NO arranca hasta que exista functions/.env.
#   5. HTTPS en https://<ip-con-guiones>.sslip.io -> motor (puerto 10000), con gzip.
#   6. Actualización automática cada 5 min desde la rama main (sin tocar los archivos de estado).
#
# Las claves (Alpaca, Pepperstone, Telegram, Firestore...) NO están aquí: van en
# /opt/kraken-cloud/functions/.env, que crea Pedro dentro de la VM (permisos 600).
# ==============================================================================
set -euo pipefail
APP=/opt/kraken-cloud
REPO=https://github.com/pecas89/kraken-cloud.git
log(){ echo "[kraken-setup] $*"; }

# 1. Swap
if ! swapon --show | grep -q '/swapfile'; then
  log "creando swap de 1 GB"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Paquetes
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  log "instalando Node.js 22"
  apt-get update -y && apt-get install -y curl ca-certificates gnupg git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null || apt-get install -y git
if ! command -v caddy >/dev/null; then
  log "instalando Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# 3. Usuario y código
id kraken >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin kraken
if [ ! -d "$APP/.git" ]; then
  log "clonando el repositorio"
  git clone --depth 50 "$REPO" "$APP"
  git -C "$APP" rev-parse HEAD > "$APP/.deployed_sha"
fi
cd "$APP"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev
mkdir -p "$APP/logs"
chown -R kraken:kraken "$APP"
[ -f "$APP/functions/.env" ] && chmod 600 "$APP/functions/.env" || true

# 4. Servicio del motor (UNA sola instancia: nunca dos motores operando a la vez)
cat > /etc/systemd/system/kraken.service <<'UNIT'
[Unit]
Description=Kraken / Anastasia - motor de trading DEMO
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/kraken-cloud/functions/.env

[Service]
User=kraken
WorkingDirectory=/opt/kraken-cloud
Environment=NODE_ENV=production
Environment=PORT=10000
ExecStart=/usr/bin/node functions/autonomous_daemon_runner.js
Restart=always
RestartSec=10
MemoryMax=800M
StandardOutput=append:/opt/kraken-cloud/logs/kraken.log
StandardError=append:/opt/kraken-cloud/logs/kraken.log

[Install]
WantedBy=multi-user.target
UNIT

# 5. HTTPS con Caddy en <ip>.sslip.io
IP=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
if [ -n "$IP" ]; then
  DOMAIN="${IP//./-}.sslip.io"
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:10000
}
CADDY
  echo "$DOMAIN" > "$APP/.public_domain"
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  log "URL pública del motor: https://$DOMAIN"
fi

# 6. Actualización automática desde GitHub cada 5 min
cat > /etc/systemd/system/kraken-update.service <<'UNIT'
[Unit]
Description=Kraken - actualizar el motor desde GitHub (main)
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/kraken-cloud/deploy/gcp_update.sh
UNIT
cat > /etc/systemd/system/kraken-update.timer <<'UNIT'
[Unit]
Description=Kraken - comprobar actualizaciones cada 5 minutos
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable kraken.service kraken-update.timer >/dev/null 2>&1
systemctl start kraken-update.timer
if [ -f "$APP/functions/.env" ]; then
  systemctl restart kraken.service
  log "motor arrancado"
else
  log "FALTA $APP/functions/.env: el motor NO arranca hasta que exista (ver deploy/GOOGLE_VM.md)"
fi
log "listo"
