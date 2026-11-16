/**
 * KRAKEN QUANT ENGINE // 24/7 AUTONOMOUS CLOUD DAEMON RUNNER
 * Castillo Imperial Holding S.A.
 * 
 * Corre 24/7 en servidor cloud autónomo (PC apagado).
 * Funcionalidades:
 * - Supervisa el motor Anastasia con las 8 Pistas en 5m, 15m, 1H.
 * - Watchdog interno: Captura errores y alerta a Pedro por Telegram.
 * - Auto-Sync a Firebase Hosting cada 5 minutos.
 * - Health Check HTTP Server en puerto $PORT (Render / Cloud Web Service).
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const anastasiaEngine = require('./anastasia_autonomous_engine');
const firestoreStore = require('./firestore_store');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PORT = process.env.PORT || 10000;

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
// HTTP HEALTH CHECK & API SERVER (PARA RENDER / SERVIDORES CLOUD)
// ------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const url = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (url === '/trading_state.json') {
        const statePath = path.join(__dirname, '..', 'public', 'trading_state.json');
        if (fs.existsSync(statePath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return fs.createReadStream(statePath).pipe(res);
        }
    }

    // ENDPOINT VELAS REALES (ALPACA IEX/CRYPTO -> TRADINGVIEW LIGHTWEIGHT CHARTS)
    if (url === '/bars') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'TSLA';
        const tf = parsedUrl.searchParams.get('tf') || '5m';
        let rawBars = anastasiaEngine.getLatestBars(symbol, tf);
        if (!rawBars || rawBars.length === 0) {
            await anastasiaEngine.fetchMarketQuotes().catch(() => {});
            rawBars = anastasiaEngine.getLatestBars(symbol, tf);
        }
        const seenTimes = new Set();
        const candles = (rawBars || [])
            .map(b => ({
                time: Math.floor(new Date(b.t).getTime() / 1000),
                open: parseFloat(b.o),
                high: parseFloat(b.h),
                low: parseFloat(b.l),
                close: parseFloat(b.c),
                volume: parseFloat(b.v || 0)
            }))
            .filter(c => Number.isFinite(c.time) && Number.isFinite(c.close))
            .sort((a, b) => a.time - b.time)
            .filter(c => {
                if (seenTimes.has(c.time)) return false;
                seenTimes.add(c.time);
                return true;
            });

        const lastRaw = (rawBars && rawBars.length > 0) ? rawBars[rawBars.length - 1] : null;
        const st = anastasiaEngine.getEngineState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            symbol,
            tf,
            candles,
            count: candles.length,
            lastBarTime: lastRaw ? lastRaw.t : null,
            liveQuote: (st.liveQuotes && st.liveQuotes[symbol.toUpperCase()]) || (candles.length ? candles[candles.length - 1].close : null),
            indicators: lastRaw ? {
                ema9: lastRaw.ema9,
                ema21: lastRaw.ema21,
                atr: lastRaw.atr,
                vwap: lastRaw.vwap,
                rsi: lastRaw.rsi,
                rvol: lastRaw.rvol,
                supertrend: lastRaw.supertrend
            } : null
        }));
    }

    // ENDPOINT CEREBRO SOBERANO KRAKEN (RENDER / CLOUD 24/7)
    if (url === '/cerebro') {
        const st = anastasiaEngine.getEngineState();
        const lm = st.liveMetrics || {};
        const dd = isFinite(lm.dailyDrawdownPct) ? lm.dailyDrawdownPct : 0.00;
        const alpBal = st.accountBalances?.alpaca || 'PENDIENTE_API';
        const pepBal = st.accountBalances?.pepperstone || 'PENDIENTE_API';
        const perf = st.performanceStats?.global || {};

        if (req.method === 'GET') {
            const romeDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
            const hist = Array.isArray(st.closedTradesHistory) ? st.closedTradesHistory : [];
            const todayTrades = hist.filter(t => t.closedAt && new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date(t.closedAt)) === romeDate);
            const alpNum = isFinite(lm.alpacaPortfolioUsd) ? lm.alpacaPortfolioUsd : null;
            const pepNum = isFinite(lm.pepperstoneBalanceEur) ? lm.pepperstoneBalanceEur : null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                ok: true,
                status: 'ONLINE_24_7',
                piso: 2,
                reina: 'Anastasia',
                rol: 'Chief Investment Officer & Quant Lead',
                doctrina: 'Verdad Factual Pura & Frialdad Matemática Rusa',
                alpacaBalance: alpNum,
                pepperstoneBalance: pepNum,
                alpacaBalanceLabel: alpBal,
                pepperstoneBalanceLabel: pepBal,
                alpacaPnlToday: parseFloat((st.dailyRealizedPnlUSD || 0).toFixed(2)),
                pepperstonePnlToday: parseFloat((st.dailyRealizedPnlEUR || 0).toFixed(2)),
                currentDrawdownPct: dd,
                maxDailyDrawdownLimit: 2.50,
                emergencyStop: !!st.emergencyStop,
                tradesTodayCount: todayTrades.length,
                balancesAuditados: {
                    alpacaPaper: alpBal,
                    alpacaPaperUsd: alpNum,
                    pepperstoneEcn: pepBal,
                    pepperstoneEcnEur: pepNum,
                    dailyReturnPct: lm.dailyReturnPct ?? 0.00,
                    currentDrawdownPct: dd,
                    maxDailyDrawdownLimit: 2.50,
                    statusRiesgo: st.emergencyStop ? '🚨 KILL SWITCH ACTIVO' : (dd >= 2.50 ? '🚨 KILL SWITCH' : (dd >= 2.00 ? '🟡 ALERTA' : `🟢 PROTEGIDO (${dd.toFixed(2)}% DD)`))
                },
                timeframes: ['5m', '15m', '1H', '4H'],
                estrategias: 8,
                estadisticas: perf,
                posicionesAbiertasMotor: (st.openPositions || []).length,
                posicionesRealesAlpaca: st.brokerReconciliation?.alpacaPositions?.length ?? null,
                posicionesRealesCTrader: st.brokerReconciliation?.ctraderRealCount ?? null,
                firestorePersisted: firestoreStore.isConfigured(),
                filtroRVol: 'Activo (rVol >= 1.5 en SOL)',
                serverTime: new Date().toISOString()
            }, null, 2));
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const parsed = body ? JSON.parse(body) : {};
                    const rawText = (parsed.contents && parsed.contents[0] && parsed.contents[0].parts && parsed.contents[0].parts[0].text) || 'Reporte de estado';
                    const attachedParts = (parsed.contents && parsed.contents[0] && parsed.contents[0].parts) ? parsed.contents[0].parts.slice(1) : [];

                    const systemPrompt = `Eres 🇷🇺 Anastasia, CIO del Piso 2 (Kraken Quant Fund) de Castillo Imperial Holding S.A.
DOCTRINA DE VERDAD FACTUAL PURA (CERO SUPOSICIONES):
- Saldos reales auditados ahora mismo en vivo:
  • Alpaca Paper Algorithmic: ${alpBal} (${st.brokerReconciliation?.alpacaPositions?.length ?? 'N/A'} pos API)
  • Pepperstone cTrader ECN (#4285238): ${pepBal} (${st.brokerReconciliation?.ctraderRealCount ?? 'N/A'} pos cTrader)
  • Drawdown Diario Real: ${dd.toFixed(2)}% (Límite: 2.50% | Kill Switch: ${st.emergencyStop ? 'ACTIVO' : 'INACTIVO'})
  • Temporalidades activas: 5m, 15m, 1H, 4H (1m eliminado)
  • Estadísticas reales cerradas (${perf.total || 0} trades): WR ${perf.winRate || 0}%, PF ${perf.profitFactor || 0}, PnL Neto $${perf.netPnlUSD || 0} USD
  • Posiciones en libreta motor: ${(st.openPositions || []).length}
  • Persistencia Google Firestore (kraken-trading-cloud): ${firestoreStore.isConfigured() ? 'ACTIVA' : 'PENDIENTE DE CREDENCIAL'}
- TERMINANTEMENTE PROHIBIDO INVENTAR OPERACIONES, WIN RATES O RESULTADOS SIMULADOS.
- Si falta un dato: "DATO NO REGISTRADO: [motivo técnico]".
- FRIALDAD MATEMÁTICA RUSA: concisa, sin rodeos, cero adulación («cero sobona»).`;

                    const geminiPayload = {
                        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nConsulta de Pedro: ${rawText}` }, ...attachedParts] }]
                    };

                    // Autonomía total de Piso 2 (Cero dependencia de Valentina / otros pisos):
                    // 1. Intentar Google AI Studio (generativelanguage.googleapis.com) con GEMINI_AI_STUDIO_KEY o GEMINI_API_KEY
                    const studioKey = process.env.GEMINI_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
                    const vertexKey = process.env.GEMINI_API_KEY || '';
                    let lastErr = null;

                    if (studioKey) {
                        const studioModels = [
                            process.env.GEMINI_STUDIO_MODEL,
                            'gemini-3-flash-preview',
                            'gemini-3.5-flash-lite',
                            'gemini-flash-lite-latest',
                            'gemini-3.1-flash-lite-preview'
                        ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

                        for (const modelName of studioModels) {
                            const studioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${studioKey}`;
                            try {
                                const sRes = await fetch(studioUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(geminiPayload)
                                });
                                const sJson = await sRes.json();
                                if (sRes.ok && sJson && !sJson.error && sJson.candidates) {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    return res.end(JSON.stringify(sJson));
                                }
                                lastErr = sJson;
                                if (sRes.status === 401 || sRes.status === 403 || sJson?.error?.details?.some?.(d => d.reason === 'API_KEY_INVALID')) {
                                    break;
                                }
                            } catch(sErr) { lastErr = { error: { message: sErr.message } }; }
                        }
                    }

                    // 2. Intentar Vertex AI directo con GEMINI_API_KEY propio
                    if (vertexKey) {
                        const vertexUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${process.env.GEMINI_MODEL || 'gemini-3-flash-preview'}:generateContent?key=${vertexKey}`;
                        try {
                            const vRes = await fetch(vertexUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(geminiPayload)
                            });
                            const vJson = await vRes.json();
                            if (vRes.ok && vJson && !vJson.error && vJson.candidates) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify(vJson));
                            }
                            lastErr = vJson;
                        } catch(vErr) { lastErr = { error: { message: vErr.message } }; }
                    }

                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(lastErr || { error: { message: 'GEMINI_API_KEY / GEMINI_AI_STUDIO_KEY sin acceso o créditos en Render.' } }));
                } catch(e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ONLINE',
        service: 'Kraken Autonomous Cloud Daemon',
        director: 'Pedro Castillo',
        holding: 'Castillo Imperial Holding S.A.',
        serverTimeRome: new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Rome' }),
        strategies: 8,
        activeAssets: ['TSLA', 'NVDA', 'GLD/XAUUSD', 'SOLUSD'],
        maxPositions: 24,
        firestorePersisted: firestoreStore.isConfigured(),
        uptimeSeconds: Math.floor(process.uptime())
    }, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 [Cloud Server] Health HTTP Server escuchando en 0.0.0.0:${PORT}`);
});

// ------------------------------------------------------------------------------
// AUTO-DEPLOY A FIREBASE HOSTING CADA 5 MINUTOS (SI FIREBASE_TOKEN ESTÁ PRESENTE)
// ------------------------------------------------------------------------------
let isDeploying = false;
function autoDeployHosting() {
    // DESACTIVADO POR DEFECTO (fix crash-loop 11-nov): la web pública ya lee
    // trading_state.json directamente de Render (/trading_state.json), por lo
    // que este deploy es redundante. Ejecutar `npx --yes firebase-tools deploy`
    // cada 5 min descargaba ~100MB en la instancia gratuita de 512MB de Render
    // y provocaba OOM -> reinicios constantes -> 502. Solo se reactiva si se
    // define ENABLE_FIREBASE_AUTODEPLOY=true en el entorno.
    if (process.env.ENABLE_FIREBASE_AUTODEPLOY !== 'true') {
        return;
    }
    if (isDeploying) return;
    if (!process.env.FIREBASE_TOKEN) {
        console.log('[Firebase Auto-Deploy] Nota: FIREBASE_TOKEN no configurado aún en Render. Omitiendo deploy a Hosting.');
        return;
    }
    isDeploying = true;

    const projectRoot = path.join(__dirname, '..');
    const cmd = `npx --yes firebase-tools deploy --project kraken-trading-cloud --only hosting --non-interactive --token "${process.env.FIREBASE_TOKEN}"`;

    console.log('[Firebase Auto-Deploy] Iniciando sincronización con Firebase Hosting...');
    exec(cmd, { 
        cwd: projectRoot,
        env: Object.assign({}, process.env, { FIREBASE_TOKEN: process.env.FIREBASE_TOKEN })
    }, (error, stdout, stderr) => {
        isDeploying = false;
        const now = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Rome' });
        if (error) {
            console.error(`[Firebase Auto-Deploy ${now}] ERROR DETALLADO:`, error.message);
            if (stderr) console.error(`[Firebase Auto-Deploy ${now}] STDERR:`, stderr);
        } else {
            console.log(`[Firebase Auto-Deploy ${now}] ✅ Web pública sincronizada con éxito en Firebase Hosting.`);
            if (stdout) console.log(`[Firebase Auto-Deploy ${now}] STDOUT:`, stdout.slice(0, 300));
        }
    });
}

// ------------------------------------------------------------------------------
// KEEP-ALIVE ANTI-SLEEP (RENDER FREE TIER PREVENT 15-MIN INACTIVITY)
// ------------------------------------------------------------------------------
function startInternalKeepAlive() {
    setInterval(() => {
        const keepAliveUrl = 'https://kraken-cloud.onrender.com/health';
        const httpsClient = require('https');
        httpsClient.get(keepAliveUrl, (res) => {
            console.log(`💓 [Keep-Alive Ping] Status: ${res.statusCode} (Render container despierto)`);
        }).on('error', (err) => {
            console.warn('💓 [Keep-Alive Ping Error]:', err.message);
        });
    }, 240000); // Cada 4 minutos (240,000 ms) para nunca llegar a los 15 min de inactividad
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
    console.log('   Pistas: 8 Estrategias x 4 Activos x 5m/15m/1H/4H');
    console.log('================================================================');

    // 1. Iniciar motor autónomo (escaneo cada 30 segundos)
    anastasiaEngine.startAutonomousDaemon(30000);

    // 2. Iniciar Keep-Alive interno anti-sleep (cada 4 min)
    startInternalKeepAlive();

    // 3. Programar Auto-Deploy a Firebase Hosting cada 5 minutos (300,000 ms)
    setInterval(autoDeployHosting, 300000);
    setTimeout(autoDeployHosting, 60000);

    // 3. Notificación de Arranque a Pedro
    const bootMsg = `👑✨ <b>[KRAKEN CLOUD // LABORATORIO 24/7 EN LÍNEA]</b>\n` +
        `─────────────────────────\n` +
        `Comandante Pedro, el motor cuántico está corriendo en el servidor autónomo Render.\n\n` +
        `🏛️ <b>Arquitectura Activa:</b>\n` +
        `• <b>8 Pistas:</b> P1 a P5 + P6 (RSI-2), P7 (ORB-30), P8 (TTM Squeeze)\n` +
        `• <b>4 Activos:</b> TSLA, NVDA, Oro (GLD/XAU), SOL/USD\n` +
        `• <b>Temporalidades:</b> 5m, 15m, 1H y 4H\n` +
        `• <b>Brokers en Duelo:</b> Alpaca Paper API vs Pepperstone cTrader #4285238 (consulta live)\n` +
        `• <b>Tope Concurrencia:</b> Máximo 24 posiciones en Pepperstone\n` +
        `• <b>Auto-Sync Web:</b> Cada 5 min a https://kraken-trading-cloud.web.app\n\n` +
        `<i>Tu PC puede apagarse con total tranquilidad. El Kraken vigila el mercado 24/7.</i>`;

    await sendTelegramAlert(bootMsg);
    console.log('📱 Notificación de inicio enviada a Pedro por Telegram.');
}

if (require.main === module) {
    startServerDaemon();
}

module.exports = {
    startServerDaemon
};
