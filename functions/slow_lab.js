// ==============================================================================
// 🐢 P13 • ESTRATEGIA LENTA vs COMPRAR Y MANTENER (Claude v2.5, 21-nov-2026)
// ------------------------------------------------------------------------------
// Fantasma diaria sobre SPY, QQQ y GLD (un tercio cada uno, liquidez al 0 %):
//   Entra cuando el cierre supera la media de 200 días + 2 %; sale cuando cae
//   por debajo de la media − 2 % (la banda evita entradas y salidas en falso).
// Se compara con comprar los tres y no tocar nada, desde el mismo día.
// Backtest previo (Yahoo, 1994-2026, SPY): 9,4 %/año y caída máx −20 %,
// frente a 10,5 %/año y −55 % de comprar y mantener. No gana más: protege.
// Una actualización al día, tras el cierre de Nueva York. Coste 5 pb por cambio.
// ==============================================================================
const https = require('https');

const SYMBOLS = ['SPY', 'QQQ', 'GLD'];
const COST = 0.0005;
const BAND = 0.02;

function fetchDaily(headers) {
    const start = new Date(Date.now() - 420 * 864e5).toISOString();
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${SYMBOLS.join(',')}&timeframe=1Day&limit=10000&adjustment=all&start=${encodeURIComponent(start)}&feed=iex`;
    return new Promise(resolve => {
        https.get(url, { headers }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

function bandState(closes) {
    // recorre toda la historia para que el estado con banda sea el mismo que en el backtest
    let st = 0; let sum = 0;
    for (let i = 0; i < closes.length; i++) {
        sum += closes[i]; if (i >= 200) sum -= closes[i - 200];
        if (i >= 199) {
            const sma = sum / 200;
            if (st === 0 && closes[i] > sma * (1 + BAND)) st = 1;
            else if (st === 1 && closes[i] < sma * (1 - BAND)) st = 0;
        }
    }
    return st;
}

function ensure(engineState) {
    if (!engineState.slowLab || typeof engineState.slowLab !== 'object') {
        engineState.slowLab = { startedAt: null, lastDay: null, eqP13: 1, eqBH: 1, peakP13: 1, peakBH: 1, ddP13: 0, ddBH: 0, pos: {}, lastClose: {}, trades: [] };
    }
    return engineState.slowLab;
}

// Llamar en cada ciclo: solo trabaja una vez por día de bolsa nuevo
async function update(engineState, headers, fetcher = fetchDaily) {
    const s = ensure(engineState);
    const nyNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date())
        .reduce((a, x) => (a[x.type] = x.value, a), {});
    const nyHour = +nyNow.hour % 24;
    if (nyHour < 17 && s.lastDay) return; // tras el cierre (17:00 NY) para usar la vela diaria ya cerrada
    const now = Date.now();
    if (s.lastFetchMs && now - s.lastFetchMs < 30 * 60 * 1000) return; // como mucho cada 30 min
    s.lastFetchMs = now;

    const j = await fetcher(headers);
    if (!j || !j.bars) return;
    const series = {};
    for (const sym of SYMBOLS) {
        const b = (j.bars[sym] || []).map(x => ({ d: String(x.t).slice(0, 10), c: x.c })).filter(x => x.c > 0);
        if (b.length < 210) return; // sin historia suficiente no se decide nada
        series[sym] = b;
    }
    // si la vela de hoy aún no está cerrada (antes de 17:00 NY), se ignora
    const todayNY = `${nyNow.year}-${nyNow.month}-${nyNow.day}`;
    const usable = sym => series[sym].filter(x => x.d < todayNY || nyHour >= 17);
    const lastDay = usable('SPY').slice(-1)[0].d;
    if (s.lastDay === lastDay) return;

    const sleeves = [];
    for (const sym of SYMBOLS) {
        const b = usable(sym); const closes = b.map(x => x.c); const c = closes[closes.length - 1];
        const want = bandState(closes);
        const had = s.pos[sym] ? s.pos[sym].inPos : null;
        let ret = 0, bhRet = 0;
        if (s.lastClose[sym] > 0) {
            bhRet = c / s.lastClose[sym] - 1;
            if (had === 1) ret = bhRet;
        }
        if (had !== null && want !== had) {
            ret -= COST;
            s.trades.unshift({ d: lastDay, sym, action: want ? 'ENTRA' : 'SALE', price: c });
            if (s.trades.length > 60) s.trades.length = 60;
        }
        s.pos[sym] = { inPos: want, since: (had === want && s.pos[sym]) ? s.pos[sym].since : lastDay, price: c };
        s.lastClose[sym] = c;
        sleeves.push({ ret, bhRet, first: had === null });
    }
    if (!s.startedAt) { s.startedAt = lastDay; } // el primer día solo fija la posición de partida
    else {
        const p = sleeves.reduce((a, x) => a + x.ret, 0) / sleeves.length;
        const bh = sleeves.reduce((a, x) => a + x.bhRet, 0) / sleeves.length;
        s.eqP13 *= 1 + p; s.eqBH *= 1 + bh;
        s.peakP13 = Math.max(s.peakP13, s.eqP13); s.peakBH = Math.max(s.peakBH, s.eqBH);
        s.ddP13 = Math.min(s.ddP13, s.eqP13 / s.peakP13 - 1); s.ddBH = Math.min(s.ddBH, s.eqBH / s.peakBH - 1);
    }
    s.lastDay = lastDay;
    s.summary = {
        startedAt: s.startedAt, lastDay,
        p13Pct: +((s.eqP13 - 1) * 100).toFixed(2), bhPct: +((s.eqBH - 1) * 100).toFixed(2),
        p13MaxDD: +(s.ddP13 * 100).toFixed(2), bhMaxDD: +(s.ddBH * 100).toFixed(2),
        positions: Object.fromEntries(SYMBOLS.map(sym => [sym, s.pos[sym] ? (s.pos[sym].inPos ? 'DENTRO' : 'FUERA') : '—']))
    };
}

module.exports = { update, bandState };
