/**
 * KRAKEN QUANT ENGINE // ESTRATEGIAS v2 (P9 - P12)
 * Escrito por Claude para Pedro (18-nov-2026). Solo compras (el motor no opera cortos).
 *
 * P9  🐙 26 Hermanas (KRAKEN V55 de Pedro) traducida de Pine v5, corregida:
 *       - sin mirar el futuro (el original leía el RSI de 15m de una vela aún abierta),
 *       - stop 1,5 ATR y objetivo 3 ATR (el original arriesgaba 10-30% para ganar 2-12%),
 *       - H25 (fuerza relativa vs S&P / BTC) neutra = 5, porque el motor no descarga el índice,
 *       - "trampa HTF" aproximada con RSI(50) del mismo marco.
 * P10 🐬 Delfín E: P1 de Pedro + solo 9:45-11:30 NY + sobre VWAP de sesión + sobre cierre de ayer. Cierra al final de la sesión.
 * P11 🚀 Gap & Go: hueco >= +0,5% y primera vela de 15 min verde. Stop en el mínimo de esa vela. Cierra al final de la sesión.
 * P12 🌊 Rebote VWAP mañana: 10:00-12:00 NY, toca el VWAP y cierra encima, día alcista y VWAP subiendo. Objetivo 2R. Cierra al final de la sesión.
 */

const STRATEGY_VERSION = 'v2-2026-11-18';
const SESSION_TICKERS = ['NVDA', 'TSLA', 'XAUUSD', 'GLD']; // P10-P12 necesitan la sesión de Wall Street

// ------------------------------------------------------------------ utilidades de serie
const sma = (a, n) => a.map((_, i) => { if (i < n - 1) return NaN; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; });
const ema = (a, n) => { const k = 2 / (n + 1); const o = []; let p = NaN; a.forEach((v, i) => { p = i === 0 ? v : (isNaN(p) ? v : v * k + p * (1 - k)); o.push(p); }); return o; };
const rma = (a, n) => { const o = []; let p = NaN; for (let i = 0; i < a.length; i++) { if (i < n - 1) { o.push(NaN); continue; } if (isNaN(p)) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; p = s / n; } else p = (p * (n - 1) + a[i]) / n; o.push(p); } return o; };
const stdev = (a, n) => a.map((_, i) => { if (i < n - 1) return NaN; let m = 0; for (let k = i - n + 1; k <= i; k++) m += a[k]; m /= n; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (a[k] - m) ** 2; return Math.sqrt(s / n); });
const highest = (a, n, i) => { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, a[k]); return m; };
const lowest = (a, n, i) => { let m = Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.min(m, a[k]); return m; };
const rising = (a, n, i) => { for (let k = 1; k <= n; k++) if (!(a[i] > a[i - k])) return false; return true; };
const falling = (a, n, i) => { for (let k = 1; k <= n; k++) if (!(a[i] < a[i - k])) return false; return true; };
function rsiSeries(c, n) { const g = [0], l = [0]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); } const ag = rma(g, n), al = rma(l, n); return ag.map((x, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i]))); }
function linregLast(a, n, i) { if (i < n - 1) return NaN; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { const y = a[i - n + 1 + k]; sx += k; sy += y; sxy += k * y; sxx += k * k; } const m = (n * sxy - sx * sy) / (n * sxx - sx * sx); const b = (sy - m * sx) / n; return b + m * (n - 1); }

const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function nyInfo(t) { const p = nyFmt.formatToParts(new Date(t)).reduce((a, x) => (a[x.type] = x.value, a), {}); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + (+p.minute) }; }
function hourIn(t, tz) { return +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' }).format(new Date(t)) % 24; }

// Datos de sesión de Wall Street para la vela idx: cierre de ayer, apertura de hoy, VWAP regular, primera vela de 15 min
function sessionContext(bars, idx) {
    const cur = nyInfo(bars[idx].t);
    let prevClose = null, prevDate = null, dayOpen = null, first = null;
    const vw = []; let cv = 0, cpv = 0;
    for (let i = 0; i <= idx; i++) {
        const b = bars[i]; const ni = nyInfo(b.t);
        if (ni.date < cur.date && ni.mins >= 570 && ni.mins < 960) { if (prevDate !== ni.date) prevDate = ni.date; prevClose = b.c; }
        if (ni.date === cur.date && ni.mins >= 570 && ni.mins < 960) {
            if (dayOpen === null) dayOpen = b.o;
            cv += (b.v || 1); cpv += (b.h + b.l + b.c) / 3 * (b.v || 1);
            if (ni.mins < 585) { if (!first) first = { o: b.o, h: b.h, l: b.l, c: b.c }; else { first.h = Math.max(first.h, b.h); first.l = Math.min(first.l, b.l); first.c = b.c; } }
        }
        vw.push(ni.date === cur.date && cv > 0 ? cpv / cv : NaN);
    }
    const barMin = idx > 0 ? Math.round((new Date(bars[idx].t) - new Date(bars[idx - 1].t)) / 60000) : 0;
    return { mins: cur.mins, prevClose, dayOpen, first, vw, barMin };
}

// ------------------------------------------------------------------ P9: 26 HERMANAS (lado comprador)
function hermanas(ticker, bars, idx) {
    const o = bars.map(b => b.o), h = bars.map(b => b.h), l = bars.map(b => b.l), c = bars.map(b => b.c), v = bars.map(b => b.v || 0);
    const i = idx; if (i < 160) return { action: 'HOLD', reason: 'Faltan velas para EMA 144 (mínimo 160)', score: 0 };
    const hlc3 = bars.map(b => (b.h + b.l + b.c) / 3);
    const tr = bars.map((b, k) => k === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - c[k - 1]), Math.abs(b.l - c[k - 1])));
    const atrS = rma(tr, 14); const atr = atrS[i];
    const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21), e55 = ema(c, 55), e144 = ema(c, 144);
    const halfway = (highest(h, 15, i) + lowest(l, 15, i)) / 2;
    const esCompra = c[i] > halfway;
    if (!esCompra) return { action: 'HOLD', reason: 'Precio bajo la mitad del rango de 15 velas (lado vendedor, no operado)', score: 0 };
    const rsi = rsiSeries(c, 14); const volMA = sma(v, 20);
    // DMI / ADX
    const pdm = [0], mdm = [0]; for (let k = 1; k < bars.length; k++) { const up = h[k] - h[k - 1], dn = l[k - 1] - l[k]; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); }
    const trR = rma(tr, 14), pR = rma(pdm, 14), mR = rma(mdm, 14);
    const dx = trR.map((t, k) => { const p = 100 * pR[k] / t, m = 100 * mR[k] / t; return (p + m) ? 100 * Math.abs(p - m) / (p + m) : 0; });
    const adx = rma(dx.map(x => isNaN(x) ? 0 : x), 14)[i];

    // H1
    let b1 = 0; if (e8[i] > e13[i]) b1 += 10; if (e13[i] > e55[i]) b1 += 5; if (e55[i] > e144[i]) b1 += 5;
    // H2 FVG
    let b2 = 0; const fvgBull = l[i] > h[i - 2];
    if (fvgBull) { b2 += 3; const body1 = Math.abs(c[i - 1] - o[i - 1]); b2 += body1 > atr * 1.5 ? 4 : (body1 > atr ? 2 : 1);
        const gp = l[i] - h[i - 2]; b2 += gp > atr * 0.5 ? 6 : gp > atr * 0.3 ? 4 : gp > atr * 0.15 ? 2 : 0;
        if (c[i] < l[i - 1]) b2 += 5; else if (h[i] > l[i - 1]) b2 += 2; }
    b2 = Math.min(b2, 20);
    // H3 RSI
    let b3 = 0; const r = rsi[i]; const rma7 = sma(rsi, 7)[i], rma14 = sma(rsi, 14)[i], rp = r - rsi[i - 3];
    if (r >= 52 && r <= 62) b3 += 8; else if (r >= 45 && r < 52) b3 += 6; else if (r > 62 && r < 70) b3 += 4; else if (r >= 70) b3 += 1;
    if (r > rsi[i - 1] && rsi[i - 1] > rsi[i - 2]) b3 += 3; if (r > rma7) b3 += 2; if (r > rma14) b3 += 1;
    if (rp > 1.5) b3 += 2; else if (rp > 0.5) b3 += 1; if (l[i] < l[i - 5] && r > rsi[i - 5] && r < 50) b3 += 5; b3 = Math.min(b3, 20);
    // H4 volumen
    let b4 = 0; const vm = volMA[i] || 1;
    if (v[i] > vm) { const q = v[i] / vm; b4 += q > 3 ? 8 : q > 2.5 ? 7 : q > 2 ? 6 : q > 1.8 ? 5 : q > 1.5 ? 4 : q > 1.3 ? 3 : q > 1.1 ? 2 : 1; }
    else { if (v[i] < vm * 0.7) b4 -= 2; else if (v[i] < vm * 0.9) b4 -= 1; }
    b4 += v[i] > v[i - 1] * 2 ? 4 : v[i] > v[i - 1] * 1.5 ? 3 : v[i] > v[i - 1] * 1.2 ? 2 : v[i] > v[i - 1] ? 1 : 0;
    if (c[i] > o[i] && v[i] > vm * 1.2) b4 += 5; else if (c[i] > o[i] && v[i] > vm) b4 += 3; else if (c[i] > o[i]) b4 += 1;
    if (rising(v, 3, i) && c[i] > c[i - 3]) b4 += 3; b4 = Math.min(Math.max(b4, 0), 20);
    // H5 Fibonacci
    const sH = highest(h, 20, i), sL = lowest(l, 20, i), rg = sH - sL, f38 = sL + rg * 0.382, f50 = sL + rg * 0.5, f61 = sL + rg * 0.618;
    let b5 = 0; if (c[i] >= f38 && c[i] <= f61) b5 += 8; const dOro = Math.abs(c[i] - f50); if (dOro < atr * 0.2) b5 += 6; else if (dOro < atr * 0.4) b5 += 3;
    if (c[i] > o[i] && c[i] > c[i - 1]) { if (l[i] <= f50 && c[i] > f50) b5 += 6; else if (c[i] < f61) b5 += 3; } b5 = Math.min(b5, 20);
    // H6 vela elefante
    const cuerpo = Math.abs(c[i] - o[i]), rango = h[i] - l[i], rcr = rango > 0 ? cuerpo / rango : 0, rca = atr > 0 ? cuerpo / atr : 0;
    let b6 = rca > 2.5 ? 10 : rca > 2 ? 8 : rca > 1.5 ? 6 : rca > 1.2 ? 4 : rca > 1 ? 2 : 0;
    b6 += rcr > 0.85 ? 5 : rcr > 0.7 ? 3 : rcr > 0.55 ? 1 : -2; b6 += v[i] > vm * 2 ? 3 : v[i] > vm * 1.5 ? 2 : v[i] > vm ? 1 : 0;
    if (c[i] > o[i] && cuerpo > atr * 1.2) b6 += 2; if (c[i] > h[i - 1] && o[i] < l[i - 1] && rca > 1.5) b6 += 2; b6 = Math.min(Math.max(b6, 0), 20);
    const velaElefante = b6 >= 12;
    // H7 VWAP (sesión del motor)
    const vwS = bars.map(b => b.vwap); const vwv = vwS[i]; let b7 = 0;
    if (isFinite(vwv)) { if (c[i] > vwv) { b7 += 4; if (Math.abs(c[i] - vwv) / atr < 0.5) b7 += 2; }
        if (l[i] <= vwv + atr * 0.15 && c[i] > vwv && c[i] > o[i]) { b7 += 6; if (v[i] > vm * 1.3) b7 += 2; }
        if (vwv - vwS[i - 5] > 0) b7 += 2; if (vwv > vwS[i - 10]) b7 += 2; if (vwv > e21[i]) b7 += 2; } b7 = Math.min(b7, 20);
    // H8 MFI
    const mf = hlc3.map((x, k) => x * v[k]); const mfi = hlc3.map((x, k) => { if (k < 14) return 50; let pos = 0, neg = 0; for (let j = k - 13; j <= k; j++) { if (hlc3[j] > hlc3[j - 1]) pos += mf[j]; else if (hlc3[j] < hlc3[j - 1]) neg += mf[j]; } return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg); });
    const mv = mfi[i]; let b8 = mv >= 55 && mv <= 75 ? 8 : mv >= 45 && mv < 55 ? 5 : mv > 75 && mv <= 85 ? 3 : mv > 85 ? 1 : 0;
    if (mv - mfi[i - 3] > 1) b8 += 3; if (mv > sma(mfi, 5)[i]) b8 += 2; if (l[i] < l[i - 5] && mv > mfi[i - 5] && mv < 50) b8 += 5; if (v[i] > vm && mv > 50) b8 += 2; b8 = Math.min(b8, 20);
    // H9 WaveTrend
    const esa = ema(hlc3, 10), de = ema(hlc3.map((x, k) => Math.abs(x - esa[k])), 10), ci = hlc3.map((x, k) => de[k] ? (x - esa[k]) / (0.015 * de[k]) : 0);
    const wt1 = ema(ci, 21), wt2 = sma(wt1, 4); let b9 = 0;
    if (wt1[i] > wt2[i]) { b9 += 4; if (wt1[i - 1] <= wt2[i - 1]) b9 += 4; }
    b9 += (wt1[i] < -40 && wt1[i] > -80) ? 6 : (wt1[i] >= -40 && wt1[i] < -20) ? 4 : wt1[i] <= -80 ? 2 : 0;
    if (wt1[i] > wt1[i - 2] && wt1[i - 2] > wt1[i - 4]) b9 += 2; if (wt1[i] > 0) b9 += 2; if (l[i] < l[i - 5] && wt1[i] > wt1[i - 5]) b9 += 2; b9 = Math.min(b9, 20);
    // H10 Bollinger
    const bbm = sma(c, 20), bsd = stdev(c, 20); const bbu = bbm.map((m, k) => m + 2 * bsd[k]), bbl = bbm.map((m, k) => m - 2 * bsd[k]);
    const ancho = bbm.map((m, k) => (bbu[k] - bbl[k]) / m), anchoMa = sma(ancho.map(x => isNaN(x) ? 0 : x), 50)[i];
    let b10 = ancho[i] > anchoMa * 1.3 ? 6 : ancho[i] > anchoMa * 1.1 ? 4 : ancho[i] > anchoMa ? 2 : 1;
    const posBB = (c[i] - bbl[i]) / (bbu[i] - bbl[i] + 0.0001); b10 += posBB < 0.15 ? 8 : posBB < 0.3 ? 6 : posBB < 0.5 ? 4 : posBB < 0.7 ? 2 : 0;
    if (bbm[i] > bbm[i - 3] && c[i] > bbm[i]) b10 += 4; else if (c[i] > bbm[i]) b10 += 2; if (l[i] <= bbl[i] * 1.01 && c[i] > bbl[i] && c[i] > o[i]) b10 += 2; b10 = Math.min(b10, 20);
    // H11 Order block (estado persistente recorriendo la serie)
    let obBull = 0, obBullValid = false, obBearValid = false;
    for (let k = 2; k <= i; k++) { if (c[k] > h[k - 1] && c[k - 1] < o[k - 1] && l[k - 1] < l[k - 2]) { obBull = l[k - 1]; obBullValid = true; } if (c[k] < l[k - 1] && c[k - 1] > o[k - 1] && h[k - 1] > h[k - 2]) obBearValid = true; }
    let bob = 0; if (obBullValid) { const d = Math.abs(c[i] - obBull); bob += d < atr ? 5 : d < atr * 2 ? 3 : d < atr * 3 ? 1 : 0; bob += c[i] > obBull ? 6 : (c[i] > obBull - atr * 0.5 ? 3 : 0); }
    if (obBullValid || obBearValid) bob += v[i - 1] > vm * 2 ? 4 : v[i - 1] > vm * 1.5 ? 2 : 1; bob = Math.min(bob, 15);
    // H12 ADX
    const b12 = adx >= 20 && adx < 25 ? 5 : (adx >= 25 && adx <= 40 ? 15 : (adx > 40 ? 10 : 0));
    // H13 OBV
    const obv = []; c.forEach((x, k) => obv.push(k === 0 ? 0 : obv[k - 1] + (x > c[k - 1] ? v[k] : x < c[k - 1] ? -v[k] : 0)));
    const obvE = ema(obv, 20); const obvUp = rising(obv, 3, i), obvOver = obv[i] > obvE[i];
    const b13 = Math.max(obvUp && obvOver ? 15 : obvOver ? 5 : (!obvOver && !obvUp ? -10 : 0), 0);
    // H14 Squeeze
    const kcm = sma(c, 20), trMa = sma(tr, 20); const sqzOn = (bbl[i] > kcm[i] - trMa[i] * 1.5) && (bbu[i] < kcm[i] + trMa[i] * 1.5);
    const sqzOff = (bbl[i] < kcm[i] - trMa[i] * 1.5) && (bbu[i] > kcm[i] + trMa[i] * 1.5);
    const srcSq = c.map((x, k) => x - ((highest(h, 20, k) + lowest(l, 20, k)) / 2 + bbm[k]) / 2);
    const val = linregLast(srcSq, 20, i), valP = linregLast(srcSq, 20, i - 1);
    let b14 = sqzOn ? 5 : (sqzOff && val > valP && val > 0) ? 20 : (sqzOff && val < valP && val < 0) ? 20 : ((val < valP && val > 0) || (val > valP && val < 0)) ? -5 : 0; b14 = Math.max(b14, 0);
    // H15 BOS
    let b15 = 0; const sh20p = highest(h, 20, i - 1);
    if (c[i] > sh20p) { const f = (c[i] - sh20p) / atr; b15 += f > 1 ? 8 : f > 0.5 ? 5 : 3; b15 += v[i] > vm * 1.5 ? 6 : v[i] > vm ? 3 : 0; if (c[i - 1] > sh20p) b15 += 4; } b15 = Math.min(b15, 20);
    // H16 CHoCH
    let b16 = 0; const h10p = highest(h, 10, i - 1); if (l[i] > h10p) { b16 += (l[i] - h10p) / atr > 0.5 ? 10 : 6; if (l[i] > l[i - 1] && c[i] > o[i]) b16 += 4; } b16 = Math.min(b16, 20);
    // H17 EQL
    let b17 = 0; const eqlLvl = lowest(l, 5, i - 1), tol = atr * 0.05;
    if (Math.abs(l[i] - eqlLvl) <= tol) { let n = 0; for (let k = 1; k <= 5; k++) if (Math.abs(l[i - k] - eqlLvl) <= tol) n++; b17 += n * 3; b17 += v[i] > vm * 1.3 ? 5 : v[i] > vm ? 2 : 0; if (c[i] > l[i] && l[i] <= eqlLvl + tol) b17 += 4; } b17 = Math.min(b17, 20);
    // H18 mínimo de ayer
    const curD = nyInfo(bars[i].t).date; let dLow = Infinity, prevD = null;
    for (let k = i; k >= 0; k--) { const d = nyInfo(bars[k].t).date; if (d < curD) { if (prevD === null) prevD = d; if (d !== prevD) break; dLow = Math.min(dLow, l[k]); } }
    let b18 = 0; if (isFinite(dLow)) { const dd = atr > 0 ? Math.abs(c[i] - dLow) / atr : 0; b18 += dd < 0.3 ? 12 : dd < 0.6 ? 8 : dd < 1 ? 4 : 0; if (l[i] <= dLow && c[i] > dLow) b18 += 6; } b18 = Math.min(b18, 20);
    // H19 explosión de volumen
    const rv = v[i] / vm; let h19 = rv > 3 ? 20 : rv > 2.5 ? 18 : rv > 2 ? 15 : rv > 1.5 ? 12 : rv > 1.2 ? 8 : rv > 0.9 ? 5 : rv > 0.7 ? 3 : rv > 0.5 ? 1 : 0;
    if (v[i] > v[i - 1] * 1.5) h19 = Math.min(h19 + 4, 20); else if (v[i] > v[i - 1] * 1.2) h19 = Math.min(h19 + 2, 20);
    // H20 rango / ATR
    const rr = atr > 0 ? rango / atr : 0; let h20 = rr > 2 ? 20 : rr > 1.5 ? 16 : rr > 1.2 ? 12 : rr > 0.9 ? 8 : rr > 0.6 ? 4 : rr > 0.4 ? 2 : 0; if (rr < 0.3) h20 = Math.max(h20 - 5, 0);
    // H21 barrida de mínimos
    const sombInf = Math.min(c[i], o[i]) - l[i]; const l20p = lowest(l, 20, i - 1); let h21 = 2;
    if (l[i] < l20p && sombInf > cuerpo * 1.5) { const ds = atr > 0 ? (l20p - l[i]) / atr : 0; h21 = ds > 1 ? 20 : ds > 0.6 ? 16 : ds > 0.3 ? 12 : 8; if (v[i] > vm * 1.5) h21 = Math.min(h21 + 4, 20); else if (v[i] > vm * 1.2) h21 = Math.min(h21 + 2, 20); h21 = Math.min(h21 + 3, 20); }
    // H22 horario
    const esCrypto = ticker.includes('SOL'), esForex = !esCrypto && (ticker.includes('XAU') || ticker.includes('USD'));
    const hr = hourIn(bars[i].t, esCrypto ? 'UTC' : esForex ? 'Europe/London' : 'America/New_York');
    const h22 = esCrypto ? (((hr >= 12 && hr <= 16) || hr <= 2) ? 20 : ((hr >= 8 && hr <= 11) || (hr >= 17 && hr <= 19)) ? 14 : 8)
        : esForex ? (((hr >= 8 && hr <= 11) || (hr >= 13 && hr <= 16)) ? 20 : ((hr >= 6 && hr <= 7) || hr === 12) ? 14 : 6)
        : (((hr >= 9 && hr <= 10) || (hr >= 14 && hr <= 15)) ? 20 : (hr >= 10 && hr <= 13) ? 14 : (hr >= 6 && hr <= 8) ? 10 : 4);
    // H23 presión
    let h23; const acum = c[i] > o[i] && v[i] > vm * 1.2 && c[i] > c[i - 1];
    if (acum) { const bp = v[i] * (c[i] - l[i]) / (rango + 0.001), sp = v[i] * (h[i] - c[i]) / (rango + 0.001), pr = bp / (sp + 0.001); h23 = pr > 1.5 ? 18 : pr > 1.2 ? 14 : pr > 1 ? 10 : 6; if (rising(c, 3, i)) h23 = Math.min(h23 + 4, 20); }
    else h23 = (atr > 0 && rango / atr < 0.5 && v[i] < vm * 0.8) ? 5 : 2;
    // H24 eficiencia
    let h24 = 0; if (rango > 0) { const ef = cuerpo / rango; h24 = ef > 0.7 ? (c[i] > o[i] ? 20 : 18) : ef > 0.5 ? 12 : ef > 0.3 ? 7 : 3; if ((h[i] - Math.max(c[i], o[i])) > cuerpo * 1.5) h24 = Math.max(h24 - 6, 0); }
    // H25 fuerza relativa: sin índice de referencia en el motor -> neutra
    const h25 = 5;
    // H26 delta
    const dRaw = bars.map((b, k) => (b.c - b.o) * (b.v || 0) / (b.h - b.l + 0.001)), dS = ema(dRaw, 5); let h26 = 2;
    if (c[i] < lowest(c, 10, i - 1) && dS[i] > dS[i - 1]) { const dc = Math.abs(dS[i] - dS[i - 5]), dp = Math.abs(sma(dRaw, 10)[i]); if (dp > 0) { const it = dc / dp; h26 = it > 2 ? 20 : it > 1.5 ? 16 : it > 1 ? 12 : it > 0.5 ? 8 : 4; } if ((o[i] - l[i]) > cuerpo * 1.5) h26 = Math.min(h26 + 5, 20); }
    if (dS[i] < dS[i - 3] * 0.5) h26 = Math.max(h26 - 4, 0);

    const N = (x, m) => (x / m) * 20;
    const g1 = (N(b1, 20) + N(b10, 20) + N(b12, 15) + N(h22, 20) + N(h25, 20)) / 100 * 100;
    const g2 = (N(b3, 20) + N(b9, 20) + N(b10, 20) + N(b14, 20)) / 80 * 100;
    const g3 = (N(b4, 20) + N(b8, 20) + (b13 > 0 ? N(b13, 15) : 0) + N(h19, 20)) / 80 * 100;
    const g4 = (N(b5, 20) + N(b6, 20) + N(b7, 20) + N(h20, 20) + N(h24, 20)) / 100 * 100;
    const g5 = (N(b2, 20) + N(bob, 15) + N(b15, 20) + N(b16, 20) + N(b17, 20) + N(b18, 20) + N(h21, 20)) / 140 * 100;
    const g6 = (N(h23, 20) + N(h26, 20)) / 40 * 100;
    const gs = [g1, g2, g3, g4, g5, g6]; const top3 = gs.slice().sort((a, b) => b - a).slice(0, 3);
    const score = Math.min(Math.max((top3[0] + top3[1] + top3[2]) / 3, 0), 100);
    const nivel = gs.filter(g => g >= 45).length;
    const pez = nivel >= 6 && score >= 90 ? '🐙 KRAKEN SUPREMO' : nivel >= 5 && score >= 80 ? '🐋 BALLENA AZUL' : nivel >= 4 && score >= 70 ? '🦈 TIBURÓN BLANCO'
        : nivel >= 4 && score >= 60 ? '🐬 DELFÍN' : nivel >= 3 && score >= 50 ? '🐟 ATÚN' : nivel >= 3 && score >= 40 ? '🐠 NEMO' : '🐡 PEZ GLOBO';
    // Trampa HTF aproximada con RSI(50) del mismo marco (ya cerrado, sin mirar el futuro)
    const rsi50 = rsiSeries(c, 50)[i]; const trampaOk = !(rsi50 > 70) || score > 70;
    const minScore = ticker === 'XAUUSD' || ticker === 'GLD' ? 70 : (ticker.includes('SOL') ? 52 : 60);
    const buy = trampaOk && (score >= minScore || velaElefante) && adx > 20;
    return {
        action: buy ? 'BUY' : 'HOLD', score: Math.round(score), pez, nivel,
        reason: buy ? `🐙 26 Hermanas: score ${score.toFixed(0)} (mín ${minScore}), nivel ${nivel}/6, ADX ${adx.toFixed(0)}${velaElefante ? ', vela elefante' : ''}`
            : `Score ${score.toFixed(0)} / mín ${minScore}, nivel ${nivel}/6, ADX ${adx.toFixed(0)}${trampaOk ? '' : ', trampa HTF (RSI50 > 70)'}`,
        groups: gs.map(g => Math.round(g))
    };
}

// ------------------------------------------------------------------ evaluación P9-P12 para una vela
function evaluateV2(ticker, bars, idx) {
    const out = [];
    const cur = bars[idx]; const prev = bars[idx - 1] || cur;
    const price = cur.c; const atr = Math.max(0.01, cur.atr || price * 0.01);
    const base = (code, name, pez) => ({ stratCode: code, strategyName: name, pez, isPromoted: true, atr, strategyVersion: STRATEGY_VERSION });

    // P9
    let p9;
    try { p9 = hermanas(ticker, bars, idx); } catch (e) { p9 = { action: 'HOLD', score: 0, reason: 'Error P9: ' + e.message }; }
    out.push({ ...base('p9', 'Pista 9: 🐙 26 Hermanas (V55 de Pedro)', p9.pez || '🐙 HERMANAS'), score: p9.score, action: p9.action,
        blockedReason: p9.action === 'HOLD' ? p9.reason : null, signalReason: p9.reason,
        sl: +(price - atr * 1.5).toFixed(4), tp: +(price + atr * 3).toFixed(4), breakevenTrigger: +(price + atr * 1.5).toFixed(4),
        indicators: { atr: cur.atr, rvol: cur.rvol, groups: p9.groups || null, nivel: p9.nivel || null } });

    const isSessionAsset = SESSION_TICKERS.includes(ticker);
    const ctx = isSessionAsset ? sessionContext(bars, idx) : null;
    const hold = (code, name, pez, why) => out.push({ ...base(code, name, pez), score: 20, action: 'HOLD', blockedReason: why, signalReason: why,
        sl: +(price - atr * 1.5).toFixed(4), tp: +(price + atr * 3).toFixed(4), indicators: { atr: cur.atr, rvol: cur.rvol } });

    // P10 Delfín E
    const n10 = 'Pista 10: 🐬 Delfín E (P1 mejorada)';
    if (!ctx) hold('p10', n10, '🐬 DELFÍN E', 'Solo acciones/oro en sesión de Wall Street');
    else {
        const spr = cur.ema9 - cur.ema21, ps = prev.ema9 - prev.ema21, vw = ctx.vw[idx];
        const okWin = ctx.mins >= 585 && ctx.mins <= 690;
        const sig = spr > 0 && (ps <= 0 || (spr > ps && cur.emaSlope > 0 && cur.rsi >= 50));
        const okDay = ctx.prevClose && isFinite(vw) && price > vw && price > ctx.prevClose;
        const buy = okWin && sig && okDay;
        out.push({ ...base('p10', n10, '🐬 DELFÍN E'), score: buy ? 80 : 30, action: buy ? 'BUY' : 'HOLD',
            blockedReason: buy ? null : (!okWin ? 'Fuera de 9:45-11:30 NY' : !sig ? 'Sin cruce/impulso EMA 9/21' : 'No está sobre VWAP y sobre el cierre de ayer'),
            signalReason: buy ? `Cruce/impulso EMA 9/21 en la mañana, sobre VWAP (${vw.toFixed(2)}) y sobre cierre de ayer (${ctx.prevClose.toFixed(2)})` : '',
            sl: +(price - atr * 1.5).toFixed(4), tp: +(price + atr * 3).toFixed(4), breakevenTrigger: +(price + atr * 1.5).toFixed(4),
            closeAtSessionEnd: true, indicators: { atr: cur.atr, vwapSesion: vw, prevClose: ctx.prevClose, rvol: cur.rvol } });
    }

    // P11 Gap & Go
    const n11 = 'Pista 11: 🚀 Gap & Go (apertura)';
    if (!ctx) hold('p11', n11, '🚀 GAP', 'Solo acciones/oro en sesión de Wall Street');
    else {
        const intraday = ctx.barMin > 0 && ctx.barMin <= 15;
        const okWin = intraday && ctx.mins >= 585 && ctx.mins < 600 && ctx.first;
        const gap = ctx.prevClose && ctx.dayOpen ? (ctx.dayOpen - ctx.prevClose) / ctx.prevClose : 0;
        const buy = !!(okWin && gap >= 0.005 && ctx.first.c > ctx.first.o && price > ctx.first.l);
        const sl = ctx.first ? ctx.first.l : price - atr * 1.5;
        out.push({ ...base('p11', n11, '🚀 GAP'), score: buy ? 85 : 25, action: buy ? 'BUY' : 'HOLD',
            blockedReason: buy ? null : (!intraday ? 'Solo en 5m y 15m' : !okWin ? 'Solo en la vela de 9:45 NY' : `Hueco ${(gap * 100).toFixed(2)}% o primera vela no verde`),
            signalReason: buy ? `Hueco +${(gap * 100).toFixed(2)}% confirmado por la primera vela de 15 min` : '',
            sl: +sl.toFixed(4), tp: +(price + 3 * Math.max(price - sl, atr * 0.5)).toFixed(4), breakevenTrigger: +(price + Math.max(price - sl, atr * 0.5)).toFixed(4),
            closeAtSessionEnd: true, indicators: { atr: cur.atr, gapPct: gap * 100, firstLow: ctx.first ? ctx.first.l : null } });
    }

    // P12 Rebote VWAP mañana
    const n12 = 'Pista 12: 🌊 Rebote VWAP mañana';
    if (!ctx) hold('p12', n12, '🌊 VWAP', 'Solo acciones/oro en sesión de Wall Street');
    else {
        const vw = ctx.vw[idx], vw6 = ctx.vw[idx - 6];
        const okWin = ctx.mins >= 600 && ctx.mins <= 720;
        const buy = !!(okWin && isFinite(vw) && isFinite(vw6) && cur.l <= vw && price > vw && ctx.dayOpen && price > ctx.dayOpen && vw > vw6);
        const sl = isFinite(vw) ? Math.min(cur.l, vw) * (1 - 0.0005) : price - atr * 1.5;
        out.push({ ...base('p12', n12, '🌊 VWAP'), score: buy ? 80 : 30, action: buy ? 'BUY' : 'HOLD',
            blockedReason: buy ? null : (!okWin ? 'Fuera de 10:00-12:00 NY' : 'Sin rebote limpio sobre VWAP en día alcista'),
            signalReason: buy ? `Rebote sobre VWAP (${vw.toFixed(2)}) en día alcista, VWAP subiendo` : '',
            sl: +sl.toFixed(4), tp: +(price + 2 * Math.max(price - sl, atr * 0.3)).toFixed(4), breakevenTrigger: +(price + Math.max(price - sl, atr * 0.3)).toFixed(4),
            closeAtSessionEnd: true, indicators: { atr: cur.atr, vwapSesion: vw } });
    }
    return out;
}

module.exports = { evaluateV2, hermanas, STRATEGY_VERSION };
