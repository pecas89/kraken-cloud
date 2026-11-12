/**
 * KRAKEN CLOUD // RESETEO TOTAL DEL LABORATORIO DEMO (KIMI 12-NOV)
 * 1. Cierra TODAS las posiciones reales abiertas en cTrader (reconcile + close por positionId)
 * 2. Cierra TODAS las posiciones neteadas en Alpaca (DELETE /positions/:symbol)
 * Autorizado por Pedro Castillo. Es demo/paper: cero dinero real.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CFG = {
    clientId: process.env.PEPPERSTONE_CLIENT_ID || '',
    clientSecret: process.env.PEPPERSTONE_CLIENT_SECRET || '',
    accessToken: process.env.PEPPERSTONE_ACCESS_TOKEN || '',
    accountId: parseInt(process.env.PEPPERSTONE_ACCOUNT_ID || '49442058')
};

function wsCall(requests) {
    // requests: [{id, payloadType, payload}] ejecutados en orden tras auth
    return new Promise((resolve) => {
        const results = {};
        let done = false;
        const finish = () => { if (!done) { done = true; try { ws.close(); } catch(e){} resolve(results); } };
        const ws = new WebSocket('wss://demo.ctraderapi.com:5036');
        const send = (id, pt, payload) => ws.send(JSON.stringify({ clientMsgId: id, payloadType: pt, payload }));
        let step = 0;

        ws.onopen = () => send('auth_app', 2100, { clientId: CFG.clientId, clientSecret: CFG.clientSecret });
        ws.onmessage = (ev) => {
            if (done) return;
            let res;
            try { res = JSON.parse(ev.data); } catch(e) { return; }
            if (res.clientMsgId === 'auth_app') {
                send('auth_acc', 2102, { ctidTraderAccountId: CFG.accountId, accessToken: CFG.accessToken });
            } else if (res.clientMsgId === 'auth_acc') {
                if (step < requests.length) {
                    const r = requests[step];
                    send(r.id, r.payloadType, r.payload);
                } else finish();
            } else {
                results[res.clientMsgId] = res.payload || { errorCode: 'NO_PAYLOAD' };
                step++;
                if (step < requests.length) {
                    const r = requests[step];
                    send(r.id, r.payloadType, r.payload);
                } else finish();
            }
        };
        ws.onerror = () => finish();
        setTimeout(finish, 20000);
    });
}

async function closeAllCTrader() {
    console.log('=== FASE 1: PEPPERSTONE cTRADER ===');
    const recon = await wsCall([{ id: 'recon', payloadType: 2124, payload: { ctidTraderAccountId: CFG.accountId } }]);
    const positions = (recon.recon && recon.recon.position) || [];
    console.log(`Posiciones reales abiertas detectadas: ${positions.length}`);
    if (positions.length === 0) { console.log('Nada que cerrar.'); return; }

    // Cerrar en lotes de 6 para no saturar (cada posicion = una peticion 2111)
    let ok = 0, fail = 0;
    for (let i = 0; i < positions.length; i += 6) {
        const batch = positions.slice(i, i + 6);
        const reqs = batch.map((p, j) => ({
            id: 'close_' + (i + j),
            payloadType: 2111,
            payload: {
                ctidTraderAccountId: CFG.accountId,
                positionId: p.positionId,
                volume: (p.tradeData && p.tradeData.volume) || 10
            }
        }));
        const res = await wsCall(reqs);
        batch.forEach((p, j) => {
            const r = res['close_' + (i + j)];
            if (r && !r.errorCode) { ok++; }
            else { fail++; console.log(`  ❌ positionId ${p.positionId}: ${r ? (r.errorCode + ' ' + (r.description||'')) : 'sin respuesta'}`); }
        });
        console.log(`  Lote ${Math.floor(i/6)+1}: ${ok} cerradas, ${fail} fallidas...`);
    }
    console.log(`RESULTADO cTrader: ${ok} cerradas, ${fail} fallidas de ${positions.length}`);
}

async function closeAllAlpaca() {
    console.log('\n=== FASE 2: ALPACA PAPER ===');
    const https = require('https');
    const headers = {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY
    };
    const req = (method, pathUrl) => new Promise((resolve) => {
        const r = https.request({ hostname: 'paper-api.alpaca.markets', path: '/v2' + pathUrl, method, headers }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, raw: d }); } });
        });
        r.on('error', e => resolve({ status: 0, error: e.message }));
        r.end();
    });

    // Cancelar ordenes abiertas (patas de brackets) y luego liquidar todo
    const cancel = await req('DELETE', '/orders');
    console.log('Cancelación de órdenes pendientes (patas bracket):', cancel.status);
    const close = await req('DELETE', '/positions?cancel_orders=true');
    if (close.status === 207 || close.status === 200) {
        const arr = Array.isArray(close.data) ? close.data : [];
        arr.forEach(p => console.log(`  ${p.symbol}: HTTP ${p.status} ${p.status === 200 ? '✅ liquidada' : '❌ ' + (p.body && p.body.message || '')}`));
    } else {
        console.log('Respuesta cierre masivo:', close.status, JSON.stringify(close.data || close.raw || '').slice(0, 300));
    }
}

(async () => {
    await closeAllCTrader();
    await closeAllAlpaca();
    console.log('\n=== RESETEO BROKER COMPLETO ===');
    process.exit(0);
})();
