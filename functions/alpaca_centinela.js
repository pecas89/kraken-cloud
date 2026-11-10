/**
 * KRAKEN CLOUD // ALPACA MARKETS AUTONOMOUS CENTINELA 24/7
 * Broker: Alpaca Markets (Paper Trading)
 * Account: PA35UQ22S ($100,000.00 USD)
 */

const { getAccount, getPositions, placeBracketOrder, placeMarketOrder, closePosition } = require('./alpaca_service');

const CENTINELA_CONFIG = {
    accountNumber: 'PA35UQ22S',
    maxConcurrentPositions: 4,
    defaultShares: {
        NVDA: 1, // Mínimo absoluto (1 acción)
        TSLA: 1, // Mínimo absoluto (1 acción)
        AAPL: 1,
        SPY: 1,
        QQQ: 1,
        default: 1
    },
    riskPerTradeMaxPct: 0.015 // Max 1.5% portfolio risk
};

const centinelaState = {
    connected: false,
    portfolioValue: 100000.00,
    openPositions: [],
    tradeHistory: []
};

async function processSignal(signal) {
    console.log(`[ALPACA CENTINELA 5M] Señal entrante: ${signal.action} ${signal.ticker} (Score: ${signal.score}, Pez: ${signal.pez})`);

    // Guardrail 1: Score ≥ 60 check
    if (signal.score < 60) {
        console.warn(`⏳ [ALPACA FILTRO SCORE] Rechazada: Score ${signal.score} < 60`);
        return { executed: false, reason: 'Score insuficiente (<60)' };
    }

    // Guardrail 2: Species check
    const allowed = ['DELFÍN', 'TIBURÓN', 'BALLENA', 'KRAKEN'];
    const validFish = allowed.some(p => (signal.pez || '').toUpperCase().includes(p));
    if (!validFish) {
        console.warn(`🐡 [ALPACA FILTRO PEZ] Rechazada: ${signal.pez} es zona de bajo volumen.`);
        return { executed: false, reason: 'Especie marina no institucional' };
    }

    // Guardrail 3: Max concurrent positions
    const currentPositions = await getPositions();
    if (currentPositions.length >= CENTINELA_CONFIG.maxConcurrentPositions) {
        console.warn(`⚠️ [ALPACA FILTRO MARGEN] Límite de ${CENTINELA_CONFIG.maxConcurrentPositions} posiciones alcanzado.`);
        return { executed: false, reason: 'Máximo de posiciones simultáneas alcanzado' };
    }

    // Determine shares
    const sym = signal.ticker.toUpperCase().replace('/', '');
    const shares = CENTINELA_CONFIG.defaultShares[sym] || CENTINELA_CONFIG.defaultShares.default;
    const side = signal.action.toLowerCase() === 'sell' ? 'sell' : 'buy';

    console.log(`🚀 [DISPARO BRACKET AUTORIZADO] Enviando orden ${side.toUpperCase()} ${shares} ${sym} a Alpaca Paper...`);
    
    try {
        const order = await placeBracketOrder({
            symbol: sym,
            qty: shares,
            side: side,
            takeProfitLimit: signal.tp,
            stopLossStop: signal.sl
        });

        const record = {
            id: order.id,
            symbol: sym,
            qty: shares,
            side: side,
            orderClass: order.order_class,
            status: order.status,
            time: order.created_at,
            score: signal.score,
            pez: signal.pez,
            tp: signal.tp,
            sl: signal.sl
        };

        centinelaState.tradeHistory.unshift(record);
        console.log('✅ [ORDEN ALPACA CONFIRMADA]:', record.id, record.status);
        return { executed: true, order: record };
    } catch(err) {
        console.error('❌ Error enviando orden a Alpaca:', err.message);
        return { executed: false, error: err.message };
    }
}

// Verification Self-Test
if (require.main === module) {
    (async () => {
        console.log('===========================================================');
        console.log('  KRAKEN CLOUD // ALPACA CENTINELA ÁGIL 15M INICIADO      ');
        console.log('===========================================================');
        const acc = await getAccount();
        console.log(`Estado: ${acc.status} | Cuenta: ${acc.accountNumber} | Cartera: $${acc.portfolioValue.toLocaleString()} | Poder Compra: $${acc.buyingPower.toLocaleString()}`);

        console.log('\n--- PRUEBA DE DISPARO SIMULADO ALPACA (SCORE ≥ 60 + DELFÍN) ---');
        const testSignal = {
            action: 'BUY',
            ticker: 'NVDA',
            price: 186.60,
            score: 65,
            pez: '🐬 DELFÍN',
            sl: 182.50,
            tp: 194.80
        };
        const res = await processSignal(testSignal);
        console.log('Resultado del Centinela:', res.executed ? 'ORDEN EJECUTADA' : 'RECHAZADA / FALLIDA (' + (res.reason || res.error) + ')');
    })();
}

module.exports = {
    CENTINELA_CONFIG,
    centinelaState,
    processSignal
};
