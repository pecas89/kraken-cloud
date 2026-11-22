/**
 * ==============================================================================
 * KRAKEN QUANT FUND // PERSISTENCIA SOBERANA EN CLOUD FIRESTORE (PISO 2)
 * ==============================================================================
 * Proyecto: kraken-trading-cloud (Plan Spark - Capa Gratuita €0)
 * Implementación 100% ligera sin dependencias externas (Node 22 crypto + fetch ->
 * Google Cloud Firestore v1 REST API) para máximo rendimiento en 512MB RAM.
 * Doctrina "Bajo 7 Llaves":
 *   - Credenciales leídas solo desde FIREBASE_SERVICE_ACCOUNT_B64,
 *     FIREBASE_SERVICE_ACCOUNT o archivo local ignorado por Git (secrets/).
 *   - Control de cuota Spark (máx 20k writes/día): throttle de 60s en estado_motor.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIRESTORE_PROJECT = 'kraken-trading-cloud';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;
const STATE_WRITE_THROTTLE_MS = 60000;

let cachedCred = undefined;
let cachedToken = null;
let cachedTokenExpMs = 0;
let lastStateWriteMs = 0;

function loadCredentialJson() {
    if (cachedCred !== undefined) return cachedCred;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
        try {
            const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64.trim(), 'base64').toString('utf8');
            cachedCred = JSON.parse(decoded);
            return cachedCred;
        } catch (e) {
            console.warn('[FirestoreStore] Error decodificando FIREBASE_SERVICE_ACCOUNT_B64:', e.message);
        }
    }
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            cachedCred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT.trim());
            return cachedCred;
        } catch (e) {
            console.warn('[FirestoreStore] Error parseando FIREBASE_SERVICE_ACCOUNT:', e.message);
        }
    }
    const localPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        ? path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
        : path.join(__dirname, 'secrets', 'kraken-firebase-adminsdk.json');
    if (fs.existsSync(localPath)) {
        try {
            cachedCred = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            return cachedCred;
        } catch (e) {
            console.warn('[FirestoreStore] Error leyendo credencial local:', e.message);
        }
    }
    cachedCred = null;
    return null;
}

function base64Url(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
    if (cachedToken && Date.now() < (cachedTokenExpMs - 60000)) {
        return cachedToken;
    }
    const cred = loadCredentialJson();
    if (!cred || !cred.client_email || !cred.private_key) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64Url(JSON.stringify({
        iss: cred.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: nowSec,
        exp: nowSec + 3600
    }));
    const unsigned = `${header}.${claim}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    sign.end();
    const signature = base64Url(sign.sign(cred.private_key));
    const jwt = `${unsigned}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`
    });
    const json = await res.json();
    if (!res.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || `OAuth HTTP ${res.status}`);
    }
    cachedToken = json.access_token;
    cachedTokenExpMs = Date.now() + ((json.expires_in || 3600) * 1000);
    return cachedToken;
}

// Conversores JS <-> Firestore REST Typed JSON
function toFsValue(val) {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === 'boolean') return { booleanValue: val };
    if (typeof val === 'number') {
        if (!Number.isFinite(val)) return { nullValue: null };
        return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
    }
    if (typeof val === 'string') return { stringValue: val };
    if (Array.isArray(val)) return { arrayValue: { values: val.map(toFsValue) } };
    if (typeof val === 'object') {
        const fields = {};
        for (const [k, v] of Object.entries(val)) {
            if (v !== undefined) fields[k] = toFsValue(v);
        }
        return { mapValue: { fields } };
    }
    return { stringValue: String(val) };
}

function fromFsValue(fv) {
    if (!fv || typeof fv !== 'object') return null;
    if ('nullValue' in fv) return null;
    if ('booleanValue' in fv) return fv.booleanValue;
    if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
    if ('doubleValue' in fv) return fv.doubleValue;
    if ('stringValue' in fv) return fv.stringValue;
    if ('timestampValue' in fv) return fv.timestampValue;
    if ('arrayValue' in fv) return (fv.arrayValue.values || []).map(fromFsValue);
    if ('mapValue' in fv) {
        const obj = {};
        for (const [k, v] of Object.entries(fv.mapValue.fields || {})) {
            obj[k] = fromFsValue(v);
        }
        return obj;
    }
    return null;
}

function fromFsDoc(doc) {
    if (!doc || !doc.fields) return {};
    const out = {};
    for (const [k, v] of Object.entries(doc.fields)) {
        out[k] = fromFsValue(v);
    }
    return out;
}

async function fsPatchDoc(collection, docId, dataObj) {
    const token = await getAccessToken();
    if (!token) return false;
    const cleanId = encodeURIComponent(String(docId).replace(/[\/?#\[\]]/g, '_'));
    const fields = {};
    for (const [k, v] of Object.entries(dataObj)) {
        if (v !== undefined) fields[k] = toFsValue(v);
    }
    const res = await fetch(`${FIRESTORE_BASE}/${collection}/${cleanId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Firestore PATCH ${collection}/${cleanId} HTTP ${res.status}: ${txt.slice(0, 180)}`);
    }
    return true;
}

async function fsGetDoc(collection, docId) {
    const token = await getAccessToken();
    if (!token) return null;
    const cleanId = encodeURIComponent(String(docId).replace(/[\/?#\[\]]/g, '_'));
    const res = await fetch(`${FIRESTORE_BASE}/${collection}/${cleanId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore GET ${collection}/${cleanId} HTTP ${res.status}`);
    return fromFsDoc(await res.json());
}

async function fsQueryRecentTrades(limit = 200) {
    const token = await getAccessToken();
    if (!token) return [];
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents:runQuery`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: 'historial_ordenes' }],
                orderBy: [{ field: { fieldPath: 'closedAt' }, direction: 'DESCENDING' }],
                limit: limit
            }
        })
    });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r.document).map(r => fromFsDoc(r.document));
}

function isConfigured() {
    return !!loadCredentialJson();
}

async function hydrateFromFirestore(engineState) {
    if (!isConfigured()) return { ok: false, reason: 'no_cred' };
    try {
        const [stateData, histRows] = await Promise.all([
            fsGetDoc('estado_motor', 'actual').catch(() => null),
            fsQueryRecentTrades(250).catch(() => [])
        ]);

        let recoveredTrades = 0;
        if (stateData) {
            if (stateData.lastSignalBarTime && typeof stateData.lastSignalBarTime === 'object') {
                engineState.lastSignalBarTime = { ...(engineState.lastSignalBarTime || {}), ...stateData.lastSignalBarTime };
            }
            if (stateData.closedCooldowns && typeof stateData.closedCooldowns === 'object') {
                engineState.closedCooldowns = { ...(engineState.closedCooldowns || {}), ...stateData.closedCooldowns };
            }
            if (typeof stateData.emergencyStop === 'boolean') {
                engineState.emergencyStop = stateData.emergencyStop;
                engineState.emergencyStopReason = stateData.emergencyStopReason || null;
            }
            if (stateData.lastDailyReportDate) engineState.lastDailyReportDate = stateData.lastDailyReportDate;
            if (stateData.lastDailyReconciliationDate) engineState.lastDailyReconciliationDate = stateData.lastDailyReconciliationDate; // [FIX ANTIGRAVITY v2.4.1]
            if (stateData.lastMidReportDate) engineState.lastMidReportDate = stateData.lastMidReportDate; // [CLAUDE v2.5]
            if (stateData.labEpochStart && typeof stateData.labEpochStart === 'object' && !engineState.labEpochStart) engineState.labEpochStart = stateData.labEpochStart; // [CLAUDE v2.6]
            if (stateData.slowLab && typeof stateData.slowLab === 'object' && !engineState.slowLab) engineState.slowLab = stateData.slowLab; // [CLAUDE v2.5] P13
            if (stateData.lastHeartbeatDate) engineState.lastHeartbeatDate = stateData.lastHeartbeatDate;
            // [CLAUDE v2.2] Recuperar posiciones abiertas tras un redeploy (antes se guardaban pero nunca se leían:
            // cada deploy las convertía en "Custodia" y se perdía su estrategia, SL/TP y salida STEP/STD).
            // Se marcan restoredFromFirestore: el primer cruce con el broker descarta las que ya no existan.
            if (Array.isArray(stateData.openPositions) && stateData.openPositions.length > 0 && (!engineState.openPositions || engineState.openPositions.length === 0)) {
                engineState.openPositions = stateData.openPositions
                    .filter(p => p && (p.id || p.positionId))
                    .map(p => ({ ...p, restoredFromFirestore: true }));
                console.log(`🔥 [FirestoreStore] ${engineState.openPositions.length} posiciones abiertas recuperadas (pendientes de cruce con broker).`);
            }
            if (stateData.peakEquity && typeof stateData.peakEquity === 'object') engineState.peakEquity = stateData.peakEquity;
            // [CLAUDE v2.4] Laboratorio fantasma: recuperar acumulados, fantasmas abiertas e historial reciente
            if (stateData.shadowLab && typeof stateData.shadowLab === 'object' && !engineState.shadowLab) {
                engineState.shadowLab = {
                    startedAt: stateData.shadowLab.startedAt || new Date().toISOString(),
                    version: stateData.shadowLab.version || 'v2.4',
                    agg: stateData.shadowLab.agg || {},
                    open: Array.isArray(stateData.shadowLab.open) ? stateData.shadowLab.open : [],
                    recent: Array.isArray(stateData.shadowLab.recent) ? stateData.shadowLab.recent : [],
                    lastBar: stateData.shadowLab.lastBar || {}
                };
                console.log(`👻 [FirestoreStore] Laboratorio fantasma recuperado: ${engineState.shadowLab.open.length} abiertas, ${engineState.shadowLab.recent.length} recientes.`);
            }
        }

        if (Array.isArray(histRows) && histRows.length > 0) {
            const existingIds = new Set((engineState.closedTradesHistory || []).map(t => String(t.id)));
            const fresh = histRows.filter(t => t && t.id && !existingIds.has(String(t.id)));
            if (fresh.length > 0) {
                engineState.closedTradesHistory = fresh.concat(engineState.closedTradesHistory || [])
                    .sort((a, b) => new Date(b.closedAt || 0) - new Date(a.closedAt || 0));
                recoveredTrades = fresh.length;
            }
        }

        console.log(`🔥 [FirestoreStore] Conectado a Google Cloud (${FIRESTORE_PROJECT}). +${recoveredTrades} trades recuperados.`);
        return { ok: true, recoveredTrades };
    } catch (e) {
        console.warn('⚠️ [FirestoreStore] Error hidratando:', e.message);
        return { ok: false, error: e.message };
    }
}

async function saveClosedTrade(trade) {
    if (!isConfigured() || !trade || !trade.id) return false;
    try {
        await fsPatchDoc('historial_ordenes', String(trade.id).replace(/[^\w.-]/g, '_'), {
            ...trade,
            persistedAt: new Date().toISOString()
        });
        return true;
    } catch (e) {
        console.warn('⚠️ [FirestoreStore] Error guardando trade:', e.message);
        return false;
    }
}

async function syncEngineState(engineState, force = false) {
    if (!isConfigured() || !engineState) return false;
    const now = Date.now();
    if (!force && (now - lastStateWriteMs) < STATE_WRITE_THROTTLE_MS) return false;
    lastStateWriteMs = now;
    try {
        await fsPatchDoc('estado_motor', 'actual', {
            updatedAt: new Date().toISOString(),
            lastScanAt: engineState.lastScanAt || null,
            totalScans: engineState.totalScans || 0,
            emergencyStop: !!engineState.emergencyStop,
            emergencyStopReason: engineState.emergencyStopReason || null,
            accountBalances: engineState.accountBalances || {},
            liveMetrics: engineState.liveMetrics || {},
            performanceStatsGlobal: (engineState.performanceStats && engineState.performanceStats.global) || {},
            openPositionsCount: (engineState.openPositions || []).length,
            openPositions: (engineState.openPositions || []).slice(0, 60),
            peakEquity: engineState.peakEquity || {},
            shadowLab: engineState.shadowLab ? {
                startedAt: engineState.shadowLab.startedAt || null,
                version: engineState.shadowLab.version || 'v2.4',
                agg: engineState.shadowLab.agg || {},
                open: (engineState.shadowLab.open || []).slice(0, 200),
                recent: (engineState.shadowLab.recent || []).slice(0, 150),
                lastBar: engineState.shadowLab.lastBar || {}
            } : null,
            closedCooldowns: engineState.closedCooldowns || {},
            lastSignalBarTime: engineState.lastSignalBarTime || {},
            lastDailyReportDate: engineState.lastDailyReportDate || null,
            lastDailyReconciliationDate: engineState.lastDailyReconciliationDate || null, // [FIX ANTIGRAVITY v2.4.1]
            lastMidReportDate: engineState.lastMidReportDate || null, // [CLAUDE v2.5]
            labEpochStart: engineState.labEpochStart || null, // [CLAUDE v2.6] saldos al punto cero de la semana
            slowLab: engineState.slowLab || null, // [CLAUDE v2.5] P13 (pequeño: 3 posiciones, 2 curvas y 60 cambios como mucho)
            lastHeartbeatDate: engineState.lastHeartbeatDate || null,
            timeframes: ['5m', '15m', '1H', '4H'],
            strategiesActive: 12
        });
        return true;
    } catch (e) {
        console.warn('⚠️ [FirestoreStore] Error guardando estado_motor:', e.message);
        return false;
    }
}

async function saveDailyPerformanceMetric(dateStr, payload) {
    if (!isConfigured() || !dateStr) return false;
    try {
        await fsPatchDoc('metricas_rendimiento', dateStr, {
            ...payload,
            updatedAt: new Date().toISOString()
        });
        return true;
    } catch (e) {
        console.warn('⚠️ [FirestoreStore] Error guardando metricas_rendimiento:', e.message);
        return false;
    }
}

module.exports = {
    isConfigured,
    getAccessToken,
    hydrateFromFirestore,
    saveClosedTrade,
    syncEngineState,
    saveDailyPerformanceMetric
};
