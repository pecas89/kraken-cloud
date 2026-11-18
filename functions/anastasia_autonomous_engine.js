/**
 * ==============================================================================
 * KRAKEN CLOUD // ANASTASIA AUTONOMOUS TRADING ENGINE 24/7 (PISO 2 • CIO)
 * ==============================================================================
 * Mandato Supremo: 100% Autónomo. Cero intervención manual de Pedro ("franc").
 * Anastasia abre, gestiona (Trailing BE) y cierra posiciones reales en los 4 activos:
 * 1. 🚗 TSLA (Tesla)      -> Alpaca Markets Paper & Pepperstone cTrader #4285238
 * 2. 💚 NVDA (Nvidia)     -> Alpaca Markets Paper & Pepperstone cTrader #4285238
 * 3. 🥇 XAUUSD / GLD (Oro)-> Pepperstone cTrader ECN & Alpaca ETF GLD
 * 4. 🟣 SOLUSD (Solana)   -> Pepperstone cTrader & Alpaca Crypto 24/7
 * 
 * Regla Cuantitativa Oficial (Mandato Pedro 16-Nov-2026):
 * - Marcos Temporales: 5m, 15m, 1H, 4H (1m eliminado)
 * - Las 8 Pistas Cuantitativas: P1 a P8 (cada estrategia usa sus propios filtros y R:R)
 * - Candados Transversales: DD Diario Máx 2.50% (Kill Switch), rVol SOL >= 1.5x,
 *   Ventana bursátil L-V 15:30-21:30 Roma, Cooldown anti-churn y Control Real por API.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const alpacaService = require('./alpaca_service');
const pepperstoneService = require('./pepperstone_centinela');
const ti = require('./technical_indicators');
const { evaluateStrategiesForBar } = require('./strategy_signals');
const firestoreStore = require('./firestore_store');

const PROMO_MATRIX_FILE = path.join(__dirname, 'promoted_strategies.json');
let promotedMatrix = null;
function loadPromotedMatrix() {
    if (fs.existsSync(PROMO_MATRIX_FILE)) {
        try {
            promotedMatrix = JSON.parse(fs.readFileSync(PROMO_MATRIX_FILE, 'utf8'));
        } catch(e) {}
    }
}
loadPromotedMatrix();

// ⏱️ Las 4 Temporalidades Cuantitativas Sagradas (Mandato Pedro 16-Nov: 5m, 15m, 1H, 4H - Cero Ruido de 1m)
const TIMEFRAMES = [
    { code: '5Min', label: '5m' },
    { code: '15Min', label: '15m' },
    { code: '1Hour', label: '1H' },
    { code: '4Hour', label: '4H' }
];

let latestEnrichedBars = {
    NVDA: { '5m': [], '15m': [], '1H': [], '4H': [] },
    TSLA: { '5m': [], '15m': [], '1H': [], '4H': [] },
    XAUUSD: { '5m': [], '15m': [], '1H': [], '4H': [] },
    SOLUSD: { '5m': [], '15m': [], '1H': [], '4H': [] }
};

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const STATE_FILE = path.join(__dirname, 'anastasia_trading_state.json');

// Matriz de los 4 Activos Sagrados (DUELO HEAD-TO-HEAD: AMBOS BROKERS EN LAS 4 ACCIONES)
// [FIX CLAUDE 18-NOV] Laboratorio: hasta 10 estrategias x 4 marcos por símbolo
const MAX_ALPACA_SUBPOS_PER_SYMBOL = 40;
// [CLAUDE v2] Salidas: 'STD' = stop + breakeven + objetivo | 'STEP' = escalera de stops de Pedro (objetivo en 4 escalones; el stop sube al escalón anterior)
// Las dos patas de cada señal (duelPairId) usan salidas distintas: así se comparan sobre las MISMAS entradas.
const EXIT_MODE_BY_BROKER = { alpaca: 'STEP', pepperstone: 'STD' };
const ENGINE_VERSION = 'v2-2026-11-18';

const ASSETS_CONFIG = {
    NVDA: {
        symbol: 'NVDA',
        name: 'NVIDIA Corp.',
        currency: 'USD',
        alpacaSymbol: 'NVDA',
        alpacaQty: 1, // 1 acción (Mínimo capital en Alpaca)
        pepperstoneSymbol: 'NVDA',
        pepperstoneQty: 0.10, // 0.10 lotes CFD (Mínimo en Pepperstone para acciones US)
        baseAtr: 3.40
    },
    TSLA: {
        symbol: 'TSLA',
        name: 'Tesla, Inc.',
        currency: 'USD',
        alpacaSymbol: 'TSLA',
        alpacaQty: 1, // 1 acción
        pepperstoneSymbol: 'TSLA',
        pepperstoneQty: 0.10, // 0.10 lotes CFD (Mínimo en Pepperstone para acciones US)
        baseAtr: 6.80
    },
    XAUUSD: {
        symbol: 'XAUUSD',
        name: 'Oro al Contado / Spot Gold',
        currency: 'EUR',
        alpacaSymbol: 'GLD', // SPDR Gold Trust ETF en Alpaca para competir en Oro en igualdad
        alpacaQty: 1, // 1 acción
        pepperstoneSymbol: 'XAUUSD',
        pepperstoneQty: 0.01, // 0.01 micro-lotes CFD
        baseAtr: 18.50
    },
    SOLUSD: {
        symbol: 'SOLUSD',
        altSymbol: 'SOL/USD',
        name: 'Solana Crypto 24/7',
        currency: 'EUR',
        alpacaSymbol: 'SOL/USD',
        alpacaQty: 1, // 1 SOL
        pepperstoneSymbol: 'SOLUSD',
        pepperstoneQty: 0.01, // 0.01 micro-lotes CFD
        baseAtr: 2.10
    }
};

// Estado del Motor Autónomo de Anastasia
let engineState = {
    running: false,
    startedAt: new Date().toISOString(),
    lastScanAt: null,
    totalScans: 0,
    emergencyStop: false,
    emergencyStopReason: null,
    openPositions: [],
    closedTradesHistory: [],
    dailyRealizedPnlUSD: 0.0,
    dailyRealizedPnlEUR: 0.0,
    accountBalances: {
        alpaca: 'CONSULTANDO API...',
        pepperstone: 'CONSULTANDO API...'
    },
    latestScores: {
        NVDA: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null },
        TSLA: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null },
        XAUUSD: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null },
        SOLUSD: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null }
    },
    closedCooldowns: {},
    lastSignalBarTime: {},
    externalQty: { TSLA: 1 },
    lastDailyReconciliationDate: null
};

// Cargar estado persistente si existe y depurar restos legados
if (fs.existsSync(STATE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        engineState = { ...engineState, ...saved, running: true };
        if (!engineState.externalQty) engineState.externalQty = { TSLA: 1 };
        if (Array.isArray(engineState.closedTradesHistory)) {
            engineState.closedTradesHistory.forEach(t => {
                if (t && typeof t.broker === 'string' && t.broker.includes('200')) {
                    t.broker = 'Pepperstone cTrader ECN Razor';
                }
            });
        }
        if (engineState.latestScores) {
            Object.keys(engineState.latestScores).forEach(k => {
                if (k.endsWith('_1m')) delete engineState.latestScores[k];
            });
        }
        if (!engineState.lastSignalBarTime) engineState.lastSignalBarTime = {};
    } catch(e) {
        console.warn('[ANASTASIA ENGINE] Error cargando estado previo:', e.message);
    }
}

const PUBLIC_STATE_FILE = path.join(__dirname, '../public/trading_state.json');
function saveState(forceCloud = false) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(engineState, null, 2), 'utf8');
        fs.writeFileSync(PUBLIC_STATE_FILE, JSON.stringify(engineState, null, 2), 'utf8');
        firestoreStore.syncEngineState(engineState, forceCloud).catch(() => {});
    } catch(e) {
        console.error('[ANASTASIA ENGINE] Error guardando estado:', e.message);
    }
}

// ------------------------------------------------------------------------------
// ♻️ RECONSTRUCCIÓN TRAS REDESPLIEGUE (KIMI 13-NOV)
// Render free no tiene disco persistente: cada deploy reinicia el estado al
// snapshot de git. Si la libreta quedó vacía pero el broker tiene fills reales
// desde el reseteo, reconstruimos el historial con FIFO (verdad del broker).
// Las entradas reconstruidas llevan rebuiltFromFills: true y estrategia
// "(reconstruido Alpaca)" porque el broker no guarda la etiqueta de estrategia.
// ------------------------------------------------------------------------------
async function rebuildHistoryFromAlpacaFills(sinceIso) {
    try {
        const since = sinceIso ? new Date(sinceIso).getTime() : (Date.now() - 36 * 3600 * 1000);
        const afterParam = new Date(since).toISOString();
        let fills = [];
        let pageToken = null;
        for (let page = 0; page < 35; page++) {
            let url = `/account/activities/FILL?page_size=100&direction=asc&after=${encodeURIComponent(afterParam)}`;
            if (pageToken) url += '&page_token=' + encodeURIComponent(pageToken);
            const res = await alpacaService.alpacaRequest(url, 'GET');
            if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
            fills = fills.concat(res.data);
            pageToken = res.data[res.data.length - 1].id;
            if (res.data.length < 100) break;
        }
        fills = fills.filter(f => new Date(f.transaction_time).getTime() >= since);
        if (fills.length === 0) {
            console.log('♻️ [REBUILD] Sin fills nuevos desde el snapshot. Nada que reconstruir.');
            return 0;
        }

        const alpacaSymbolToTicker = { 'NVDA': 'NVDA', 'TSLA': 'TSLA', 'GLD': 'XAUUSD', 'SOLUSD': 'SOLUSD', 'SOL/USD': 'SOLUSD' };
        const books = {};
        const rebuilt = [];
        let lotSeq = 0;
        fills.forEach(f => {
            const sym = f.symbol;
            if (!books[sym]) books[sym] = [];
            const qty = parseFloat(f.qty);
            const price = parseFloat(f.price);
            if (f.side === 'buy') {
                books[sym].push({ qty, price, time: f.transaction_time });
            } else {
                let remaining = qty;
                while (remaining > 1e-9 && books[sym].length > 0) {
                    const lot = books[sym][0];
                    const take = Math.min(lot.qty, remaining);
                    const pnl = (price - lot.price) * take;
                    lotSeq++;
                    rebuilt.push({
                        id: `REBUILT-${f.id}-${lotSeq}`,
                        broker: 'Alpaca Markets Paper Algorithmic',
                        strategy: '(reconstruido Alpaca)',
                        symbol: alpacaSymbolToTicker[sym] || sym,
                        orderSymbol: sym === 'SOLUSD' ? 'SOL/USD' : sym,
                        qty: parseFloat(take.toFixed(6)),
                        currency: 'USD',
                        side: 'BUY',
                        entryPrice: lot.price,
                        exitPrice: price,
                        pnl: parseFloat(pnl.toFixed(sym.includes('SOL') ? 4 : 2)),
                        closeReason: '♻️ Reconstruido desde fills reales del broker (redespliegue)',
                        openedAt: lot.time,
                        closedAt: f.transaction_time,
                        brokerCloseExecuted: true,
                        rebuiltFromFills: true,
                        status: 'CLOSED'
                    });
                    lot.qty -= take;
                    remaining -= take;
                    if (lot.qty <= 1e-9) books[sym].shift();
                }
            }
        });

        if (rebuilt.length > 0) {
            rebuilt.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
            const existing = new Set((engineState.closedTradesHistory || []).map(t => t.id));
            const fresh = rebuilt.filter(t => !existing.has(t.id));
            engineState.closedTradesHistory = fresh.concat(engineState.closedTradesHistory || []);
            computePerformanceStats();
            console.log(`♻️ [REBUILD] Historial sincronizado desde Alpaca: +${fresh.length} trades reales recuperados.`);
            return fresh.length;
        }
        return 0;
    } catch(e) {
        console.warn('♻️ [REBUILD] Error reconstruyendo desde fills:', e.message);
        return 0;
    }
}

// ------------------------------------------------------------------------------
// 📲 TELEGRAM BROADCAST A PEDRO CASTILLO
// ------------------------------------------------------------------------------
async function notifyPedro(htmlText) {
    const payload = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: htmlText,
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
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ ok: res.statusCode === 200 }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.write(payload);
        req.end();
    });
}

// ------------------------------------------------------------------------------
// 📡 FEED DE MERCADO EN VIVO PARA LOS 4 ACTIVOS (VELAS REALES EN 4 TIMEFRAMES)
// ------------------------------------------------------------------------------
async function fetchMarketQuotes() {
    const quotes = {};
    const alpacaHeaders = {
        'APCA-API-KEY-ID': alpacaService.ALPACA_CONFIG.apiKey,
        'APCA-API-SECRET-KEY': alpacaService.ALPACA_CONFIG.secretKey
    };

    function fetchBarsUrl(url) {
        return new Promise((resolve) => {
            https.get(url, { headers: alpacaHeaders }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
                });
            }).on('error', () => resolve(null));
        });
    }

    // 25 días atrás para asegurar suficientes velas en 4H (mínimo 30-50 barras para EMA21 y ATR14)
    // MANDATO VERDAD FACTUAL: usar feed=iex + sort=desc + reverse() para obtener siempre las ÚLTIMAS 50 velas reales hasta HOY (nunca velas viejas).
    // [CLAUDE v2] 300 velas por marco (antes 50: EMA 50/200 y la P9 no tenían historia suficiente)
    const start = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();

    try {
        const fetchPromises = [];
        TIMEFRAMES.forEach(tf => {
            fetchPromises.push(
                fetchBarsUrl(`https://data.alpaca.markets/v2/stocks/NVDA/bars?timeframe=${tf.code}&limit=300&start=${encodeURIComponent(start)}&sort=desc&feed=iex`)
                    .then(data => ({ ticker: 'NVDA', tf: tf.label, bars: (data?.bars || []).slice().reverse() })),
                fetchBarsUrl(`https://data.alpaca.markets/v2/stocks/TSLA/bars?timeframe=${tf.code}&limit=300&start=${encodeURIComponent(start)}&sort=desc&feed=iex`)
                    .then(data => ({ ticker: 'TSLA', tf: tf.label, bars: (data?.bars || []).slice().reverse() })),
                fetchBarsUrl(`https://data.alpaca.markets/v2/stocks/GLD/bars?timeframe=${tf.code}&limit=300&start=${encodeURIComponent(start)}&sort=desc&feed=iex`)
                    .then(data => ({ ticker: 'XAUUSD', tf: tf.label, bars: (data?.bars || []).slice().reverse() })),
                fetchBarsUrl(`https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=SOL/USD&timeframe=${tf.code}&limit=300&start=${encodeURIComponent(start)}&sort=desc`)
                    .then(data => ({ ticker: 'SOLUSD', tf: tf.label, bars: (data?.bars?.['SOL/USD'] || []).slice().reverse() }))
            );
        });

        const [results, stockSnaps, cryptoLatest] = await Promise.all([
            Promise.all(fetchPromises),
            fetchBarsUrl('https://data.alpaca.markets/v2/stocks/snapshots?symbols=NVDA,TSLA,GLD&feed=iex'),
            fetchBarsUrl('https://data.alpaca.markets/v1beta3/crypto/us/latest/trades?symbols=SOL/USD')
        ]);

        results.forEach(r => {
            if (r.bars && r.bars.length > 0) {
                if (!latestEnrichedBars[r.ticker]) latestEnrichedBars[r.ticker] = {};
                latestEnrichedBars[r.ticker][r.tf] = ti.enrichBarsWithIndicators(r.bars);
                const lastBar = r.bars[r.bars.length - 1];
                // Priorizar la vela más fresca (5m es el precio más reciente tras eliminar 1m)
                if (r.tf === '5m' || !quotes[r.ticker]) {
                    quotes[r.ticker] = lastBar.c;
                }
            }
        });

        // Sobrescribir quotes con último tick en vivo si está disponible (máxima precisión al segundo)
        if (stockSnaps) {
            if (stockSnaps.NVDA?.latestTrade?.p) quotes.NVDA = stockSnaps.NVDA.latestTrade.p;
            if (stockSnaps.TSLA?.latestTrade?.p) quotes.TSLA = stockSnaps.TSLA.latestTrade.p;
            if (stockSnaps.GLD?.latestTrade?.p) quotes.XAUUSD = stockSnaps.GLD.latestTrade.p;
        }
        if (cryptoLatest?.trades?.['SOL/USD']?.p) {
            quotes.SOLUSD = cryptoLatest.trades['SOL/USD'].p;
        }
    } catch(e) {
        console.warn('[FEED 4-TIMEFRAMES] Error descargando velas:', e.message);
    }

    // Guardar cotizaciones vivas en el estado para la terminal web
    engineState.liveQuotes = { ...quotes, updatedAt: new Date().toISOString() };

    return quotes;
}

// ------------------------------------------------------------------------------
// 🧠 CÁLCULO DE SCORE DE LAS 26 HERMANAS Y LAS 3 ESTRATEGIAS (5M ÁGIL)
// ------------------------------------------------------------------------------

// ------------------------------------------------------------------------------
// 📊 MATRIZ CUANTITATIVA: AUDITORÍA DE WIN RATE Y PNL (MANDATO DE PEDRO)
// ------------------------------------------------------------------------------
function computePerformanceStats() {
    const history = engineState.closedTradesHistory || [];
    function calc(trades) {
        let wins = 0, losses = 0, bes = 0, grossProfit = 0, grossLoss = 0, netPnlUSD = 0, netPnlEUR = 0;
        trades.forEach(t => {
            const pnl = parseFloat(t.pnl) || 0;
            const isUSD = (t.currency === 'USD') || (t.broker && t.broker.includes('Alpaca'));
            const pnlUSD = isUSD ? pnl : pnl * 1.05;
            const pnlEUR = isUSD ? pnl / 1.05 : pnl;
            netPnlUSD += pnlUSD;
            netPnlEUR += pnlEUR;
            if (pnl > 0.005) { wins++; grossProfit += pnlUSD; }
            else if (pnl < -0.005) { losses++; grossLoss += Math.abs(pnlUSD); }
            else { bes++; }
        });
        const total = wins + losses + bes;
        const winRate = (wins + losses) > 0 ? parseFloat(((wins / (wins + losses)) * 100).toFixed(1)) : 0.0;
        const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99.9 : 0.0);
        return {
            total, wins, losses, breakevens: bes,
            winRate,
            grossProfit: parseFloat(grossProfit.toFixed(2)),
            grossLoss: parseFloat(grossLoss.toFixed(2)),
            netPnlUSD: parseFloat(netPnlUSD.toFixed(2)),
            netPnlEUR: parseFloat(netPnlEUR.toFixed(2)),
            profitFactor
        };
    }

    engineState.performanceStats = {
        global: calc(history),
        byBroker: {
            alpaca: calc(history.filter(t => t.broker && t.broker.includes('Alpaca'))),
            pepperstone: calc(history.filter(t => !t.broker || t.broker.includes('Pepperstone')))
        },
        byAsset: {
            NVDA: calc(history.filter(t => (t.symbol || '').toUpperCase() === 'NVDA')),
            TSLA: calc(history.filter(t => (t.symbol || '').toUpperCase() === 'TSLA')),
            SOL: calc(history.filter(t => (t.symbol || '').toUpperCase().includes('SOL'))),
            ORO: calc(history.filter(t => (t.symbol || '').toUpperCase().includes('XAU') || (t.symbol || '').toUpperCase() === 'GLD'))
        },
        // [CLAUDE v2] Clasificación por stratCode (antes por nombre: "Pista 10" contaba como P1, "Gap & Go (apertura)" como P7)
        byStrategy: (() => {
            const out = {};
            ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10','p11','p12','rebuilt'].forEach(c => {
                out[c] = calc(history.filter(t => classifyStratCodeEngine(t) === c));
            });
            return out;
        })(),
        // [CLAUDE v2] Escalera de Pedro (STEP, Alpaca) vs salida normal (STD, Pepperstone) sobre las mismas señales
        byExitMode: {
            STEP: calc(history.filter(t => t.exitMode === 'STEP')),
            STD: calc(history.filter(t => t.exitMode === 'STD'))
        },
        updatedAt: new Date().toISOString()
    };
}
// [CLAUDE v2] Código de estrategia de una operación: primero la etiqueta stratCode, si no el nombre (operaciones antiguas)
function classifyStratCodeEngine(t) {
    if (t.rebuiltFromFills) return 'rebuilt';
    if (t.stratCode) return String(t.stratCode).toLowerCase();
    const s = (t.strategy || '').toLowerCase();
    if (s.includes('reconstruido')) return 'rebuilt';
    const m = s.match(/pista\s*(\d{1,2})\b/);
    if (m) return 'p' + m[1];
    if (s.includes('delfín') || s.includes('delfin')) return 'p1';
    if (s.includes('base') || s.includes('tibur')) return 'p2';
    if (s.includes('timemachine')) return 'p3';
    if (s.includes('vwap') || s.includes('whale') || s.includes('ballena')) return 'p4';
    if (s.includes('supertrend')) return 'p5';
    if (s.includes('reversión') || s.includes('reversion') || s.includes('rsi') || s.includes('bollinger')) return 'p6';
    if (s.includes('orb') || s.includes('apertura')) return 'p7';
    if (s.includes('squeeze') || s.includes('ttm')) return 'p8';
    return 'otros';
}
// Inicializar métricas cuantitativas al arrancar
computePerformanceStats();


// ------------------------------------------------------------------------------
// 🧠 EVALUACIÓN MULTI-ESTRATEGIA EN 4 TIMEFRAMES (VELAS REALES ALPACA)
// ------------------------------------------------------------------------------
function evaluateAllStrategies(ticker, currentPrice, timeframe = '5m') {
    loadPromotedMatrix();
    const tickerData = latestEnrichedBars[ticker];
    let bars = [];
    if (tickerData) {
        if (tickerData[timeframe] && tickerData[timeframe].length > 0) {
            bars = tickerData[timeframe];
        } else if (Array.isArray(tickerData) && tickerData.length > 0) {
            bars = tickerData;
        } else {
            const firstKey = Object.keys(tickerData).find(k => tickerData[k]?.length > 0);
            if (firstKey) bars = tickerData[firstKey];
        }
    }
    if (bars && bars.length > 0) {
        const results = evaluateStrategiesForBar(ticker, bars, -1, promotedMatrix);
        const lastBar = bars[bars.length - 1];
        const barClose = (lastBar && typeof lastBar.c === 'number') ? lastBar.c : currentPrice;
        results.forEach(r => {
            r.timeframe = timeframe;
            r.barPrice = barClose;
        });
        return results;
    }
    return [];
}

function calculate26HermanasScore(ticker, currentPrice) {
    const list = evaluateAllStrategies(ticker, currentPrice);
    return list.find(s => s.action === 'BUY') || list[0] || null;
}

// ------------------------------------------------------------------------------
// 🚀 EJECUCIÓN AUTÓNOMA DE APERTURA: DUELO EN VIVO (AMBOS BROKERS EN LAS 4 ACCIONES)
// ------------------------------------------------------------------------------
async function executeAutonomousOpen(ticker, price, analysis) {
    const config = ASSETS_CONFIG[ticker];
    if (!config) return null;

    // Obtener precio vivo real actual para calcular SL/TP sin desfase respecto a la vela
    const liveRefPrice = (engineState.liveQuotes && engineState.liveQuotes[ticker] > 0)
        ? parseFloat(engineState.liveQuotes[ticker])
        : parseFloat(price);

    // 🛡️ CANDADO MATEMÁTICO INQUEBRANTABLE (Mandato Frialdad Rusa de Pedro):
    // Toda entrada BUY DEBE tener TP > liveRefPrice y SL < liveRefPrice calculados sobre precio vivo.
    const atr = Math.max(0.01, (analysis.indicators && analysis.indicators.atr) ? analysis.indicators.atr : (liveRefPrice * 0.01));
    const stratRisk = Math.max(atr * 0.5, (isFinite(analysis.sl) && isFinite(analysis.barPrice) && analysis.barPrice > analysis.sl) ? (analysis.barPrice - analysis.sl) : (atr * 1.5));
    const stratReward = Math.max(atr * 1.0, (isFinite(analysis.tp) && isFinite(analysis.barPrice) && analysis.tp > analysis.barPrice) ? (analysis.tp - analysis.barPrice) : (atr * 3.0));
    const priceDecimals = ticker.includes('SOL') ? 4 : 2;

    analysis.sl = parseFloat((liveRefPrice - stratRisk).toFixed(priceDecimals));
    analysis.tp = parseFloat((liveRefPrice + stratReward).toFixed(priceDecimals));
    analysis.breakevenTrigger = parseFloat((liveRefPrice + (stratRisk)).toFixed(priceDecimals));
    if (analysis.isDelfin4x4) {
        analysis.tp1 = parseFloat((liveRefPrice + (atr * 0.75)).toFixed(priceDecimals));
        analysis.tp2 = parseFloat((liveRefPrice + (atr * 1.50)).toFixed(priceDecimals));
        analysis.tp3 = parseFloat((liveRefPrice + (atr * 2.25)).toFixed(priceDecimals));
        analysis.tp4 = parseFloat((liveRefPrice + (atr * 3.00)).toFixed(priceDecimals));
        analysis.sl = parseFloat((liveRefPrice - (atr * 1.5)).toFixed(priceDecimals));
        analysis.tp = analysis.tp4;
        analysis.breakevenTrigger = analysis.tp2;
    }

    console.log(`\n⚔️ [DUELO EN VIVO • ALPACA vs PEPPERSTONE] DISPARO PARALELO EN ${ticker}:`);
    console.log(`   Acción: ${analysis.action} | Precio Live: $${liveRefPrice} | Score: ${analysis.score} (${analysis.pez})`);
    console.log(`   SL: $${analysis.sl} | TP: $${analysis.tp}`);

    const duelPairId = 'DUEL-' + Date.now();
    const executedOrders = [];

    // 1. DISPARO A ALPACA MARKETS - Validar tope real en cartera (máx 3 posiciones simultáneas por símbolo)
    const reconAlpPos = (engineState.brokerReconciliation && Array.isArray(engineState.brokerReconciliation.alpacaPositions))
        ? engineState.brokerReconciliation.alpacaPositions : [];
    const existingAlpSameSym = engineState.openPositions.filter(p => p.broker && p.broker.includes('Alpaca') && p.symbol === ticker).length;
    const brokerHasHeavyBag = reconAlpPos.some(ap => (ap.symbol === config.alpacaSymbol || ap.symbol === config.alpacaSymbol.replace('/', '')) && parseFloat(ap.qty || 0) >= 3);

    if (existingAlpSameSym < MAX_ALPACA_SUBPOS_PER_SYMBOL) { // [FIX CLAUDE 18-NOV] sin bracket ya no hay choque entre subposiciones
        try {
            const isCrypto = config.alpacaSymbol.includes('/');
            let alpacaTp = analysis.tp;
            let alpacaSl = analysis.sl;
            let alpacaEntry = liveRefPrice;

            let alpacaOrder = null;
            if (isCrypto) {
                alpacaOrder = await alpacaService.placeMarketOrder({
                    symbol: config.alpacaSymbol,
                    qty: config.alpacaQty,
                    side: 'buy'
                });
            } else {
                // [FIX CLAUDE 18-NOV] Sin bracket: el stop del broker + el stop del motor vendían DOS veces
                // y abrían cortos (NVDA -2 el 17-nov). Ahora el motor es la única fuente de salidas en Alpaca.
                alpacaOrder = await alpacaService.placeMarketOrder({
                    symbol: config.alpacaSymbol,
                    qty: config.alpacaQty,
                    side: 'buy'
                });
            }
            if (!alpacaOrder || !alpacaOrder.id) {
                throw new Error(`Alpaca no devolvió ID de orden válido para ${config.alpacaSymbol}. Orden no ejecutada.`);
            }

            // Capturar Fill Price real de Alpaca (Mandato 3.B.3)
            let realAlpacaFill = parseFloat(alpacaOrder.filled_avg_price || 0);
            if (!realAlpacaFill || realAlpacaFill <= 0) {
                await new Promise(r => setTimeout(r, 450));
                try {
                    const refreshedOrder = await alpacaService.getOrderById(alpacaOrder.id);
                    if (refreshedOrder && parseFloat(refreshedOrder.filled_avg_price) > 0) {
                        realAlpacaFill = parseFloat(refreshedOrder.filled_avg_price);
                    }
                } catch(e) {}
            }
            if (realAlpacaFill > 0) {
                alpacaEntry = realAlpacaFill;
                alpacaSl = parseFloat((alpacaEntry - stratRisk).toFixed(priceDecimals));
                alpacaTp = parseFloat((alpacaEntry + stratReward).toFixed(priceDecimals));
            }

            const alpacaRecord = {
                id: alpacaOrder.id,
                duelPairId: duelPairId,
                broker: 'Alpaca Markets Paper Algorithmic',
                strategy: analysis.strategyName,
                account: 'PA35UQ22S',
                symbol: ticker,
                orderSymbol: config.alpacaSymbol,
                qty: config.alpacaQty,
                initialQty: config.alpacaQty,
                unit: 'acción',
                currency: 'USD',
                side: 'BUY',
                entryPrice: alpacaEntry,
                fillPrice: realAlpacaFill || alpacaEntry,
                sl: alpacaSl,
                tp: alpacaTp,
                initialRiskPerUnit: parseFloat(Math.abs(alpacaEntry - alpacaSl).toFixed(priceDecimals)),
                isDelfin4x4: false, // [FIX CLAUDE 18-NOV] los escalones 25% nunca se vendían en el broker: la ganancia parcial era solo de libreta. Pendiente v2 (ventas fraccionadas reales).
                tp1: analysis.isDelfin4x4 ? parseFloat((alpacaEntry + atr * 0.75).toFixed(priceDecimals)) : null,
                tp2: analysis.isDelfin4x4 ? parseFloat((alpacaEntry + atr * 1.50).toFixed(priceDecimals)) : null,
                tp3: analysis.isDelfin4x4 ? parseFloat((alpacaEntry + atr * 2.25).toFixed(priceDecimals)) : null,
                tp4: analysis.isDelfin4x4 ? parseFloat((alpacaEntry + atr * 3.00).toFixed(priceDecimals)) : null,
                tranchesClosed: 0,
                realizedPartialPnl: 0,
                breakevenTrigger: parseFloat((alpacaEntry + stratRisk).toFixed(priceDecimals)),
                score: analysis.score,
                pez: analysis.pez,
                indicators: analysis.indicators || null,
                signalReason: analysis.signalReason || '',
                timeframe: analysis.timeframe || '5m',
                stratCode: analysis.stratCode || null, // [CLAUDE v2] etiquetas para el informe
                strategyVersion: analysis.strategyVersion || ENGINE_VERSION,
                exitMode: EXIT_MODE_BY_BROKER.alpaca,
                closeAtSessionEnd: !!analysis.closeAtSessionEnd,
                status: 'OPEN',
                openedAt: new Date().toISOString(),
                trailingStopMovedToBreakeven: false
            };
            executedOrders.push(alpacaRecord);
            engineState.openPositions.push(alpacaRecord);
        } catch(err) {
            console.error(`❌ [ALPACA ERROR] No se pudo enviar orden en ${ticker} (${config.alpacaSymbol}):`, err.message);
        }
    } else {
        console.log(`🔒 [CANDADO ALPACA] Límite de exposición en ${ticker} alcanzado (${existingAlpSameSym} pos motor).`);
    }

    // 2. DISPARO A PEPPERSTONE cTRADER - Mínimo volumen (0.01 micro-lotes / 0.10 CFD)
    try {
        const pepRes = await pepperstoneService.processIncomingSignal({
            action: 'BUY',
            ticker: config.pepperstoneSymbol,
            price: liveRefPrice,
            score: analysis.score,
            pez: analysis.pez,
            sl: analysis.sl,
            tp: analysis.tp,
            timeframe: analysis.timeframe || '5m'
        });
        if (pepRes && pepRes.executed && pepRes.order && pepRes.order.id) {
            const pepEntry = pepRes.order.fillPrice || pepRes.order.entryPrice || liveRefPrice;
            const pepSl = isFinite(pepRes.order.stopLoss) ? pepRes.order.stopLoss : analysis.sl;
            const pepTp = isFinite(pepRes.order.takeProfit) ? pepRes.order.takeProfit : analysis.tp;
            const pepRiskDist = Math.abs(pepEntry - pepSl) || stratRisk;
            const pepRecord = {
                id: pepRes.order.id,
                positionId: pepRes.order.positionId || pepRes.order.id,
                duelPairId: duelPairId,
                broker: 'Pepperstone cTrader ECN Razor',
                strategy: analysis.strategyName,
                account: 4285238,
                symbol: ticker,
                orderSymbol: config.pepperstoneSymbol,
                qty: config.pepperstoneQty,
                initialQty: config.pepperstoneQty,
                unit: 'micro-lotes',
                currency: 'EUR',
                side: 'BUY',
                entryPrice: pepEntry,
                fillPrice: pepEntry,
                sl: pepSl,
                tp: pepTp,
                initialRiskPerUnit: parseFloat(Math.abs(pepEntry - pepSl).toFixed(priceDecimals)),
                brokerSltpBound: !!pepRes.order.brokerSltpBound,
                isDelfin4x4: false, // [FIX CLAUDE 18-NOV] los escalones 25% nunca se vendían en el broker: la ganancia parcial era solo de libreta. Pendiente v2 (ventas fraccionadas reales).
                tp1: analysis.isDelfin4x4 ? parseFloat((pepEntry + atr * 0.75).toFixed(priceDecimals)) : null,
                tp2: analysis.isDelfin4x4 ? parseFloat((pepEntry + atr * 1.50).toFixed(priceDecimals)) : null,
                tp3: analysis.isDelfin4x4 ? parseFloat((pepEntry + atr * 2.25).toFixed(priceDecimals)) : null,
                tp4: analysis.isDelfin4x4 ? parseFloat((pepEntry + atr * 3.00).toFixed(priceDecimals)) : null,
                tranchesClosed: 0,
                realizedPartialPnl: 0,
                breakevenTrigger: parseFloat((pepEntry + pepRiskDist).toFixed(priceDecimals)),
                score: analysis.score,
                pez: analysis.pez,
                indicators: analysis.indicators || null,
                signalReason: analysis.signalReason || '',
                timeframe: analysis.timeframe || '5m',
                stratCode: analysis.stratCode || null, // [CLAUDE v2] etiquetas para el informe
                strategyVersion: analysis.strategyVersion || ENGINE_VERSION,
                exitMode: EXIT_MODE_BY_BROKER.pepperstone,
                closeAtSessionEnd: !!analysis.closeAtSessionEnd,
                status: 'OPEN',
                openedAt: new Date().toISOString(),
                trailingStopMovedToBreakeven: false
            };
            executedOrders.push(pepRecord);
            engineState.openPositions.push(pepRecord);
        }
    } catch(err) {
        console.error(`❌ [PEPPERSTONE ERROR] No se pudo enviar orden en ${ticker} (${config.pepperstoneSymbol}):`, err.message);
    }

    if (executedOrders.length > 0) {
        saveState();

        // 🔕 POLÍTICA TELEGRAM CERO SPAM (Mandato Don Pedro):
        // Scalping rápido en 5m se opera en silencio en la nube (visibles en terminal web y logs).
        // A Telegram solo se envían disparos institucionales de 15m, 1H, 4H o con Score de alta convicción (>= 85).
        const isInstitutionalTf = (analysis.timeframe === '15m' || analysis.timeframe === '1H' || analysis.timeframe === '4H');
        const isHighConviction = (analysis.score >= 85);
        if (isInstitutionalTf || isHighConviction) {
            const msg = `⚔️ <b>[DUELO EN VIVO • DÍA DE 15 • HEAD-TO-HEAD]</b>\n` +
                `🎯 <b>Disparo Paralelo en los 4 Activos: ${ticker}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `⚡ <b>Gatillo:</b> ${analysis.strategyName} en <b>${analysis.timeframe || '5m'}</b> (Score ${analysis.score}/100)\n` +
                `💵 <b>Precio Entrada:</b> $${liveRefPrice.toFixed(priceDecimals)}\n` +
                `🛡️ <b>Stop Loss:</b> $${analysis.sl} | 🎯 <b>Take Profit:</b> $${analysis.tp}\n` +
                `🔒 <b>Trailing a Breakeven:</b> Al superar $${analysis.breakevenTrigger}\n\n` +
                `🏛️ <b>EJECUCIÓN CONFIRMADA:</b>\n` +
                executedOrders.map(o => `• ${o.broker.includes('Alpaca') ? '🦙 Alpaca' : '🏛️ Pepperstone'} ID <code>${o.id}</code> ($${o.entryPrice})`).join('\n') + `\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `<i>Orden verificada con ID oficial de broker. Cero operaciones fantasma.</i>`;

            await notifyPedro(msg);
            console.log(`✅ [DUELO PARALELO] Órdenes registradas y Pedro notificado vía Telegram.`);
        } else {
            console.log(`✅ [DUELO PARALELO SILENCIOSO (${analysis.timeframe || '5m'})] Órdenes registradas en nube (Telegram silenciado para micro-scalp).`);
        }
    }

    return executedOrders;
}

// ------------------------------------------------------------------------------
// ⏰ HORARIOS DE MERCADO (MANDATO PEDRO 13-NOV): TSLA/NVDA/Oro solo operan en
// sesión de Wall Street (15:30-22:00 Roma, lunes-viernes). No se abren posiciones
// en los últimos 30 minutos (21:30+) ni fuera de horario. SOL es 24/7 libre.
// ------------------------------------------------------------------------------
function romeNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
}
function isSessionOpenForAsset(symbol) {
    if ((symbol || '').includes('SOL')) return true; // cripto 24/7
    const d = romeNow();
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins >= 15 * 60 + 30 && mins < 22 * 60; // 15:30 - 22:00 Roma
}
function isEntryWindowForAsset(symbol) {
    if ((symbol || '').includes('SOL')) return true;
    const d = romeNow();
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins >= 15 * 60 + 30 && mins < 21 * 60 + 30; // no abrir desde 21:30 (últimos 30 min)
}

// ------------------------------------------------------------------------------
// 🔧 CIERRE REAL EN EL BROKER (KIMI FIX 11-NOV): la libreta ya no miente.
// Antes de este fix el motor anotaba cierres en su JSON pero NUNCA vendía en
// Alpaca ni cerraba en cTrader. Ahora cada cierre interno ejecuta la salida real.
// ------------------------------------------------------------------------------
async function executeRealBrokerClose(pos) {
    const isAlpaca = pos.broker && pos.broker.includes('Alpaca');
    if (isAlpaca) {
        // [FIX CLAUDE 18-NOV] Nunca vender más de lo que el broker tiene: así nacían los cortos.
        const sym = pos.orderSymbol || pos.symbol;
        const brokerQty = await alpacaService.getPositionQty(sym);
        if (!(brokerQty > 0)) {
            return { broker: 'Alpaca', alreadyClosedByBroker: true, brokerQty };
        }
        const qty = Math.min(parseFloat(pos.qty) || 0, brokerQty);
        const order = await alpacaService.placeMarketOrder({ symbol: sym, qty, side: 'sell' });
        const exitFill = order && order.id ? await alpacaService.getFillPrice(order.id) : null;
        return { broker: 'Alpaca', orderId: order && order.id ? order.id : null, qtySold: qty, exitFill };
    }
    const pid = pos.positionId || pos.id;
    let vol = pos.cTraderVolume;
    if (!vol) {
        const sym = (pos.symbol || pos.orderSymbol || '').toUpperCase();
        if (sym === 'NVDA' || sym === 'TSLA') vol = 10;
        else vol = 100; // SOL y XAUUSD
    }
    const res = await pepperstoneService.closeOrderViaOpenAPI(pid, vol);
    if (!res) throw new Error('Sin respuesta de cTrader');
    if (res.errorCode && String(res.errorCode).includes('POSITION_NOT_FOUND')) {
        return { broker: 'Pepperstone', positionId: pid, alreadyClosedByBroker: true };
    }
    if (res.errorCode) throw new Error(`${res.errorCode} - ${res.description || 'Error cTrader'}`);
    if (res.error) throw new Error(res.error);
    if (res.timeout) throw new Error('Timeout cerrando posición en cTrader (10s)');
    return { broker: 'Pepperstone', positionId: pid };
}

function getLiveAtrForTicker(ticker, refPrice) {
    const tfData = latestEnrichedBars[ticker] || {};
    const bars = (tfData['15m'] && tfData['15m'].length) ? tfData['15m']
        : ((tfData['5m'] && tfData['5m'].length) ? tfData['5m'] : []);
    const lastBar = bars.length ? bars[bars.length - 1] : null;
    if (lastBar && isFinite(lastBar.atr) && lastBar.atr > 0) return lastBar.atr;
    return Math.max(0.05, (ASSETS_CONFIG[ticker] && ASSETS_CONFIG[ticker].baseAtr) || (refPrice * 0.01));
}

// Hidrata posiciones reales abiertas en los brokers que faltan en engineState.openPositions (tras reinicios)
// Protege el capital con SL (-1.5 ATR), Breakeven (+1.5 ATR) y TP (+3.0 ATR) reales; excluye T.US (legacy).
function adoptUnmanagedBrokerPositions(alpPositions, pepRealPositions) {
    let adopted = 0;
    const SYMBOL_ID_MAP = { 1614: 'SOLUSD', 338: 'NVDA', 339: 'TSLA', 41: 'XAUUSD' };

    // 1. Pepperstone cTrader: cada posición tiene positionId único
    (pepRealPositions || []).forEach(p => {
        const td = p.tradeData || {};
        const ticker = SYMBOL_ID_MAP[td.symbolId];
        if (!ticker || !ASSETS_CONFIG[ticker]) return; // Respeta T.US (legacy) u otros externos
        const pid = p.positionId;
        const alreadyTracked = engineState.openPositions.some(op =>
            String(op.positionId || op.id) === String(pid)
        );
        if (alreadyTracked) return;

        const entry = parseFloat(p.price) || (engineState.liveQuotes && engineState.liveQuotes[ticker]) || 0;
        if (!(entry > 0)) return;
        const decimals = ticker.includes('SOL') ? 4 : 2;
        const atr = getLiveAtrForTicker(ticker, entry);
        // [FIX CLAUDE v2] Ninguna estrategia vende en corto y manageOpenPositions solo gestiona compras:
        // un corto en Pepperstone no se adopta (se gestionaría al revés). Solo aviso, igual que en Alpaca.
        if (td.tradeSide === 2) {
            const key = `SHORT_ALERT_PEP_${pid}_${romeDateStr()}`;
            if (!engineState.closedCooldowns) engineState.closedCooldowns = {};
            if (!engineState.closedCooldowns[key]) {
                engineState.closedCooldowns[key] = Date.now();
                notifyPedro(`🚨 <b>[ANASTASIA]</b> Corto inesperado en Pepperstone: ${ticker} (posición ${pid}). No se adopta. Revisar y cerrar a mano.`).catch(() => {});
            }
            return;
        }
        const cfg = ASSETS_CONFIG[ticker];
        engineState.openPositions.push({
            id: pid,
            positionId: pid,
            broker: 'Pepperstone cTrader ECN Razor',
            strategy: `Custodia Broker (${td.comment || 'cTrader'})`,
            account: 4285238,
            symbol: ticker,
            orderSymbol: cfg.pepperstoneSymbol,
            qty: ticker.includes('SOL') ? ((td.volume || 100) / 100) : cfg.pepperstoneQty,
            initialQty: ticker.includes('SOL') ? ((td.volume || 100) / 100) : cfg.pepperstoneQty,
            cTraderVolume: td.volume || (ticker.includes('NVDA') || ticker.includes('TSLA') ? 10 : 100),
            usedMarginEur: (p.usedMargin || 0) / 100,
            unit: ticker.includes('SOL') ? 'SOL' : 'CFD',
            currency: 'EUR',
            side: td.tradeSide === 2 ? 'SELL' : 'BUY',
            entryPrice: entry,
            initialRiskPerUnit: parseFloat((atr * 1.5).toFixed(decimals)),
            sl: parseFloat((entry - atr * 1.5).toFixed(decimals)),
            tp: parseFloat((entry + atr * 3.0).toFixed(decimals)),
            breakevenTrigger: parseFloat((entry + atr * 1.5).toFixed(decimals)),
            pez: '🛡️ CUSTODIA',
            timeframe: '15m',
            status: 'OPEN',
            hydratedFromBroker: true,
            openedAt: td.openTimestamp ? new Date(td.openTimestamp).toISOString() : new Date().toISOString(),
            trailingStopMovedToBreakeven: false
        });
        adopted++;
    });

    // 2. Alpaca: posiciones netas por símbolo (adoptar solo si no hay cobertura suficiente en libreta)
    const ALP_TO_TICKER = { 'NVDA': 'NVDA', 'TSLA': 'TSLA', 'GLD': 'XAUUSD', 'SOLUSD': 'SOLUSD', 'SOL/USD': 'SOLUSD' };
    (alpPositions || []).forEach(ap => {
        const ticker = ALP_TO_TICKER[ap.symbol];
        if (!ticker || !ASSETS_CONFIG[ticker]) return;
        const cfg = ASSETS_CONFIG[ticker];
        const normSym = s => (s || '').replace('/', '').toUpperCase();
        const engineQtyForSym = engineState.openPositions
            .filter(op => op.broker && op.broker.includes('Alpaca') && normSym(op.orderSymbol || op.symbol) === normSym(ap.symbol))
            .reduce((sum, op) => sum + (parseFloat(op.qty) || 0), 0);

        // [FIX CLAUDE 18-NOV] Ninguna estrategia vende en corto: un corto en Alpaca es un error, no se adopta como compra
        if (!(parseFloat(ap.qty || 0) > 0)) {
            const key = `SHORT_ALERT_${ap.symbol}_${romeDateStr()}`;
            if (!engineState.closedCooldowns) engineState.closedCooldowns = {};
            if (!engineState.closedCooldowns[key]) {
                engineState.closedCooldowns[key] = Date.now();
                notifyPedro(`🚨 <b>[ANASTASIA]</b> Corto inesperado en Alpaca: ${ap.symbol} qty ${ap.qty}. No se adopta. Revisar y cerrar a mano.`).catch(() => {});
            }
            return;
        }

        // [REGLA externalQty 18-NOV] Descontar posición externa editable (brokerQty - externalQty[símbolo])
        const extQty = (engineState.externalQty && engineState.externalQty[ap.symbol])
            ? (parseFloat(engineState.externalQty[ap.symbol]) || 0)
            : 0;
        const brokerQtyForEngine = Math.max(0, parseFloat(ap.qty || 0) - extQty);
        const qtyToAdopt = brokerQtyForEngine - engineQtyForSym;

        if (qtyToAdopt <= 0.001) return; // Si lo que queda no está por encima del libro, no se adopta

        const entry = parseFloat(ap.avgEntryPrice) || (engineState.liveQuotes && engineState.liveQuotes[ticker]) || 0;
        if (!(entry > 0)) return;
        const decimals = ticker.includes('SOL') ? 4 : 2;
        const atr = getLiveAtrForTicker(ticker, entry);
        const slPrice = parseFloat((entry - atr * 1.5).toFixed(decimals));
        const initialRiskPerUnit = parseFloat(Math.abs(entry - slPrice).toFixed(decimals));
        engineState.openPositions.push({
            id: `ALP-CUST-${ap.symbol}`,
            broker: 'Alpaca Markets Paper Algorithmic',
            strategy: 'Custodia Broker (Alpaca API)',
            account: 'PA35UQ22S',
            symbol: ticker,
            orderSymbol: cfg.alpacaSymbol,
            qty: parseFloat(qtyToAdopt.toFixed(decimals)),
            initialQty: parseFloat(qtyToAdopt.toFixed(decimals)),
            unit: ticker.includes('SOL') ? 'SOL' : 'acción',
            currency: 'USD',
            side: 'BUY',
            entryPrice: entry,
            initialRiskPerUnit: initialRiskPerUnit,
            sl: slPrice,
            tp: parseFloat((entry + atr * 3.0).toFixed(decimals)),
            breakevenTrigger: parseFloat((entry + atr * 1.5).toFixed(decimals)),
            pez: '🛡️ CUSTODIA',
            timeframe: '15m',
            status: 'OPEN',
            hydratedFromBroker: true,
            openedAt: new Date().toISOString(),
            trailingStopMovedToBreakeven: false
        });
        adopted++;
    });

    if (adopted > 0) {
        console.log(`♻️ [CUSTODIA HIDRATADA] +${adopted} posiciones reales adoptadas bajo protección SL/TP automática.`);
        saveState();
    }
}

// ------------------------------------------------------------------------------
// 🔍 RECONCILIACIÓN LIBRETA vs BROKER (señal de verdad para Pedro)
// Compara lo que el motor cree tener abierto en Alpaca contra lo que Alpaca
// reporta de verdad, y publica divergencias en el estado. No vende nada solo.
// ------------------------------------------------------------------------------
async function syncBrokerReality() {
    try {
        const [acc, alpPositions] = await Promise.all([
            alpacaService.getAccount().catch(() => null),
            alpacaService.getPositions().catch(() => [])
        ]);
        let pepAcc = null;
        if (acc && isFinite(acc.portfolioValue)) {
            engineState.accountBalances.alpaca = `$${acc.portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
        }
        try {
            pepAcc = await pepperstoneService.getLiveAccountData();
            if (pepAcc && isFinite(pepAcc.balance)) {
                engineState.accountBalances.pepperstone = `€${pepAcc.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
            }
        } catch(e) { /* Pepperstone offline: conservar último saldo conocido */ }

        // Métricas numéricas reales para KPI Strip, Drawdown y Cerebro (cero hardcoded)
        const alpEquity = acc ? (acc.equity || acc.portfolioValue || 0) : null;
        const alpLastEq = acc ? (acc.lastEquity || acc.portfolioValue || 0) : null;
        const pepBalEur = (pepAcc && isFinite(pepAcc.balance)) ? pepAcc.balance : null;
        let dailyChangeUsd = 0;
        let baseEqUsd = 0;
        if (alpEquity && alpLastEq && alpLastEq > 0) {
            dailyChangeUsd += (alpEquity - alpLastEq);
            baseEqUsd += alpLastEq;
        }
        const pepTodayPnlEur = engineState.dailyRealizedPnlEUR || 0;
        if (pepBalEur && pepBalEur > 0) {
            dailyChangeUsd += (pepTodayPnlEur * 1.05);
            baseEqUsd += (pepBalEur * 1.05);
        }
        const dailyReturnPct = baseEqUsd > 0 ? parseFloat(((dailyChangeUsd / baseEqUsd) * 100).toFixed(2)) : 0.00;
        const dailyDrawdownPct = dailyReturnPct < 0 ? Math.abs(dailyReturnPct) : 0.00;
        engineState.liveMetrics = {
            alpacaPortfolioUsd: acc ? acc.portfolioValue : null,
            alpacaCashUsd: acc ? acc.cash : null,
            alpacaEquityUsd: alpEquity,
            alpacaLastEquityUsd: alpLastEq,
            pepperstoneBalanceEur: pepBalEur,
            dailyReturnPct,
            dailyDrawdownPct,
            maxDailyDrawdownPct: 2.50,
            updatedAt: new Date().toISOString()
        };

        // Reconcile REAL de cTrader (posiciones abiertas de verdad en el broker)
        let pepRealPositions = [];
        let pepReconOk = false;
        try {
            const pepRecon = await pepperstoneService.getOpenPositionsViaOpenAPI();
            if (pepRecon && Array.isArray(pepRecon.positions)) {
                pepRealPositions = pepRecon.positions;
                pepReconOk = true;
            }
        } catch(e) { console.warn('[RECONCILE cTrader] Error:', e.message); }

        const SYMBOL_ID_NAMES = {
            1614: 'SOLUSD',
            338: 'NVDA',
            339: 'TSLA',
            41: 'XAUUSD',
            340: 'T.US (legacy)'
        };

        // 🧹 PURGA AUTORIZADA POR PEDRO (12-NOV)
        if (engineState.pendingBrokerPurge && pepRealPositions.length > 0) {
            let purged = 0, failed = 0;
            for (const p of pepRealPositions) {
                try {
                    const vol = (p.tradeData && p.tradeData.volume) || 10;
                    const res = await pepperstoneService.closeOrderViaOpenAPI(p.positionId, vol);
                    if (res && res.errorCode) { failed++; console.warn(`[PURGA] ${p.positionId}: ${res.errorCode}`); }
                    else if (res && (res.error || res.timeout)) { failed++; }
                    else purged++;
                } catch(e) { failed++; }
            }
            console.log(`🧹 [PURGA cTRADER] ${purged} cerradas, ${failed} pendientes (mercado cerrado o error). Reintento en 5 min.`);
            if (failed === 0) {
                engineState.pendingBrokerPurge = false;
                await notifyPedro('🧹👑 <b>[LABORATORIO RESETEADO]</b>\nTodas las posiciones reales de cTrader han sido cerradas a mercado.\nEl duelo Alpaca vs Pepperstone empieza limpio: libreta = broker en cero.\nDesde ahora, cada cierre es 100% real. 🇵🇪✨');
            }
        } else if (engineState.pendingBrokerPurge && pepRealPositions.length === 0 && pepReconOk) {
            engineState.pendingBrokerPurge = false;
            await notifyPedro('🧹👑 <b>[LABORATORIO RESETEADO]</b>\ncTrader ya está en cero. Duelo limpio activado.');
        }

        // Si cTrader confirma en vivo las posiciones, limpiar fantasmas ya cerrados en servidor (SL/TP nativo o cierre manual)
        if (pepReconOk) {
            const livePidSet = new Set(pepRealPositions.map(p => String(p.positionId)));
            const beforeLen = engineState.openPositions.length;
            engineState.openPositions = engineState.openPositions.filter(op => {
                if (!op.broker || !op.broker.includes('Pepperstone')) return true;
                return livePidSet.has(String(op.positionId || op.id));
            });
            if (engineState.openPositions.length !== beforeLen) {
                console.log(`♻️ [SYNC cTrader] Limpiadas ${beforeLen - engineState.openPositions.length} posiciones ya cerradas en servidor cTrader.`);
            }
        }

        // Adoptar posiciones reales del broker que falten tras reinicios ANTES del cálculo de divergencias
        adoptUnmanagedBrokerPositions(alpPositions, pepRealPositions);
        if (pepperstoneService && pepperstoneService.syncOpenPositions) {
            const pepTracked = engineState.openPositions.filter(p => p.broker && p.broker.includes('Pepperstone'));
            pepperstoneService.syncOpenPositions(pepTracked, pepRealPositions.length);
        }

        const engineAlpaca = {};
        engineState.openPositions
            .filter(p => p.broker && p.broker.includes('Alpaca'))
            .forEach(p => { engineAlpaca[p.orderSymbol] = (engineAlpaca[p.orderSymbol] || 0) + (p.qty || 0); });

        const realAlpaca = {};
        (alpPositions || []).forEach(p => { realAlpaca[p.symbol] = p.qty; });

        const divergences = [];
        const norm = s => (s || '').replace('/', '').toUpperCase();
        const allSyms = new Set([...Object.keys(engineAlpaca), ...Object.keys(realAlpaca)].map(norm));
        allSyms.forEach(sym => {
            const engKey = Object.keys(engineAlpaca).find(k => norm(k) === sym);
            const realKey = Object.keys(realAlpaca).find(k => norm(k) === sym);
            const eng = engKey ? engineAlpaca[engKey] : 0;
            const real = realKey ? realAlpaca[realKey] : 0;
            const extQty = (engineState.externalQty && engineState.externalQty[sym])
                ? (parseFloat(engineState.externalQty[sym]) || 0)
                : 0;
            const brokerQtyForEngine = Math.max(0, real - extQty);

            if (extQty > 0) {
                divergences.push({
                    symbol: sym,
                    engineQty: eng,
                    brokerQty: real,
                    brokerQtyForEngine,
                    externalQty: extQty,
                    type: 'POSICION_EXTERNA',
                    note: `Posición externa (${extQty} ud)`
                });
            }

            if (Math.abs(eng - brokerQtyForEngine) > 0.0001) {
                divergences.push({
                    symbol: sym,
                    engineQty: eng,
                    brokerQty: real,
                    brokerQtyForEngine,
                    diff: Math.abs(eng - brokerQtyForEngine)
                });
            }
        });

        const MANAGED_CTRADER_IDS = new Set([1614, 338, 339, 41]);
        const pepManagedCount = pepRealPositions.filter(p => MANAGED_CTRADER_IDS.has(p.tradeData?.symbolId)).length;
        const pepLibreta = engineState.openPositions.filter(p => p.broker && p.broker.includes('Pepperstone')).length;
        if (pepReconOk && Math.abs(pepManagedCount - pepLibreta) > 0) {
            divergences.push({ symbol: 'cTrader', engineQty: pepLibreta, brokerQty: pepManagedCount });
        }

        engineState.brokerReconciliation = {
            checkedAt: new Date().toISOString(),
            alpacaPositions: (alpPositions || []).map(p => ({
                symbol: p.symbol, qty: p.qty, side: p.side,
                avgEntryPrice: p.avgEntryPrice, currentPrice: p.currentPrice,
                unrealizedPnl: p.unrealizedPnl, unrealizedPnlPct: p.unrealizedPnlPct
            })),
            ctraderPositions: (pepRealPositions || []).map(p => {
                const td = p.tradeData || {};
                const symId = td.symbolId;
                const sym = SYMBOL_ID_NAMES[symId] || `ID_${symId}`;
                return {
                    positionId: p.positionId,
                    symbolId: symId,
                    symbol: sym,
                    side: td.tradeSide === 2 ? 'SELL' : 'BUY',
                    volumeRaw: td.volume || 0,
                    unitsLabel: sym === 'SOLUSD' ? `${((td.volume || 0) / 100).toFixed(2)} SOL` : `${((td.volume || 0) / 100).toFixed(2)} lot`,
                    entryPrice: p.price,
                    usedMarginEur: (p.usedMargin || 0) / 100,
                    swapEur: (p.swap || 0) / 100,
                    comment: td.comment || '',
                    openedAt: td.openTimestamp ? new Date(td.openTimestamp).toISOString() : null
                };
            }),
            ctraderRealCount: pepRealPositions.length,
            ctraderManagedCount: pepManagedCount,
            ctraderLibretaCount: pepLibreta,
            engineAlpacaQty: engineAlpaca,
            divergences
        };

        // 🚨 CIRCUIT BREAKER AUTOMÁTICO (Regla Sagrada Holding: Límite Drawdown Diario 2.50%)
        const today = romeDateStr();
        if (dailyDrawdownPct >= 2.50 && !engineState.emergencyStop) {
            engineState.emergencyStop = true;
            engineState.emergencyStopReason = `Drawdown diario alcanzó ${dailyDrawdownPct.toFixed(2)}% (>= 2.50%)`;
            if (pepperstoneService && pepperstoneService.centinelaState) {
                pepperstoneService.centinelaState.circuitBreakerTripped = true;
            }
            saveState();
            if (engineState.killSwitchAlertDate !== today) {
                engineState.killSwitchAlertDate = today;
                await notifyPedro(
                    `🚨🚨 <b>[ANASTASIA CIO • KILL SWITCH ACTIVADO (DD ${dailyDrawdownPct.toFixed(2)}%)]</b> 🚨🚨\n\n` +
                    `🛑 Se alcanzó el límite máximo diario de Drawdown (2.50%).\n` +
                    `🔒 Nuevas aperturas bloqueadas en Alpaca y Pepperstone hasta revisión del Chairman.`
                );
            }
        } else if (dailyDrawdownPct >= 2.00 && dailyDrawdownPct < 2.50 && engineState.dailyWarnAlertDate !== today) {
            engineState.dailyWarnAlertDate = today;
            await notifyPedro(
                `🟡 <b>[ANASTASIA CIO • ALERTA AMARILLA DE DRAWDOWN]</b>\n` +
                `⚠️ Drawdown diario actual: <b>${dailyDrawdownPct.toFixed(2)}%</b> (Límite crítico Kill Switch: 2.50%).`
            );
        }

        if (divergences.length > 0) {
            console.warn(`⚠️ [RECONCILE] Divergencias libreta vs Alpaca: ${JSON.stringify(divergences)}`);
        }
    } catch(e) {
        console.warn('[RECONCILE] Error:', e.message);
    }
}

// ------------------------------------------------------------------------------
// 📬 PARTE DIARIO POR TELEGRAM (KIMI 13-NOV) — Anastasia reporta sola desde
// Render, sin PC y sin Kimi: 09:00 Roma = latido "estoy viva", 22:05 Roma =
// parte de guerra completo tras el cierre de Wall Street.
// ------------------------------------------------------------------------------
function romeDateStr(d = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);
}

function duelStatsFor(list, keyFn) {
    const groups = {};
    list.forEach(t => { const k = keyFn(t) || '¿?'; (groups[k] = groups[k] || []).push(t); });
    return Object.entries(groups).map(([name, tr]) => {
        let w = 0, l = 0, pnl = 0;
        tr.forEach(t => {
            let p = parseFloat(t.pnl) || 0;
            if (t.currency === 'USD') p = p / 1.05;
            pnl += p;
            if (p > 0.05) w++; else if (p < -0.05) l++;
        });
        return { name, n: tr.length, w, l, pnl };
    }).sort((a, b) => b.pnl - a.pnl);
}

function medalRow(s, i) {
    const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '▫️'));
    const sign = s.pnl >= 0 ? '+' : '';
    return `${medal} ${s.name}: <b>${sign}€${s.pnl.toFixed(2)}</b> (${s.n} trades, ${s.w}W/${s.l}L)`;
}

function buildDailyReportText() {
    const today = romeDateStr();
    const hist = engineState.closedTradesHistory || [];
    const todayTrades = hist.filter(t => t.closedAt && romeDateStr(new Date(t.closedAt)) === today);
    let w = 0, l = 0, pnl = 0, real = 0;
    todayTrades.forEach(t => {
        let p = parseFloat(t.pnl) || 0;
        if (t.currency === 'USD') p = p / 1.05;
        pnl += p;
        if (p > 0.05) w++; else if (p < -0.05) l++;
        if (t.brokerCloseExecuted) real++;
    });
    const sign = pnl >= 0 ? '+' : '';
    const recon = engineState.brokerReconciliation || {};
    const divs = recon.divergences || [];

    let msg = `🇷🇺👑 <b>[ANASTASIA CIO • PARTE DE GUERRA ${today}]</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 <b>Hoy:</b> ${todayTrades.length} trades cerrados (${real} con cierre confirmado en broker)\n`;
    msg += `💰 <b>Resultado del día:</b> ${sign}€${pnl.toFixed(2)} ≈ (${w}W / ${l}L)\n`;
    msg += `📈 <b>Acumulado era real:</b> ${hist.length} trades\n`;
    msg += `🔓 <b>Posiciones abiertas ahora:</b> ${(engineState.openPositions || []).length}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🏦 <b>DUELO BROKERS (hoy):</b>\n`;
    const byBroker = duelStatsFor(todayTrades, t => (t.broker || '').includes('Alpaca') ? '🦙 Alpaca' : '🏛️ Pepperstone');
    msg += byBroker.length ? byBroker.map(medalRow).join('\n') + '\n' : '▫️ Sin cierres hoy\n';
    msg += `⚔️ <b>DUELO ACTIVOS (hoy):</b>\n`;
    const byAsset = duelStatsFor(todayTrades, t => {
        const s = t.symbol || '?';
        if (s.includes('XAU') || s === 'GLD') return '🥇 Oro';
        if (s.includes('SOL')) return '🟣 SOL';
        return s === 'NVDA' ? '💚 NVDA' : (s === 'TSLA' ? '🚗 TSLA' : s);
    });
    msg += byAsset.length ? byAsset.map(medalRow).join('\n') + '\n' : '▫️ Sin cierres hoy\n';
    msg += `🎯 <b>DUELO ESTRATEGIAS (hoy):</b>\n`;
    const byStrat = duelStatsFor(todayTrades, t => (t.strategy || '?').split(':')[0]);
    msg += byStrat.length ? byStrat.map(medalRow).join('\n') + '\n' : '▫️ Sin cierres hoy\n';
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💼 <b>Saldos reales:</b> Alpaca ${engineState.accountBalances.alpaca} · Pepperstone ${engineState.accountBalances.pepperstone}\n`;
    if (divs.length > 0) {
        msg += `⚠️ <b>ALARMA DIVERGENCIA:</b> ${divs.map(d => `${d.symbol}: motor ${d.engineQty} vs broker ${d.brokerQty}`).join(' | ')}\n`;
    } else {
        msg += `✅ Libreta reconciliada con los brokers (sin divergencias)\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `<i>Mañana seguimos cazando. Web: kraken-trading-cloud.web.app</i>`;
    return msg;
}

async function sendDailyReport() {
    const today = romeDateStr();
    engineState.lastDailyReportDate = today;
    await notifyPedro(buildDailyReportText());
    firestoreStore.saveDailyPerformanceMetric(today, {
        accountBalances: engineState.accountBalances,
        liveMetrics: engineState.liveMetrics,
        globalStats: (engineState.performanceStats && engineState.performanceStats.global) || {}
    }).catch(() => {});
    saveState(true);
    console.log('📬 [PARTE DIARIO] Enviado a Pedro por Telegram.');
}

async function maybeSendScheduledReports() {
    const d = romeNow();
    const mins = d.getHours() * 60 + d.getMinutes();
    const today = romeDateStr();
    // 09:00 Roma: latido de vida
    if (mins >= 9 * 60 && mins < 9 * 60 + 2 && engineState.lastHeartbeatDate !== today) {
        engineState.lastHeartbeatDate = today;
        await notifyPedro(`🐙💓 <b>[Kraken despierto]</b> Motor online en Frankfurt. ${(engineState.openPositions || []).length} posiciones vivas, ${(engineState.closedTradesHistory || []).length} trades en la era real. Escaneando cada 30s.`);
        saveState();
    }
    // 22:05 Roma: parte de guerra tras cierre de Wall Street
    if (mins >= 22 * 60 + 5 && engineState.lastDailyReportDate !== today) {
        await sendDailyReport();
    }
}

// ------------------------------------------------------------------------------
// 🛡️ GESTIÓN AUTÓNOMA DE SALIDAS (STOP LOSS, TAKE PROFIT & TRAILING BE)
// ------------------------------------------------------------------------------
async function manageOpenPositions(currentQuotes) {
    if (engineState.openPositions.length === 0) return;

    const remainingPositions = [];

    for (const pos of engineState.openPositions) {
        if (pos.legacyExternal) {
            remainingPositions.push(pos);
            continue;
        }
        // Fuera de sesión (acciones US / oro): no gestionar. Las velas llegan congeladas
        // y comparar precios viejos contra SL/TP genera cierres fantasma que el broker
        // rechaza con MARKET_CLOSED. La posición espera viva a la próxima sesión.
        if (!isSessionOpenForAsset(pos.symbol)) {
            remainingPositions.push(pos);
            continue;
        }

        // Protección anti-whipsaw de entrada: no ejecutar cierres automáticos en los primeros 60s desde apertura
        const ageMs = pos.openedAt ? (Date.now() - new Date(pos.openedAt).getTime()) : 999999;
        if (ageMs >= 0 && ageMs < 60000) {
            remainingPositions.push(pos);
            continue;
        }

        const currentPrice = currentQuotes[pos.symbol] || pos.entryPrice;
        const config = ASSETS_CONFIG[pos.symbol];
        let positionClosed = false;
        let closeReason = '';
        let profitAmount = 0.0;

        // [CLAUDE v2] P10-P12 nunca duermen con la posición abierta: cierre a las 15:55 de Nueva York
        if (pos.closeAtSessionEnd && !(pos.symbol || '').includes('SOL')) {
            const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
            const nyMins = (+ny.hour % 24) * 60 + (+ny.minute);
            if (nyMins >= 955) {
                positionClosed = true;
                closeReason = '⏰ Cierre de sesión (15:55 NY)';
                profitAmount = (currentPrice - pos.entryPrice) * pos.qty;
            }
        }

        // A) LÓGICA ESPECIAL PISTA 1: ESCALERA DELFÍN 4X4 (TP ESCALONADO DINÁMICO)
        if (pos.isDelfin4x4) {
            const tranches = pos.tranchesClosed || 0;
            const trancheQty = (pos.initialQty || pos.qty || 1) * 0.25;

            // Escalón 1: +0.75 ATR -> Asegurar 25% de ganancia inmediata
            if (tranches === 0 && currentPrice >= pos.tp1) {
                pos.tranchesClosed = 1;
                const profit1 = (pos.tp1 - pos.entryPrice) * trancheQty;
                pos.realizedPartialPnl = (pos.realizedPartialPnl || 0) + profit1;
                console.log(`🐬🎯 [DELFÍN 4x4 • ESCALÓN 1/4] ${pos.symbol}: +0.75 ATR ($${pos.tp1})! 25% cobrado (+$$${profit1.toFixed(2)}).`);

                if (pos.timeframe === '15m' || pos.timeframe === '1H' || pos.timeframe === '4H' || Math.abs(profit1) >= 2.0) {
                    const msg = `🐬🎯 <b>[DELFÍN ESCALÓN 1/4 COBRADO]</b>\n` +
                        `💰 <b>${pos.symbol} superó +0.75 ATR ($${pos.tp1.toFixed(2)})</b>\n` +
                        `✅ <b>25% asegurado en caja:</b> +$${profit1.toFixed(2)} ${pos.currency || 'USD'}\n` +
                        `🛡️ Resto de la posición protegida esperando Escalón 2.`;
                    await notifyPedro(msg);
                }
            }

            // Escalón 2: +1.50 ATR -> Cobrar otro 25% + Mover SL a BREAKEVEN (Riesgo Cero 🛡️)
            if (tranches === 1 && currentPrice >= pos.tp2) {
                pos.tranchesClosed = 2;
                const profit2 = (pos.tp2 - pos.entryPrice) * trancheQty;
                pos.realizedPartialPnl = (pos.realizedPartialPnl || 0) + profit2;
                pos.sl = pos.entryPrice;
                pos.trailingStopMovedToBreakeven = true;
                console.log(`🐬🛡️ [DELFÍN 4x4 • ESCALÓN 2/4] ${pos.symbol}: +1.50 ATR ($${pos.tp2})! 50% cobrado y SL a Breakeven ($${pos.entryPrice}).`);

                if (pos.timeframe === '15m' || pos.timeframe === '1H' || pos.timeframe === '4H' || Math.abs(profit2) >= 2.0) {
                    const msg = `🐬🛡️ <b>[DELFÍN ESCALÓN 2/4 • CAPITAL BLINDADO]</b>\n` +
                        `💰 <b>${pos.symbol} superó +1.50 ATR ($${pos.tp2.toFixed(2)})</b>\n` +
                        `✅ <b>Otro 25% cobrado (Total 50% en ganancias)</b>\n` +
                        `🛡️ <b>Stop Loss movido a Breakeven ($${pos.entryPrice})</b>.\n` +
                        `🔒 ¡Riesgo CERO absoluto garantizado en esta operación!`;
                    await notifyPedro(msg);
                }
            }

            // Escalón 3: +2.25 ATR -> Cobrar otro 25% + Subir SL a Asegurar Ganancia (+0.75 ATR)
            if (tranches === 2 && currentPrice >= pos.tp3) {
                pos.tranchesClosed = 3;
                const profit3 = (pos.tp3 - pos.entryPrice) * trancheQty;
                pos.realizedPartialPnl = (pos.realizedPartialPnl || 0) + profit3;
                pos.sl = pos.tp1; // Subir SL a asegurar ganancia mínima de +0.75 ATR
                console.log(`🐬🚀 [DELFÍN 4x4 • ESCALÓN 3/4] ${pos.symbol}: +2.25 ATR ($${pos.tp3})! 75% cobrado y SL en ganancia ($${pos.sl}).`);

                if (pos.timeframe === '15m' || pos.timeframe === '1H' || pos.timeframe === '4H' || Math.abs(profit3) >= 2.0) {
                    const msg = `🐬🚀 <b>[DELFÍN ESCALÓN 3/4 • GANANCIA BLOQUEADA]</b>\n` +
                        `💰 <b>${pos.symbol} superó +2.25 ATR ($${pos.tp3.toFixed(2)})</b>\n` +
                        `✅ <b>75% del trade cobrado en caja</b>\n` +
                        `🔒 <b>Stop Loss subido a $${pos.sl.toFixed(2)} (+0.75 ATR)</b> garantizando ganancia pase lo que pase.`;
                    await notifyPedro(msg);
                }
            }

            // Escalón 4: +3.00 ATR -> Take Profit Final o Runner completado!
            if (tranches >= 3 && currentPrice >= pos.tp4) {
                positionClosed = true;
                closeReason = '🚀 Escalera Delfín 4x4 Completada (+3.0 ATR) 🎯';
                const profit4 = (pos.tp4 - pos.entryPrice) * trancheQty;
                profitAmount = (pos.realizedPartialPnl || 0) + profit4;
            }
        }

        // B) GESTIÓN ESTÁNDAR PARA NO-DELFÍN (PISTAS 2..8 / CUSTODIA)
        // [CLAUDE v2] Escalera de stops de Pedro: el recorrido hasta el objetivo se divide en 4 escalones.
        // Al tocar el escalón k, el stop sube al escalón k-1 (el 1º lo lleva a la entrada). En el 4º se cierra todo.
        if (!positionClosed && !pos.isDelfin4x4 && pos.exitMode === 'STEP' && pos.tp > pos.entryPrice) {
            const stepD = (pos.tp - pos.entryPrice) / 4;
            let step = pos.stepReached || 0;
            while (step < 4 && currentPrice >= pos.entryPrice + stepD * (step + 1)) step++;
            if (step >= 4) {
                positionClosed = true;
                closeReason = '🪜 Escalera completada (objetivo) 🎯';
                profitAmount = (currentPrice - pos.entryPrice) * pos.qty;
            } else if (step > (pos.stepReached || 0)) {
                pos.stepReached = step;
                const newSl = pos.entryPrice + stepD * (step - 1);
                if (newSl > pos.sl) {
                    pos.sl = parseFloat(newSl.toFixed(4));
                    pos.trailingStopMovedToBreakeven = true;
                    console.log(`🪜 [ESCALERA ${step}/4] ${pos.symbol} (${pos.broker}): stop sube a ${pos.sl}`);
                    if (pos.broker && pos.broker.includes('Pepperstone') && (pos.positionId || pos.id) && pepperstoneService.amendPositionSLTPViaOpenAPI) {
                        pepperstoneService.amendPositionSLTPViaOpenAPI(pos.positionId || pos.id, pos.sl, pos.tp).catch(() => {});
                    }
                }
            }
        }

        if (!pos.isDelfin4x4 && !positionClosed && pos.exitMode !== 'STEP') {
            // 1. Verificación de Trailing Stop a Breakeven (+1.5 ATR)
            if (!pos.trailingStopMovedToBreakeven && currentPrice >= pos.breakevenTrigger) {
                pos.sl = pos.entryPrice; // Movemos SL al precio de entrada (Riesgo Cero)
                pos.trailingStopMovedToBreakeven = true;
                console.log(`🔒 [TRAILING A BREAKEVEN] ${pos.symbol}: Stop Loss movido a $${pos.entryPrice} (Riesgo Cero).`);
                if (pos.broker && pos.broker.includes('Pepperstone') && (pos.positionId || pos.id) && pepperstoneService.amendPositionSLTPViaOpenAPI) {
                    pepperstoneService.amendPositionSLTPViaOpenAPI(pos.positionId || pos.id, pos.sl, pos.tp).catch(() => {});
                }

                if (pos.timeframe === '15m' || pos.timeframe === '1H' || pos.timeframe === '4H') {
                    const beMsg = `🇷🇺👑 <b>[Anastasia CIO • BLINDAJE DE CAPITAL]</b>\n` +
                        `🛡️ <b>${pos.symbol} superó +1.5 ATR de ganancia</b>\n` +
                        `He movido el Stop Loss al precio de entrada ($${pos.entryPrice}).\n` +
                        `<b>Riesgo Cero absoluto garantizado</b> en esta operación.`;
                    await notifyPedro(beMsg);
                }
            }

            // 2. Verificación de Take Profit / Ballena Runner (+3.0 a +5.0 ATR)
            const isWhale = pos.pez && pos.pez.includes('BALLENA');
            const targetTp = isWhale ? (pos.whaleRunnerTp || pos.tp) : pos.tp;
            if (currentPrice >= targetTp && currentPrice > pos.entryPrice) {
                positionClosed = true;
                closeReason = isWhale ? '🐋 Ballena Runner Completada (+5.0 ATR) 🎯' : 'Take Profit alcanzado (+3.0 ATR) 🎯';
                profitAmount = (currentPrice - pos.entryPrice) * pos.qty;
            }
        }

        // C) STOP LOSS (Común para todas las estrategias)
        if (!positionClosed && currentPrice <= pos.sl) {
            positionClosed = true;
            if (pos.isDelfin4x4) {
                const remainingFraction = 1 - ((pos.tranchesClosed || 0) * 0.25);
                const lossRemaining = (pos.sl - pos.entryPrice) * pos.qty * remainingFraction;
                profitAmount = (pos.realizedPartialPnl || 0) + lossRemaining;

                if (pos.tranchesClosed === 3) {
                    closeReason = `🔒 Salida con 75% Cobrado y Ganancia Bloqueada (+$${profitAmount.toFixed(2)})`;
                } else if (pos.tranchesClosed === 2) {
                    closeReason = `🛡️ Salida Breakeven con 50% Cobrado (+$${profitAmount.toFixed(2)})`;
                } else if (pos.tranchesClosed === 1) {
                    closeReason = `🛡️ Salida con 25% Cobrado (Neto: $${profitAmount.toFixed(2)})`;
                } else {
                    closeReason = 'Stop Loss ejecutado (-1.5 ATR) 🛑';
                }
            } else {
                closeReason = pos.trailingStopMovedToBreakeven ? 'Salida en Breakeven (Riesgo Cero) 🛡️' : 'Stop Loss ejecutado (-1.5 ATR) 🛑';
                profitAmount = (pos.sl - pos.entryPrice) * pos.qty;
            }
        }

        if (positionClosed) {
            const isSol = (pos.symbol || '').includes('SOL');
            const pnlDecimals = isSol ? 4 : 2;

            // 🔧 KIMI FIX: ejecutar el cierre REAL en el broker antes de anotarlo.
            pos.brokerCloseExecuted = false;
            try {
                const closeRes = await executeRealBrokerClose(pos);
                pos.brokerCloseExecuted = true;
                pos.brokerCloseInfo = closeRes;
                console.log(`✅ [CIERRE REAL EN BROKER] ${pos.symbol} (${pos.broker}): ${JSON.stringify(closeRes)}`);
            } catch(closeErr) {
                pos.closeError = closeErr.message;
                console.error(`❌ [CIERRE REAL FALLÓ] ${pos.symbol} (${pos.broker}): ${closeErr.message} — se anota en libreta pero el broker puede seguir abierto.`);
            }

            console.log(`\n🎯 [CIERRE AUTÓNOMO] Posición ${pos.symbol} cerrada: ${closeReason} | PnL: $${profitAmount.toFixed(pnlDecimals)}`);

            pos.closedAt = new Date().toISOString();
            pos.exitPrice = currentPrice;
            // [FIX CLAUDE 18-NOV] El libro se apunta con el fill real del broker, no con el precio que vio el motor
            const ci = pos.brokerCloseInfo || {};
            if (ci.exitFill > 0 && ci.qtySold > 0) {
                pos.exitPrice = ci.exitFill;
                pos.qty = ci.qtySold;
                profitAmount = (ci.exitFill - pos.entryPrice) * ci.qtySold;
                pos.pnlVerifiedByBroker = true;
            } else {
                pos.pnlVerifiedByBroker = false; // cierre del broker o fallo: revisar contra Alpaca/cTrader
            }
            pos.pnl = parseFloat(profitAmount.toFixed(pnlDecimals));
            pos.closeReason = closeReason;
            if (pos.initialRiskPerUnit > 0 && pos.qty > 0) {
                pos.rMultiple = parseFloat((pos.pnl / (pos.initialRiskPerUnit * pos.qty)).toFixed(2));
            } else {
                pos.rMultiple = null;
            }

            // Cooldown anti-churn: registrar marca de tiempo para evitar reaperturas instantáneas
            if (!engineState.closedCooldowns) engineState.closedCooldowns = {};
            const cooldownKey = `${pos.symbol}_${pos.strategy}_${pos.timeframe || '5m'}`;
            engineState.closedCooldowns[cooldownKey] = Date.now();

            engineState.closedTradesHistory.unshift(pos);
            computePerformanceStats();
            firestoreStore.saveClosedTrade(pos).catch(() => {});
            if (engineState.brokerReconciliation && Array.isArray(engineState.brokerReconciliation.ctraderPositions) && pos.positionId) {
                engineState.brokerReconciliation.ctraderPositions = engineState.brokerReconciliation.ctraderPositions
                    .filter(cp => String(cp.positionId) !== String(pos.positionId));
            }
            const isAlpaca = pos.broker && pos.broker.includes('Alpaca');
            if (isAlpaca || (config && config.currency === 'USD')) engineState.dailyRealizedPnlUSD += pos.pnl;
            else engineState.dailyRealizedPnlEUR += pos.pnl;

            // Notificación a Pedro del cierre (Solo 15m/1H/4H o PnL relevante >= $2.00 para evitar spam)
            const shouldNotifyClose = (pos.timeframe === '15m' || pos.timeframe === '1H' || pos.timeframe === '4H' || Math.abs(pos.pnl) >= 2.0);
            if (shouldNotifyClose) {
                const isProfit = pos.pnl >= 0;
                const icon = isProfit ? '💰' : '🛡️';
                const sign = isProfit ? '+' : '';

                const closeMsg = `🇷🇺👑 <b>[Anastasia CIO • POSICIÓN CERRADA]</b>\n` +
                    `${icon} <b>Operación completada en ${pos.symbol}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📊 <b>Motivo:</b> ${closeReason}\n` +
                    `💵 <b>Entrada:</b> $${pos.entryPrice} | <b>Salida:</b> $${currentPrice}\n` +
                    `📈 <b>Beneficio Neto:</b> ${sign}$${pos.pnl.toFixed(pnlDecimals)} ${config.currency}\n` +
                    `🏢 <b>Broker:</b> ${pos.broker}\n` +
                    `🔧 <b>Cierre real en broker:</b> ${pos.brokerCloseExecuted ? '✅ Ejecutado' : '❌ FALLÓ: ' + (pos.closeError || 'desconocido')}\n` +
                    `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Rome' })}\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `<i>Capital protegido y acumulado con frialdad cuantitativa.</i>`;

                await notifyPedro(closeMsg);
            }
        } else {
            remainingPositions.push(pos);
        }
    }

    engineState.openPositions = remainingPositions;
    const remPep = remainingPositions.filter(p => p.broker && p.broker.includes('Pepperstone'));
    const nextRealPepCount = (engineState.brokerReconciliation && typeof engineState.brokerReconciliation.ctraderRealCount === 'number')
        ? Math.max(remPep.length, engineState.brokerReconciliation.ctraderRealCount - (engineState.brokerReconciliation.ctraderManagedCount - remPep.length))
        : remPep.length;
    if (engineState.brokerReconciliation) {
        engineState.brokerReconciliation.ctraderManagedCount = remPep.length;
        engineState.brokerReconciliation.ctraderRealCount = Math.max(0, nextRealPepCount);
    }
    const hadClosedTrades = (engineState.openPositions.length !== remainingPositions.length);
    saveState(hadClosedTrades);
    if (pepperstoneService && pepperstoneService.syncOpenPositions) {
        pepperstoneService.syncOpenPositions(remPep, engineState.brokerReconciliation ? engineState.brokerReconciliation.ctraderRealCount : remPep.length);
    }
}

// ------------------------------------------------------------------------------
// 📋 CONCILIACIÓN DIARIA 22:30 ROMA (AUDITORÍA PASIVA Y ALERTA TELEGRAM)
// ------------------------------------------------------------------------------
async function checkDailyReconciliationAt2230() {
    const d = romeNow();
    // Ventana de 5 minutos a las 22:30 Roma
    if (d.getHours() === 22 && d.getMinutes() >= 30 && d.getMinutes() < 35) {
        const todayStr = romeDateStr(d);
        if (engineState.lastDailyReconciliationDate === todayStr) return;

        try {
            console.log(`[CONCILIACIÓN 22:30 ROMA] Iniciando control de libro vs Alpaca (${todayStr})...`);
            const [acc, alpPositions] = await Promise.all([
                alpacaService.getAccount().catch(() => null),
                alpacaService.getPositions().catch(() => null)
            ]);

            if (!acc || !Array.isArray(alpPositions)) {
                console.warn('[CONCILIACIÓN 22:30 ROMA] Alpaca offline o error de cuenta');
                return; // [FIX CLAUDE v2] no se marca el día: reintenta en el próximo ciclo dentro de la ventana
            }
            engineState.lastDailyReconciliationDate = todayStr;
            saveState();

            const symbols = ['TSLA', 'NVDA', 'SOLUSD', 'GLD'];
            const qtyDiscrepancies = [];

            symbols.forEach(sym => {
                const bookQty = engineState.openPositions
                    .filter(p => (p.broker || '').includes('Alpaca') && (p.orderSymbol === sym || p.symbol === sym))
                    .reduce((sum, p) => sum + (parseFloat(p.qty) || 0), 0);

                const alpReal = (alpPositions || []).find(p => p.symbol === sym || p.symbol === sym.replace('/', ''));
                const realQty = alpReal ? parseFloat(alpReal.qty || 0) : 0;

                const extQty = (engineState.externalQty && engineState.externalQty[sym])
                    ? (parseFloat(engineState.externalQty[sym]) || 0)
                    : 0;
                const brokerQtyForEngine = Math.max(0, realQty - extQty);

                const diff = Math.abs(bookQty - brokerQtyForEngine);
                if (diff > 0.001) {
                    qtyDiscrepancies.push(`• <b>${sym}:</b> Libro = ${bookQty} | Broker Motor = ${brokerQtyForEngine} (Total: ${realQty}, Externa: ${extQty}) (Δ ${diff.toFixed(3)}) ⚠️`);
                } else if (extQty > 0) {
                    qtyDiscrepancies.push(`• <b>${sym}:</b> Libro = ${bookQty} | Broker Motor = ${brokerQtyForEngine} (Externa: ${extQty}) ✅`);
                }
            });

            // Comparar cambio de saldo de Alpaca con (P&L cerrado del día + P&L no realizado de posiciones abiertas, sumando externas)
            const todayTrades = (engineState.closedTradesHistory || []).filter(t =>
                t.closedAt && romeDateStr(new Date(t.closedAt)) === todayStr && (t.broker || '').includes('Alpaca')
            );
            const closedPnlDay = todayTrades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);

            // P&L no realizado de TODAS las posiciones abiertas en Alpaca (incluye las externas)
            const unrealizedPnlDay = (alpPositions || []).reduce((sum, p) => {
                const u = parseFloat(p.unrealizedIntradayPnl ?? p.unrealizedPnl ?? 0); // [CLAUDE v2] intradía: el saldo de ayer ya incluye lo de días anteriores
                return sum + (isFinite(u) ? u : 0);
            }, 0);

            const totalTheorPnlDay = closedPnlDay + unrealizedPnlDay;

            const equity = parseFloat(acc.equity || 0);
            const lastEquity = parseFloat(acc.lastEquity || equity);
            const brokerEquityChange = equity - lastEquity;
            const pnlDiff = Math.abs(totalTheorPnlDay - brokerEquityChange);

            let pnlDiscrepancy = null;
            if (pnlDiff > 5.0) {
                pnlDiscrepancy = `• <b>P&L Día vs Saldo:</b> Teórico $${totalTheorPnlDay.toFixed(2)} (Cerrado $${closedPnlDay.toFixed(2)} + No Realizado $${unrealizedPnlDay.toFixed(2)}) | Cambio Saldo Broker = $${brokerEquityChange.toFixed(2)} (Δ $${pnlDiff.toFixed(2)} USD)`;
            }

            const hasAlert = qtyDiscrepancies.some(q => q.includes('⚠️')) || pnlDiscrepancy;
            if (hasAlert || qtyDiscrepancies.length > 0) {
                let msg = `📋 <b>[CONCILIACIÓN DIARIA 22:30 ROMA]</b>\n`;
                msg += `Fecha: <code>${todayStr}</code>\n\n`;
                if (qtyDiscrepancies.length > 0) {
                    msg += `<b>Diferencias en Posiciones:</b>\n` + qtyDiscrepancies.join('\n') + `\n\n`;
                }
                if (pnlDiscrepancy) {
                    msg += `<b>Diferencia en Saldo:</b>\n${pnlDiscrepancy}\n\n`;
                }
                msg += `<i>Auditoría pasiva. No se cerró ni adoptó nada automáticamente.</i>`;
                await notifyPedro(msg).catch(() => {});
                console.log(`[CONCILIACIÓN 22:30 ROMA] Reporte emitido a Telegram.`);
            } else {
                console.log(`[CONCILIACIÓN 22:30 ROMA] ✅ Todo conciliado exactamente (0 diferencias).`);
            }
        } catch(err) {
            console.error('[CONCILIACIÓN 22:30 ROMA ERROR]', err.message);
        }
    }
}

// ------------------------------------------------------------------------------
// 🔄 CICLO CUANTITATIVO PERPETUO DE ANASTASIA
// ------------------------------------------------------------------------------
async function runAutonomousCycle() {
    if (engineState.emergencyStop) {
        console.log('🛑 [EMERGENCIA ACTIVADA] Operativa detenida por orden de Pedro. No se abren nuevas posiciones.');
        return;
    }
    engineState.totalScans++;
    engineState.lastScanAt = new Date().toISOString();

    const quotes = await fetchMarketQuotes();

    // 0. Cada 10 escaneos (~5 min): reconciliar libreta vs broker real y refrescar saldos
    if (engineState.totalScans % 10 === 1) {
        await syncBrokerReality();
    }

    // [FIX CLAUDE 18-NOV] Conciliación diaria a las 22:30 Roma
    await checkDailyReconciliationAt2230();

    // 1. Gestionar posiciones abiertas existentes (Trailing BE, TP, SL)
    await manageOpenPositions(quotes);

    // Limpiar restos antiguos de temporalidad 1m eliminada por mandato de Pedro
    Object.keys(engineState.latestScores || {}).forEach(k => {
        if (k.endsWith('_1m')) delete engineState.latestScores[k];
    });

    // 2. Escaneo de los 4 activos evaluando las 8 Estrategias en los 4 Timeframes (5m, 15m, 1H, 4H)
    const TF_COOLDOWN_MS = { '5m': 15 * 60 * 1000, '15m': 30 * 60 * 1000, '1H': 60 * 60 * 1000, '4H': 240 * 60 * 1000 };
    if (!engineState.lastSignalBarTime) engineState.lastSignalBarTime = {};

    for (const [ticker, config] of Object.entries(ASSETS_CONFIG)) {
        const price = quotes[ticker] || quotes[config.altSymbol] || 0;
        let bestOverall = null;
        let openedTickerThisCycle = false;

        for (const tf of TIMEFRAMES) {
            const allStrats = evaluateAllStrategies(ticker, price, tf.label);
            const barsForTf = (latestEnrichedBars[ticker] && latestEnrichedBars[ticker][tf.label]) ? latestEnrichedBars[ticker][tf.label] : [];
            const currentBarTime = barsForTf.length ? barsForTf[barsForTf.length - 1].t : null;
            let bestForTf = null;

            for (const analysis of allStrats) {
                analysis.timeframe = tf.label;

                // Seleccionar la mejor estrategia de este timeframe (BUY primero, luego mayor Score)
                const candPriority = (analysis.action === 'BUY' ? 1000 : 0) + (analysis.score || 0);
                const curTfPriority = bestForTf ? ((bestForTf.action === 'BUY' ? 1000 : 0) + (bestForTf.score || 0)) : -1;
                if (!bestForTf || candPriority > curTfPriority) {
                    bestForTf = analysis;
                }

                // Si no es BUY (la propia estrategia dictó HOLD o sus propios filtros bloquearon), saltar
                if (analysis.action !== 'BUY') {
                    if (analysis.blockedReason) {
                        console.log(`🛡️ [FILTRO PROPIO ${analysis.strategyName} • ${tf.label}] ${ticker}: ${analysis.blockedReason}`);
                    }
                    continue;
                }

                // Restricciones de activo por diseño de la estrategia:
                if (analysis.stratCode === 'p7' && (ticker !== 'TSLA' && ticker !== 'NVDA')) continue;
                if (analysis.stratCode === 'p6' && (ticker !== 'NVDA' && ticker !== 'TSLA' && ticker !== 'GLD' && ticker !== 'XAUUSD')) continue;
                if (analysis.stratCode === 'p8' && (ticker !== 'XAUUSD' && ticker !== 'GLD' && !ticker.includes('SOL'))) continue;

                // 🛑 MANDATO DE ORO DE PEDRO: Cero entradas en SOL en rango seco (volumen muerto de noche)
                if (ticker.includes('SOL') && (analysis.indicators?.rvol || 0) < 1.5) {
                    console.log(`🛑 [CHOP FILTER ${tf.label}] SOL ignorado: rVol insuficiente (${analysis.indicators?.rvol || 0} < 1.5x).`);
                    continue;
                }

                // Máximo 1 disparo por misma vela cerrada/en curso en (activo, estrategia, timeframe)
                const barKey = `${ticker}_${analysis.stratCode}_${tf.label}`;
                if (currentBarTime && engineState.lastSignalBarTime[barKey] === currentBarTime) {
                    continue;
                }

                // Evitar duplicar posición en el mismo activo, misma estrategia y mismo timeframe
                const hasOpenInSameStrategy = engineState.openPositions.some(p => 
                    p.symbol === ticker && 
                    p.strategy === analysis.strategyName &&
                    (p.timeframe === tf.label || (!p.timeframe && tf.label === '5m'))
                );
                if (hasOpenInSameStrategy) continue;

                // Cooldown anti-churn proporcional al timeframe tras cierre (o reinicio desde historial)
                const cooldownKey = `${ticker}_${analysis.strategyName}_${tf.label}`;
                const assetCooldownKey = `${ticker}_LAST_OPEN`;
                const minCooldown = TF_COOLDOWN_MS[tf.label] || 15 * 60 * 1000;
                if (engineState.closedCooldowns && engineState.closedCooldowns[cooldownKey]) {
                    const elapsed = Date.now() - engineState.closedCooldowns[cooldownKey];
                    if (elapsed < minCooldown) continue;
                }
                if (engineState.closedCooldowns && engineState.closedCooldowns[assetCooldownKey]) {
                    const elapsedAsset = Date.now() - engineState.closedCooldowns[assetCooldownKey];
                    if (elapsedAsset < 10 * 60 * 1000) continue; // Mínimo 10 min entre aperturas en el mismo activo
                }
                if (openedTickerThisCycle) continue; // Máximo 1 apertura simultánea por activo y escaneo

                // ⏰ MANDATO PEDRO: no abrir fuera de sesión ni en los últimos 30 min (SOL es 24/7)
                if (!isEntryWindowForAsset(ticker)) {
                    console.log(`⏰ [HORARIO] Señal ${ticker} (${analysis.strategyName} • ${tf.label}) ignorada: fuera de ventana de entrada (15:30-21:30 Roma, L-V).`);
                    continue;
                }

                // Candado sagrado de máximo 24 posiciones simultáneas REALES en Pepperstone (libreta + API cTrader)
                const pepLibretaCount = engineState.openPositions.filter(p => !p.broker || p.broker.includes('Pepperstone')).length;
                const ctraderRealCount = (engineState.brokerReconciliation && typeof engineState.brokerReconciliation.ctraderRealCount === 'number')
                    ? engineState.brokerReconciliation.ctraderRealCount : pepLibretaCount;
                const pepCount = Math.max(pepLibretaCount, ctraderRealCount);

                if (pepCount < 24 && price > 0) {
                    const opened = await executeAutonomousOpen(ticker, price, analysis);
                    if (opened && opened.length > 0) {
                        openedTickerThisCycle = true;
                        if (currentBarTime) engineState.lastSignalBarTime[barKey] = currentBarTime;
                        if (!engineState.closedCooldowns) engineState.closedCooldowns = {};
                        engineState.closedCooldowns[assetCooldownKey] = Date.now();
                    }
                } else {
                    console.log(`🔒 [CANDADO PEPPERSTONE] Máximo 24 posiciones reales alcanzado (${pepCount}/24 en cTrader). Señal ${ticker} (${analysis.strategyName} • ${tf.label}) en espera.`);
                }
            }

            if (bestForTf) {
                const tfEntry = {
                    score: bestForTf.score,
                    pez: bestForTf.pez,
                    price: price,
                    barPrice: bestForTf.barPrice || price,
                    action: bestForTf.action,
                    strategy: bestForTf.strategyName,
                    stratCode: bestForTf.stratCode,
                    timeframe: tf.label,
                    isPromoted: bestForTf.isPromoted,
                    indicators: bestForTf.indicators || null,
                    signalReason: bestForTf.signalReason || '',
                    sl: bestForTf.sl,
                    tp: bestForTf.tp,
                    allStrats: allStrats.map(s => ({
                        code: s.stratCode,
                        score: s.score,
                        action: s.action
                    })),
                    time: new Date().toISOString()
                };
                engineState.latestScores[`${ticker}_${tf.label}`] = tfEntry;

                const tfPrio = (bestForTf.action === 'BUY' ? 1000 : 0) + (bestForTf.score || 0);
                const ovPrio = bestOverall ? ((bestOverall.action === 'BUY' ? 1000 : 0) + (bestOverall.score || 0)) : -1;
                if (!bestOverall || tfPrio > ovPrio) {
                    bestOverall = tfEntry;
                }
            }
        }

        if (bestOverall) {
            engineState.latestScores[ticker] = { ...bestOverall, price: price };
        }
    }

    // 3. Recalcular Matriz Cuantitativa en Vivo (Win Rate & PnL)
    computePerformanceStats();

    // 4. Partes programados a Pedro (latido 09:00 y parte de guerra 22:05 Roma)
    await maybeSendScheduledReports();

    saveState();
}

// Iniciar Motor Perpetuo
let daemonTimer = null;

function seedRecentCooldownsFromHistory() {
    if (!engineState.closedCooldowns) engineState.closedCooldowns = {};
    const hist = engineState.closedTradesHistory || [];
    const nowMs = Date.now();
    for (const t of hist.slice(0, 60)) {
        const closedMs = new Date(t.closedAt || 0).getTime();
        if (!closedMs || (nowMs - closedMs) > 60 * 60 * 1000) continue;
        const sym = t.symbol;
        if (!sym) continue;
        const key = `${sym}_LAST_OPEN`;
        if (!engineState.closedCooldowns[key] || closedMs > engineState.closedCooldowns[key]) {
            engineState.closedCooldowns[key] = closedMs;
        }
    }
}

async function startAutonomousDaemon(intervalMs = 30000) {
    if (daemonTimer) {
        console.log('[ANASTASIA ENGINE] Ya se encuentra en ejecución activa.');
        return;
    }
    engineState.running = true;
    console.log('===========================================================');
    console.log('🇷🇺👑 KRAKEN CLOUD // ANASTASIA AGENTE AUTÓNOMO INICIADO 24/7');
    console.log('   Activos: TSLA, NVDA, XAUUSD (Oro), SOLUSD (Solana)');
    console.log('   Brokers: Alpaca Algorithmic & Pepperstone cTrader (Auditados Live por API)');
    console.log('   Modo: 100% Independiente y Manos Libres para Pedro');
    console.log('===========================================================');

    // ♻️ Secuencia ordenada de arranque tras redespliegue:
    // 1. Hidratar desde Google Firestore -> 2. Velas/ATRs -> 3. Fills Alpaca -> 4. Reconciliación APIs -> 5. Escaneo
    try {
        await firestoreStore.hydrateFromFirestore(engineState).catch(e => console.warn('🔥 [ARRANQUE FIRESTORE] Error:', e.message));
        let catchupIso = engineState.labResetAt || null;
        if (engineState.closedTradesHistory && engineState.closedTradesHistory.length > 0) {
            const latestMs = engineState.closedTradesHistory.reduce((mx, t) => Math.max(mx, new Date(t.closedAt || 0).getTime()), 0);
            if (latestMs > 0) catchupIso = new Date(latestMs + 1000).toISOString();
        }
        console.log(`♻️ [ARRANQUE] Cargando mercado en vivo y sincronizando fills Alpaca desde ${catchupIso || '36h atrás'}...`);
        await fetchMarketQuotes().catch(e => console.warn('[ARRANQUE QUOTES] Error:', e.message));
        await rebuildHistoryFromAlpacaFills(catchupIso).catch(e => console.warn('♻️ [ARRANQUE REBUILD] Error:', e.message));
        computePerformanceStats();
        seedRecentCooldownsFromHistory();
        await syncBrokerReality().catch(e => console.warn('[ARRANQUE RECON] Error:', e.message));
        saveState(true);
    } finally {
        runAutonomousCycle().catch(e => console.error('[ANASTASIA ERROR]', e.message));
    }

    // Bucle continuo cada 30 segundos
    daemonTimer = setInterval(() => {
        runAutonomousCycle().catch(e => console.error('[ANASTASIA INTERVAL ERROR]', e.message));
    }, intervalMs);
}

function getLatestBars(symbol, timeframe = '5m') {
    const raw = (symbol || 'TSLA').toUpperCase();
    let key = raw;
    if (raw === 'GLD' || raw === 'ORO' || raw.includes('XAU')) key = 'XAUUSD';
    else if (raw.includes('SOL')) key = 'SOLUSD';

    const tfMap = { '5m': '5m', '5Min': '5m', '15m': '15m', '15Min': '15m', '1H': '1H', '1Hour': '1H', '4H': '4H', '4Hour': '4H' };
    const tfKey = tfMap[timeframe] || '5m';
    const bars = (latestEnrichedBars[key] && latestEnrichedBars[key][tfKey]) ? latestEnrichedBars[key][tfKey] : [];
    return bars;
}

function getEngineState() {
    return engineState;
}

// Ejecución directa si se invoca con node
if (require.main === module) {
    startAutonomousDaemon();
}

module.exports = {
    ASSETS_CONFIG,
    engineState,
    getEngineState,
    getLatestBars,
    startAutonomousDaemon,
    runAutonomousCycle,
    fetchMarketQuotes,
    calculate26HermanasScore,
    evaluateAllStrategies,
    computePerformanceStats,
    executeAutonomousOpen,
    manageOpenPositions,
    executeRealBrokerClose,
    syncBrokerReality,
    buildDailyReportText,
    maybeSendScheduledReports,
    notifyPedro
};
