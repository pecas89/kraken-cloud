/**
 * KRAKEN CLOUD // AUDITORÍA DE FILLS REALES PEPPERSTONE (KIMI 11-NOV)
 * Descarga el deal list real de cTrader Open API y calcula el PnL cerrado
 * REAL por símbolo, emparejando deals por positionId.
 * Uso: node audit_real_fills_pepperstone.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// Node 22+ ya trae WebSocket global (igual que pepperstone_centinela.js)

const CFG = {
    clientId: process.env.PEPPERSTONE_CLIENT_ID || '',
    clientSecret: process.env.PEPPERSTONE_CLIENT_SECRET || '',
    accessToken: process.env.PEPPERSTONE_ACCESS_TOKEN || '',
    accountId: parseInt(process.env.PEPPERSTONE_ACCOUNT_ID || '49442058')
};

const SYMBOL_NAMES = { 41: 'XAUUSD', 1614: 'SOLUSD', 7250: 'NVDA.US', 340: 'TSLA.US' };

function fetchDeals(fromTs, toTs) {
    return new Promise((resolve) => {
        let done = false;
        const deals = [];
        const finish = (r) => { if (!done) { done = true; try { ws.close(); } catch(e){} resolve(r); } };
        const ws = new WebSocket('wss://demo.ctraderapi.com:5036');
        const send = (id, pt, payload) => ws.send(JSON.stringify({ clientMsgId: id, payloadType: pt, payload }));

        ws.onopen = () => send('auth_app', 2100, { clientId: CFG.clientId, clientSecret: CFG.clientSecret });
        ws.onmessage = (ev) => {
            if (done) return;
            try {
                const res = JSON.parse(ev.data);
                if (process.env.AUDIT_DEBUG) console.log('[RAW]', JSON.stringify(res).slice(0, 500));
                if (res.clientMsgId === 'auth_app') {
                    send('auth_acc', 2102, { ctidTraderAccountId: CFG.accountId, accessToken: CFG.accessToken });
                } else if (res.clientMsgId === 'auth_acc') {
                    send('deals', 2130, { ctidTraderAccountId: CFG.accountId, fromTimestamp: fromTs, toTimestamp: toTs });
                } else if (res.clientMsgId === 'deals' || res.payloadType === 2131) {
                    if (res.payload && res.payload.deal) deals.push(...res.payload.deal);
                    if (res.payload && res.payload.hasMore) {
                        // paginación simple: pedir desde el último deal
                        const last = res.payload.deal[res.payload.deal.length - 1];
                        send('deals', 2130, { ctidTraderAccountId: CFG.accountId, fromTimestamp: last.executionTimestamp + 1, toTimestamp: toTs });
                    } else {
                        finish({ deals });
                    }
                } else if (res.payload && res.payload.errorCode) {
                    finish({ error: res.payload.errorCode + ' ' + (res.payload.description || '') });
                }
            } catch(e) { finish({ error: e.message }); }
        };
        ws.onerror = (e) => finish({ error: e ? e.message : 'WS Error' });
        ws.onclose = () => finish(deals.length ? { deals } : { error: 'WS closed' });
        setTimeout(() => finish(deals.length ? { deals } : { error: 'timeout' }), 30000);
    });
}

(async () => {
    const toTs = Date.now();
    const fromTs = toTs - 7 * 24 * 3600 * 1000; // últimos 7 días
    console.log('Descargando deals reales de cTrader (últimos 7 días)...');
    const res = await fetchDeals(fromTs, toTs);
    if (res.error) { console.error('ERROR:', res.error); process.exit(1); }

    // Emparejar por positionId: apertura (BUY) y cierre (SELL) con profit real
    const byPos = {};
    res.deals.forEach(d => {
        const pid = d.positionId;
        if (!byPos[pid]) byPos[pid] = { opens: [], closes: [], symbolId: d.symbolId, moneyDigits: d.moneyDigits || 2 };
        const side = d.tradeSide;
        if (side === 1 || side === 'BUY') byPos[pid].opens.push(d);
        else byPos[pid].closes.push(d);
    });

    const stats = {};
    let totalProfit = 0, totalComm = 0, totalSwap = 0, closedCount = 0, wins = 0, losses = 0;
    Object.entries(byPos).forEach(([pid, p]) => {
        const sym = SYMBOL_NAMES[p.symbolId] || ('ID' + p.symbolId);
        if (!stats[sym]) stats[sym] = { closed: 0, pnl: 0, comm: 0, wins: 0, losses: 0 };
        p.closes.forEach(c => {
            const div = Math.pow(10, c.moneyDigits || 2);
            const cpd = c.closePositionDetail || {};
            const profit = (cpd.profit || 0) / div;
            const comm = (cpd.commission || 0) / div;
            const swap = (cpd.swap || 0) / div;
            stats[sym].closed++; stats[sym].pnl += profit; stats[sym].comm += comm;
            if (profit > 0) { stats[sym].wins++; wins++; } else if (profit < 0) { stats[sym].losses++; losses++; }
            totalProfit += profit; totalComm += comm; totalSwap += swap; closedCount++;
        });
    });

    const openOnly = Object.values(byPos).filter(p => p.opens.length > p.closes.length).length;
    console.log('\n=== PnL REAL CERRADO EN PEPPERSTONE (deals reales cTrader) ===');
    Object.entries(stats).forEach(([sym, s]) => {
        const wr = (s.wins + s.losses) ? (s.wins / (s.wins + s.losses) * 100).toFixed(0) : '0';
        console.log(`${sym}: cerrados ${s.closed} | PnL neto €${(s.pnl + s.comm).toFixed(2)} (bruto €${s.pnl.toFixed(2)}, comisiones €${s.comm.toFixed(2)}) | W:${s.wins} L:${s.losses} | WR ${wr}%`);
    });
    console.log(`\nTOTAL DEALS: ${res.deals.length} | POSICIONES CERRADAS REALES: ${closedCount} | ABIERTAS AHORA: ${openOnly}`);
    console.log(`PNL NETO REAL TOTAL: €${(totalProfit + totalComm + totalSwap).toFixed(2)} (bruto €${totalProfit.toFixed(2)}, comisiones €${totalComm.toFixed(2)}, swap €${totalSwap.toFixed(2)})`);
    console.log(`GLOBAL: W:${wins} L:${losses} | WinRate real: ${(wins + losses) ? (wins / (wins + losses) * 100).toFixed(1) : 0}%`);
    process.exit(0);
})();
