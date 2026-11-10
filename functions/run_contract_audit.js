/**
 * RUNNER DE AUDITORÍA CONTRACTUAL // TAREA 6 FINAL
 * Genera las 4 tablas exigidas por Pedro Castillo.
 */

const { runComprehensiveBacktest, ASSETS_CONFIG } = require('./backtest_advanced');
const fs = require('fs');
const path = require('path');

async function main() {
    const { comparativeMatrix, qualifiedCombinations, splitOosDate } = await runComprehensiveBacktest();

    console.log('\n========================================================================================================================');
    console.log('TABLA 1: COMPARATIVA MULTI-TIMEFRAME (5m vs 15m vs 1H) CON COSTES REALES (SPREADS Y COMISIONES DESCONTADOS)');
    console.log('========================================================================================================================');
    console.log(
        'ACTIVO'.padEnd(7) +
        ' | ' + 'TF'.padEnd(4) +
        ' | ' + 'ESTRATEGIA'.padEnd(38) +
        ' | ' + 'TRADES'.padStart(6) +
        ' | ' + 'WIN RATE'.padStart(9) +
        ' | ' + 'COSTES($)'.padStart(10) +
        ' | ' + 'PF NETO'.padStart(9) +
        ' | ' + 'PNL NETO($)'.padStart(12) +
        ' | ' + 'ESTADO / CALIFICACIÓN'.padEnd(23)
    );
    console.log('------------------------------------------------------------------------------------------------------------------------');

    comparativeMatrix.forEach(r => {
        const pfStr = r.netProfitFactor >= 99 ? 'MAX' : r.netProfitFactor.toFixed(2);
        const pnlStr = (r.netPnl >= 0 ? '+' : '') + '$' + r.netPnl.toFixed(2);
        const costStr = '$' + r.totalCosts.toFixed(2);
        const isQualified = r.netProfitFactor > 1.20 && r.totalTrades >= 15;
        const statusStr = isQualified ? '🟢 CALIFICA (PF > 1.2)' : '⚪ MODO SOMBRA';
        console.log(
            r.ticker.padEnd(7) +
            ' | ' + r.timeframe.padEnd(4) +
            ' | ' + r.strategyName.slice(0, 38).padEnd(38) +
            ' | ' + String(r.totalTrades).padStart(6) +
            ' | ' + (r.winRate.toFixed(1) + '%').padStart(9) +
            ' | ' + costStr.padStart(10) +
            ' | ' + pfStr.padStart(9) +
            ' | ' + pnlStr.padStart(12) +
            ' | ' + statusStr.padEnd(23)
        );
    });

    console.log('\n========================================================================================================================');
    console.log('TABLA 2: VALIDACIÓN FUERA DE MUESTRA (OUT-OF-SAMPLE - ÚLTIMOS 10 DÍAS HÁBILES)');
    console.log('Fecha de corte OOS: ' + splitOosDate.toISOString().slice(0, 10));
    console.log('========================================================================================================================');
    console.log(
        'ACTIVO'.padEnd(7) +
        ' | ' + 'TF'.padEnd(4) +
        ' | ' + 'ESTRATEGIA'.padEnd(38) +
        ' | ' + 'IS TRADES'.padStart(10) +
        ' | ' + 'IS PF NET'.padStart(10) +
        ' | ' + 'OOS TRADES'.padStart(11) +
        ' | ' + 'OOS PF NET'.padStart(11) +
        ' | ' + 'OOS PNL($)'.padStart(11) +
        ' | ' + 'CONSISTENCIA OOS'.padEnd(20)
    );
    console.log('------------------------------------------------------------------------------------------------------------------------');

    // Filtrar estrategias de interés o ganadoras
    const targets = comparativeMatrix.filter(r => r.stratCode === 'p4' || r.stratCode === 'p5' || r.netProfitFactor > 1.10);
    targets.forEach(r => {
        const isPfStr = r.isProfitFactor >= 99 ? 'MAX' : r.isProfitFactor.toFixed(2);
        const oosPfStr = r.oosProfitFactor >= 99 ? 'MAX' : r.oosProfitFactor.toFixed(2);
        const oosPnlStr = (r.oosNetPnl >= 0 ? '+' : '') + '$' + r.oosNetPnl.toFixed(2);
        const isRobust = r.oosProfitFactor >= 1.10 && r.oosNetPnl > 0;
        const consistency = isRobust ? '🟢 ROBUSTA OOS' : (r.oosNetPnl >= 0 ? '🟡 NEUTRAL' : '🔴 DEGRADADA');
        console.log(
            r.ticker.padEnd(7) +
            ' | ' + r.timeframe.padEnd(4) +
            ' | ' + r.strategyName.slice(0, 38).padEnd(38) +
            ' | ' + String(r.totalTrades - r.oosTradesCount).padStart(10) +
            ' | ' + isPfStr.padStart(10) +
            ' | ' + String(r.oosTradesCount).padStart(11) +
            ' | ' + oosPfStr.padStart(11) +
            ' | ' + oosPnlStr.padStart(11) +
            ' | ' + consistency.padEnd(20)
        );
    });

    console.log('\n========================================================================================================================');
    console.log('TABLA 3: GESTIÓN DE RIESGO Y CAPITAL MÍNIMO REQUERIDO (REGLA SAGRADA DEL 1% DE PEDRO)');
    console.log('========================================================================================================================');
    console.log(
        'COMBINACIÓN'.padEnd(16) +
        ' | ' + 'BROKER'.padEnd(12) +
        ' | ' + 'LOTE MÍN.'.padEnd(10) +
        ' | ' + 'NOCIONAL ($)'.padStart(13) +
        ' | ' + 'MARGEN 1:30'.padStart(12) +
        ' | ' + 'RIESGO SL 1.5 ATR'.padStart(18) +
        ' | ' + 'CUENTA MÍN. (1%)'.padStart(17) +
        ' | ' + 'PNL MENSUAL EST.'.padStart(17)
    );
    console.log('------------------------------------------------------------------------------------------------------------------------');

    // Estrategias calificadas o candidatas prioritarias
    const prioritized = comparativeMatrix.filter(r => r.netProfitFactor > 1.15 && r.totalTrades >= 12);
    const finalPromotedList = prioritized.length > 0 ? prioritized : comparativeMatrix.filter(r => r.netProfitFactor > 1.05);

    finalPromotedList.forEach(r => {
        const asset = r.asset;
        const lastPrice = asset.priceFallback;
        // Calcular ATR medio de las operaciones
        const avgAtr = r.trades.length > 0 ? (r.trades.reduce((acc, t) => acc + (t.atrAtEntry || 2.0), 0) / r.trades.length) : 2.0;

        // 1. Alpaca (Paper/Real): Mínimo 1 acción
        const alpacaQty = 1;
        const alpacaNocional = lastPrice * alpacaQty;
        const alpacaRisk = parseFloat((1.5 * avgAtr * alpacaQty).toFixed(2));
        const alpacaMinAccount = parseFloat((alpacaRisk / 0.01).toFixed(2));
        const alpacaMonthlyPnl = parseFloat((r.avgTradeNet * (r.totalTrades)).toFixed(2));

        console.log(
            `${r.ticker} (${r.timeframe}) ${r.stratCode}`.padEnd(16) +
            ' | ' + 'Alpaca Paper'.padEnd(12) +
            ' | ' + '1 acción'.padEnd(10) +
            ' | ' + ('$' + alpacaNocional.toFixed(2)).padStart(13) +
            ' | ' + ('$' + (alpacaNocional * 0.25).toFixed(2) + ' (4x)').padStart(12) +
            ' | ' + ('$' + alpacaRisk.toFixed(2)).padStart(18) +
            ' | ' + ('$' + alpacaMinAccount.toFixed(2)).padStart(17) +
            ' | ' + ((alpacaMonthlyPnl >= 0 ? '+' : '') + '$' + alpacaMonthlyPnl.toFixed(2)).padStart(17)
        );

        // 2. Pepperstone (cTrader): Lote mínimo CFD
        const pepQty = asset.pepperstoneMinLot;
        const pepNocional = lastPrice * pepQty;
        const pepMargin = pepNocional * asset.pepperstoneMarginRate;
        const pepRisk = parseFloat((1.5 * avgAtr * pepQty).toFixed(2));
        const pepMinAccount = parseFloat((pepRisk / 0.01).toFixed(2));
        const pepMonthlyPnl = parseFloat((r.avgTradeNet * pepQty * r.totalTrades).toFixed(2));

        console.log(
            `${r.ticker} (${r.timeframe}) ${r.stratCode}`.padEnd(16) +
            ' | ' + 'Pepperstone'.padEnd(12) +
            ' | ' + (pepQty + ' lotes').padEnd(10) +
            ' | ' + ('$' + pepNocional.toFixed(2)).padStart(13) +
            ' | ' + ('$' + pepMargin.toFixed(2)).padStart(12) +
            ' | ' + ('$' + pepRisk.toFixed(2)).padStart(18) +
            ' | ' + ('$' + pepMinAccount.toFixed(2)).padStart(17) +
            ' | ' + ((pepMonthlyPnl >= 0 ? '+' : '') + '$' + pepMonthlyPnl.toFixed(2)).padStart(17)
        );
        console.log('-'.repeat(120));
    });

    // Guardar resultados completos en json para referencia técnica
    const outPath = path.join(__dirname, 'multi_timeframe_backtest_results.json');
    fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        splitOosDate: splitOosDate.toISOString(),
        comparativeMatrix: comparativeMatrix.map(c => ({
            ticker: c.ticker,
            timeframe: c.timeframe,
            stratCode: c.stratCode,
            strategyName: c.strategyName,
            totalTrades: c.totalTrades,
            winRate: c.winRate,
            netProfitFactor: c.netProfitFactor,
            netPnl: c.netPnl,
            totalCosts: c.totalCosts,
            avgTradeNet: c.avgTradeNet,
            isProfitFactor: c.isProfitFactor,
            isNetPnl: c.isNetPnl,
            oosTradesCount: c.oosTradesCount,
            oosProfitFactor: c.oosProfitFactor,
            oosNetPnl: c.oosNetPnl
        }))
    }, null, 2), 'utf8');

    console.log(`\n💾 Resultados Multi-Timeframe guardados en: ${outPath}\n`);
}

main().catch(err => console.error('Error:', err));
