/**
 * KRAKEN QUANT ENGINE // MULTI-STRATEGY SIGNALS MODULE
 * Castillo Imperial Holding S.A.
 * 
 * Evaluación cuantitativa pura sobre velas OHLCV de 5m con indicadores.
 * Cero fórmulas de 'seed % N'. Auditabilidad completa de métricas técnicas.
 */

/**
 * Evalúa todas las pistas para una vela específica en una serie histórica o en tiempo real.
 * 
 * @param {string} ticker - Ticker del activo (NVDA, TSLA, GLD, SOLUSD, etc.)
 * @param {Array<object>} enrichedBars - Serie de velas enriquecidas con indicadores
 * @param {number} barIndex - Índice de la vela a evaluar (por defecto la última)
 * @param {object} [promotedMatrix] - Matriz opcional de calificación del backtest
 * @returns {Array<object>} Lista de estrategias evaluadas
 */
function evaluateStrategiesForBar(ticker, enrichedBars, barIndex = -1, promotedMatrix = null) {
    if (!enrichedBars || enrichedBars.length === 0) return [];
    const idx = barIndex < 0 ? enrichedBars.length - 1 : barIndex;
    const cur = enrichedBars[idx];
    if (!cur) return [];

    const prev = idx > 0 ? enrichedBars[idx - 1] : cur;
    const currentPrice = cur.c;
    const atr = Math.max(0.01, cur.atr || 1.0);
    const strategies = [];

    // Verificación de si la estrategia está promovida para este activo
    function isPromoted(stratCode) {
        if (!promotedMatrix) return true; // Si no hay matriz, modo permisivo
        const key = `${stratCode}_${ticker}`;
        return promotedMatrix[key] ? promotedMatrix[key].isPromoted : false;
    }

    // ==============================================================================
    // PISTA 1: 🐬 DELFÍN RÁPIDO (MOMENTUM 5M - CRUCE EMA 9 / EMA 21 + ESCALERA 4X4)
    // ==============================================================================
    let p1Action = 'HOLD';
    let p1Reason = '';
    const emaSpread = cur.ema9 - cur.ema21;
    const prevEmaSpread = prev.ema9 - prev.ema21;
    const isEmaBullish = cur.ema9 > cur.ema21;
    const isEmaCrossingUp = (cur.isBullishCross || (prevEmaSpread <= 0 && emaSpread > 0));
    const isMomentumExpanding = emaSpread > prevEmaSpread && cur.emaSlope > 0;

    let p1Score = 40;
    if (isEmaBullish) {
        p1Score = 55;
        if (isEmaCrossingUp) p1Score += 25; // Cruce fresco
        if (isMomentumExpanding) p1Score += 12; // Expansión de momentum
        if (cur.rsi >= 50 && cur.rsi <= 65) p1Score += 8; // Zona ideal
        p1Score = Math.min(98, Math.max(20, Math.round(p1Score)));

        if (p1Score >= 65 && (isEmaCrossingUp || (isMomentumExpanding && cur.rsi >= 50))) {
            p1Action = 'BUY';
            p1Reason = `Cruce/Impulso EMA 9 (${cur.ema9.toFixed(2)}) > EMA 21 (${cur.ema21.toFixed(2)}) con RSI en ${cur.rsi.toFixed(1)}`;
        } else {
            p1Reason = `EMA 9 sobre EMA 21 pero sin momentum suficiente (Score: ${p1Score})`;
        }
    } else {
        p1Score = Math.max(20, Math.round(45 - Math.abs(emaSpread / atr) * 15));
        p1Reason = `EMA 9 (${cur.ema9.toFixed(2)}) por debajo de EMA 21 (${cur.ema21.toFixed(2)})`;
    }

    const tp1 = parseFloat((currentPrice + (atr * 0.75)).toFixed(2));
    const tp2 = parseFloat((currentPrice + (atr * 1.50)).toFixed(2));
    const tp3 = parseFloat((currentPrice + (atr * 2.25)).toFixed(2));
    const tp4 = parseFloat((currentPrice + (atr * 3.00)).toFixed(2));

    strategies.push({
        stratCode: 'p1',
        strategyName: 'Pista 1: 🐬 Delfín Rápido de Pedro (Scalping 5m)',
        pez: '🐬 DELFÍN',
        score: p1Score,
        action: p1Action,
        signalReason: p1Reason,
        isPromoted: isPromoted('p1'),
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: tp4,
        tp1, tp2, tp3, tp4,
        isDelfin4x4: true,
        breakevenTrigger: tp2,
        indicators: {
            ema9: cur.ema9,
            ema21: cur.ema21,
            atr: cur.atr,
            vwap: cur.vwap,
            rvol: cur.rvol,
            rsi: cur.rsi
        }
    });

    // ==============================================================================
    // PISTA 2: 🦈 BASE INSTITUCIONAL (AMBOS - TREND FOLLOWING MULTI-EMA)
    // ==============================================================================
    let p2Action = 'HOLD';
    let p2Reason = '';
    const isInstAlignment = (cur.c > cur.ema21 && cur.ema21 >= cur.ema50);
    let p2Score = 40;

    if (isInstAlignment) {
        p2Score = 60;
        if (cur.c > cur.vwap) p2Score += 15;
        if (cur.rsi >= 48 && cur.rsi <= 66) p2Score += 15;
        if (cur.rvol >= 1.1) p2Score += 8;
        p2Score = Math.min(98, Math.max(25, Math.round(p2Score)));

        if (p2Score >= 68 && cur.c > cur.vwap) {
            p2Action = 'BUY';
            p2Reason = `Estructura alcista sólida: Precio > EMA21 (${cur.ema21.toFixed(2)}) > EMA50 (${cur.ema50.toFixed(2)}) y Precio > VWAP`;
        } else {
            p2Reason = `Estructura alineada pero consolidando (Score: ${p2Score})`;
        }
    } else {
        p2Score = Math.max(25, Math.round(45 - (cur.ema21 - cur.c) / atr * 10));
        p2Reason = `Estructura institucional no alineada o precio bajo EMA 21`;
    }

    strategies.push({
        stratCode: 'p2',
        strategyName: 'Pista 2: 🦈 Base Institucional (Ambos)',
        pez: '🦈 TIBURÓN',
        score: p2Score,
        action: p2Action,
        signalReason: p2Reason,
        isPromoted: isPromoted('p2'),
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 3.0)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.5)).toFixed(2)),
        indicators: {
            ema9: cur.ema9,
            ema21: cur.ema21,
            ema50: cur.ema50,
            atr: cur.atr,
            vwap: cur.vwap,
            rvol: cur.rvol,
            rsi: cur.rsi
        }
    });

    // ==============================================================================
    // PISTA 3: ⏳ TIMEMACHINE PROBABILÍSTICA (BREAKOUT DE VOLATILIDAD DONCHIAN 15)
    // ==============================================================================
    let p3Action = 'HOLD';
    let p3Reason = '';
    const lookback = Math.min(15, idx);
    let highestHigh = 0;
    for (let j = idx - lookback; j < idx; j++) {
        if (enrichedBars[j].h > highestHigh) highestHigh = enrichedBars[j].h;
    }
    const isBreakout = cur.c > highestHigh && highestHigh > 0;
    const isAtrExpanding = cur.atr > prev.atr;

    let p3Score = 40;
    if (isBreakout) {
        p3Score = 65;
        if (isAtrExpanding) p3Score += 15;
        if (cur.rvol >= 1.2) p3Score += 15;
        p3Score = Math.min(98, Math.max(30, Math.round(p3Score)));

        if (p3Score >= 70 && isAtrExpanding) {
            p3Action = 'BUY';
            p3Reason = `Ruptura alcista Donchian (Cierre ${cur.c} > Máx ${highestHigh.toFixed(2)}) con ATR en expansión`;
        } else {
            p3Reason = `Ruptura de nivel pero sin confirmación de volatilidad`;
        }
    } else {
        p3Score = Math.max(25, Math.round(45 - ((highestHigh - cur.c) / atr) * 8));
        p3Reason = `Dentro del canal Donchian (por debajo de ${highestHigh.toFixed(2)})`;
    }

    strategies.push({
        stratCode: 'p3',
        strategyName: 'Pista 3: ⏳ TimeMachine Probabilística (Odds > 65%)',
        pez: '🦈 TIBURÓN',
        score: p3Score,
        action: p3Action,
        signalReason: p3Reason,
        isPromoted: isPromoted('p3'),
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 2.8)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.4)).toFixed(2)),
        indicators: {
            highestHigh,
            atr: cur.atr,
            vwap: cur.vwap,
            rvol: cur.rvol,
            rsi: cur.rsi
        }
    });

    // ==============================================================================
    // PISTA 4: 🌊 VWAP + VOLUME BURST SCALPER (REBOTE VWAP + RVOL > 1.5x)
    // ==============================================================================
    let p4Action = 'HOLD';
    let p4Reason = '';
    const isAboveVwap = cur.c >= cur.vwap;
    const vwapDist = Math.abs(cur.c - cur.vwap);
    const isVwapTouchOrBounce = (cur.l <= (cur.vwap + 0.3 * atr) && cur.c >= cur.vwap);
    const hasHighVolume = cur.rvol >= 1.5;

    let p4Score = 40;
    if (isAboveVwap) {
        p4Score = 50;
        if (hasHighVolume) p4Score += Math.min(30, Math.round(cur.rvol * 15));
        if (isVwapTouchOrBounce) p4Score += 18;
        p4Score = Math.min(98, Math.max(30, Math.round(p4Score)));

        if (hasHighVolume && isAboveVwap && p4Score >= 65) {
            p4Action = 'BUY';
            p4Reason = `Rebote sobre VWAP (${cur.vwap.toFixed(2)}) con rVol explosivo (${cur.rvol}x > 1.5x)`;
        } else if (!hasHighVolume) {
            p4Reason = `Sobre VWAP pero sin volumen institucional (rVol ${cur.rvol}x < 1.5x)`;
        } else {
            p4Reason = `Falta cercanía al soporte de VWAP`;
        }
    } else {
        p4Score = Math.max(20, Math.round(40 - (cur.vwap - cur.c) / atr * 15));
        p4Reason = `Precio (${cur.c.toFixed(2)}) por debajo del VWAP de sesión (${cur.vwap.toFixed(2)})`;
    }

    const p4Sl = parseFloat((currentPrice - (atr * 1.0)).toFixed(2));
    const p4Tp = parseFloat((currentPrice + (atr * 1.5)).toFixed(2));

    strategies.push({
        stratCode: 'p4',
        strategyName: 'Pista 4: 🌊 VWAP + Volume Burst Scalper (Scalping 5m)',
        pez: '🌊 VWAP',
        score: p4Score,
        action: p4Action,
        signalReason: p4Reason,
        isPromoted: isPromoted('p4'),
        atr,
        sl: p4Sl,
        tp: p4Tp,
        breakevenTrigger: parseFloat((currentPrice + (atr * 0.75)).toFixed(2)),
        indicators: {
            vwap: cur.vwap,
            rvol: cur.rvol,
            atr: cur.atr,
            ema9: cur.ema9,
            ema21: cur.ema21
        }
    });

    // ==============================================================================
    // PISTA 5: ⚡ SUPERTREND + EMA RIBBON 9/21 (GUARDIÁN ANTI-CAÍDAS REAL)
    // ==============================================================================
    let p5Action = 'HOLD';
    let p5Reason = '';
    let p5Score = 30;

    // CONDICIÓN INQUEBRANTABLE ANTI-CAÍDAS DE PEDRO:
    // PROHIBIDO COMPRAR SI EMA9 < EMA21 O PRECIO < VWAP O SUPERTREND BAJISTA (-1)
    const isEmaRibbonRed = cur.ema9 < cur.ema21;
    const isBelowVwap = cur.c < cur.vwap;
    const isSupertrendBearish = cur.supertrend === -1;

    if (isEmaRibbonRed || isBelowVwap || isSupertrendBearish) {
        p5Action = 'HOLD';
        const reasons = [];
        if (isEmaRibbonRed) reasons.push(`EMA 9 (${cur.ema9.toFixed(2)}) < EMA 21 (${cur.ema21.toFixed(2)})`);
        if (isBelowVwap) reasons.push(`Precio (${cur.c.toFixed(2)}) < VWAP (${cur.vwap.toFixed(2)})`);
        if (isSupertrendBearish) reasons.push(`SuperTrend Rojo`);
        p5Reason = `🛡️ FILTRO ANTI-CAÍDAS ACTIVO: Prohibido comprar en caída libre [${reasons.join(' | ')}]`;
        p5Score = 30;
    } else {
        // Mercado en tendencia alcista confirmada
        p5Score = 65;
        const emaDist = (cur.ema9 - cur.ema21) / atr;
        p5Score += Math.min(20, Math.round(emaDist * 15));
        if (cur.c > cur.supertrendBand) p5Score += 10;
        p5Score = Math.min(98, Math.max(50, Math.round(p5Score)));

        if (p5Score >= 68) {
            p5Action = 'BUY';
            p5Reason = `SuperTrend Verde + EMA Ribbon Expansiva sobre VWAP (${cur.vwap.toFixed(2)})`;
        } else {
            p5Reason = `Filtro anti-caídas superado pero esperando mayor confirmación`;
        }
    }

    strategies.push({
        stratCode: 'p5',
        strategyName: 'Pista 5: ⚡ SuperTrend + EMA Ribbon 9/21 (Anti-Caídas 5m)',
        pez: '⚡ SUPERTREND',
        score: p5Score,
        action: p5Action,
        blockedReason: p5Action === 'HOLD' ? p5Reason : null,
        signalReason: p5Reason,
        isPromoted: isPromoted('p5'),
        atr,
        sl: parseFloat((currentPrice - (atr * 1.2)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 2.4)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.2)).toFixed(2)),
        indicators: {
            ema9: cur.ema9,
            ema21: cur.ema21,
            vwap: cur.vwap,
            supertrend: cur.supertrend,
            supertrendBand: cur.supertrendBand,
            atr: cur.atr,
            rvol: cur.rvol
        }
    });

    return strategies;
}

module.exports = {
    evaluateStrategiesForBar
};
