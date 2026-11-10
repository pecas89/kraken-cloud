const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ALPACA_CONFIG = {
    apiKey: process.env.ALPACA_API_KEY || '',
    secretKey: process.env.ALPACA_SECRET_KEY || '',
    accountNumber: process.env.ALPACA_ACCOUNT_NUMBER || 'PA35UQ22S',
    baseUrl: 'paper-api.alpaca.markets',
    port: 443
};

function alpacaRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
            'APCA-API-KEY-ID': ALPACA_CONFIG.apiKey,
            'APCA-API-SECRET-KEY': ALPACA_CONFIG.secretKey,
            'Content-Type': 'application/json'
        };
        if (payload) {
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = https.request({
            hostname: ALPACA_CONFIG.baseUrl,
            port: ALPACA_CONFIG.port,
            path: '/v2' + path,
            method: method,
            headers: headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
                } catch(e) {
                    resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, raw: data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// 1. Get Live Account
async function getAccount() {
    const res = await alpacaRequest('/account', 'GET');
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    const d = res.data;
    return {
        accountNumber: d.account_number,
        status: d.status,
        currency: d.currency,
        cash: parseFloat(d.cash),
        portfolioValue: parseFloat(d.portfolio_value),
        buyingPower: parseFloat(d.buying_power),
        multiplier: d.multiplier,
        patternDayTrader: d.pattern_day_trader,
        createdAt: d.created_at
    };
}

// 2. Get Open Positions
async function getPositions() {
    const res = await alpacaRequest('/positions', 'GET');
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    return Array.isArray(res.data) ? res.data.map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        side: p.side,
        avgEntryPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPnl: parseFloat(p.unrealized_pl),
        unrealizedPnlPct: parseFloat(p.unrealized_plpc) * 100,
        changeToday: parseFloat(p.change_today) * 100
    })) : [];
}

// 3. Place Bracket Order (Entry with Automatic Stop Loss and Take Profit)
async function placeBracketOrder({ symbol, qty = 1, side = 'buy', takeProfitLimit, stopLossStop }) {
    const orderData = {
        symbol: symbol.toUpperCase(),
        qty: qty,
        side: side.toLowerCase(),
        type: 'market',
        time_in_force: 'day',
        order_class: 'bracket'
    };

    if (takeProfitLimit) {
        orderData.take_profit = { limit_price: parseFloat(takeProfitLimit.toFixed(2)) };
    }
    if (stopLossStop) {
        orderData.stop_loss = { stop_price: parseFloat(stopLossStop.toFixed(2)) };
    }

    const res = await alpacaRequest('/orders', 'POST', orderData);
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    return res.data;
}

// 4. Place Simple Market Order
async function placeMarketOrder({ symbol, qty = 1, side = 'buy' }) {
    const isCrypto = symbol.includes('/');
    const orderData = {
        symbol: symbol.toUpperCase(),
        qty: qty,
        side: side.toLowerCase(),
        type: 'market',
        time_in_force: isCrypto ? 'gtc' : 'day'
    };
    const res = await alpacaRequest('/orders', 'POST', orderData);
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    return res.data;
}

// 5. Close Position
async function closePosition(symbol) {
    const res = await alpacaRequest(`/positions/${symbol.toUpperCase()}`, 'DELETE');
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    return res.data;
}

// 6. Get Orders
async function getOrders(status = 'open') {
    const res = await alpacaRequest(`/orders?status=${status}`, 'GET');
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    return res.data;
}

// 7. Cancel All Orders
async function cancelAllOrders() {
    const res = await alpacaRequest('/orders', 'DELETE');
    if (!res.ok) throw new Error(res.data ? res.data.message : `HTTP ${res.status}`);
    return res.data;
}

// Self-Test Execution
if (require.main === module) {
    (async () => {
        console.log('=== TEST ALPACA PAPER SERVICE (PA35UQ22S) ===');
        try {
            const acc = await getAccount();
            console.log('✅ Cuenta Alpaca Verificada:');
            console.log(`   Número: ${acc.accountNumber} | Estado: ${acc.status}`);
            console.log(`   Valor Cartera: $${acc.portfolioValue.toLocaleString()} ${acc.currency}`);
            console.log(`   Poder de Compra (Buying Power): $${acc.buyingPower.toLocaleString()} ${acc.currency}`);
            
            const pos = await getPositions();
            console.log(`✅ Posiciones Abiertas: ${pos.length}`);
        } catch(e) {
            console.error('❌ Error en test Alpaca:', e.message);
        }
    })();
}

module.exports = {
    ALPACA_CONFIG,
    alpacaRequest,
    getAccount,
    getPositions,
    getOrders,
    placeBracketOrder,
    placeMarketOrder,
    closePosition,
    cancelAllOrders
};
