// ==============================================================================
// [CLAUDE v3.2] AUDITORÍA CONTRA LOS BROKERS — "dos fuentes" (petición de Pedro, 27-nov-2026)
// Compara la libreta del motor con el historial REAL de cada broker:
//  - Pepperstone (cTrader): operación por operación por positionId. El resultado neto real
//    (bruto + swap + comisiones, en EUR) se guarda en la operación (pnlBroker) y pasa a ser
//    su pnl; el valor que calculó el motor queda en pnlLibreta. Así el dinero del panel es el del broker.
//  - Alpaca: cada entrada se busca por su order_id en las ejecuciones (FILL) y cada salida por
//    símbolo/hora/cantidad. Además, P&L realizado FIFO por símbolo según el broker frente a la libreta.
// Solo lee de los brokers: nunca envía órdenes.
// ==============================================================================
'use strict';

const r2 = x => Math.round(x * 100) / 100;

async function auditPepperstone(engineState, getDealList, sinceMs) {
    const deals = [];
    const now = Date.now();
    for (let from = sinceMs; from < now; from += 3 * 24 * 3600 * 1000) {
        const to = Math.min(now, from + 3 * 24 * 3600 * 1000);
        const res = await getDealList(from, to);
        if (!res || res.error) return { ok: false, error: (res && (res.error + (res.description ? ' ' + res.description : ''))) || 'sin respuesta' };
        deals.push(...(res.deals || []));
    }
    // sin duplicados en los bordes entre tramos
    const seen = new Set();
    for (let i = deals.length - 1; i >= 0; i--) { const id = String(deals[i].dealId); if (deals[i].dealId != null && seen.has(id)) deals.splice(i, 1); else seen.add(id); }
    // Resultado neto real por posición (solo deals ya ejecutados)
    const byPos = {};
    deals.forEach(d => {
        if (d.dealStatus && d.dealStatus !== 2 && d.dealStatus !== 'FILLED') return; // 2 = FILLED
        const pid = String(d.positionId);
        const p = byPos[pid] = byPos[pid] || { net: 0, closed: false, commission: 0, swap: 0, gross: 0, exitPrice: null, entryPrice: null, closedAt: null };
        const md = Math.pow(10, d.moneyDigits || (d.closePositionDetail && d.closePositionDetail.moneyDigits) || 2);
        p.commission += (d.commission || 0) / md;
        if (d.closePositionDetail) {
            const c = d.closePositionDetail; const cmd = Math.pow(10, c.moneyDigits || d.moneyDigits || 2);
            p.gross += (c.grossProfit || 0) / cmd; p.swap += (c.swap || 0) / cmd;
            p.closed = true; p.exitPrice = d.executionPrice; p.entryPrice = c.entryPrice; p.closedAt = new Date(d.executionTimestamp).toISOString();
        } else if (p.entryPrice == null) { p.entryPrice = d.executionPrice; }
    });
    Object.values(byPos).forEach(p => { p.net = p.gross + p.swap + p.commission; });

    const ledger = (engineState.closedTradesHistory || []).filter(t => (t.broker || '').includes('Pepperstone') && Date.parse(t.closedAt || 0) >= sinceMs);
    let matched = 0, ledgerEur = 0, brokerEur = 0; const diffs = []; const missingInBroker = [];
    ledger.forEach(t => {
        const b = byPos[String(t.positionId || t.id)];
        if (!b || !b.closed) { missingInBroker.push({ id: t.positionId || t.id, symbol: t.symbol, stratCode: t.stratCode, closedAt: t.closedAt }); return; }
        matched++;
        const libreta = (t.pnlLibreta != null) ? t.pnlLibreta : (+t.pnl || 0);
        if (t.pnlLibreta == null) t.pnlLibreta = libreta;
        t.pnlBroker = r2(b.net); t.pnl = t.pnlBroker; t.pnlVerifiedByBroker = true; t.brokerExitPrice = b.exitPrice; t.brokerEntryPrice = b.entryPrice;
        t.brokerCosts = r2(b.commission + b.swap);
        ledgerEur += libreta; brokerEur += b.net;
        if (Math.abs(libreta - b.net) > 0.05) diffs.push({ id: t.positionId || t.id, symbol: t.symbol, stratCode: t.stratCode, timeframe: t.timeframe, libreta: r2(libreta), broker: r2(b.net), costes: t.brokerCosts });
    });
    const ledgerIds = new Set(ledger.map(t => String(t.positionId || t.id)));
    const openIds = new Set((engineState.openPositions || []).map(p => String(p.positionId || p.id)));
    const missingInLedger = Object.entries(byPos).filter(([pid, b]) => b.closed && !ledgerIds.has(pid) && !openIds.has(pid))
        .map(([pid, b]) => ({ positionId: pid, net: r2(b.net), closedAt: b.closedAt }));
    diffs.sort((a, b) => Math.abs(b.broker - b.libreta) - Math.abs(a.broker - a.libreta));
    return {
        ok: true, deals: deals.length, ledgerTrades: ledger.length, matched,
        ledgerEur: r2(ledgerEur), brokerEur: r2(brokerEur), gapEur: r2(brokerEur - ledgerEur),
        brokerNetAllClosed: r2(Object.values(byPos).filter(b => b.closed).reduce((a, b) => a + b.net, 0)),
        costsEur: r2(Object.values(byPos).reduce((a, b) => a + b.commission + b.swap, 0)),
        missingInBroker: missingInBroker.slice(0, 30), missingInBrokerCount: missingInBroker.length,
        missingInLedger: missingInLedger.slice(0, 30), missingInLedgerCount: missingInLedger.length,
        biggestDiffs: diffs.slice(0, 15), diffCount: diffs.length
    };
}

async function auditAlpaca(engineState, alpacaRequest, sinceMs) {
    let fills = []; let pageToken = null;
    for (let page = 0; page < 40; page++) {
        let url = `/account/activities/FILL?page_size=100&direction=asc&after=${encodeURIComponent(new Date(sinceMs).toISOString())}`;
        if (pageToken) url += '&page_token=' + encodeURIComponent(pageToken);
        const res = await alpacaRequest(url, 'GET');
        if (!res || !res.ok) return { ok: false, error: 'Alpaca activities no responde' };
        if (!Array.isArray(res.data) || !res.data.length) break;
        fills = fills.concat(res.data); pageToken = res.data[res.data.length - 1].id;
        if (res.data.length < 100) break;
    }
    const norm = s => String(s || '').replace('/', '').toUpperCase();
    const byOrder = {}; fills.forEach(f => { (byOrder[f.order_id] = byOrder[f.order_id] || []).push(f); });
    const sells = fills.filter(f => f.side === 'sell').map(f => ({ ...f, t: Date.parse(f.transaction_time), sym: norm(f.symbol), left: parseFloat(f.qty), price: parseFloat(f.price) }));
    const ledger = (engineState.closedTradesHistory || []).filter(t => (t.broker || '').includes('Alpaca') && !t.rebuiltFromFills && Date.parse(t.closedAt || 0) >= sinceMs);
    let entryOk = 0, exitOk = 0; const entryMissing = [], exitMissing = []; let slipIn = 0, slipOut = 0, nIn = 0, nOut = 0;
    ledger.forEach(t => {
        const f = byOrder[t.id];
        if (f) { entryOk++; const px = f.reduce((a, x) => a + parseFloat(x.price) * parseFloat(x.qty), 0) / f.reduce((a, x) => a + parseFloat(x.qty), 0); t.brokerEntryPrice = Math.round(px * 10000) / 10000; if (t.entryPrice > 0) { slipIn += (px - t.entryPrice) / t.entryPrice * 10000; nIn++; } }
        else entryMissing.push({ id: t.id, symbol: t.symbol, stratCode: t.stratCode, openedAt: t.openedAt });
        const sym = norm(t.orderSymbol || t.symbol), tc = Date.parse(t.closedAt), q = +t.qty || 0;
        const s = sells.filter(x => x.sym === sym && Math.abs(x.t - tc) < 5 * 60 * 1000 && x.left >= q * 0.95).sort((a, b) => Math.abs(a.t - tc) - Math.abs(b.t - tc))[0];
        if (s) { exitOk++; s.left -= q; t.brokerExitPrice = s.price; if (t.exitPrice > 0) { slipOut += (t.exitPrice - s.price) / t.exitPrice * 10000; nOut++; } }
        else exitMissing.push({ id: t.id, symbol: t.symbol, stratCode: t.stratCode, closedAt: t.closedAt, closeReason: t.closeReason });
    });
    // P&L realizado FIFO según el broker, por símbolo, frente a la libreta
    const books = {}, fifo = {}, led = {};
    fills.forEach(f => { const sym = norm(f.symbol), q = parseFloat(f.qty), px = parseFloat(f.price); books[sym] = books[sym] || [];
        if (f.side === 'buy') books[sym].push({ q, px });
        else { let rem = q; while (rem > 1e-9 && books[sym].length) { const lot = books[sym][0], take = Math.min(lot.q, rem); fifo[sym] = (fifo[sym] || 0) + (px - lot.px) * take; lot.q -= take; rem -= take; if (lot.q <= 1e-9) books[sym].shift(); } } });
    ledger.forEach(t => { const sym = norm(t.orderSymbol || t.symbol); led[sym] = (led[sym] || 0) + (+t.pnl || 0); });
    const bySymbol = {}; new Set(Object.keys(fifo).concat(Object.keys(led))).forEach(k => { bySymbol[k] = { broker: r2(fifo[k] || 0), libreta: r2(led[k] || 0), gap: r2((fifo[k] || 0) - (led[k] || 0)) }; });
    return {
        ok: true, fills: fills.length, ledgerTrades: ledger.length, entryMatched: entryOk, exitMatched: exitOk,
        entryMissing: entryMissing.slice(0, 20), entryMissingCount: entryMissing.length,
        exitMissing: exitMissing.slice(0, 20), exitMissingCount: exitMissing.length,
        avgEntrySlipBp: nIn ? r2(slipIn / nIn) : null, avgExitSlipBp: nOut ? r2(slipOut / nOut) : null,
        realizedBySymbol: bySymbol,
        note: 'FIFO del broker mezcla posiciones antiguas y externas (p. ej. TSLA externa): comparar por tendencia, no al céntimo.'
    };
}

async function run(engineState, deps, sinceIso) {
    const sinceMs = Date.parse(sinceIso);
    const out = { checkedAt: new Date().toISOString(), since: sinceIso };
    try { out.pepperstone = await auditPepperstone(engineState, deps.getDealList, sinceMs); } catch (e) { out.pepperstone = { ok: false, error: e.message }; }
    try { out.alpaca = await auditAlpaca(engineState, deps.alpacaRequest, sinceMs); } catch (e) { out.alpaca = { ok: false, error: e.message }; }
    engineState.brokerAudit = out;
    return out;
}

module.exports = { run };
