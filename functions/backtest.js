/**
 * KRAKEN QUANT ENGINE // BACKTEST SIMULATOR & PROMOTION AUDITOR
 * Castillo Imperial Holding S.A.
 * 
 * Descarga 30 días de velas de 5 minutos reales de Alpaca Data API
 * y simula barra a barra las 5 pistas en los 4 activos:
 * NVDA, TSLA, GLD (Oro) y SOL/USD.
 * 
 * Regla de Promoción de Pedro:
 * Solo combinaciones con Profit Factor > 1.2 y >= 20 trades quedan PROMOVIDAS.
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
    console.error('❌ ERROR: Falta ALPACA_API_KEY o ALPACA_SECRET_KEY en functions/.env');
    process.exit(1);
}

const HEADERS = {
    'APCA-API-KEY-ID': API_KEY,
    'APCA-API-SECRET-KEY': SECRET_KEY
};

const ASSETS = [
    { ticker: 'NVDA', type: 'stock', symbol: 'NVDA', name: 'NVIDIA Corp.', unitQty: 1 },
    { ticker: 'TSLA', type: 'stock', symbol: 'TSLA', name: 'Tesla Inc.', unitQty: 1 },
    { ticker: 'GLD',  type: 'stock', symbol: 'GLD',  name: 'SPDR Gold Trust (Oro)', unitQty: 1 },
    { ticker: 'SOLUSD', type: 'crypto', symbol: 'SOL/USD', name: 'Solana USD', unitQty: 1 }
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

async function downloadHistoricalBars(asset) {
    const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    let url = '';
    if (asset.type === 'stock') {
        url = `https://data.alpaca.markets/v2/stocks/${asset.symbol}/bars?timeframe=5Min&limit=10000&start=${start}&feed=sip`;
    } else {
        url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(asset.symbol)}&timeframe=5Min&limit=10000&start=${start}`;
    }

    console.log(`⏳ Descargando 30 días de velas 5m para ${asset.ticker} (${asset.symbol})...`);
    const resp = await fetchHttps(url);
    if (resp.status !== 200 || !resp.data) {
        console.error(`❌ Error descargando ${asset.ticker}:`, resp);
        return [];
    }

    let rawBars = [];
    if (asset.type === 'stock') {
        rawBars = resp.data.bars || [];
    } else {
        rawBars = (resp.data.bars && resp.data.bars[asset.symbol]) || [];
    }

    console.log(`✅ ${asset.ticker}: ${rawBars.length} velas de 5m obtenidas.`);
    return rawBars;
}

/**
 * Simulación cuantitativa barra a barra de una estrategia en una serie histórica
 */
function simulateStrategy(stratCode, asset, enrichedBars) {
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
            let pnl = 0;

            if (activeTrade.isDelfin4x4) {
                // Escalera 4x4 de Pedro: 4 tramos de salida
                // Si toca Breakeven trigger (TP2), mover SL a entrada
                if (high >= activeTrade.tp2 && !activeTrade.trailingBE) {
                    activeTrade.trailingBE = true;
                    activeTrade.sl = activeTrade.entryPrice;
                }

                // Chequear salidas por tramos
                if (high >= activeTrade.tp4) {
                    closed = true;
                    exitPrice = activeTrade.tp4;
                    exitReason = '🎯 TP4 Final (Escalera 4x4)';
                    pnl = (exitPrice - activeTrade.entryPrice) * activeTrade.qty;
                } else if (low <= activeTrade.sl) {
                    closed = true;
                    exitPrice = activeTrade.sl;
                    exitReason = activeTrade.trailingBE ? '🛡️ Salida en Breakeven' : '🛑 Stop Loss (-1.5 ATR)';
                    pnl = (exitPrice - activeTrade.entryPrice) * activeTrade.qty;
                }
            } else {
                // Estrategias Estándar (TP Fijo + Trailing BE)
                if (high >= activeTrade.breakevenTrigger && !activeTrade.trailingBE) {
                    activeTrade.trailingBE = true;
                    activeTrade.sl = activeTrade.entryPrice;
                }

                if (high >= activeTrade.tp) {
                    closed = true;
                    exitPrice = activeTrade.tp;
                    exitReason = '🎯 Take Profit Alcanzado';
                    pnl = (exitPrice - activeTrade.entryPrice) * activeTrade.qty;
                } else if (low <= activeTrade.sl) {
                    closed = true;
                    exitPrice = activeTrade.sl;
                    exitReason = activeTrade.trailingBE ? '🛡️ Salida en Breakeven' : '🛑 Stop Loss Alcanzado';
                    pnl = (exitPrice - activeTrade.entryPrice) * activeTrade.qty;
                }
            }

            // Expiración por tiempo si lleva más de 36 velas (3 horas) sin resolver
            if (!closed && (i - activeTrade.entryBarIndex) >= 36) {
                closed = true;
                exitPrice = curBar.c;
                pnl = (exitPrice - activeTrade.entryPrice) * activeTrade.qty;
                exitReason = '⏰ Cierre por Tiempo Máximo (3h)';
            }

            if (closed) {
                trades.push({
                    stratCode,
                    ticker: asset.ticker,
                    entryTime: activeTrade.entryTime,
                    exitTime: curBar.t,
                    entryPrice: activeTrade.entryPrice,
                    exitPrice: parseFloat(exitPrice.toFixed(2)),
                    pnl: parseFloat(pnl.toFixed(2)),
                    exitReason,
                    barsHeld: i - activeTrade.entryBarIndex,
                    indicatorsAtEntry: activeTrade.indicators
                });
                activeTrade = null;
                lastTradeExitBar = i;
            }
        }

        // 2. Si no hay posición activa, evaluar señal de entrada
        if (!activeTrade && (i - lastTradeExitBar) >= minBarsBetweenTrades) {
            const allStrats = evaluateStrategiesForBar(asset.ticker, enrichedBars, i);
            const stratEval = allStrats.find(s => s.stratCode === stratCode);

            if (stratEval && stratEval.action === 'BUY' && stratEval.score >= 65) {
                // Entrada en la apertura de la siguiente vela para evitar lookahead bias
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
                    sl = entryPrice - (stratEval.atr * (stratCode === 'p4' ? 1.0 : (stratCode === 'p5' ? 1.2 : 1.5)));
                    tp = entryPrice + (stratEval.atr * (stratCode === 'p4' ? 1.5 : (stratCode === 'p5' ? 2.4 : 3.0)));
                    breakevenTrigger = entryPrice + (stratEval.atr * (stratCode === 'p4' ? 0.75 : (stratCode === 'p5' ? 1.2 : 1.5)));
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
                    indicators: stratEval.indicators
                };
            }
        }
    }

    // Calcular métricas
    let wins = 0;
    let losses = 0;
    let bes = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let netPnl = 0;

    trades.forEach(t => {
        netPnl += t.pnl;
        if (t.pnl > 0.05) {
            wins++;
            grossProfit += t.pnl;
        } else if (t.pnl < -0.05) {
            losses++;
            grossLoss += Math.abs(t.pnl);
        } else {
            bes++;
        }
    });

    const total = trades.length;
    const winRate = (wins + losses) > 0 ? parseFloat(((wins / (wins + losses)) * 100).toFixed(1)) : 0.0;
    const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99.9 : 0.0);

    // Regla de Promoción de Pedro: Profit Factor > 1.2 y >= 20 trades
    const isPromoted = (profitFactor > 1.2 && total >= 20);

    return {
        stratCode,
        ticker: asset.ticker,
        totalTrades: total,
        wins,
        losses,
        breakevens: bes,
        winRate,
        grossProfit: parseFloat(grossProfit.toFixed(2)),
        grossLoss: parseFloat(grossLoss.toFixed(2)),
        netPnl: parseFloat(netPnl.toFixed(2)),
        profitFactor,
        isPromoted,
        sampleTrades: trades.slice(-3)
    };
}

async function runFullBacktest() {
    console.log('========================================================================================');
    console.log('🏛️ CASTILLO IMPERIAL HOLDING // AUDITORÍA DE BACKTEST CUANTITATIVO (30 DÍAS - 5M)');
    console.log('   Estrategias: P1 (Delfín 4x4), P2 (Base Inst), P3 (TimeMachine), P4 (VWAP), P5 (SuperTrend)');
    console.log('   Activos: NVDA, TSLA, GLD, SOL/USD');
    console.log('   Regla de Promoción: Profit Factor > 1.20 Y Trades >= 20');
    console.log('========================================================================================\n');

    const STRATS = [
        { code: 'p1', name: 'Pista 1: 🐬 Delfín Rápido (EMA 9/21 4x4)' },
        { code: 'p2', name: 'Pista 2: 🦈 Base Institucional (Ambos)' },
        { code: 'p3', name: 'Pista 3: ⏳ TimeMachine Probabilística' },
        { code: 'p4', name: 'Pista 4: 🌊 VWAP + Volume Burst Scalper' },
        { code: 'p5', name: 'Pista 5: ⚡ SuperTrend + EMA Ribbon (Anti-Caídas)' }
    ];

    const allResults = [];
    const promotionMatrix = {};

    for (const asset of ASSETS) {
        const rawBars = await downloadHistoricalBars(asset);
        if (rawBars.length < 50) {
            console.warn(`⚠️ Muy pocas velas para ${asset.ticker}, saltando.`);
            continue;
        }

        const enrichedBars = ti.enrichBarsWithIndicators(rawBars);

        for (const strat of STRATS) {
            const res = simulateStrategy(strat.code, asset, enrichedBars);
            res.strategyName = strat.name;
            allResults.push(res);

            const matrixKey = `${strat.code}_${asset.ticker}`;
            promotionMatrix[matrixKey] = {
                stratCode: strat.code,
                strategyName: strat.name,
                ticker: asset.ticker,
                totalTrades: res.totalTrades,
                winRate: res.winRate,
                profitFactor: res.profitFactor,
                netPnl: res.netPnl,
                isPromoted: res.isPromoted,
                mode: res.isPromoted ? 'OPERACIÓN REAL (PAPER)' : 'MODO SOMBRA (SOLO AUDITORÍA)'
            };
        }
    }

    // Imprimir Tabla Formateada
    console.log('\n========================================================================================================================');
    console.log(
        'ACTIVO'.padEnd(8) +
        ' | ' + 'ESTRATEGIA'.padEnd(42) +
        ' | ' + 'TRADES'.padStart(6) +
        ' | ' + 'WIN RATE'.padStart(9) +
        ' | ' + 'P. FACTOR'.padStart(10) +
        ' | ' + 'NET PNL ($)'.padStart(12) +
        ' | ' + 'ESTADO / PROMOCIÓN'.padEnd(26)
    );
    console.log('------------------------------------------------------------------------------------------------------------------------');

    allResults.forEach(r => {
        const pfStr = r.profitFactor >= 99 ? 'MAX' : r.profitFactor.toFixed(2);
        const pnlStr = (r.netPnl >= 0 ? '+' : '') + '$' + r.netPnl.toFixed(2);
        const promoStr = r.isPromoted ? '🟢 PROMOVIDA (PAPER)' : '⚪ MODO SOMBRA';
        console.log(
            r.ticker.padEnd(8) +
            ' | ' + r.strategyName.slice(0, 42).padEnd(42) +
            ' | ' + String(r.totalTrades).padStart(6) +
            ' | ' + (r.winRate.toFixed(1) + '%').padStart(9) +
            ' | ' + pfStr.padStart(10) +
            ' | ' + pnlStr.padStart(12) +
            ' | ' + promoStr.padEnd(26)
        );
    });
    console.log('========================================================================================================================\n');

    // Guardar matriz de promoción en disco
    const matrixPath = path.join(__dirname, 'promoted_strategies.json');
    fs.writeFileSync(matrixPath, JSON.stringify(promotionMatrix, null, 2), 'utf8');
    console.log(`💾 Matriz de Promoción guardada en: ${matrixPath}`);

    return { allResults, promotionMatrix };
}

if (require.main === module) {
    runFullBacktest().catch(err => console.error('❌ Error fatal en backtest:', err));
}

module.exports = {
    runFullBacktest,
    simulateStrategy
};
