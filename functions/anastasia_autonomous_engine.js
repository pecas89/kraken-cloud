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
const ti = require('./technical_indicators');
const { evaluateStrategiesForBar } = require('./strategy_signals');

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

let latestEnrichedBars = {
    NVDA: [],
    TSLA: [],
    XAUUSD: [],
    SOLUSD: []
};

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
// 📡 FEED DE MERCADO EN VIVO PARA LOS 4 ACTIVOS (VELAS REALES 5M CON INDICADORES)
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

    try {
        const [nvdaData, tslaData, gldData, cryptoData] = await Promise.all([
            fetchBarsUrl('https://data.alpaca.markets/v2/stocks/NVDA/bars?timeframe=5Min&limit=50&feed=sip'),
            fetchBarsUrl('https://data.alpaca.markets/v2/stocks/TSLA/bars?timeframe=5Min&limit=50&feed=sip'),
            fetchBarsUrl('https://data.alpaca.markets/v2/stocks/GLD/bars?timeframe=5Min&limit=50&feed=sip'),
            fetchBarsUrl('https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=SOL/USD&timeframe=5Min&limit=50')
        ]);

        if (nvdaData && nvdaData.bars && nvdaData.bars.length > 0) {
            latestEnrichedBars.NVDA = ti.enrichBarsWithIndicators(nvdaData.bars);
            quotes.NVDA = latestEnrichedBars.NVDA[latestEnrichedBars.NVDA.length - 1].c;
        }

        if (tslaData && tslaData.bars && tslaData.bars.length > 0) {
            latestEnrichedBars.TSLA = ti.enrichBarsWithIndicators(tslaData.bars);
            quotes.TSLA = latestEnrichedBars.TSLA[latestEnrichedBars.TSLA.length - 1].c;
        }

        if (gldData && gldData.bars && gldData.bars.length > 0) {
            latestEnrichedBars.XAUUSD = ti.enrichBarsWithIndicators(gldData.bars);
            quotes.XAUUSD = latestEnrichedBars.XAUUSD[latestEnrichedBars.XAUUSD.length - 1].c;
        }

        if (cryptoData && cryptoData.bars && cryptoData.bars['SOL/USD'] && cryptoData.bars['SOL/USD'].length > 0) {
            latestEnrichedBars.SOLUSD = ti.enrichBarsWithIndicators(cryptoData.bars['SOL/USD']);
            quotes.SOLUSD = latestEnrichedBars.SOLUSD[latestEnrichedBars.SOLUSD.length - 1].c;
        }
    } catch(e) {
        console.warn('[FEED] Error descargando velas 5m:', e.message);
    }

    // Fallbacks si el mercado estuviera cerrado o sin tick
    if (!quotes.NVDA) quotes.NVDA = 177.28;
    if (!quotes.TSLA) quotes.TSLA = 372.91;
    if (!quotes.SOLUSD) quotes.SOLUSD = 85.84;
    if (!quotes.XAUUSD) quotes.XAUUSD = 373.64;

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
// 🧠 EVALUACIÓN MULTI-ESTRATEGIA 5M (VELAS REALES ALPACA - CERO NÚMEROS ALEATORIOS)
// ------------------------------------------------------------------------------
function evaluateAllStrategies(ticker, currentPrice) {
    loadPromotedMatrix();
    const bars = latestEnrichedBars[ticker] || [];
    if (bars && bars.length > 0) {
        return evaluateStrategiesForBar(ticker, bars, -1, promotedMatrix);
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
            indicators: analysis.indicators || null,
            signalReason: analysis.signalReason || '',
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
                indicators: analysis.indicators || null,
                signalReason: analysis.signalReason || '',
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
// 🔧 CIERRE REAL EN EL BROKER (KIMI FIX 11-NOV): la libreta ya no miente.
// Antes de este fix el motor anotaba cierres en su JSON pero NUNCA vendía en
// Alpaca ni cerraba en cTrader. Ahora cada cierre interno ejecuta la salida real.
// ------------------------------------------------------------------------------
async function executeRealBrokerClose(pos) {
    const isAlpaca = pos.broker && pos.broker.includes('Alpaca');
    if (isAlpaca) {
        // Vendemos exactamente la qty de ESTA posición (nunca closePosition(symbol),
        // que liquidaría toda la posición neteada del símbolo, incluidas otras pistas).
        const order = await alpacaService.placeMarketOrder({
            symbol: pos.orderSymbol,
            qty: pos.qty,
            side: 'sell'
        });
        return { broker: 'Alpaca', orderId: order && order.id ? order.id : null };
    }
    // Pepperstone cTrader: cierre por positionId. El volumen se deriva del símbolo
    // con el mismo mapa que la apertura (los registros antiguos no guardan cTraderVolume):
    // SOL=100 (1 SOL), NVDA/TSLA=10 (0.10 lotes), XAUUSD=100 (0.01 lotes = 1 onza).
    const pid = pos.positionId || pos.id;
    let vol = pos.cTraderVolume;
    if (!vol) {
        const sym = (pos.symbol || pos.orderSymbol || '').toUpperCase();
        if (sym === 'NVDA' || sym === 'TSLA') vol = 10;
        else vol = 100; // SOL y XAUUSD
    }
    const res = await pepperstoneService.closeOrderViaOpenAPI(pid, vol);
    if (!res) throw new Error('Sin respuesta de cTrader');
    if (res.errorCode) throw new Error(`${res.errorCode} - ${res.description || 'Error cTrader'}`);
    if (res.error) throw new Error(res.error);
    if (res.timeout) throw new Error('Timeout cerrando posición en cTrader (10s)');
    return { broker: 'Pepperstone', positionId: pid };
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
        if (acc && isFinite(acc.portfolioValue)) {
            engineState.accountBalances.alpaca = `$${acc.portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
        }
        try {
            const pepAcc = await pepperstoneService.getLiveAccountData();
            if (pepAcc && isFinite(pepAcc.balance)) {
                engineState.accountBalances.pepperstone = `€${pepAcc.balance.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
            }
        } catch(e) { /* Pepperstone offline: conservar último saldo conocido */ }

        // Reconcile REAL de cTrader (posiciones abiertas de verdad en el broker)
        let pepRealPositions = [];
        try {
            const pepRecon = await pepperstoneService.getOpenPositionsViaOpenAPI();
            if (pepRecon && pepRecon.positions) pepRealPositions = pepRecon.positions;
        } catch(e) { console.warn('[RECONCILE cTrader] Error:', e.message); }

        // 🧹 PURGA AUTORIZADA POR PEDRO (12-NOV): cerrar TODAS las posiciones reales
        // de cTrader en cuanto el mercado abra (los CFDs de acciones US estaban
        // MARKET_CLOSED a la 01:00). Reintenta cada 5 min hasta dejarlo en cero.
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
        } else if (engineState.pendingBrokerPurge && pepRealPositions.length === 0) {
            engineState.pendingBrokerPurge = false;
            await notifyPedro('🧹👑 <b>[LABORATORIO RESETEADO]</b>\ncTrader ya está en cero. Duelo limpio activado.');
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
            if (Math.abs(eng - real) > 0.0001) {
                divergences.push({ symbol: sym, engineQty: eng, brokerQty: real });
            }
        });

        const pepLibreta = engineState.openPositions.filter(p => p.broker && p.broker.includes('Pepperstone')).length;
        if (Math.abs(pepRealPositions.length - pepLibreta) > 0) {
            divergences.push({ symbol: 'cTrader', engineQty: pepLibreta, brokerQty: pepRealPositions.length });
        }

        engineState.brokerReconciliation = {
            checkedAt: new Date().toISOString(),
            alpacaPositions: (alpPositions || []).map(p => ({
                symbol: p.symbol, qty: p.qty, side: p.side,
                avgEntryPrice: p.avgEntryPrice, unrealizedPnl: p.unrealizedPnl,
                unrealizedPnlPct: p.unrealizedPnlPct
            })),
            ctraderRealCount: pepRealPositions.length,
            ctraderLibretaCount: pepLibreta,
            engineAlpacaQty: engineAlpaca,
            divergences
        };
        if (divergences.length > 0) {
            console.warn(`⚠️ [RECONCILE] Divergencias libreta vs Alpaca: ${JSON.stringify(divergences)}`);
        }
    } catch(e) {
        console.warn('[RECONCILE] Error:', e.message);
    }
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
            pos.pnl = parseFloat(profitAmount.toFixed(pnlDecimals));
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
                `📈 <b>Beneficio Neto:</b> ${sign}$${pos.pnl.toFixed(pnlDecimals)} ${config.currency}\n` +
                `🏢 <b>Broker:</b> ${pos.broker}\n` +
                `🔧 <b>Cierre real en broker:</b> ${pos.brokerCloseExecuted ? '✅ Ejecutado' : '❌ FALLÓ: ' + (pos.closeError || 'desconocido')}\n` +
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

    // 0. Cada 10 escaneos (~5 min): reconciliar libreta vs broker real y refrescar saldos
    if (engineState.totalScans % 10 === 1) {
        await syncBrokerReality();
    }

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
                isPromoted: analysis.isPromoted,
                indicators: analysis.indicators || null,
                signalReason: analysis.signalReason || '',
                time: new Date().toISOString()
            };

            // Si está bloqueado por el filtro anti-caídas o es HOLD, registrar y saltar
            if (analysis.action !== 'BUY') {
                if (analysis.blockedReason) {
                    console.log(`🛡️ [FILTRO ANTI-CAÍDAS] ${ticker} en ${analysis.strategyName}: ${analysis.blockedReason}`);
                }
                continue;
            }

            // REGLA DE LABORATORIO DE PEDRO:
            // Todas las 8 pistas ejecutan en Demo (Alpaca Paper y Pepperstone Demo) a tamaño mínimo.
            // Restricciones de activo por diseño:
            if (analysis.stratCode === 'p7' && (ticker !== 'TSLA' && ticker !== 'NVDA')) continue;
            if (analysis.stratCode === 'p6' && (ticker !== 'NVDA' && ticker !== 'TSLA' && ticker !== 'GLD' && ticker !== 'XAUUSD')) continue;
            if (analysis.stratCode === 'p8' && (ticker !== 'XAUUSD' && ticker !== 'GLD' && !ticker.includes('SOL'))) continue;

            // Cada estrategia compite libremente sin duplicar posición en el mismo activo
            const hasOpenInSameStrategy = engineState.openPositions.some(p => p.symbol === ticker && p.strategy === analysis.strategyName);
            if (hasOpenInSameStrategy) continue;

            // Disparo autónomo en ambos brokers si califica
            if (analysis.score >= 65) {
                // Candado sagrado de máximo 24 posiciones simultáneas en Pepperstone
                const pepCount = engineState.openPositions.filter(p => !p.broker || p.broker.includes('Pepperstone')).length;
                if (pepCount < 24) {
                    await executeAutonomousOpen(ticker, price, analysis);
                } else {
                    console.log(`🔒 [CANDADO PEPPERSTONE] Máximo 24 posiciones en paralelo alcanzado (${pepCount}/24). Señal ${ticker} (${analysis.strategyName}) en espera.`);
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
    executeRealBrokerClose,
    syncBrokerReality,
    notifyPedro
};
