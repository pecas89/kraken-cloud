// ==============================================================================
// 🔒 LA JAULA (Claude v2.5, 21-nov-2026)
// ------------------------------------------------------------------------------
// "El modelo propone, el reglamento decide." Toda orden pasa por aquí ANTES de
// llegar al broker. Si no cumple, NO se envía y queda apuntado el motivo.
// Límites en % del saldo de ESA cuenta (se escalan solos: valen igual con
// $99.000 de demo que con €100 reales). Configurables en Render:
//   KRAKEN_GATE_MAX_RISK_PCT     pérdida máxima si salta el stop, por orden   (def. 1 %)
//   KRAKEN_GATE_MAX_SYMBOL_PCT   valor máximo en un mismo activo               (def. 20 %)
//   KRAKEN_GATE_MAX_TOTAL_PCT    valor máximo invertido en total en la cuenta  (def. 80 %)
// Para la cuenta real de €100 se recomienda medir sobre todo el RIESGO
// (KRAKEN_GATE_MAX_RISK_PCT) y subir el de valor por apalancamiento si hace falta.
// ==============================================================================

function num(v, d) { const x = parseFloat(v); return Number.isFinite(x) ? x : d; }

function limits() {
    return {
        maxRiskPct: num(process.env.KRAKEN_GATE_MAX_RISK_PCT, 1),
        maxSymbolPct: num(process.env.KRAKEN_GATE_MAX_SYMBOL_PCT, 20),
        maxTotalPct: num(process.env.KRAKEN_GATE_MAX_TOTAL_PCT, 80)
    };
}

// brokerKey: 'alpaca' | 'pepperstone'
function check(engineState, { brokerKey, symbol, qty, price, sl, equity }) {
    const L = limits();
    const fail = reason => ({ ok: false, reason, limits: L });
    if (engineState.emergencyStop) return fail('freno de pérdida diaria activo');
    if (!(qty > 0) || !(price > 0)) return fail('cantidad o precio no válidos');
    if (!(sl > 0) || sl >= price) return fail('stop no válido (debe estar por debajo de la entrada)');
    if (!(equity > 0)) return fail('saldo de la cuenta desconocido: no se opera a ciegas');

    const isBroker = p => (p.broker || '').toLowerCase().includes(brokerKey === 'alpaca' ? 'alpaca' : 'pepperstone');
    const mine = (engineState.openPositions || []).filter(isBroker);
    const notional = p => Math.abs(parseFloat(p.qty) || 0) * (parseFloat(p.entryPrice) || 0);

    const risk = qty * (price - sl);
    if (risk > equity * L.maxRiskPct / 100) {
        return fail(`riesgo ${risk.toFixed(2)} > ${L.maxRiskPct}% del saldo (${(equity * L.maxRiskPct / 100).toFixed(2)})`);
    }
    const symNow = mine.filter(p => p.symbol === symbol).reduce((a, p) => a + notional(p), 0);
    const symAfter = symNow + qty * price;
    if (symAfter > equity * L.maxSymbolPct / 100) {
        return fail(`${symbol} pasaría al ${(symAfter / equity * 100).toFixed(1)}% del saldo (máx ${L.maxSymbolPct}%)`);
    }
    const totNow = mine.reduce((a, p) => a + notional(p), 0);
    const totAfter = totNow + qty * price;
    if (totAfter > equity * L.maxTotalPct / 100) {
        return fail(`invertido total pasaría al ${(totAfter / equity * 100).toFixed(1)}% (máx ${L.maxTotalPct}%)`);
    }
    return { ok: true, risk, symPct: symAfter / equity * 100, totPct: totAfter / equity * 100, limits: L };
}

function record(engineState, entry) {
    if (!Array.isArray(engineState.gateLog)) engineState.gateLog = [];
    if (!entry.ok) { // solo se guardan los rechazos (lo aprobado ya queda en las operaciones)
        engineState.gateLog.unshift({ at: new Date().toISOString(), ...entry });
        if (engineState.gateLog.length > 60) engineState.gateLog.length = 60;
    }
    if (!engineState.gateStats) engineState.gateStats = { checked: 0, rejected: 0 };
    engineState.gateStats.checked += 1;
    if (!entry.ok) engineState.gateStats.rejected += 1;
}

module.exports = { check, record, limits };
