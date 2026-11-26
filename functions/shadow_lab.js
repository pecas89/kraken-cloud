// ==============================================================================
// 👻 LABORATORIO FANTASMA (Claude v2.4, 19-nov-2026)
// ------------------------------------------------------------------------------
// Cada señal BUY de las 12 estrategias, en los 4 marcos y los 4 activos, abre una
// operación VIRTUAL con su SL/TP. No depende de cupos, esperas entre entradas
// ni del límite de 1 apertura por activo: todas compiten en igualdad.
// Una sola fantasma abierta a la vez por (estrategia, marco, activo), igual que
// un sistema real, para no inflar la estadística con operaciones solapadas.
// Cada fantasma se mide con las DOS salidas a la vez:
//   STD  = SL / TP fijos (como Pepperstone)
//   STEP = escalera de Pedro: TP en 4 escalones, el stop sube cada escalón (como Alpaca)
// Resultado en R (múltiplos del riesgo inicial), con coste de 5 pb por lado.
// Las operaciones reales en los brokers siguen siendo el control de ejecución.
// ==============================================================================

const COST_BPS_PER_SIDE = 5;           // 0,05 % por lado (mismo supuesto que el backtest)
const MAX_RECENT = 300;                // fantasmas cerradas guardadas con su "signal stack"
const MAX_HOLD_MS = { '5m': 2 * 864e5, '15m': 3 * 864e5, '1H': 7 * 864e5, '4H': 20 * 864e5 };

function ensure(engineState) {
    if (!engineState.shadowLab || typeof engineState.shadowLab !== 'object') {
        engineState.shadowLab = { startedAt: new Date().toISOString(), open: [], agg: {}, recent: [], version: 'v2.4' };
    }
    const s = engineState.shadowLab;
    if (!Array.isArray(s.open)) s.open = [];
    if (!s.agg || typeof s.agg !== 'object') s.agg = {};
    if (!s.aggF4 || typeof s.aggF4 !== 'object') s.aggF4 = {};   // [CLAUDE v2.7] variante "a favor de la tendencia x4"
    if (!s.aggShort || typeof s.aggShort !== 'object') s.aggShort = {}; // [CLAUDE v3.0] ventas en corto en espejo
    if (!Array.isArray(s.recentShort)) s.recentShort = [];
    if (!Array.isArray(s.recent)) s.recent = [];
    return s;
}

function nyParts(d = new Date()) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' })
        .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return { mins: (+p.hour % 24) * 60 + (+p.minute), weekday: p.weekday };
}

// "Signal stack": la foto de los indicadores en el momento de la señal
function features(analysis, bars, price) {
    const b = (bars && bars.length) ? bars[bars.length - 1] : {};
    const atr = b.atr || (analysis.indicators && analysis.indicators.atr) || 0;
    const c = b.c || price || 0;
    const r2 = v => (isFinite(v) ? Math.round(v * 100) / 100 : null);
    const ny = nyParts();
    return {
        score: r2(analysis.score),
        rsi: r2(b.rsi),
        rvol: r2(b.rvol),
        atrPct: (atr && c) ? r2(atr / c * 100) : null,
        trendAtr: (atr && isFinite(b.ema9) && isFinite(b.ema21)) ? r2((b.ema9 - b.ema21) / atr) : null,   // EMA9-EMA21 en ATR
        vwapAtr: (atr && isFinite(b.vwap) && b.vwap > 0) ? r2((c - b.vwap) / atr) : null,               // distancia al VWAP en ATR
        aboveEma200: (isFinite(b.ema200) && b.ema200 > 0) ? (c > b.ema200) : null,
        supertrend: isFinite(b.supertrend) ? b.supertrend : null,
        nyMins: ny.mins,
        weekday: ny.weekday
    };
}

// [CLAUDE v2.7] Tendencia del marco 4 veces mayor (5m→20m, 15m→1H, 1H→4H, 4H→16H).
// Se construye agrupando las velas del propio marco en bloques de reloj de 4 velas (solo velas ya cerradas
// del bloque anterior, para no mirar el futuro) y se mira si la EMA20 de esos cierres sube (vs hace 3 bloques).
// Solo MIDE: no bloquea ninguna entrada, ni real ni fantasma.
const TF_MS = { '5m': 3e5, '15m': 9e5, '1H': 36e5, '4H': 144e5 };
function htfTrend(bars, tf) {
    const ms = TF_MS[tf];
    if (!ms || !Array.isArray(bars) || bars.length < 40) return null;
    const blk = ms * 4, buckets = [];
    for (const b of bars) {
        const t = typeof b.t === 'number' ? b.t : Date.parse(b.t);
        if (!isFinite(t) || !isFinite(b.c)) continue;
        const k = Math.floor(t / blk);
        if (buckets.length && buckets[buckets.length - 1].k === k) buckets[buckets.length - 1].c = b.c;
        else buckets.push({ k, c: b.c });
    }
    buckets.pop();                                  // el bloque en curso todavía no ha cerrado
    if (buckets.length < 24) return null;
    const a = 2 / 21; let e = buckets[0].c; const ema = buckets.map(x => (e = x.c * a + e * (1 - a)));
    const n = ema.length - 1;
    return { tf: tf + 'x4', up: ema[n] > ema[n - 3], above: buckets[n].c > ema[n] };
}

function key(code, tf, ticker) { return `${code}_${tf}_${ticker}`; }

// Llamar por cada análisis BUY que ya pasó los filtros de diseño de la estrategia
// [CLAUDE v3.0] opts.mirror = C: la señal viene de las velas en espejo (precio' = C - precio). Una COMPRA en el espejo
// es una VENTA EN CORTO en el precio real. La fantasma vive en el espacio espejo, así SL/TP/escalera/R no cambian.
function onSignal(engineState, ticker, tf, analysis, price, bars, barTime, inEntryWindow, opts = {}) {
    if (!analysis || analysis.action !== 'BUY' || !(price > 0) || !inEntryWindow) return null;
    const s = ensure(engineState);
    const baseCode = String(analysis.stratCode || 'otros').toLowerCase();
    const mirror = (opts && opts.mirror > 0) ? opts.mirror : null;
    const code = mirror ? baseCode + 's' : baseCode;   // p9 -> p9s (corto) solo para la casilla viva
    const k = key(code, tf, ticker);
    if (s.open.some(o => o.k === k)) return null;                 // ya hay una fantasma viva en esa casilla
    if (barTime && s.lastBar && s.lastBar[k] === barTime) return null; // una por vela
    const atr = Math.max(price * 0.0005, (analysis.indicators && analysis.indicators.atr) || (bars && bars.length ? bars[bars.length - 1].atr : 0) || price * 0.01);
    const bp = isFinite(analysis.barPrice) ? analysis.barPrice : price;
    // Mismas distancias que executeAutonomousOpen: riesgo y premio de la estrategia, anclados al precio vivo
    const risk = Math.max(atr * 0.5, (isFinite(analysis.sl) && bp > analysis.sl) ? (bp - analysis.sl) : atr * 1.5);
    const reward = Math.max(atr * 1.0, (isFinite(analysis.tp) && analysis.tp > bp) ? (analysis.tp - bp) : atr * 3.0);
    const o = {
        k, code, baseCode, tf, ticker, side: mirror ? 'SELL' : 'BUY', mirror,
        entry: price, risk, sl: price - risk, tp: price + reward,
        rr: Math.round(reward / risk * 100) / 100,
        costR: ((mirror ? (mirror - price) : price) * COST_BPS_PER_SIDE * 2 / 10000) / risk, // coste sobre el precio real
        openedAt: new Date().toISOString(),
        closeAtSessionEnd: !!analysis.closeAtSessionEnd,
        std: null, step: null, stepK: 0,
        mfeR: 0, maeR: 0,
        f: features(analysis, bars, price),
        htf: htfTrend(bars, tf)
    };
    s.open.push(o);
    if (!s.lastBar) s.lastBar = {};
    if (barTime) s.lastBar[k] = barTime;
    return o;
}

function addAgg(s, aggKey, exit, R, win, bucket) {
    const store = bucket || s.agg;
    if (!store[aggKey]) store[aggKey] = { STD: { n: 0, sumR: 0, sumR2: 0, wins: 0 }, STEP: { n: 0, sumR: 0, sumR2: 0, wins: 0 } };
    const a = store[aggKey][exit];
    a.n += 1; a.sumR += R; a.sumR2 += R * R; if (win) a.wins += 1;
}

function finish(s, o) {
    const R = { STD: o.std.R - o.costR, STEP: o.step.R - o.costR };
    if (o.mirror) {                                   // [CLAUDE v3.0] cortos: estadística aparte, no mezcla con las compras
        ['STD', 'STEP'].forEach(x => { const r = R[x]; addAgg(s, key(o.baseCode, o.tf, o.ticker), x, r, r > 0, s.aggShort); addAgg(s, o.baseCode, x, r, r > 0, s.aggShort); });
        s.recentShort.unshift({ code: o.baseCode, side: 'SELL', tf: o.tf, ticker: o.ticker, entry: Math.round((o.mirror - o.entry) * 10000) / 10000, rr: o.rr,
            openedAt: o.openedAt, closedAt: new Date().toISOString(), rStd: Math.round(R.STD * 1000) / 1000, rStep: Math.round(R.STEP * 1000) / 1000,
            whyStd: o.std.why, whyStep: o.step.why, mfeR: Math.round(o.mfeR * 100) / 100, maeR: Math.round(o.maeR * 100) / 100 });
        if (s.recentShort.length > 200) s.recentShort.length = 200;
        return;
    }
    ['STD', 'STEP'].forEach(x => {
        const r = R[x];
        addAgg(s, key(o.code, o.tf, o.ticker), x, r, r > 0);
        addAgg(s, o.code, x, r, r > 0);          // total por estrategia
        if (o.htf && o.htf.up === true) {        // [CLAUDE v2.7] misma operación, contada también en la variante filtrada
            addAgg(s, key(o.code, o.tf, o.ticker), x, r, r > 0, s.aggF4);
            addAgg(s, o.code, x, r, r > 0, s.aggF4);
        }
    });
    s.recent.unshift({
        code: o.code, tf: o.tf, ticker: o.ticker, entry: o.entry, rr: o.rr,
        openedAt: o.openedAt, closedAt: new Date().toISOString(),
        rStd: Math.round(R.STD * 1000) / 1000, rStep: Math.round(R.STEP * 1000) / 1000,
        whyStd: o.std.why, whyStep: o.step.why,
        mfeR: Math.round(o.mfeR * 100) / 100, maeR: Math.round(o.maeR * 100) / 100,
        f: o.f,
        htfUp: o.htf ? o.htf.up : null
    });
    if (s.recent.length > MAX_RECENT) s.recent.length = MAX_RECENT;
}

// Llamar cada ciclo. getPrice(ticker) -> precio vivo; isSessionOpen(ticker) -> bool
function manage(engineState, getPrice, isSessionOpen) {
    const s = ensure(engineState);
    const now = Date.now();
    const ny = nyParts().mins;
    const still = [];
    for (const o of s.open) {
        const raw = getPrice(o.ticker);
        const q = (o.mirror && raw > 0) ? o.mirror - raw : raw;   // [CLAUDE v3.0] cortos: precio en espejo
        const sessionOk = isSessionOpen(o.ticker);
        if (!(q > 0) || !sessionOk) { still.push(o); continue; }   // fuera de sesión el precio está congelado
        const rNow = (q - o.entry) / o.risk;
        o.mfeR = Math.max(o.mfeR, rNow);
        o.maeR = Math.min(o.maeR, rNow);
        const forced = (o.closeAtSessionEnd && !o.ticker.includes('SOL') && ny >= 955) ? 'EOD 15:55'
            : ((now - new Date(o.openedAt).getTime()) > (MAX_HOLD_MS[o.tf] || 7 * 864e5) ? 'Tiempo máximo' : null);

        // STD: SL / TP fijos
        if (!o.std) {
            if (q <= o.sl) o.std = { R: rNow, why: 'SL' };                       // salida al precio real (incluye huecos)
            else if (q >= o.tp) o.std = { R: (o.tp - o.entry) / o.risk, why: 'TP' };
            else if (forced) o.std = { R: rNow, why: forced };
        }
        // STEP: escalera de Pedro
        if (!o.step) {
            const stepD = (o.tp - o.entry) / 4;
            while (o.stepK < 4 && q >= o.entry + stepD * (o.stepK + 1)) o.stepK++;
            const stop = o.stepK >= 1 ? o.entry + stepD * (o.stepK - 1) : o.sl;
            if (o.stepK >= 4) o.step = { R: (o.tp - o.entry) / o.risk, why: 'Escalón 4' };
            else if (q <= stop) o.step = { R: rNow, why: o.stepK >= 1 ? `Stop escalón ${o.stepK}` : 'SL' }; // al precio real, igual que STD
            else if (forced) o.step = { R: rNow, why: forced };
        }
        if (o.std && o.step) finish(s, o); else still.push(o);
    }
    s.open = still;
    s.updatedAt = new Date().toISOString();
}

// Estadística: media, t-stat y semáforo "¿ya es verdad?"
function statsOf(a) {
    if (!a || !a.n) return { n: 0, avgR: null, t: null, wr: null, light: 'gris', label: 'sin datos' };
    const n = a.n, mean = a.sumR / n;
    const varr = n > 1 ? Math.max(0, (a.sumR2 - n * mean * mean) / (n - 1)) : 0;
    const sd = Math.sqrt(varr);
    const t = (n > 1 && sd > 0) ? mean / (sd / Math.sqrt(n)) : null;
    let light = 'rojo', label = 'todavía es azar (< 30)';
    // [FIX ANTIGRAVITY v2.4.1] Con n >= 30, solo etiquetar "prometedor" si la media es positiva
    if (n >= 30) { light = 'amarillo'; label = mean > 0 ? 'prometedor, no probado' : 'negativo, sin confirmar'; }
    if (n >= 30 && t !== null && t <= -2) { light = 'negro'; label = 'pierde de verdad'; }
    if (n >= 100 && t !== null && t >= 2) { light = 'verde'; label = 'VENTAJA REAL'; }
    if (n >= 30 && n < 100 && t !== null && t >= 2) { light = 'amarillo'; label = 'buena pinta, faltan datos (< 100)'; }
    return { n, avgR: Math.round(mean * 1000) / 1000, sumR: Math.round(a.sumR * 100) / 100, t: t === null ? null : Math.round(t * 100) / 100, wr: Math.round(a.wins / n * 1000) / 10, light, label };
}

// Resumen compacto para el panel (se recalcula cada ciclo)
function summarize(engineState) {
    const s = ensure(engineState);
    const out = { startedAt: s.startedAt, updatedAt: s.updatedAt || null, openCount: s.open.length, closedCount: s.recent.length, byStrategy: {}, byCell: {} };
    Object.entries(s.agg).forEach(([k, v]) => {
        const target = k.includes('_') ? out.byCell : out.byStrategy;
        target[k] = { STD: statsOf(v.STD), STEP: statsOf(v.STEP) };
    });
    // [CLAUDE v2.7] variante "solo a favor de la tendencia x4": mismas operaciones, subconjunto filtrado
    out.f4 = { rule: 'EMA20 del marco x4 subiendo (5m→20m, 15m→1H, 1H→4H, 4H→16H)', byStrategy: {}, byCell: {} };
    Object.entries(s.aggF4 || {}).forEach(([k, v]) => {
        const target = k.includes('_') ? out.f4.byCell : out.f4.byStrategy;
        target[k] = { STD: statsOf(v.STD), STEP: statsOf(v.STEP) };
    });
    // [CLAUDE v3.0] ventas en corto en espejo (mismas estrategias sobre el gráfico invertido)
    out.short = { rule: 'Cada estrategia aplicada al gráfico en espejo: su COMPRA ahí = VENTA EN CORTO real', byStrategy: {}, byCell: {} };
    Object.entries(s.aggShort || {}).forEach(([k, v]) => {
        const target = k.includes('_') ? out.short.byCell : out.short.byStrategy;
        target[k] = { STD: statsOf(v.STD), STEP: statsOf(v.STEP) };
    });
    s.summary = out;
    return out;
}

// [CLAUDE v3.0] Velas en espejo: precio' = C - precio (C = 2 x máximo de la serie, siempre positivo).
// Las subidas pasan a ser bajadas, los máximos mínimos; el volumen y la hora no cambian.
function mirrorBars(rawBars) {
    if (!Array.isArray(rawBars) || !rawBars.length) return { C: null, bars: [] };
    const C = 2 * Math.max(...rawBars.map(b => b.h || b.c || 0));
    return { C, bars: rawBars.map(b => ({ ...b, o: C - b.o, h: C - b.l, l: C - b.h, c: C - b.c })) };
}

module.exports = { onSignal, manage, summarize, features, statsOf, htfTrend, mirrorBars };
