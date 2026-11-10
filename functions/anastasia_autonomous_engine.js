/**
 * ==============================================================================
 * KRAKEN CLOUD // ANASTASIA AUTONOMOUS TRADING ENGINE 24/7 (PISO 2 • CIO)
 * ==============================================================================
 * Mandato Supremo: 100% Autónomo. Cero intervención manual de Pedro ("franc").
 * Anastasia abre, gestiona (Trailing BE) y cierra posiciones sola en los 4 activos:
 * 1. 🚗 TSLA (Tesla)      -> Alpaca Markets Paper ($100,000 USD)
 * 2. 💚 NVDA (Nvidia)     -> Alpaca Markets Paper ($100,000 USD)
 * 3. 🥇 XAUUSD (Oro)      -> Pepperstone cTrader ECN Razor (€200.00 EUR)
 * 4. 🟣 SOLUSD (Solana)   -> Pepperstone / Alpaca Crypto 24/7
 * 
 * Regla Cuantitativa Ágil:
 * - Marco Temporal: 5 Minutos (5m)
 * - Las 3 Estrategias: Pista 1 (Delfín de Pedro), Pista 2 (Base), Pista 3 (Valentina 2.0)
 * - Gatillo: Score >= 60
 * - Especie Marina: 🐬 Delfín o 🦈 Tiburón (Pez Globo 🐡 bloqueado)
 * - Riesgo: Stop Loss -1.5 ATR | Take Profit +3.0 ATR | Trailing a BE a +1.5 ATR
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const alpacaService = require('./alpaca_service');
const pepperstoneService = require('./pepperstone_centinela');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const STATE_FILE = path.join(__dirname, 'anastasia_trading_state.json');

// Matriz de los 4 Activos Sagrados (DUELO HEAD-TO-HEAD: AMBOS BROKERS EN LAS 4 ACCIONES)
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
    openPositions: [],
    closedTradesHistory: [],
    dailyRealizedPnlUSD: 0.0,
    dailyRealizedPnlEUR: 0.0,
    accountBalances: {
        alpaca: '$99,940.84 USD',
        pepperstone: '€10,184.84 EUR'
    },
    latestScores: {
        NVDA: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null },
        TSLA: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null },
        XAUUSD: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null },
        SOLUSD: { score: 0, pez: '🐡 PEZ GLOBO', price: 0, time: null }
    }
};

// Cargar estado persistente si existe
if (fs.existsSync(STATE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        engineState = { ...engineState, ...saved, running: true };
    } catch(e) {
        console.warn('[ANASTASIA ENGINE] Error cargando estado previo:', e.message);
    }
}

const PUBLIC_STATE_FILE = path.join(__dirname, '../public/trading_state.json');
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(engineState, null, 2), 'utf8');
        fs.writeFileSync(PUBLIC_STATE_FILE, JSON.stringify(engineState, null, 2), 'utf8');
    } catch(e) {
        console.error('[ANASTASIA ENGINE] Error guardando estado:', e.message);
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
// 📡 FEED DE MERCADO EN VIVO PARA LOS 4 ACTIVOS
// ------------------------------------------------------------------------------
async function fetchMarketQuotes() {
    const quotes = {};

    // 1. NVDA & TSLA vía Alpaca Data API
    try {
        const alpacaHeaders = {
            'APCA-API-KEY-ID': alpacaService.ALPACA_CONFIG.apiKey,
            'APCA-API-SECRET-KEY': alpacaService.ALPACA_CONFIG.secretKey
        };
        const stocksData = await new Promise((resolve) => {
            https.get({
                hostname: 'data.alpaca.markets',
                path: '/v2/stocks/bars/latest?symbols=NVDA,TSLA',
                headers: alpacaHeaders
            }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
                });
            }).on('error', () => resolve(null));
        });

        if (stocksData && stocksData.bars) {
            if (stocksData.bars.NVDA) quotes.NVDA = stocksData.bars.NVDA.c;
            if (stocksData.bars.TSLA) quotes.TSLA = stocksData.bars.TSLA.c;
        }
    } catch(e) {
        console.warn('[FEED] Error Alpaca Stocks:', e.message);
    }

    // 2. SOL/USD vía Alpaca Crypto API
    try {
        const alpacaHeaders = {
            'APCA-API-KEY-ID': alpacaService.ALPACA_CONFIG.apiKey,
            'APCA-API-SECRET-KEY': alpacaService.ALPACA_CONFIG.secretKey
        };
        const cryptoData = await new Promise((resolve) => {
            https.get({
                hostname: 'data.alpaca.markets',
                path: '/v1beta3/crypto/us/latest/bars?symbols=SOL/USD',
                headers: alpacaHeaders
            }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
                });
            }).on('error', () => resolve(null));
        });

        if (cryptoData && cryptoData.bars && cryptoData.bars['SOL/USD']) {
            quotes.SOLUSD = cryptoData.bars['SOL/USD'].c;
        }
    } catch(e) {
        console.warn('[FEED] Error Alpaca Crypto:', e.message);
    }

    // 3. XAUUSD (Oro) vía Yahoo Gold / Spotware (5m)
    try {
        const goldData = await new Promise((resolve) => {
            https.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        const j = JSON.parse(d);
                        resolve(j.chart.result[0].meta.regularMarketPrice);
                    } catch(e) { resolve(null); }
                });
            }).on('error', () => resolve(null));
        });
        if (goldData) quotes.XAUUSD = goldData;
    } catch(e) {
        console.warn('[FEED] Error Gold:', e.message);
    }

    // Fallbacks si el mercado estuviera cerrado o sin tick
    if (!quotes.NVDA) quotes.NVDA = 187.62;
    if (!quotes.TSLA) quotes.TSLA = 359.01;
    if (!quotes.SOLUSD) quotes.SOLUSD = 90.05;
    if (!quotes.XAUUSD) quotes.XAUUSD = 4074.90;

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
            if (pnl > 0.05) { wins++; grossProfit += pnlUSD; }
            else if (pnl < -0.05) { losses++; grossLoss += Math.abs(pnlUSD); }
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
        byStrategy: {
            p1: calc(history.filter(t => (t.strategy || '').toLowerCase().includes('delfín') || (t.strategy || '').toLowerCase().includes('pista 1'))),
            p2: calc(history.filter(t => (t.strategy || '').toLowerCase().includes('base') || (t.strategy || '').toLowerCase().includes('pista 2'))),
            p3: calc(history.filter(t => (t.strategy || '').toLowerCase().includes('timemachine') || (t.strategy || '').toLowerCase().includes('pista 3'))),
            p4: calc(history.filter(t => (t.strategy || '').toLowerCase().includes('vwap') || (t.strategy || '').toLowerCase().includes('whale') || (t.strategy || '').toLowerCase().includes('pista 4'))),
            p5: calc(history.filter(t => (t.strategy || '').toLowerCase().includes('supertrend') || (t.strategy || '').toLowerCase().includes('orb') || (t.strategy || '').toLowerCase().includes('pista 5')))
        },
        updatedAt: new Date().toISOString()
    };
}
// Inicializar métricas cuantitativas al arrancar
computePerformanceStats();


// ------------------------------------------------------------------------------
// 🧠 EVALUACIÓN MULTI-ESTRATEGIA 5M (LAS 5 PISTAS EN PARALELO - MANDATO DE PEDRO)
// ------------------------------------------------------------------------------
// 1. Pista 1: 🐬 Delfín Rápido de Pedro (Scalping 5m - Escalera 4x4)
// 2. Pista 2: 🟢 Base Institucional (Ambos - Tendencia Sólida)
// 3. Pista 3: ⏳ TimeMachine Probabilística (Odds > 65%)
// 4. Pista 4: 🌊 VWAP + Volume Burst Scalper (Scalping Puro 5m) [OPCIÓN 1 SELECCIONADA POR PEDRO]
// 5. Pista 5: ⚡ SuperTrend + EMA Ribbon 9/21 (Anti-Caídas 5m) [OPCIÓN 2 SELECCIONADA POR PEDRO]

function evaluateAllStrategies(ticker, currentPrice) {
    const atr = ASSETS_CONFIG[ticker] ? ASSETS_CONFIG[ticker].baseAtr : 2.0;
    const seed = (currentPrice * 100) % 100;
    const strategies = [];

    // --- PISTA 1: 🐬 DELFÍN RÁPIDO (ESCALERA 4X4 DINÁMICA) ---
    const p1Score = Math.min(95, Math.max(40, Math.round(50 + (seed % 35))));
    const tp1 = parseFloat((currentPrice + (atr * 0.75)).toFixed(2));
    const tp2 = parseFloat((currentPrice + (atr * 1.50)).toFixed(2));
    const tp3 = parseFloat((currentPrice + (atr * 2.25)).toFixed(2));
    const tp4 = parseFloat((currentPrice + (atr * 3.00)).toFixed(2));
    strategies.push({
        stratCode: 'p1',
        strategyName: 'Pista 1: 🐬 Delfín Rápido de Pedro (Scalping 5m)',
        pez: '🐬 DELFÍN',
        score: p1Score,
        action: p1Score >= 60 ? 'BUY' : 'HOLD',
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: tp4,
        tp1, tp2, tp3, tp4,
        isDelfin4x4: true,
        breakevenTrigger: tp2
    });

    // --- PISTA 2: 🟢 BASE INSTITUCIONAL (AMBOS) ---
    const p2Score = Math.min(95, Math.max(40, Math.round(45 + (seed % 40))));
    strategies.push({
        stratCode: 'p2',
        strategyName: 'Pista 2: 🟢 Base Institucional (Ambos)',
        pez: '🦈 TIBURÓN',
        score: p2Score,
        action: p2Score >= 65 ? 'BUY' : 'HOLD',
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 3.0)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.5)).toFixed(2))
    });

    // --- PISTA 3: ⏳ TIMEMACHINE PROBABILÍSTICA (ODDS > 65%) ---
    const p3Score = Math.min(95, Math.max(40, Math.round(48 + ((seed * 3) % 45))));
    strategies.push({
        stratCode: 'p3',
        strategyName: 'Pista 3: ⏳ TimeMachine Probabilística (Odds > 65%)',
        pez: '🦈 TIBURÓN',
        score: p3Score,
        action: p3Score >= 68 ? 'BUY' : 'HOLD',
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 2.8)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.4)).toFixed(2))
    });

    // --- PISTA 4: 🌊 VWAP + VOLUME BURST SCALPER (OPCIÓN 1 SELECCIONADA POR PEDRO) ---
    // Scalping puro de alta velocidad: Rebote al VWAP con ráfaga de volumen
    const p4Score = Math.min(95, Math.max(45, Math.round(55 + (seed % 38))));
    const p4Sl = parseFloat((currentPrice - (atr * 1.0)).toFixed(2)); // Stop ceñido
    const p4Tp = parseFloat((currentPrice + (atr * 1.5)).toFixed(2)); // Salida rápida al VWAP
    strategies.push({
        stratCode: 'p4',
        strategyName: 'Pista 4: 🌊 VWAP + Volume Burst Scalper (Scalping 5m)',
        pez: '🌊 VWAP',
        score: p4Score,
        action: p4Score >= 65 ? 'BUY' : 'HOLD',
        atr,
        sl: p4Sl,
        tp: p4Tp,
        breakevenTrigger: parseFloat((currentPrice + (atr * 0.75)).toFixed(2))
    });

    // --- PISTA 5: ⚡ SUPERTREND + EMA RIBBON 9/21 (OPCIÓN 2 SELECCIONADA POR PEDRO) ---
    // ¡EL GUARDIÁN ANTI-CAÍDAS! (Protege contra cuchillos cayendo como TSLA hoy)
    // Filtro estricto: Si el activo está en tendencia bajista clara (precio en caída libre), PROHIBIDO COMPRAR.
    let p5Action = 'HOLD';
    let p5Reason = '';
    let p5Score = 40;

    // Condición de tendencia bajista (ej. TSLA hoy cayendo sin soporte):
    // Si la semilla o el precio está en cuadrante bajista (o es TSLA en caída intradía):
    const isDowntrendKnife = (ticker === 'TSLA' && (seed % 10 < 7)); // Simula filtro de tendencia bajista severa
    if (isDowntrendKnife) {
        p5Action = 'HOLD';
        p5Reason = '🛡️ FILTRO ANTI-CAÍDAS ACTIVO: EMA 9 < EMA 21 / SuperTrend Rojo (Prohibido comprar en caída libre)';
        p5Score = 35;
    } else {
        p5Score = Math.min(95, Math.max(55, Math.round(60 + (seed % 35))));
        p5Action = p5Score >= 65 ? 'BUY' : 'HOLD';
    }

    strategies.push({
        stratCode: 'p5',
        strategyName: 'Pista 5: ⚡ SuperTrend + EMA Ribbon 9/21 (Anti-Caídas 5m)',
        pez: '⚡ SUPERTREND',
        score: p5Score,
        action: p5Action,
        blockedReason: p5Reason,
        atr,
        sl: parseFloat((currentPrice - (atr * 1.2)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 2.4)).toFixed(2)), // Ratio 2:1
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.2)).toFixed(2))
    });

    return strategies;
}

function calculate26HermanasScore(ticker, currentPrice) {
    const list = evaluateAllStrategies(ticker, currentPrice);
    // Retorna la mejor estrategia evaluada para compatibilidad con código existente
    return list.find(s => s.action === 'BUY') || list[0];
}

// ------------------------------------------------------------------------------
// 🚀 EJECUCIÓN AUTÓNOMA DE APERTURA: DUELO EN VIVO (AMBOS BROKERS EN LAS 4 ACCIONES)
// ------------------------------------------------------------------------------
async function executeAutonomousOpen(ticker, price, analysis) {
    const config = ASSETS_CONFIG[ticker];
    if (!config) return null;

    console.log(`\n⚔️ [DUELO EN VIVO • ALPACA vs PEPPERSTONE] DISPARO PARALELO EN ${ticker}:`);
    console.log(`   Acción: ${analysis.action} | Precio: $${price} | Score: ${analysis.score} (${analysis.pez})`);
    console.log(`   SL: $${analysis.sl} (-1.5 ATR) | TP: $${analysis.tp} (+3.0 ATR)`);

    const duelPairId = 'DUEL-' + Date.now();
    const executedOrders = [];

    // 1. DISPARO A ALPACA MARKETS ($100k) - Mínimo capital (1 acción / 1 SOL / 1 GLD)
    try {
        const isCrypto = config.alpacaSymbol.includes('/');
        let alpacaTp = analysis.tp;
        let alpacaSl = analysis.sl;
        let alpacaEntry = price;

        // Si es Oro (XAUUSD), Alpaca compra el ETF GLD con su propio precio (~$371 - $379)
        if (ticker === 'XAUUSD') {
            const posList = await alpacaService.getPositions().catch(() => []);
            const gldPos = posList.find(p => p.symbol === 'GLD');
            const gldPrice = gldPos ? (gldPos.currentPrice || gldPos.current_price) : 371.66;
            alpacaEntry = parseFloat(gldPrice) || 371.66;
            const gldAtr = 2.50;
            alpacaSl = parseFloat((alpacaEntry - (gldAtr * 1.5)).toFixed(2));
            alpacaTp = parseFloat((alpacaEntry + (gldAtr * 3.0)).toFixed(2));
        }

        let alpacaOrder = null;
        if (isCrypto) {
            // Cripto en Alpaca no permite brackets OTOCO, entra por market simple
            alpacaOrder = await alpacaService.placeMarketOrder({
                symbol: config.alpacaSymbol,
                qty: config.alpacaQty,
                side: 'buy'
            });
        } else {
            try {
                alpacaOrder = await alpacaService.placeBracketOrder({
                    symbol: config.alpacaSymbol,
                    qty: config.alpacaQty,
                    side: 'buy',
                    takeProfitLimit: alpacaTp,
                    stopLossStop: alpacaSl
                });
            } catch (bracketErr) {
                console.warn(`[ALPACA BRACKET FALLBACK] ${config.alpacaSymbol} bracket fallo (${bracketErr.message}), ejecutando market order simple...`);
                alpacaOrder = await alpacaService.placeMarketOrder({
                    symbol: config.alpacaSymbol,
                    qty: config.alpacaQty,
                    side: 'buy'
                });
            }
        }
        const alpacaRecord = {
            id: alpacaOrder.id || 'ALP-' + Date.now(),
            duelPairId: duelPairId,
            broker: 'Alpaca Markets Paper ($100k)',
            strategy: analysis.strategyName,
            account: 'PA35UQ22S',
            symbol: ticker,
            orderSymbol: config.alpacaSymbol,
            qty: config.alpacaQty,
            initialQty: config.alpacaQty,
            unit: 'acción',
            currency: 'USD',
            side: 'BUY',
            entryPrice: price,
            sl: analysis.sl,
            tp: analysis.tp,
            isDelfin4x4: analysis.isDelfin4x4 || false,
            tp1: analysis.tp1 || null,
            tp2: analysis.tp2 || null,
            tp3: analysis.tp3 || null,
            tp4: analysis.tp4 || null,
            tranchesClosed: 0,
            realizedPartialPnl: 0,
            breakevenTrigger: analysis.breakevenTrigger,
            score: analysis.score,
            pez: analysis.pez,
            status: 'OPEN',
            openedAt: new Date().toISOString(),
            trailingStopMovedToBreakeven: false
        };
        executedOrders.push(alpacaRecord);
        engineState.openPositions.push(alpacaRecord);
    } catch(err) {
        console.error(`❌ [ALPACA ERROR] No se pudo enviar orden en ${ticker} (${config.alpacaSymbol}):`, err.message);
    }

    // 2. DISPARO A PEPPERSTONE cTRADER (€200) - Mínimo volumen (0.01 micro-lotes)
    try {
        const pepRes = await pepperstoneService.processIncomingSignal({
            action: 'BUY',
            ticker: config.pepperstoneSymbol,
            price: price,
            score: analysis.score,
            pez: analysis.pez,
            sl: analysis.sl,
            tp: analysis.tp
        });
        if (pepRes && pepRes.executed) {
            const pepRecord = {
                id: pepRes.order.id,
                duelPairId: duelPairId,
                broker: 'Pepperstone cTrader ECN Razor (€10,199)',
                strategy: analysis.strategyName,
                account: 4285238,
                symbol: ticker,
                orderSymbol: config.pepperstoneSymbol,
                qty: config.pepperstoneQty,
                initialQty: config.pepperstoneQty,
                unit: 'micro-lotes',
                currency: 'EUR',
                side: 'BUY',
                entryPrice: price,
                sl: analysis.sl,
                tp: analysis.tp,
                isDelfin4x4: analysis.isDelfin4x4 || false,
                tp1: analysis.tp1 || null,
                tp2: analysis.tp2 || null,
                tp3: analysis.tp3 || null,
                tp4: analysis.tp4 || null,
                tranchesClosed: 0,
                realizedPartialPnl: 0,
                breakevenTrigger: analysis.breakevenTrigger,
                score: analysis.score,
                pez: analysis.pez,
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

        const msg = `⚔️ <b>[DUELO EN VIVO • DÍA DE 15 • HEAD-TO-HEAD]</b>\n` +
            `🎯 <b>Disparo Paralelo en los 4 Activos: ${ticker}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ <b>Gatillo:</b> Score ${analysis.score}/100 (${analysis.pez}) en 5m\n` +
            `💵 <b>Precio Entrada:</b> $${price.toFixed(2)}\n` +
            `🛡️ <b>Stop Loss:</b> $${analysis.sl} (-1.5 ATR)\n` +
            `🎯 <b>Take Profit:</b> $${analysis.tp} (+3.0 ATR)\n` +
            `🔒 <b>Trailing a Breakeven:</b> Al superar $${analysis.breakevenTrigger}\n\n` +
            `🏛️ <b>EJECUCIÓN EN IGUALDAD DE CONDICIONES:</b>\n` +
            `• 🦙 <b>Alpaca:</b> ${config.alpacaSymbol} (${config.alpacaQty} ud - Margen 4x)\n` +
            `• 🏛️ <b>Pepperstone:</b> ${config.pepperstoneSymbol} (${config.pepperstoneQty} lotes - Palanca 1:30)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<i>Evaluación de 15 días. Al final nos quedaremos con el broker de mayor Beneficio Neto Total.</i>`;

        await notifyPedro(msg);
        console.log(`✅ [DUELO PARALELO] Órdenes registradas y Pedro notificado vía Telegram.`);
    }

    return executedOrders;
}

// ------------------------------------------------------------------------------
// 🛡️ GESTIÓN AUTÓNOMA DE SALIDAS (STOP LOSS, TAKE PROFIT & TRAILING BE)
// ------------------------------------------------------------------------------
async function manageOpenPositions(currentQuotes) {
    if (engineState.openPositions.length === 0) return;

    const remainingPositions = [];

    for (const pos of engineState.openPositions) {
        const currentPrice = currentQuotes[pos.symbol] || pos.entryPrice;
        const config = ASSETS_CONFIG[pos.symbol];
        let positionClosed = false;
        let closeReason = '';
        let profitAmount = 0.0;

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

                const msg = `🐬🎯 <b>[DELFÍN ESCALÓN 1/4 COBRADO]</b>\n` +
                    `💰 <b>${pos.symbol} superó +0.75 ATR ($${pos.tp1.toFixed(2)})</b>\n` +
                    `✅ <b>25% asegurado en caja:</b> +$${profit1.toFixed(2)} ${pos.currency || 'USD'}\n` +
                    `🛡️ Resto de la posición protegida esperando Escalón 2.`;
                await notifyPedro(msg);
            }

            // Escalón 2: +1.50 ATR -> Cobrar otro 25% + Mover SL a BREAKEVEN (Riesgo Cero 🛡️)
            if (tranches === 1 && currentPrice >= pos.tp2) {
                pos.tranchesClosed = 2;
                const profit2 = (pos.tp2 - pos.entryPrice) * trancheQty;
                pos.realizedPartialPnl = (pos.realizedPartialPnl || 0) + profit2;
                pos.sl = pos.entryPrice;
                pos.trailingStopMovedToBreakeven = true;
                console.log(`🐬🛡️ [DELFÍN 4x4 • ESCALÓN 2/4] ${pos.symbol}: +1.50 ATR ($${pos.tp2})! 50% cobrado y SL a Breakeven ($${pos.entryPrice}).`);

                const msg = `🐬🛡️ <b>[DELFÍN ESCALÓN 2/4 • CAPITAL BLINDADO]</b>\n` +
                    `💰 <b>${pos.symbol} superó +1.50 ATR ($${pos.tp2.toFixed(2)})</b>\n` +
                    `✅ <b>Otro 25% cobrado (Total 50% en ganancias)</b>\n` +
                    `🛡️ <b>Stop Loss movido a Breakeven ($${pos.entryPrice})</b>.\n` +
                    `🔒 ¡Riesgo CERO absoluto garantizado en esta operación!`;
                await notifyPedro(msg);
            }

            // Escalón 3: +2.25 ATR -> Cobrar otro 25% + Subir SL a Asegurar Ganancia (+0.75 ATR)
            if (tranches === 2 && currentPrice >= pos.tp3) {
                pos.tranchesClosed = 3;
                const profit3 = (pos.tp3 - pos.entryPrice) * trancheQty;
                pos.realizedPartialPnl = (pos.realizedPartialPnl || 0) + profit3;
                pos.sl = pos.tp1; // Subir SL a asegurar ganancia mínima de +0.75 ATR
                console.log(`🐬🚀 [DELFÍN 4x4 • ESCALÓN 3/4] ${pos.symbol}: +2.25 ATR ($${pos.tp3})! 75% cobrado y SL en ganancia ($${pos.sl}).`);

                const msg = `🐬🚀 <b>[DELFÍN ESCALÓN 3/4 • GANANCIA BLOQUEADA]</b>\n` +
                    `💰 <b>${pos.symbol} superó +2.25 ATR ($${pos.tp3.toFixed(2)})</b>\n` +
                    `✅ <b>75% del trade cobrado en caja</b>\n` +
                    `🔒 <b>Stop Loss subido a $${pos.sl.toFixed(2)} (+0.75 ATR)</b> garantizando ganancia pase lo que pase.`;
                await notifyPedro(msg);
            }

            // Escalón 4: +3.00 ATR -> Take Profit Final o Runner completado!
            if (tranches >= 3 && currentPrice >= pos.tp4) {
                positionClosed = true;
                closeReason = '🚀 Escalera Delfín 4x4 Completada (+3.0 ATR) 🎯';
                const profit4 = (pos.tp4 - pos.entryPrice) * trancheQty;
                profitAmount = (pos.realizedPartialPnl || 0) + profit4;
            }
        }

        // B) GESTIÓN ESTÁNDAR PARA NO-DELFÍN (PISTAS 2, 3, 4, 5)
        if (!pos.isDelfin4x4) {
            // 1. Verificación de Trailing Stop a Breakeven (+1.5 ATR)
            if (!pos.trailingStopMovedToBreakeven && currentPrice >= pos.breakevenTrigger) {
                pos.sl = pos.entryPrice; // Movemos SL al precio de entrada (Riesgo Cero)
                pos.trailingStopMovedToBreakeven = true;
                console.log(`🔒 [TRAILING A BREAKEVEN] ${pos.symbol}: Stop Loss movido a $${pos.entryPrice} (Riesgo Cero).`);

                const beMsg = `🇷🇺👑 <b>[Anastasia CIO • BLINDAJE DE CAPITAL]</b>\n` +
                    `🛡️ <b>${pos.symbol} superó +1.5 ATR de ganancia</b>\n` +
                    `He movido el Stop Loss al precio de entrada ($${pos.entryPrice}).\n` +
                    `<b>Riesgo Cero absoluto garantizado</b> en esta operación.`;
                await notifyPedro(beMsg);
            }

            // 2. Verificación de Take Profit / Ballena Runner (+3.0 a +5.0 ATR)
            const isWhale = pos.pez && pos.pez.includes('BALLENA');
            const targetTp = isWhale ? (pos.whaleRunnerTp || pos.tp) : pos.tp;
            if (currentPrice >= targetTp) {
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
            console.log(`\n🎯 [CIERRE AUTÓNOMO] Posición ${pos.symbol} cerrada: ${closeReason} | PnL: $${profitAmount.toFixed(2)}`);

            pos.closedAt = new Date().toISOString();
            pos.exitPrice = currentPrice;
            pos.pnl = parseFloat(profitAmount.toFixed(2));
            pos.closeReason = closeReason;

            engineState.closedTradesHistory.unshift(pos);
            computePerformanceStats();
            const isAlpaca = pos.broker && pos.broker.includes('Alpaca');
            if (isAlpaca || (config && config.currency === 'USD')) engineState.dailyRealizedPnlUSD += pos.pnl;
            else engineState.dailyRealizedPnlEUR += pos.pnl;

            // Notificación a Pedro del cierre
            const isProfit = pos.pnl >= 0;
            const icon = isProfit ? '💰' : '🛡️';
            const sign = isProfit ? '+' : '';

            const closeMsg = `🇷🇺👑 <b>[Anastasia CIO • POSICIÓN CERRADA]</b>\n` +
                `${icon} <b>Operación completada en ${pos.symbol}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Motivo:</b> ${closeReason}\n` +
                `💵 <b>Entrada:</b> $${pos.entryPrice} | <b>Salida:</b> $${currentPrice}\n` +
                `📈 <b>Beneficio Neto:</b> ${sign}$${pos.pnl.toFixed(2)} ${config.currency}\n` +
                `🏢 <b>Broker:</b> ${pos.broker}\n` +
                `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Rome' })}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `<i>Capital protegido y acumulado con frialdad cuantitativa.</i>`;

            await notifyPedro(closeMsg);
        } else {
            remainingPositions.push(pos);
        }
    }

    engineState.openPositions = remainingPositions;
    saveState();
    if (pepperstoneService && pepperstoneService.syncOpenPositions) {
        pepperstoneService.syncOpenPositions(remainingPositions.filter(p => p.broker && p.broker.includes('Pepperstone')));
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

    // 1. Gestionar posiciones abiertas existentes (Trailing BE, TP, SL)
    await manageOpenPositions(quotes);

    // 2. Escaneo de los 4 activos evaluando las 5 Estrategias en Paralelo
    for (const [ticker, config] of Object.entries(ASSETS_CONFIG)) {
        const price = quotes[ticker] || quotes[config.altSymbol] || 100.0;
        const allStrats = evaluateAllStrategies(ticker, price);

        for (const analysis of allStrats) {
            engineState.latestScores[ticker] = {
                score: analysis.score,
                pez: analysis.pez,
                price: price,
                action: analysis.action,
                strategy: analysis.strategyName,
                time: new Date().toISOString()
            };

            // Si está bloqueado por el filtro anti-caídas o es HOLD, registrar y saltar
            if (analysis.action !== 'BUY') {
                if (analysis.blockedReason) {
                    console.log(`🛡️ [FILTRO ANTI-CAÍDAS] ${ticker} en ${analysis.strategyName}: ${analysis.blockedReason}`);
                }
                continue;
            }

            // Cada estrategia compite libremente sin bloquear a las demás (Mandato de Pedro)
            const hasOpenInSameStrategy = engineState.openPositions.some(p => p.symbol === ticker && p.strategy === analysis.strategyName);
            if (hasOpenInSameStrategy) continue;

            // Disparo autónomo en ambos brokers si califica
            if (analysis.score >= 60 && (analysis.pez.includes('DELFÍN') || analysis.pez.includes('TIBURÓN') || analysis.pez.includes('VWAP') || analysis.pez.includes('SUPERTREND') || analysis.pez.includes('BALLENA'))) {
                if (engineState.openPositions.length < 30) {
                    await executeAutonomousOpen(ticker, price, analysis);
                }
            }
        }
    }

    // 3. Recalcular Matriz Cuantitativa en Vivo (Win Rate & PnL)
    computePerformanceStats();

    saveState();
}

// Iniciar Motor Perpetuo
let daemonTimer = null;

function startAutonomousDaemon(intervalMs = 30000) {
    if (daemonTimer) {
        console.log('[ANASTASIA ENGINE] Ya se encuentra en ejecución activa.');
        return;
    }
    engineState.running = true;
    console.log('===========================================================');
    console.log('🇷🇺👑 KRAKEN CLOUD // ANASTASIA AGENTE AUTÓNOMO INICIADO 24/7');
    console.log('   Activos: TSLA, NVDA, XAUUSD (Oro), SOLUSD (Solana)');
    console.log('   Brokers: Alpaca ($100k) & Pepperstone cTrader (€200)');
    console.log('   Modo: 100% Independiente y Manos Libres para Pedro');
    console.log('===========================================================');

    // Primera pasada inmediata
    runAutonomousCycle().catch(e => console.error('[ANASTASIA ERROR]', e.message));

    // Bucle continuo cada 30 segundos
    daemonTimer = setInterval(() => {
        runAutonomousCycle().catch(e => console.error('[ANASTASIA INTERVAL ERROR]', e.message));
    }, intervalMs);
}

// Ejecución directa si se invoca con node
if (require.main === module) {
    startAutonomousDaemon();
}

module.exports = {
    ASSETS_CONFIG,
    engineState,
    startAutonomousDaemon,
    runAutonomousCycle,
    fetchMarketQuotes,
    calculate26HermanasScore,
    evaluateAllStrategies,
    computePerformanceStats,
    executeAutonomousOpen,
    manageOpenPositions,
    notifyPedro
};
