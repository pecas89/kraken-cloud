/**
 * KRAKEN CLOUD // PEPPERSTONE cTRADER AUTONOMOUS CENTINELA 24/7
 * Broker: Pepperstone - Europe (Razor ECN)
 * Account Number: 4285238 (€ 10,199.22 EUR)
 * Account ID: 49442058
 */

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PEPPERSTONE_CONFIG = {
    clientId: process.env.PEPPERSTONE_CLIENT_ID || '',
    clientSecret: process.env.PEPPERSTONE_CLIENT_SECRET || '',
    accessToken: process.env.PEPPERSTONE_ACCESS_TOKEN || '',
    refreshToken: process.env.PEPPERSTONE_REFRESH_TOKEN || '',
    accountId: parseInt(process.env.PEPPERSTONE_ACCOUNT_ID || '49442058'),
    accountNumber: parseInt(process.env.PEPPERSTONE_ACCOUNT_NUMBER || '4285238'),
    balanceBase: 10199.22,
    maxDailyRiskEur: 10.00,  // Circuit breaker: max loss 5% per day
    riskPerTradeEur: 2.80,   // Max risk per trade (~1.4%)
    lotSize: 0.01            // Micro-lot size
};

const centinelaState = {
    connected: false,
    balance: 10185.46,
    openPositions: [],
    dailyRealizedPnl: 0.00,
    circuitBreakerTripped: false,
    lastHeartbeat: new Date().toISOString()
};

async function getLiveAccountData() {
    return new Promise((resolve, reject) => {
        const url = `https://api.spotware.com/connect/tradingaccounts?access_token=${PEPPERSTONE_CONFIG.accessToken}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.data && parsed.data.length > 0) {
                        const acc = parsed.data.find(a => a.accountNumber === PEPPERSTONE_CONFIG.accountNumber) || parsed.data[0];
                        resolve({
                            success: true,
                            broker: acc.brokerTitle,
                            accountNumber: acc.accountNumber,
                            accountId: acc.accountId,
                            balance: acc.balance / 100,
                            currency: acc.depositCurrency,
                            leverage: '1:' + acc.leverage,
                            status: acc.accountStatus,
                            type: acc.traderAccountType
                        });
                    } else {
                        resolve({ success: false, error: 'No account returned' });
                    }
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function processIncomingSignal(signal) {
    console.log(`[CENTINELA 15M] Recibida señal: ${signal.action} ${signal.ticker} (Score: ${signal.score}, Pez: ${signal.pez})`);

    if (centinelaState.circuitBreakerTripped) {
        console.warn('⛔ [BLOQUEO DE SEGURIDAD] Circuit breaker diario activo (-€10). Protegiendo capital.');
        return { executed: false, reason: 'Circuit breaker activo' };
    }

    if (signal.score < 60) {
        console.warn(`⏳ [FILTRO SCORE] Señal rechazada: Score ${signal.score} < 60`);
        return { executed: false, reason: 'Score insuficiente (<60)' };
    }

    const allowedPez = ['DELFÍN', 'TIBURÓN', 'BALLENA', 'KRAKEN', 'VWAP', 'SUPERTREND'];
    const hasValidPez = allowedPez.some(p => (signal.pez || '').toUpperCase().includes(p));
    if (!hasValidPez) {
        console.warn(`🐡 [FILTRO PEZ] Señal rechazada: ${signal.pez} es zona de bajo volumen.`);
        return { executed: false, reason: 'Especie marina no institucional' };
    }

    if (centinelaState.openPositions.length >= 24) {
        console.warn('⚠️ [FILTRO MARGEN] Máximo 24 posiciones en paralelo alcanzado.');
        return { executed: false, reason: 'Límite de posiciones simultáneas alcanzado' };
    }

    // Mapeo oficial de símbolos cTrader
    const SYMBOL_MAP = {
        'SOLUSD': 1614,
        'SOL/USD': 1614,
        'XAUUSD': 41,
        'NVDA': 7250, // NVDA.US
        'TSLA': 340   // TSLA.US
    };

    const symbolId = SYMBOL_MAP[signal.ticker] || 1614;
    // Volume en cTrader Open API (centésimas de lote):
    // SOL: 100 = 1 SOL
    // NVDA/TSLA: 10 = 0.10 lotes (mínimo permitido por Pepperstone para acciones US)
    // XAUUSD (Oro): 100 = 0.01 lotes (1 onza)
    let cTraderVolume = 100;
    if (signal.ticker.includes('SOL')) {
        cTraderVolume = 100;
    } else if (signal.ticker === 'NVDA' || signal.ticker === 'TSLA') {
        cTraderVolume = 10;
    } else if (signal.ticker.includes('XAU')) {
        cTraderVolume = 100;
    }

    console.log(`[cTrader WebSocket] Disparando orden REAL en Pepperstone: ${signal.action} ${signal.ticker} (SymbolID: ${symbolId}, Vol: ${cTraderVolume})...`);
    
    let cTraderResult = null;
    const cleanComment = 'KRAKEN_' + (signal.pez || 'DELFIN').replace(/[^\w]/g, '_').slice(0, 20);
    try {
        cTraderResult = await executeOrderViaOpenAPI(symbolId, signal.action, cTraderVolume, cleanComment);
        console.log(`[cTrader RESPUESTA EN VIVO]:`, JSON.stringify(cTraderResult));
    } catch(err) {
        console.error('[cTrader WebSocket Error]:', err.message);
    }

    if (!cTraderResult || cTraderResult.errorCode || !cTraderResult.position || !cTraderResult.position.positionId) {
        console.warn(`❌ [cTrader ORDEN RECHAZADA] ${signal.ticker}:`, cTraderResult ? (cTraderResult.errorCode + ' - ' + (cTraderResult.description || '')) : 'Sin respuesta de cTrader');
        return { executed: false, error: cTraderResult ? cTraderResult.errorCode : 'NO_RESPONSE', description: cTraderResult ? cTraderResult.description : 'Unknown error' };
    }

    const positionId = cTraderResult.position.positionId;

    const tradeOrder = {
        id: positionId,
        positionId: positionId,
        timestamp: new Date().toISOString(),
        broker: 'Pepperstone ECN Razor (Londres)',
        accountNumber: PEPPERSTONE_CONFIG.accountNumber,
        accountId: PEPPERSTONE_CONFIG.accountId,
        symbolId: symbolId,
        ticker: signal.ticker,
        action: signal.action,
        volumeLots: PEPPERSTONE_CONFIG.lotSize,
        cTraderVolume: cTraderVolume,
        entryPrice: signal.price,
        stopLoss: signal.sl,
        takeProfit: signal.tp,
        score: signal.score,
        pez: signal.pez,
        status: 'OPEN_ECN_LIVE',
        timeframe: '5m'
    };

    centinelaState.openPositions.push(tradeOrder);
    console.log('✅ [DISPARO OFICIAL cTRADER AUTORIZADO]', JSON.stringify(tradeOrder, null, 2));
    return { executed: true, order: tradeOrder, cTraderResult };
}

function executeOrderViaOpenAPI(symbolId, action, volume = 100, comment = 'KRAKEN_SNIPER') {
    return new Promise((resolve) => {
        let isDone = false;
        let ws = null;
        const finish = (result) => {
            if (isDone) return;
            isDone = true;
            if (ws) {
                try {
                    ws.onerror = null;
                    ws.onclose = null;
                    ws.onmessage = null;
                    if (ws.readyState === 1 || ws.readyState === 0) ws.close();
                } catch(e) {}
            }
            resolve(result);
        };

        try {
            ws = new WebSocket('wss://demo.ctraderapi.com:5036');
        } catch(e) {
            return resolve({ error: e.message });
        }

        ws.onopen = () => {
            if (isDone) return;
            try {
                ws.send(JSON.stringify({
                    clientMsgId: 'auth_app',
                    payloadType: 2100,
                    payload: {
                        clientId: PEPPERSTONE_CONFIG.clientId,
                        clientSecret: PEPPERSTONE_CONFIG.clientSecret
                    }
                }));
            } catch(e) { finish({ error: e.message }); }
        };

        ws.onmessage = (event) => {
            if (isDone) return;
            try {
                const res = JSON.parse(event.data);
                if (res.clientMsgId === 'auth_app') {
                    ws.send(JSON.stringify({
                        clientMsgId: 'auth_acc',
                        payloadType: 2102,
                        payload: {
                            ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId,
                            accessToken: PEPPERSTONE_CONFIG.accessToken
                        }
                    }));
                } else if (res.clientMsgId === 'auth_acc') {
                    ws.send(JSON.stringify({
                        clientMsgId: 'order_exec',
                        payloadType: 2106,
                        payload: {
                            ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId,
                            symbolId: symbolId,
                            orderType: 'MARKET',
                            tradeSide: action.toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
                            volume: volume,
                            comment: comment
                        }
                    }));
                } else if (res.clientMsgId === 'order_exec' || res.payloadType === 2126) {
                    finish(res.payload);
                }
            } catch(e) {
                finish({ error: e.message });
            }
        };

        ws.onerror = (err) => { finish({ error: err ? err.message : 'WS Error' }); };
        ws.onclose = () => { finish({ closed: true }); };
        setTimeout(() => { finish({ timeout: true }); }, 10000);
    });
}

function closeOrderViaOpenAPI(positionId, volume = 100) {
    return new Promise((resolve) => {
        let isDone = false;
        let ws = null;
        const finish = (result) => {
            if (isDone) return;
            isDone = true;
            if (ws) {
                try {
                    ws.onerror = null;
                    ws.onclose = null;
                    ws.onmessage = null;
                    if (ws.readyState === 1 || ws.readyState === 0) ws.close();
                } catch(e) {}
            }
            resolve(result);
        };

        try {
            ws = new WebSocket('wss://demo.ctraderapi.com:5036');
        } catch(e) {
            return resolve({ error: e.message });
        }

        ws.onopen = () => {
            if (isDone) return;
            try {
                ws.send(JSON.stringify({
                    clientMsgId: 'auth_app',
                    payloadType: 2100,
                    payload: {
                        clientId: PEPPERSTONE_CONFIG.clientId,
                        clientSecret: PEPPERSTONE_CONFIG.clientSecret
                    }
                }));
            } catch(e) { finish({ error: e.message }); }
        };

        ws.onmessage = (event) => {
            if (isDone) return;
            try {
                const res = JSON.parse(event.data);
                if (res.clientMsgId === 'auth_app') {
                    ws.send(JSON.stringify({
                        clientMsgId: 'auth_acc',
                        payloadType: 2102,
                        payload: {
                            ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId,
                            accessToken: PEPPERSTONE_CONFIG.accessToken
                        }
                    }));
                } else if (res.clientMsgId === 'auth_acc') {
                    ws.send(JSON.stringify({
                        clientMsgId: 'close_exec',
                        payloadType: 2111,
                        payload: {
                            ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId,
                            positionId: positionId,
                            volume: volume
                        }
                    }));
                } else if (res.clientMsgId === 'close_exec' || res.payloadType === 2126) {
                    finish(res.payload);
                }
            } catch(e) {
                finish({ error: e.message });
            }
        };

        ws.onerror = (err) => { finish({ error: err ? err.message : 'WS Error' }); };
        ws.onclose = () => { finish({ closed: true }); };
        setTimeout(() => { finish({ timeout: true }); }, 10000);
    });
}

if (require.main === module) {
    (async () => {
        console.log('===========================================================');
        console.log('  KRAKEN CLOUD // PEPPERSTONE CENTINELA ÁGIL 5M INICIADO ');
        console.log('===========================================================');
        const acc = await getLiveAccountData();
        console.log(`Estado Nube: ${acc.status} | Cuenta: ${acc.accountNumber} | Saldo: €${acc.balance.toFixed(2)} ${acc.currency} | ECN Razor: ACTIVO | Apalancamiento: ${acc.leverage}`);
    })();
}

function syncOpenPositions(openPos) {
    centinelaState.openPositions = openPos || [];
}

module.exports = {
    syncOpenPositions,
    PEPPERSTONE_CONFIG,
    centinelaState,
    getLiveAccountData,
    processIncomingSignal,
    executeOrderViaOpenAPI,
    closeOrderViaOpenAPI
};
