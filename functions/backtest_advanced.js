/**
 * KRAKEN QUANT ENGINE // ADVANCED MULTI-TIMEFRAME & COST-ADJUSTED BACKTESTER
 * Castillo Imperial Holding S.A.
 * 
 * Contrato de Pedro Castillo - Tarea 6:
 * 1. Costes Reales: Spreads y comisiones descontadas de cada trade.
 *    - TSLA / NVDA: $0.02 entrada + $0.02 salida ($0.04 USD round-trip).
 *    - GLD: $0.01 entrada + $0.01 salida ($0.02 USD round-trip).
 *    - SOL/USD: 0.15% entrada + 0.15% salida (0.30% round-trip).
 * 2. Multi-Timeframe: Simulación en 5m, 15m y 1H.
 * 3. Filtro de Sesión Regular (RTH): 15:30 - 21:45 CET (14:30 - 20:45 UTC) para acciones.
 * 4. Validación Fuera de Muestra (OOS): Separación In-Sample (20 días) y Out-Of-Sample (últimos 10 días hábiles).
 * 5. Matriz de Capital Mínimo y Gestión de Riesgo (1% por trade).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ti = require('./technical_indicators');
const { evaluateStrategiesForBar } = require('./strategy_signals');

const API_KEY = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;

if (!API_KEY || !SECRET_KEY) {
    console.error('❌ Falta ALPACA_API_KEY o ALPACA_SECRET_KEY');
    process.exit(1);
}

const HEADERS = {
    'APCA-API-KEY-ID': API_KEY,
    'APCA-API-SECRET-KEY': SECRET_KEY
};

// Configuración de Activos y Costes Reales
const ASSETS_CONFIG = {
    NVDA: {
        ticker: 'NVDA',
        type: 'stock',
        symbol: 'NVDA',
        name: 'NVIDIA Corp.',
        costPerShareRoundTrip: 0.04, // $0.02 entrada + $0.02 salida
        costPctRoundTrip: 0,
        unitQty: 1,
        pepperstoneMinLot: 0.10, // CFD en cTrader
        pepperstoneMarginRate: 1 / 30,
        priceFallback: 177.28
    },
    TSLA: {
        ticker: 'TSLA',
        type: 'stock',
        symbol: 'TSLA',
        name: 'Tesla Inc.',
        costPerShareRoundTrip: 0.04, // $0.02 entrada + $0.02 salida
        costPctRoundTrip: 0,
        unitQty: 1,
        pepperstoneMinLot: 0.10,
        pepperstoneMarginRate: 1 / 30,
        priceFallback: 372.91
    },
    GLD: {
        ticker: 'GLD',
        type: 'stock',
        symbol: 'GLD',
        name: 'SPDR Gold Trust (Proxy Oro)',
        costPerShareRoundTrip: 0.02, // $0.01 entrada + $0.01 salida
        costPctRoundTrip: 0,
        unitQty: 1,
        pepperstoneMinLot: 0.01, // 0.01 lote XAUUSD en cTrader
        pepperstoneMarginRate: 1 / 20, // Oro apalancamiento 1:20 ESMA
        priceFallback: 373.64
    },
    SOLUSD: {
        ticker: 'SOLUSD',
        type: 'crypto',
        symbol: 'SOL/USD',
        name: 'Solana USD',
        costPerShareRoundTrip: 0,
        costPctRoundTrip: 0.0030, // 0.15% entrada + 0.15% salida = 0.30%
        unitQty: 1,
        pepperstoneMinLot: 0.01,
        pepperstoneMarginRate: 1 / 2, // Cripto ESMA 1:2
        priceFallback: 85.84
    }
};

const TIMEFRAMES = [
    { code: '5Min', name: '5m' },
    { code: '15Min', name: '15m' },
    { code: '1Hour', name: '1H' }
];

const STRATEGIES = [
    { code: 'p1', name: 'P1: 🐬 Delfín Rápido (EMA 9/21 4x4)' },
    { code: 'p2', name: 'P2: 🦈 Base Institucional (Ambos)' },
    { code: 'p3', name: 'P3: ⏳ TimeMachine Probabilística' },
    { code: 'p4', name: 'P4: 🌊 VWAP + Volume Burst Scalper' },
    { code: 'p5', name: 'P5: ⚡ SuperTrend + EMA Ribbon (Anti-Caídas)' }
];

function fetchHttps(url) {
    return new Promise((resolve) => {
        https.get(url, { headers: HEADERS }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch(e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        }).on('error', err => resolve({ status: 500, error: err.message }));
    });
}

async function downloadBars(asset, timeframe) {
    const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    let allBars = [];
    let pageToken = '';
    let maxPages = 5;

    while (maxPages > 0) {
        maxPages--;
        let url = '';
        if (asset.type === 'stock') {
            url = `https://data.alpaca.markets/v2/stocks/${asset.symbol}/bars?timeframe=${timeframe}&limit=10000&start=${start}&feed=sip`;
            if (pageToken) url += `&page_token=${pageToken}`;
        } else {
            url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(asset.symbol)}&timeframe=${timeframe}&limit=10000&start=${start}`;
            if (pageToken) url += `&page_token=${pageToken}`;
        }

        const resp = await fetchHttps(url);
        if (resp.status !== 200 || !resp.data) break;

        let pageBars = [];
        if (asset.type === 'stock') {
            pageBars = resp.data.bars || [];
        } else {
            pageBars = (resp.data.bars && resp.data.bars[asset.symbol]) || [];
        }

        allBars = allBars.concat(pageBars);
        pageToken = resp.data.next_page_token;
        if (!pageToken) break;
    }

    return allBars;
}

/**
 * Filtro de Sesión Regular (RTH): 14:30 a 20:45 UTC (15:30 a 21:45 CET) para acciones
 */
function isRegularMarketHours(barTimeIso, assetType) {
    if (assetType === 'crypto') return true; // Cripto opera 24/7
    const d = new Date(barTimeIso);
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const timeNum = hour * 60 + minute;
    // 14:30 UTC = 870 min, 20:45 UTC = 1245 min
    return timeNum >= 870 && timeNum <= 1245;
}

/**
 * Simulación cuantitativa barra a barra con costes reales
 */
function simulateStrategy(stratCode, asset, enrichedBars, tfName, splitOosDate = null) {
    const trades = [];
    let activeTrade = null;
    const minBarsBetweenTrades = 2;
    let lastTradeExitBar = -10;

    for (let i = 25; i < enrichedBars.length - 1; i++) {
        const curBar = enrichedBars[i];
        const nextBar = enrichedBars[i + 1];

        // 1. Gestión de posición abierta existente
        if (activeTrade) {
            const high = curBar.h;
            const low = curBar.l;
            let closed = false;
            let exitPrice = 0;
            let exitReason = '';

            if (activeTrade.isDelfin4x4) {
                if (high >= activeTrade.tp2 && !activeTrade.trailingBE) {
                    activeTrade.trailingBE = true;
                    activeTrade.sl = activeTrade.entryPrice;
                }

                if (high >= activeTrade.tp4) {
                    closed = true;
                    exitPrice = activeTrade.tp4;
                    exitReason = '🎯 TP4 Final (Escalera 4x4)';
                } else if (low <= activeTrade.sl) {
                    closed = true;
                    exitPrice = activeTrade.sl;
                    exitReason = activeTrade.trailingBE ? '🛡️ Salida en Breakeven' : '🛑 Stop Loss (-1.5 ATR)';
                }
            } else {
                if (high >= activeTrade.breakevenTrigger && !activeTrade.trailingBE) {
                    activeTrade.trailingBE = true;
                    activeTrade.sl = activeTrade.entryPrice;
                }

                if (high >= activeTrade.tp) {
                    closed = true;
                    exitPrice = activeTrade.tp;
                    exitReason = '🎯 Take Profit';
                } else if (low <= activeTrade.sl) {
                    closed = true;
                    exitPrice = activeTrade.sl;
                    exitReason = activeTrade.trailingBE ? '🛡️ Salida en Breakeven' : '🛑 Stop Loss';
                }
            }

            // Expiración por tiempo: máx 36 velas en 5m, 16 en 15m, 8 en 1H
            const maxBars = tfName === '5m' ? 36 : (tfName === '15m' ? 16 : 8);
            if (!closed && (i - activeTrade.entryBarIndex) >= maxBars) {
                closed = true;
                exitPrice = curBar.c;
                exitReason = '⏰ Cierre por Tiempo Máximo';
            }

            if (closed) {
                const grossPnl = (exitPrice - activeTrade.entryPrice) * activeTrade.qty;
                
                // DESCUENTO DE COSTES REALES (SPREAD + COMISIÓN ROUND-TRIP)
                let tradeCost = 0;
                if (asset.costPerShareRoundTrip > 0) {
                    tradeCost = asset.costPerShareRoundTrip * activeTrade.qty;
                } else if (asset.costPctRoundTrip > 0) {
                    tradeCost = (activeTrade.entryPrice * asset.costPctRoundTrip) * activeTrade.qty;
                }

                const netPnl = grossPnl - tradeCost;
                const isOos = splitOosDate ? new Date(activeTrade.entryTime) >= splitOosDate : false;

                trades.push({
                    stratCode,
                    ticker: asset.ticker,
                    entryTime: activeTrade.entryTime,
                    exitTime: curBar.t,
                    entryPrice: activeTrade.entryPrice,
                    exitPrice: parseFloat(exitPrice.toFixed(2)),
                    grossPnl: parseFloat(grossPnl.toFixed(2)),
                    tradeCost: parseFloat(tradeCost.toFixed(4)),
                    netPnl: parseFloat(netPnl.toFixed(2)),
                    isOos,
                    exitReason,
                    barsHeld: i - activeTrade.entryBarIndex,
                    atrAtEntry: activeTrade.atr,
                    indicators: activeTrade.indicators
                });
                activeTrade = null;
                lastTradeExitBar = i;
            }
        }

        // 2. Si no hay posición activa, evaluar señal de entrada
        if (!activeTrade && (i - lastTradeExitBar) >= minBarsBetweenTrades) {
            // Filtro de Sesión Regular para acciones
            if (!isRegularMarketHours(curBar.t, asset.type)) {
                continue;
            }

            const allStrats = evaluateStrategiesForBar(asset.ticker, enrichedBars, i);
            const stratEval = allStrats.find(s => s.stratCode === stratCode);

            if (stratEval && stratEval.action === 'BUY' && stratEval.score >= 65) {
                const entryPrice = nextBar.o;
                const atr = stratEval.atr;

                let sl = stratEval.sl;
                let tp = stratEval.tp;
                let tp1 = stratEval.tp1;
                let tp2 = stratEval.tp2;
                let tp3 = stratEval.tp3;
                let tp4 = stratEval.tp4;
                let breakevenTrigger = stratEval.breakevenTrigger;

                if (stratEval.isDelfin4x4) {
                    tp1 = entryPrice + (atr * 0.75);
                    tp2 = entryPrice + (atr * 1.50);
                    tp3 = entryPrice + (atr * 2.25);
                    tp4 = entryPrice + (atr * 3.00);
                    tp = tp4;
                    sl = entryPrice - (atr * 1.50);
                    breakevenTrigger = tp2;
                } else {
                    const slMult = (stratCode === 'p4' ? 1.0 : (stratCode === 'p5' ? 1.2 : 1.5));
                    const tpMult = (stratCode === 'p4' ? 1.5 : (stratCode === 'p5' ? 2.4 : 3.0));
                    const beMult = (stratCode === 'p4' ? 0.75 : (stratCode === 'p5' ? 1.2 : 1.5));
                    sl = entryPrice - (atr * slMult);
                    tp = entryPrice + (atr * tpMult);
                    breakevenTrigger = entryPrice + (atr * beMult);
                }

                activeTrade = {
                    ticker: asset.ticker,
                    stratCode,
                    entryPrice,
                    entryTime: nextBar.t,
                    entryBarIndex: i + 1,
                    sl,
                    tp,
                    tp1, tp2, tp3, tp4,
                    breakevenTrigger,
                    isDelfin4x4: !!stratEval.isDelfin4x4,
                    trailingBE: false,
                    qty: asset.unitQty,
                    atr,
                    indicators: stratEval.indicators
                };
            }
        }
    }

    return trades;
}

function computeMetrics(trades) {
    let wins = 0;
    let losses = 0;
    let bes = 0;
    let grossWinPnl = 0;
    let grossLossPnl = 0;
    let totalNetPnl = 0;
    let totalCosts = 0;

    trades.forEach(t => {
        totalNetPnl += t.netPnl;
        totalCosts += t.tradeCost;
        if (t.netPnl > 0.01) {
            wins++;
            grossWinPnl += t.netPnl;
        } else if (t.netPnl < -0.01) {
            losses++;
            grossLossPnl += Math.abs(t.netPnl);
        } else {
            bes++;
        }
    });

    const total = trades.length;
    const winRate = (wins + losses) > 0 ? parseFloat(((wins / (wins + losses)) * 100).toFixed(1)) : 0.0;
    const netProfitFactor = grossLossPnl > 0 ? parseFloat((grossWinPnl / grossLossPnl).toFixed(2)) : (grossWinPnl > 0 ? 99.9 : 0.0);
    const avgTradeNet = total > 0 ? parseFloat((totalNetPnl / total).toFixed(2)) : 0.0;

    return {
        totalTrades: total,
        wins,
        losses,
        breakevens: bes,
        winRate,
        grossWinPnl: parseFloat(grossWinPnl.toFixed(2)),
        grossLossPnl: parseFloat(grossLossPnl.toFixed(2)),
        totalCosts: parseFloat(totalCosts.toFixed(2)),
        netPnl: parseFloat(totalNetPnl.toFixed(2)),
        netProfitFactor,
        avgTradeNet
    };
}

async function runComprehensiveBacktest() {
    console.log('====================================================================================================');
    console.log('🏛️ CASTILLO IMPERIAL HOLDING // BACKTEST MULTI-TIMEFRAME CON COSTES REALES Y AUDITORÍA OOS');
    console.log('   Activos: NVDA, TSLA, GLD, SOL/USD | Temporalidades: 5m, 15m, 1H');
    console.log('   Costes: TSLA/NVDA: $0.04 RT | GLD: $0.02 RT | SOL: 0.30% RT');
    console.log('   Filtro RTH: 15:30 - 21:45 CET (Acciones) | Out-Of-Sample: Últimos 10 días hábiles');
    console.log('====================================================================================================\n');

    // Fecha de corte Out-Of-Sample (últimos 14 días naturales = ~10 días de mercado)
    const splitOosDate = new Date(Date.now() - 14 * 24 * 3600 * 1000);

    const comparativeMatrix = [];
    const qualifiedCombinations = [];

    for (const [ticker, asset] of Object.entries(ASSETS_CONFIG)) {
        for (const tf of TIMEFRAMES) {
            const rawBars = await downloadBars(asset, tf.code);
            if (rawBars.length < 30) continue;

            const enrichedBars = ti.enrichBarsWithIndicators(rawBars);

            for (const strat of STRATEGIES) {
                const trades = simulateStrategy(strat.code, asset, enrichedBars, tf.name, splitOosDate);
                const allMetrics = computeMetrics(trades);
                
                // Métricas In-Sample (IS) vs Out-Of-Sample (OOS)
                const isTrades = trades.filter(t => !t.isOos);
                const oosTrades = trades.filter(t => t.isOos);
                const isMetrics = computeMetrics(isTrades);
                const oosMetrics = computeMetrics(oosTrades);

                const record = {
                    ticker,
                    timeframe: tf.name,
                    stratCode: strat.code,
                    strategyName: strat.name,
                    asset,
                    totalTrades: allMetrics.totalTrades,
                    winRate: allMetrics.winRate,
                    netProfitFactor: allMetrics.netProfitFactor,
                    netPnl: allMetrics.netPnl,
                    totalCosts: allMetrics.totalCosts,
                    avgTradeNet: allMetrics.avgTradeNet,
                    // OOS Metrics
                    oosTradesCount: oosMetrics.totalTrades,
                    oosProfitFactor: oosMetrics.netProfitFactor,
                    oosNetPnl: oosMetrics.netPnl,
                    // IS Metrics
                    isProfitFactor: isMetrics.netProfitFactor,
                    isNetPnl: isMetrics.netPnl,
                    trades
                };

                comparativeMatrix.push(record);

                // Criterio de Calificación de Pedro: PF Neto > 1.20 y al menos 15 trades en la serie completa
                if (allMetrics.netProfitFactor > 1.20 && allMetrics.totalTrades >= 15) {
                    qualifiedCombinations.push(record);
                }
            }
        }
    }

    return { comparativeMatrix, qualifiedCombinations, splitOosDate };
}

module.exports = {
    runComprehensiveBacktest,
    ASSETS_CONFIG,
    TIMEFRAMES,
    STRATEGIES
};

if (require.main === module) {
    runComprehensiveBacktest().then(({ comparativeMatrix, qualifiedCombinations }) => {
        console.log(`Auditoría finalizada. Total combinaciones analizadas: ${comparativeMatrix.length}`);
    });
}
