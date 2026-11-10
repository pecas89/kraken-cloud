/**
 * KRAKEN QUANT ENGINE // TECHNICAL INDICATORS MODULE
 * Castillo Imperial Holding S.A.
 * 
 * Biblioteca de indicadores cuantitativos sobre velas OHLCV de 5m.
 * Libre de números aleatorios o seeds. Matemática pura institucional.
 */

/**
 * Calcula EMA (Exponential Moving Average)
 * @param {Array<number>} values 
 * @param {number} period 
 * @returns {Array<number>}
 */
function calculateEMA(values, period) {
    if (!values || values.length === 0) return [];
    const k = 2 / (period + 1);
    const ema = new Array(values.length);
    
    // Inicializar primera EMA con la media simple de los primeros 'period' elementos
    let sum = 0;
    const initLen = Math.min(period, values.length);
    for (let i = 0; i < initLen; i++) sum += values[i];
    let prev = sum / initLen;
    ema[initLen - 1] = prev;

    for (let i = 0; i < initLen - 1; i++) {
        ema[i] = values[i]; // Relleno previo
    }

    for (let i = initLen; i < values.length; i++) {
        prev = (values[i] * k) + (prev * (1 - k));
        ema[i] = prev;
    }
    return ema;
}

/**
 * Calcula SMA (Simple Moving Average)
 * @param {Array<number>} values 
 * @param {number} period 
 * @returns {Array<number>}
 */
function calculateSMA(values, period) {
    if (!values || values.length === 0) return [];
    const sma = new Array(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period) {
            sum -= values[i - period];
            sma[i] = sum / period;
        } else if (i === period - 1) {
            sma[i] = sum / period;
        } else {
            sma[i] = sum / (i + 1);
        }
    }
    return sma;
}

/**
 * Calcula ATR (Average True Range)
 * @param {Array<{h: number, l: number, c: number}>} bars 
 * @param {number} period 
 * @returns {Array<number>}
 */
function calculateATR(bars, period = 14) {
    if (!bars || bars.length === 0) return [];
    const tr = new Array(bars.length);
    tr[0] = bars[0].h - bars[0].l;

    for (let i = 1; i < bars.length; i++) {
        const h = bars[i].h;
        const l = bars[i].l;
        const prevC = bars[i - 1].c;
        const hl = h - l;
        const hpc = Math.abs(h - prevC);
        const lpc = Math.abs(l - prevC);
        tr[i] = Math.max(hl, hpc, lpc);
    }

    // Suavizado Wilder (RMA)
    const atr = new Array(bars.length);
    let sum = 0;
    const initLen = Math.min(period, bars.length);
    for (let i = 0; i < initLen; i++) sum += tr[i];
    let prev = sum / initLen;
    atr[initLen - 1] = prev;

    for (let i = 0; i < initLen - 1; i++) atr[i] = tr[i];

    for (let i = initLen; i < bars.length; i++) {
        prev = ((prev * (period - 1)) + tr[i]) / period;
        atr[i] = prev;
    }
    return atr;
}

/**
 * Calcula VWAP de Sesión Intradía (reinicia cada medianoche UTC o cambio de sesión)
 * @param {Array<{h: number, l: number, c: number, v: number, t: string}>} bars 
 * @returns {Array<number>}
 */
function calculateSessionVWAP(bars) {
    if (!bars || bars.length === 0) return [];
    const vwap = new Array(bars.length);
    let cumVol = 0;
    let cumTPV = 0;
    let currentDay = '';

    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const day = (b.t || '').slice(0, 10);
        if (day !== currentDay) {
            cumVol = 0;
            cumTPV = 0;
            currentDay = day;
        }

        const tp = (b.h + b.l + b.c) / 3;
        const vol = b.v || 1;
        cumTPV += tp * vol;
        cumVol += vol;

        vwap[i] = cumVol > 0 ? (cumTPV / cumVol) : b.c;
    }
    return vwap;
}

/**
 * Calcula RSI (Relative Strength Index)
 * @param {Array<number>} closes 
 * @param {number} period 
 * @returns {Array<number>}
 */
function calculateRSI(closes, period = 14) {
    if (!closes || closes.length === 0) return [];
    const rsi = new Array(closes.length).fill(50);
    if (closes.length <= period) return rsi;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? Math.abs(diff) : 0;

        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;

        if (avgLoss === 0) {
            rsi[i] = 100;
        } else {
            const rs = avgGain / avgLoss;
            rsi[i] = 100 - (100 / (1 + rs));
        }
    }
    return rsi;
}

/**
 * Calcula SuperTrend
 * @param {Array<{h: number, l: number, c: number}>} bars 
 * @param {Array<number>} atr 
 * @param {number} multiplier 
 * @returns {Array<{trend: 1 | -1, band: number}>} (1 = Bullish, -1 = Bearish)
 */
function calculateSuperTrend(bars, atr, multiplier = 3) {
    const len = bars.length;
    const result = new Array(len);
    if (len === 0) return result;

    let upperBand = 0;
    let lowerBand = 0;
    let trend = 1;

    for (let i = 0; i < len; i++) {
        const b = bars[i];
        const a = atr[i] || (b.h - b.l);
        const hl2 = (b.h + b.l) / 2;

        let curUpper = hl2 + (multiplier * a);
        let curLower = hl2 - (multiplier * a);

        if (i > 0) {
            const prevClose = bars[i - 1].c;
            if (curLower < lowerBand && prevClose > lowerBand) {
                curLower = lowerBand;
            }
            if (curUpper > upperBand && prevClose < upperBand) {
                curUpper = upperBand;
            }
        }

        if (i === 0) {
            trend = b.c > curUpper ? 1 : -1;
        } else {
            if (trend === 1 && b.c < lowerBand) {
                trend = -1;
            } else if (trend === -1 && b.c > upperBand) {
                trend = 1;
            }
        }

        upperBand = curUpper;
        lowerBand = curLower;

        result[i] = {
            trend,
            band: trend === 1 ? lowerBand : upperBand
        };
    }
    return result;
}

/**
 * Enriquece la lista de velas con todos los indicadores institucionales
 * @param {Array<{h: number, l: number, c: number, o: number, v: number, t: string}>} bars 
 * @returns {Array<object>}
 */
function enrichBarsWithIndicators(bars) {
    if (!bars || bars.length === 0) return [];

    const closes = bars.map(b => b.c);
    const volumes = bars.map(b => b.v || 0);

    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const atr14 = calculateATR(bars, 14);
    const vwap = calculateSessionVWAP(bars);
    const rsi14 = calculateRSI(closes, 14);
    const volSma20 = calculateSMA(volumes, 20);
    const supertrend = calculateSuperTrend(bars, atr14, 3);

    return bars.map((b, i) => {
        const prevBar = i > 0 ? bars[i - 1] : null;
        const prevEma9 = i > 0 ? ema9[i - 1] : ema9[i];
        const prevEma21 = i > 0 ? ema21[i - 1] : ema21[i];
        const curEma9 = ema9[i];
        const curEma21 = ema21[i];
        const curEma50 = ema50[i];
        const curAtr = atr14[i];
        const curVwap = vwap[i];
        const curRsi = rsi14[i];
        const curVol = b.v || 0;
        const avgVol = volSma20[i] || 1;
        const rvol = avgVol > 0 ? (curVol / avgVol) : 1;
        const st = supertrend[i];

        return {
            ...b,
            ema9: parseFloat(curEma9.toFixed(4)),
            ema21: parseFloat(curEma21.toFixed(4)),
            ema50: parseFloat(curEma50.toFixed(4)),
            prevEma9: parseFloat(prevEma9.toFixed(4)),
            prevEma21: parseFloat(prevEma21.toFixed(4)),
            atr: parseFloat(curAtr.toFixed(4)),
            vwap: parseFloat(curVwap.toFixed(4)),
            rsi: parseFloat(curRsi.toFixed(2)),
            rvol: parseFloat(rvol.toFixed(2)),
            supertrend: st.trend, // 1 alcista, -1 bajista
            supertrendBand: parseFloat(st.band.toFixed(4)),
            isBullishCross: (prevEma9 <= prevEma21 && curEma9 > curEma21),
            emaSlope: curEma9 - prevEma9
        };
    });
}

module.exports = {
    calculateEMA,
    calculateSMA,
    calculateATR,
    calculateSessionVWAP,
    calculateRSI,
    calculateSuperTrend,
    enrichBarsWithIndicators
};
