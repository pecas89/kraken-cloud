/**
 * KRAKEN QUANT ENGINE // 24/7 AUTONOMOUS CLOUD DAEMON RUNNER
 * Castillo Imperial Holding S.A.
 * 
 * Corre 24/7 en servidor cloud autónomo (PC apagado).
 * Funcionalidades:
 * - Supervisa el motor Anastasia con las 8 Pistas en 5m, 15m, 1H.
 * - Watchdog interno: Captura errores y alerta a Pedro por Telegram.
 * - Auto-Sync a Firebase Hosting cada 5 minutos.
 * - Heartbeat periódico de telemetría a Pedro Castillo.
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const anastasiaEngine = require('./anastasia_autonomous_engine');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegramAlert(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    const https = require('https');
    const payload = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
    });

    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(true));
        });
        req.on('error', () => resolve(false));
        req.write(payload);
        req.end();
    });
}

// ------------------------------------------------------------------------------
// AUTO-DEPLOY A FIREBASE HOSTING CADA 5 MINUTOS (WEB PÚBLICA 24/7 VIVA)
// ------------------------------------------------------------------------------
let isDeploying = false;
function autoDeployHosting() {
    if (isDeploying) return;
    isDeploying = true;

    const projectRoot = path.join(__dirname, '..');
    const cmd = 'firebase deploy --only hosting --non-interactive';

    exec(cmd, { cwd: projectRoot }, (error, stdout, stderr) => {
        isDeploying = false;
        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Rome' });
        if (error) {
            console.warn(`[Firebase Auto-Deploy ${now}] Advertencia:`, error.message);
        } else {
            console.log(`[Firebase Auto-Deploy ${now}] ✅ Web pública sincronizada con éxito en la nube.`);
        }
    });
}

// ------------------------------------------------------------------------------
// GESTIÓN DE ERRORES Y WATCHDOG
// ------------------------------------------------------------------------------
process.on('uncaughtException', async (err) => {
    console.error('🚨 [WATCHDOG FATAL ERROR]', err);
    await sendTelegramAlert(
        `🚨 <b>[ALERTA SERVIDOR KRAKEN]</b>\n` +
        `Error no capturado en daemon autónomo:\n` +
        `<code>${err.message}</code>\n` +
        `<i>Reiniciando ciclo de rescate automático...</i>`
    );
});

process.on('unhandledRejection', (reason, promise) => {
    console.warn('⚠️ [WATCHDOG UNHANDLED PROMISE]', reason);
});

// ------------------------------------------------------------------------------
// ARRANQUE DEL LABORATORIO EN SERVIDOR
// ------------------------------------------------------------------------------
async function startServerDaemon() {
    console.log('================================================================');
    console.log('🏛️ CASTILLO IMPERIAL HOLDING // KRAKEN AUTONOMOUS CLOUD SERVER');
    console.log('   Director: Pedro Castillo');
    console.log('   Modo: 24/7 Cloud Daemon (PC Apagado)');
    console.log('   Pistas: 8 Estrategias x 4 Activos x 5m/15m/1H');
    console.log('================================================================');

    // 1. Iniciar motor autónomo (escaneo cada 30 segundos)
    anastasiaEngine.startAutonomousDaemon(30000);

    // 2. Programar Auto-Deploy a Firebase Hosting cada 5 minutos (300,000 ms)
    setInterval(autoDeployHosting, 300000);
    // Primer deploy tras 1 minuto para asentar estado
    setTimeout(autoDeployHosting, 60000);

    // 3. Notificación de Arranque a Pedro
    const bootMsg = `👑✨ <b>[KRAKEN CLOUD // LABORATORIO 24/7 EN LÍNEA]</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Comandante Pedro, el motor cuántico está corriendo en el servidor autónomo.\n\n` +
        `🏛️ <b>Arquitectura Activa:</b>\n` +
        `• <b>8 Pistas:</b> P1 a P5 + P6 (RSI-2), P7 (ORB-30), P8 (TTM Squeeze)\n` +
        `• <b>4 Activos:</b> TSLA, NVDA, Oro (GLD/XAU), SOL/USD\n` +
        `• <b>Temporalidades:</b> 5m, 15m y 1H\n` +
        `• <b>Brokers en Duelo:</b> Alpaca Paper ($100k) vs Pepperstone cTrader (€10k)\n` +
        `• <b>Tope Concurrencia:</b> Máximo 24 posiciones en Pepperstone\n` +
        `• <b>Auto-Sync Web:</b> Cada 5 min a https://kraken-trading-cloud.web.app\n\n` +
        `<i>Tu PC puede apagarse con total tranquilidad. El Kraken vigila el mercado 24/7.</i>`;

    await sendTelegramAlert(bootMsg);
    console.log('📲 Notificación de inicio enviada a Pedro por Telegram.');
}

if (require.main === module) {
    startServerDaemon();
}

module.exports = {
    startServerDaemon
};
