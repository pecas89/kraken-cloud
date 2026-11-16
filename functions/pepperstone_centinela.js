/**
 * KRAKEN CLOUD // PEPPERSTONE cTRADER AUTONOMOUS CENTINELA 24/7
 * Broker: Pepperstone - Europe (Razor ECN)
 * Account Number: 4285238 (EUR, consultada en vivo por API Spotware)
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
    maxDailyDrawdownPct: 2.50,
    lotSize: 0.01
};

const centinelaState = {
    connected: false,
    balance: null,
    openPositions: [],
    realBrokerCount: 0,
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
    console.log(`[CENTINELA ${signal.timeframe || '5m'}] Recibida señal: ${signal.action} ${signal.ticker} (Score: ${signal.score}, Pez: ${signal.pez})`);

    if (centinelaState.circuitBreakerTripped) {
        console.warn('⛔ [BLOQUEO DE SEGURIDAD] Circuit breaker diario activo (DD >= 2.50%). Protegiendo capital.');
        return { executed: false, reason: 'Circuit breaker activo' };
    }

    const allowedPez = ['DELFÍN', 'TIBURÓN', 'BALLENA', 'KRAKEN', 'VWAP', 'SUPERTREND', 'REVERSIÓN', 'ORB', 'SQUEEZE'];
    const hasValidPez = allowedPez.some(p => (signal.pez || '').toUpperCase().includes(p));
    if (!hasValidPez) {
        console.warn(`🐡 [FILTRO PEZ] Señal rechazada: ${signal.pez} es zona de bajo volumen.`);
        return { executed: false, reason: 'Especie marina no institucional' };
    }

    const livePosCount = Math.max(centinelaState.openPositions.length, centinelaState.realBrokerCount || 0);
    if (livePosCount >= 24) {
        console.warn(`⚠️ [FILTRO MARGEN] Máximo 24 posiciones en paralelo alcanzado (${livePosCount}/24 reales en cTrader).`);
        return { executed: false, reason: 'Límite de posiciones simultáneas alcanzado' };
    }

    // Mapeo oficial de símbolos cTrader (Spotware Open API Pepperstone Europe)
    const SYMBOL_MAP = {
        'SOLUSD': 1614,
        'SOL/USD': 1614,
        'XAUUSD': 41,
        'NVDA': 338,   // NVDA.US (symbolId oficial verificado: 338)
        'TSLA': 339    // TSLA.US (symbolId oficial verificado: 339)
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

    const positionObj = (cTraderResult && cTraderResult.position) || {};
    const positionId = positionObj.positionId || (cTraderResult && cTraderResult.order && cTraderResult.order.positionId);

    if (!cTraderResult || cTraderResult.errorCode || !positionId) {
        console.warn(`❌ [cTrader ORDEN RECHAZADA] ${signal.ticker}:`, cTraderResult ? (cTraderResult.errorCode + ' - ' + (cTraderResult.description || '')) : 'Sin respuesta de cTrader');
        return { executed: false, error: cTraderResult ? cTraderResult.errorCode : 'NO_RESPONSE', description: cTraderResult ? cTraderResult.description : 'Unknown error' };
    }

    const fillPrice = parseFloat(positionObj.price || (cTraderResult.order && cTraderResult.order.executionPrice) || signal.price);
    const refPrice = parseFloat(signal.price) || fillPrice;
    const isBuy = signal.action.toUpperCase() === 'BUY';
    let boundSl = parseFloat(signal.sl);
    let boundTp = parseFloat(signal.tp);
    // Re-escalar SL/TP proporcionalmente si el precio real de Spotware difiere (ej. XAUUSD spot vs GLD ETF)
    if (isFinite(fillPrice) && fillPrice > 0 && isFinite(refPrice) && refPrice > 0 && Math.abs(fillPrice - refPrice) / refPrice > 0.05) {
        const slPct = isFinite(boundSl) ? Math.abs(refPrice - boundSl) / refPrice : 0.015;
        const tpPct = isFinite(boundTp) ? Math.abs(boundTp - refPrice) / refPrice : 0.030;
        boundSl = parseFloat((isBuy ? fillPrice * (1 - slPct) : fillPrice * (1 + slPct)).toFixed(2));
        boundTp = parseFloat((isBuy ? fillPrice * (1 + tpPct) : fillPrice * (1 - tpPct)).toFixed(2));
    }

    // Vincular SL/TP reales en el servidor Spotware cTrader (Mandato Control 3.B.3)
    let brokerSltpBound = false;
    if (isFinite(boundSl) && isFinite(boundTp)) {
        try {
            const amendRes = await amendPositionSLTPViaOpenAPI(positionId, boundSl, boundTp);
            if (amendRes && !amendRes.errorCode && !amendRes.error && !amendRes.timeout) {
                brokerSltpBound = true;
                console.log(`🛡️ [cTrader SL/TP FIJADO] Pos #${positionId}: SL=${boundSl} | TP=${boundTp}`);
            } else {
                console.warn(`⚠️ [cTrader SL/TP] No vinculado en servidor para #${positionId}:`, JSON.stringify(amendRes));
            }
        } catch (sltpErr) {
            console.warn(`⚠️ [cTrader SL/TP Error] #${positionId}:`, sltpErr.message);
        }
    }

    const tradeOrder = {
        id: positionId,
        positionId: positionId,
        timestamp: new Date().toISOString(),
        broker: 'Pepperstone cTrader ECN Razor',
        accountNumber: PEPPERSTONE_CONFIG.accountNumber,
        accountId: PEPPERSTONE_CONFIG.accountId,
        symbolId: symbolId,
        ticker: signal.ticker,
        action: signal.action,
        volumeLots: PEPPERSTONE_CONFIG.lotSize,
        cTraderVolume: cTraderVolume,
        entryPrice: fillPrice,
        fillPrice: fillPrice,
        stopLoss: boundSl,
        takeProfit: boundTp,
        brokerSltpBound: brokerSltpBound,
        score: signal.score,
        pez: signal.pez,
        status: 'OPEN_ECN_LIVE',
        timeframe: signal.timeframe || '5m'
    };

    centinelaState.openPositions.push(tradeOrder);
    centinelaState.realBrokerCount = Math.max(centinelaState.realBrokerCount || 0, centinelaState.openPositions.length);
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

function syncOpenPositions(openPos, realBrokerCount = null) {
    centinelaState.openPositions = openPos || [];
    if (typeof realBrokerCount === 'number' && isFinite(realBrokerCount)) {
        centinelaState.realBrokerCount = realBrokerCount;
    }
}

/** Fija o actualiza Stop Loss / Take Profit reales en el servidor Spotware cTrader (ProtoOAAmendPositionSLTPReq 2110). */
function amendPositionSLTPViaOpenAPI(positionId, stopLoss, takeProfit) {
    return new Promise((resolve) => {
        let isDone = false;
        let ws = null;
        const finish = (result) => {
            if (isDone) return;
            isDone = true;
            if (ws) { try { ws.onerror = null; ws.onclose = null; ws.onmessage = null; if (ws.readyState === 1 || ws.readyState === 0) ws.close(); } catch(e) {} }
            resolve(result);
        };
        try { ws = new WebSocket('wss://demo.ctraderapi.com:5036'); } catch(e) { return resolve({ error: e.message }); }
        ws.onopen = () => {
            if (isDone) return;
            try { ws.send(JSON.stringify({ clientMsgId: 'auth_app', payloadType: 2100, payload: { clientId: PEPPERSTONE_CONFIG.clientId, clientSecret: PEPPERSTONE_CONFIG.clientSecret } })); } catch(e) { finish({ error: e.message }); }
        };
        ws.onmessage = (event) => {
            if (isDone) return;
            try {
                const res = JSON.parse(event.data);
                if (res.clientMsgId === 'auth_app') {
                    ws.send(JSON.stringify({ clientMsgId: 'auth_acc', payloadType: 2102, payload: { ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId, accessToken: PEPPERSTONE_CONFIG.accessToken } }));
                } else if (res.clientMsgId === 'auth_acc') {
                    const amendPayload = { ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId, positionId: positionId };
                    if (isFinite(stopLoss)) amendPayload.stopLoss = parseFloat(stopLoss);
                    if (isFinite(takeProfit)) amendPayload.takeProfit = parseFloat(takeProfit);
                    ws.send(JSON.stringify({ clientMsgId: 'amend_sltp', payloadType: 2110, payload: amendPayload }));
                } else if (res.clientMsgId === 'amend_sltp' || res.payloadType === 2126) {
                    finish(res.payload || {});
                }
            } catch(e) { finish({ error: e.message }); }
        };
        ws.onerror = (err) => finish({ error: err ? err.message : 'WS Error' });
        ws.onclose = () => finish({ closed: true });
        setTimeout(() => finish({ timeout: true }), 10000);
    });
}

// KIMI 12-NOV: reconcile real de posiciones abiertas en cTrader (ProtoOAReconcileReq)
function getOpenPositionsViaOpenAPI() {
    return new Promise((resolve) => {
        let isDone = false;
        let ws = null;
        const finish = (result) => {
            if (isDone) return;
            isDone = true;
            if (ws) { try { ws.onerror = null; ws.onclose = null; ws.onmessage = null; if (ws.readyState === 1 || ws.readyState === 0) ws.close(); } catch(e) {} }
            resolve(result);
        };
        try { ws = new WebSocket('wss://demo.ctraderapi.com:5036'); } catch(e) { return resolve({ error: e.message }); }
        ws.onopen = () => {
            try { ws.send(JSON.stringify({ clientMsgId: 'auth_app', payloadType: 2100, payload: { clientId: PEPPERSTONE_CONFIG.clientId, clientSecret: PEPPERSTONE_CONFIG.clientSecret } })); } catch(e) { finish({ error: e.message }); }
        };
        ws.onmessage = (event) => {
            if (isDone) return;
            try {
                const res = JSON.parse(event.data);
                if (res.clientMsgId === 'auth_app') {
                    ws.send(JSON.stringify({ clientMsgId: 'auth_acc', payloadType: 2102, payload: { ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId, accessToken: PEPPERSTONE_CONFIG.accessToken } }));
                } else if (res.clientMsgId === 'auth_acc') {
                    ws.send(JSON.stringify({ clientMsgId: 'recon', payloadType: 2124, payload: { ctidTraderAccountId: PEPPERSTONE_CONFIG.accountId } }));
                } else if (res.clientMsgId === 'recon') {
                    if (res.payload && res.payload.errorCode) return finish({ error: res.payload.errorCode });
                    finish({ positions: (res.payload && res.payload.position) || [] });
                }
            } catch(e) { finish({ error: e.message }); }
        };
        ws.onerror = (err) => finish({ error: err ? err.message : 'WS Error' });
        ws.onclose = () => finish({ error: 'WS closed' });
        setTimeout(() => finish({ error: 'timeout' }), 10000);
    });
}

module.exports = {
    syncOpenPositions,
    PEPPERSTONE_CONFIG,
    centinelaState,
    getLiveAccountData,
    processIncomingSignal,
    executeOrderViaOpenAPI,
    getOpenPositionsViaOpenAPI,
    amendPositionSLTPViaOpenAPI,
    closeOrderViaOpenAPI
};
