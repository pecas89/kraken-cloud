#!/bin/bash
# ==============================================================================
# CASTILLO IMPERIAL HOLDING S.A. // KRAKEN SERVER SETUP SCRIPT
# Configura un VPS Ubuntu 24.04 / 22.04 para correr 24/7 de forma autónoma.
# ==============================================================================

set -e

echo "🚀 [KRAKEN CLOUD] Iniciando aprovisionamiento del servidor..."

# 1. Actualizar sistema
apt update && apt upgrade -y
apt install -y curl wget git build-essential ufw

# 2. Configurar Firewall Básico
ufw allow OpenSSH
ufw --force enable

# 3. Instalar Node.js 22 LTS
if ! command -v node &> /dev/null; then
    echo "📦 Instalando Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
fi

node -v
npm -v

# 4. Instalar PM2 y Firebase CLI globalmente
npm install -g pm2 firebase-tools

# 5. Crear directorio de logs
mkdir -p /root/kraken-cloud/logs

# 6. Instalar dependencias en functions/
if [ -d "/root/kraken-cloud/functions" ]; then
    cd /root/kraken-cloud/functions
    npm install
    cd /root/kraken-cloud
fi

# 7. Configurar PM2 para iniciar con el sistema operativo
pm2 startup systemd -u root --hp /root
pm2 save

echo "================================================================="
echo "✅ SERVIDOR APROVISIONADO CON ÉXITO."
echo "Próximo paso: Copiar el archivo .env a /root/kraken-cloud/functions/.env"
echo "Luego arrancar con: pm2 start ecosystem.config.js && pm2 save"
echo "================================================================="
