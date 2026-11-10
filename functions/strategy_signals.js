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

    // ==============================================================================
    // PISTA 6: 🎯 REVERSIÓN A LA MEDIA (RSI-2 + BOLLINGER) - LARRY CONNORS 2008
    // ==============================================================================
    let p6Action = 'HOLD';
    let p6Reason = '';
    let p6Score = 30;

    const isP6Asset = (ticker === 'NVDA' || ticker === 'TSLA' || ticker === 'GLD' || ticker === 'XAUUSD');
    const isAboveEma200 = cur.c >= (cur.ema200 || cur.ema50);
    const isRsi2Extreme = (cur.rsi2 < 5);
    const isBelowBollingerLower = (cur.bollinger && cur.c < cur.bollinger.lower);

    if (isP6Asset) {
        if (!isAboveEma200) {
            p6Action = 'HOLD';
            p6Reason = `🛡️ FILTRO ANTI-CUCHILLOS P6: Precio (${cur.c.toFixed(2)}) < EMA 200 (${(cur.ema200 || cur.ema50).toFixed(2)})`;
            p6Score = 25;
        } else if (isRsi2Extreme && isBelowBollingerLower) {
            p6Score = Math.min(98, Math.max(65, Math.round(60 + (5 - cur.rsi2) * 6 + ((cur.bollinger.lower - cur.c) / atr) * 15)));
            if (p6Score >= 65) {
                p6Action = 'BUY';
                p6Reason = `🎯 PÁNICO EXTREMO: RSI(2) en ${cur.rsi2} (< 5) + Cierre bajo Banda Bollinger Inferior (${cur.bollinger.lower.toFixed(2)}) con Macro Alcista`;
            }
        } else {
            p6Reason = `Esperando pánico: RSI(2)=${cur.rsi2} (req < 5), Bollinger Inf=${cur.bollinger ? cur.bollinger.lower.toFixed(2) : '--'}`;
            p6Score = 40;
        }
    } else {
        p6Reason = `Activo no optimizado para P6 (solo NVDA, TSLA, GLD)`;
        p6Score = 20;
    }

    const p6TpTarget = Math.max(cur.ema20 || cur.ema21, cur.vwap);
    const p6Tp = parseFloat(p6TpTarget.toFixed(2));
    const p6Sl = parseFloat((currentPrice - (atr * 1.0)).toFixed(2));

    strategies.push({
        stratCode: 'p6',
        strategyName: 'Pista 6: 🎯 Reversión a la Media (RSI-2 + Bollinger)',
        pez: '🎯 REVERSIÓN',
        score: p6Score,
        action: p6Action,
        blockedReason: p6Action === 'HOLD' ? p6Reason : null,
        signalReason: p6Reason,
        isPromoted: isPromoted('p6'),
        atr,
        sl: p6Sl,
        tp: p6Tp > currentPrice ? p6Tp : parseFloat((currentPrice + (atr * 1.5)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 0.7)).toFixed(2)),
        timeStopBars: 12,
        indicators: {
            rsi2: cur.rsi2,
            bollingerLower: cur.bollinger ? cur.bollinger.lower : null,
            bollingerUpper: cur.bollinger ? cur.bollinger.upper : null,
            ema200: cur.ema200,
            ema20: cur.ema20,
            vwap: cur.vwap,
            atr: cur.atr
        }
    });

    // ==============================================================================
    // PISTA 7: 🚪 RUPTURA DE RANGO DE APERTURA (ORB-30) - TOBY CRABEL
    // ==============================================================================
    let p7Action = 'HOLD';
    let p7Reason = '';
    let p7Score = 30;

    const isOrbAsset = (ticker === 'TSLA' || ticker === 'NVDA');
    let orbHigh = 0;
    let orbLow = 999999;
    let orbEstablished = false;

    if (isOrbAsset && cur.t) {
        const barDate = new Date(cur.t);
        const dayStr = cur.t.slice(0, 10);
        const hour = barDate.getUTCHours();
        const min = barDate.getUTCMinutes();
        const timeMin = hour * 60 + min;

        const sessionBars = enrichedBars.slice(Math.max(0, idx - 80), idx + 1).filter(b => (b.t || '').startsWith(dayStr));
        const orbBars = sessionBars.filter(b => {
            const bd = new Date(b.t);
            const tm = bd.getUTCHours() * 60 + bd.getUTCMinutes();
            return tm >= 870 && tm < 900;
        });

        if (orbBars.length >= 4) {
            orbHigh = Math.max(...orbBars.map(b => b.h));
            orbLow = Math.min(...orbBars.map(b => b.l));
            orbEstablished = true;
        }

        const isTradingWindow = timeMin >= 900 && timeMin <= 1230; // 16:00 a 21:30 CET
        if (isTradingWindow && orbEstablished) {
            const isBreakout = (cur.c > orbHigh);
            const isFreshBreakout = (prev.c <= orbHigh && cur.c > orbHigh) || (isBreakout && (cur.c - orbHigh) <= 0.5 * atr);
            const hasVolBurst = (cur.rvol >= 1.5);

            if (isBreakout) {
                p7Score = Math.min(98, Math.max(60, Math.round(60 + (cur.rvol * 12) + ((cur.c - orbHigh) / atr) * 10)));
                if (hasVolBurst && isFreshBreakout && p7Score >= 68) {
                    p7Action = 'BUY';
                    p7Reason = `🚪 RUPTURA ORB-30: Cierre (${cur.c.toFixed(2)}) > Rango Máx (${orbHigh.toFixed(2)}) con rVol ${cur.rvol}x (> 1.5x)`;
                } else if (!hasVolBurst) {
                    p7Reason = `Ruptura sobre ORB (${orbHigh.toFixed(2)}) pero falta volumen institucional (rVol ${cur.rvol}x < 1.5x)`;
                } else {
                    p7Reason = `Sobre ORB pero ruptura ya extendida`;
                }
            } else {
                p7Reason = `Dentro del rango ORB [${orbLow.toFixed(2)} - ${orbHigh.toFixed(2)}]`;
                p7Score = 40;
            }
        } else if (!isTradingWindow) {
            p7Reason = `Fuera de ventana operativa ORB (activa de 16:00 a 21:30 CET)`;
            p7Score = 25;
        }
    } else {
        p7Reason = `Activo 24/7 sin campana de apertura (ORB reservado a TSLA/NVDA)`;
        p7Score = 20;
    }

    const orbRangeHeight = (orbHigh > orbLow && orbLow > 0) ? (orbHigh - orbLow) : (atr * 2);
    const p7Sl = orbEstablished ? parseFloat(((orbHigh + orbLow) / 2).toFixed(2)) : parseFloat((currentPrice - (atr * 1.5)).toFixed(2));
    const p7Tp = parseFloat((currentPrice + (orbRangeHeight * 2.0)).toFixed(2));
    const p7Be = parseFloat((currentPrice + (orbRangeHeight * 1.0)).toFixed(2));

    strategies.push({
        stratCode: 'p7',
        strategyName: 'Pista 7: 🚪 Ruptura del Rango de Apertura (ORB-30)',
        pez: '🚪 ORB',
        score: p7Score,
        action: p7Action,
        blockedReason: p7Action === 'HOLD' ? p7Reason : null,
        signalReason: p7Reason,
        isPromoted: isPromoted('p7'),
        atr,
        sl: p7Sl,
        tp: p7Tp,
        breakevenTrigger: p7Be,
        closeAtSessionEnd: true,
        indicators: {
            orbHigh: orbEstablished ? orbHigh : null,
            orbLow: orbEstablished ? orbLow : null,
            orbRangeHeight,
            rvol: cur.rvol,
            atr: cur.atr
        }
    });

    // ==============================================================================
    // PISTA 8: 🗜️ SQUEEZE DE VOLATILIDAD (TTM SQUEEZE) - JOHN CARTER
    // ==============================================================================
    let p8Action = 'HOLD';
    let p8Reason = '';
    let p8Score = 30;

    const isSqueezeAsset = (ticker === 'GLD' || ticker === 'XAUUSD' || ticker.includes('SOL'));
    let squeezeCount = 0;
    for (let k = Math.max(0, idx - 10); k < idx; k++) {
        if (enrichedBars[k] && enrichedBars[k].isSqueezeActive) squeezeCount++;
    }

    const hadProlongedCompression = (squeezeCount >= 5);
    const isSqueezeFiringNow = (prev.isSqueezeActive && !cur.isSqueezeActive);
    const isMomentumBullish = (cur.macd && cur.macd.hist > 0 && cur.c > cur.ema9);
    const hasVolumeConfirm = (cur.rvol >= 1.1);

    if (isSqueezeAsset) {
        if (hadProlongedCompression && isSqueezeFiringNow && isMomentumBullish && hasVolumeConfirm) {
            p8Score = Math.min(98, Math.max(70, Math.round(70 + (cur.macd.hist > 0 ? 15 : 0) + (cur.rvol * 8))));
            p8Action = 'BUY';
            p8Reason = `🗜️ TTM SQUEEZE DISPARADO: Compresión de ${squeezeCount} velas liberada al alza con Momentum MACD (${cur.macd.hist.toFixed(4)}) sobre EMA 9`;
        } else if (cur.isSqueezeActive) {
            p8Reason = `🗜️ Squeeze en Compresión activa (${squeezeCount} velas dentro de Keltner). Esperando detonación.`;
            p8Score = 55;
        } else {
            p8Reason = `Sin compresión TTM activa o momentum bajista`;
            p8Score = 35;
        }
    } else {
        p8Reason = `Activo no asignado a P8 (optimizado para ORO y SOL en 15m/1H)`;
        p8Score = 20;
    }

    strategies.push({
        stratCode: 'p8',
        strategyName: 'Pista 8: 🗜️ Squeeze de Volatilidad (TTM Squeeze)',
        pez: '🗜️ SQUEEZE',
        score: p8Score,
        action: p8Action,
        blockedReason: p8Action === 'HOLD' ? p8Reason : null,
        signalReason: p8Reason,
        isPromoted: isPromoted('p8'),
        atr,
        sl: parseFloat((currentPrice - (atr * 1.5)).toFixed(2)),
        tp: parseFloat((currentPrice + (atr * 3.0)).toFixed(2)),
        breakevenTrigger: parseFloat((currentPrice + (atr * 1.5)).toFixed(2)),
        indicators: {
            isSqueezeActive: cur.isSqueezeActive,
            squeezeCount,
            macdHist: cur.macd ? cur.macd.hist : null,
            ema9: cur.ema9,
            rvol: cur.rvol,
            atr: cur.atr
        }
    });

    return strategies;
}

module.exports = {
    evaluateStrategiesForBar
};
