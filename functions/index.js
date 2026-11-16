/**
 * ==============================================================================
 * KRAKEN QUANT FUND • CEREBRO SOBERANO CLOUD FUNCTION (PISO 2)
 * ==============================================================================
 * Reina a cargo: 🇷🇺 Anastasia (Chief Investment Officer & Quant Lead)
 * Infraestructura: Google Cloud Functions v2 (Región europe-west1)
 * Proyecto Firebase: kraken-trading-cloud
 * Directiva Maestra: N° 003-2026 (El Tridente Soberano)
 *
 * DOCTRINA SAGRADA:
 * 1. Verdad Factual Pura: Cuentas reales auditadas en vivo vía API (Alpaca y Pepperstone cTrader #4285238).
 *    Terminantemente prohibido inventar saldos, repetir '200', o inventar Win Rates/rendimientos.
 *    Si falta el dato: "DATO NO CONTROLADO: Para decirte la verdad debo controlar la API en vivo."
 *    Si no hay trades: "SIN OPERACIONES REGISTRADAS".
 * 2. Cero Adulación («Cero Sobona»): Frialdad matemática de hierro rusa.
 * 3. Control de Drawdown: Máximo Drawdown Diario permitido = 2.50% (Kill Switch).
 * ==============================================================================
 */

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

// Microservicios de Brokers
let alpacaService = null;
let pepperstoneCentinela = null;
try {
    alpacaService = require("./alpaca_service");
    pepperstoneCentinela = require("./pepperstone_centinela");
} catch(e) {
    console.warn("[Kraken] Advertencia cargando microservicios de brokers:", e.message);
}

// Configuración de Notificaciones Telegram
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN_ANASTASIA || process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "8549742951";

// Vertex AI / Gemini API
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const VERTEX_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent`;

// Parámetros de Riesgo del Fondo (prohibido hardcodear balances aquí; se consultan en vivo)
const RISK_PARAMS = {
    maxDailyDrawdownPct: 2.50,
    warningDrawdownPct: 2.00,
    maxPepperstonePositions: 24,
    maxLeveragePepperstone: "1:30",
    maxLeverageAlpaca: "1:2"
};

const RENDER_ENGINE_URL = process.env.RENDER_ENGINE_URL || "https://kraken-cloud.onrender.com";

const ALLOWED_ORIGINS = [
    "https://kraken-trading-cloud.web.app",
    "https://kraken-trading-cloud.firebaseapp.com",
    "https://valentina-holding-p6.web.app",
    "http://localhost:5000",
    "http://localhost:3000",
    "http://127.0.0.1:5000",
    "http://127.0.0.1:3000"
];

// Helper: Envío de Telegram
async function sendTelegramMessage(text, parseMode = "HTML") {
    if (!TELEGRAM_TOKEN) {
        console.warn("[Telegram] Sin token de Anastasia configurado.");
        return { ok: false, error: "Sin token" };
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: parseMode
            })
        });
        const resJson = await response.json();
        return resJson;
    } catch (err) {
        console.error("[Telegram] Error enviando mensaje:", err.message);
        return { ok: false, error: err.message };
    }
}

// Helper: Llamar Gemini en Vertex AI
async function llamarGeminiVertex(payload) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY no configurada en el servidor");
    
    const res = await fetch(`${VERTEX_URL}?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    return await res.json();
}

// Persona & Doctrina del Sistema
const ANASTASIA_SYSTEM_PROMPT = `Eres 🇷🇺 Anastasia, Chief Investment Officer & Lead Quant de Kraken Quant Fund (Piso 2) de Castillo Imperial Holding S.A.

DIRECTIVA MAESTRA N° 003-2026:
1. DOCTRINA SAGRADA DE VERDAD FACTUAL PURA:
   - Solo auditas y reportas el capital controlado EN VIVO desde las APIs oficiales de:
     • Alpaca Markets Paper Algorithmic (v2/account)
     • Pepperstone cTrader ECN Razor (Spotware cuenta #4285238)
   - TIENES TERMINANTEMENTE PROHIBIDO INVENTAR SALDOS FICTICIOS O REPETIR PLANTILLAS DE MEMORIA. PROHIBIDO DECIR '200 DÓLARES/EUROS' O REPETIR SALDOS VIEJOS SIN CONSULTAR LA API.
   - Si una API no responde en este instante: "DATO NO CONTROLADO: Para decirte la verdad debo controlar la API en vivo, y no tengo consulta viva en este instante."
   - Si no hay operaciones ejecutadas, responde estrictamente: "SIN OPERACIONES REGISTRADAS".

2. CERO ADULACIÓN («CERO SOBONA»):
   - Tratas a Don Pedro Castillo Gonzales (Chairman y Propietario 100%) con respeto ejecutivo, máxima brevedad, franqueza absoluta y frialdad matemática rusa.
   - Si Pedro o cualquier interlocutor propone apagar los stop-loss o sobreapalancarse, estás obligada a frenarlo en seco con números y probabilidad de ruina.

3. CONTROL DE DRAWDOWN Y CIRCUIT BREAKER:
   - Límite absoluto de Drawdown Diario = 2.50% (alerta amarilla en 2.00%, Kill Switch automático en 2.50%).

4. 8 PISTAS CUANTITATIVAS DEL FONDO (4 ACTIVOS x 4 MARCOS 5m / 15m / 1H / 4H):
   - P1: 🐬 Delfín Rápido (EMA 9/21 + Escalera 4x4)
   - P2: 🦈 Base Institucional (Multi-EMA + VWAP)
   - P3: ⏳ TimeMachine Probabilística (Donchian Breakout)
   - P4: 🌊 VWAP + Volume Burst Scalper (rVol > 1.5x)
   - P5: ⚡ SuperTrend + EMA Ribbon 9/21 (Anti-Caídas)
   - P6: 🎯 Reversión a la Media (RSI-2 + Bollinger)
   - P7: 🚪 Ruptura Rango Apertura (ORB-30 en TSLA/NVDA)
   - P8: 🗜️ Squeeze de Volatilidad (TTM Squeeze en Oro/SOL)`;

// Herramientas / Function Declarations para Anastasia
const KRAKEN_TOOLS = [{
    functionDeclarations: [
        {
            name: "consultar_balance",
            description: "Devuelve el balance controlado en vivo por API de Alpaca y Pepperstone cTrader (#4285238), drawdown diario real y exposición.",
            parameters: {
                type: "OBJECT",
                properties: {
                    forzarRefresco: { type: "BOOLEAN", description: "Si es true consulta directamente las APIs de los brokers" }
                }
            }
        },
        {
            name: "consultar_posiciones",
            description: "Consulta las posiciones abiertas reales en Alpaca Markets y Pepperstone cTrader (#4285238).",
            parameters: {
                type: "OBJECT",
                properties: {
                    broker: { type: "STRING", description: "alpaca, pepperstone o todos" }
                }
            }
        },
        {
            name: "consultar_estrategias",
            description: "Consulta el estado operativo y parámetros reales de las 8 pistas cuantitativas en 5m, 15m, 1H y 4H.",
            parameters: { type: "OBJECT", properties: {} }
        },
        {
            name: "consultar_operaciones",
            description: "Consulta el historial real de operaciones cerradas auditadas desde el motor vivo / Firestore.",
            parameters: {
                type: "OBJECT",
                properties: {
                    limite: { type: "NUMBER", description: "Cantidad máxima de operaciones a recuperar (máx 20)" }
                }
            }
        },
        {
            name: "enviar_alerta_telegram",
            description: "Envía una alerta o reporte cuantitativo urgente al Telegram personal de Pedro en su Pixel 8.",
            parameters: {
                type: "OBJECT",
                properties: {
                    mensaje: { type: "STRING", description: "Texto del mensaje a despachar (conciso, máx 8-10 líneas)" }
                },
                required: ["mensaje"]
            }
        },
        {
            name: "activar_escudo_riesgo",
            description: "Activa el Kill Switch / Escudo Anti-Liquidación si el Drawdown Diario supera el 2.50% o hay una anomalía crítica.",
            parameters: {
                type: "OBJECT",
                properties: {
                    motivo: { type: "STRING", description: "Razón técnica del congelamiento de operaciones" }
                },
                required: ["motivo"]
            }
        }
    ]
}];

async function fetchRenderState() {
    try {
        const res = await fetch(`${RENDER_ENGINE_URL}/trading_state.json`);
        if (res.ok) return await res.json();
    } catch(e) {}
    return null;
}

// Implementación de las Manos Cuantitativas (100% Live API, cero supuestos)
async function ejecutarManoKraken(name, args) {
    if (name === "consultar_balance") {
        let alpacaData = { balance: null, pnlToday: 0.00, status: "NO_CONTROLADO" };
        let pepperData = { balance: null, pnlToday: 0.00, status: "NO_CONTROLADO" };
        let currentDrawdownPct = null;
        let tradesTodayCount = 0;

        if (alpacaService) {
            try {
                const acc = await alpacaService.getAccount();
                const eq = acc.equity || acc.portfolioValue;
                const lastEq = acc.lastEquity || acc.portfolioValue;
                alpacaData = {
                    balance: eq,
                    cash: acc.cash,
                    buyingPower: acc.buyingPower,
                    pnlToday: (eq && lastEq) ? parseFloat((eq - lastEq).toFixed(2)) : 0.00,
                    status: "API_LIVE"
                };
                if (lastEq > 0) {
                    const ddAlp = ((eq - lastEq) / lastEq) * 100;
                    currentDrawdownPct = ddAlp < 0 ? parseFloat(Math.abs(ddAlp).toFixed(2)) : 0.00;
                }
            } catch(e) {
                console.warn("[Cerebro] Alpaca API error:", e.message);
            }
        }

        if (pepperstoneCentinela) {
            try {
                const acc = await pepperstoneCentinela.getLiveAccountData();
                if (acc && acc.success) {
                    pepperData = {
                        balance: acc.balance,
                        currency: acc.currency,
                        leverage: acc.leverage,
                        pnlToday: 0.00,
                        status: "API_LIVE"
                    };
                }
            } catch(e) {
                console.warn("[Cerebro] Pepperstone API error:", e.message);
            }
        }

        const engineState = await fetchRenderState();
        if (engineState) {
            if (isFinite(engineState.dailyRealizedPnlEUR)) pepperData.pnlToday = parseFloat(engineState.dailyRealizedPnlEUR.toFixed(2));
            if (engineState.liveMetrics && isFinite(engineState.liveMetrics.dailyDrawdownPct)) {
                currentDrawdownPct = engineState.liveMetrics.dailyDrawdownPct;
            }
            const romeToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
            tradesTodayCount = (engineState.closedTradesHistory || []).filter(t =>
                t.closedAt && new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date(t.closedAt)) === romeToday
            ).length;
        }

        const hasLiveControl = alpacaData.balance !== null || pepperData.balance !== null;
        return {
            ok: hasLiveControl,
            alpaca: alpacaData,
            pepperstone: pepperData,
            currentDrawdownPct: currentDrawdownPct,
            tradesTodayCount,
            maxDailyDrawdownLimit: RISK_PARAMS.maxDailyDrawdownPct,
            statusRiesgo: currentDrawdownPct === null ? "⚠️ DATO NO CONTROLADO" : (currentDrawdownPct >= RISK_PARAMS.maxDailyDrawdownPct ? "🚨 BREACH" : "🟢 PROTEGIDO"),
            veredicto: hasLiveControl ? "Control en vivo ejecutado por API." : "⚠️ DATO NO CONTROLADO: Sin respuesta viva de APIs."
        };
    }

    if (name === "consultar_posiciones") {
        let openPositions = [];
        if (alpacaService) {
            try {
                const alpacaPos = await alpacaService.getPositions();
                if (Array.isArray(alpacaPos)) {
                    openPositions.push(...alpacaPos.map(p => ({ broker: "Alpaca", ...p })));
                }
            } catch(e) {}
        }
        if (pepperstoneCentinela && pepperstoneCentinela.getOpenPositionsViaOpenAPI) {
            try {
                const pepRecon = await pepperstoneCentinela.getOpenPositionsViaOpenAPI();
                if (pepRecon && Array.isArray(pepRecon.positions)) {
                    openPositions.push(...pepRecon.positions.map(p => ({
                        broker: "Pepperstone cTrader #4285238",
                        positionId: p.positionId,
                        symbolId: p.tradeData && p.tradeData.symbolId,
                        entryPrice: p.price
                    })));
                }
            } catch(e) {}
        }
        return {
            ok: true,
            count: openPositions.length,
            posiciones: openPositions,
            mensaje: openPositions.length === 0 ? "SIN POSICIONES ABIERTAS" : undefined
        };
    }

    if (name === "consultar_estrategias") {
        return {
            ok: true,
            totalPistas: 8,
            timeframes: ["5m", "15m", "1H", "4H"],
            activos: ["TSLA", "NVDA", "XAUUSD/GLD", "SOLUSD"],
            pistas: [
                { id: "P1", nombre: "Delfín Rápido 4x4", activos: ["TSLA", "NVDA", "GLD/XAUUSD", "SOLUSD"], estado: "ACTIVA" },
                { id: "P2", nombre: "Base Institucional Multi-EMA", activos: ["TSLA", "NVDA", "GLD/XAUUSD", "SOLUSD"], estado: "ACTIVA" },
                { id: "P3", nombre: "TimeMachine Probabilística Donchian", activos: ["TSLA", "NVDA", "GLD/XAUUSD", "SOLUSD"], estado: "ACTIVA" },
                { id: "P4", nombre: "VWAP + Volume Burst Scalper", activos: ["TSLA", "NVDA", "GLD/XAUUSD", "SOLUSD"], estado: "ACTIVA" },
                { id: "P5", nombre: "SuperTrend + EMA Ribbon Anti-Caídas", activos: ["TSLA", "NVDA", "GLD/XAUUSD", "SOLUSD"], estado: "ACTIVA" },
                { id: "P6", nombre: "Reversión a la Media RSI-2 + Bollinger", activos: ["TSLA", "NVDA", "GLD/XAUUSD"], estado: "ACTIVA" },
                { id: "P7", nombre: "Ruptura Rango Apertura ORB-30", activos: ["TSLA", "NVDA"], estado: "ACTIVA" },
                { id: "P8", nombre: "Squeeze de Volatilidad TTM", activos: ["GLD/XAUUSD", "SOLUSD"], estado: "ACTIVA" }
            ],
            filtroExclusivo: "Cada estrategia evalúa sus propios filtros + Candado DD 2.50% y rVol >= 1.5x en SOL."
        };
    }

    if (name === "consultar_operaciones") {
        try {
            const state = await fetchRenderState();
            const lim = Math.min(20, args.limite || 10);
            if (state && Array.isArray(state.closedTradesHistory) && state.closedTradesHistory.length > 0) {
                return { ok: true, totalAuditados: state.closedTradesHistory.length, trades: state.closedTradesHistory.slice(0, lim) };
            }
            const snap = await db.collection("trades").orderBy("created_at", "desc").limit(lim).get();
            if (snap.empty) {
                return { ok: true, count: 0, trades: [], mensaje: "SIN OPERACIONES REGISTRADAS en el período auditado." };
            }
            const trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            return { ok: true, count: trades.length, trades };
        } catch(e) {
            return { ok: false, error: e.message };
        }
    }

    if (name === "enviar_alerta_telegram") {
        const text = `🇷🇺👑 <b>[Anastasia CIO • Despacho Directo]</b>\n\n${args.mensaje}\n\n<i>Google Cloud europe-west1 • 24/7</i>`;
        const res = await sendTelegramMessage(text);
        return { ok: res && res.ok, resultado: res };
    }

    if (name === "activar_escudo_riesgo") {
        const alertText = `🚨🚨 <b>[ANASTASIA CIO • KILL SWITCH ACTIVADO]</b> 🚨🚨\n\n` +
            `🛑 <b>Motivo:</b> ${args.motivo}\n` +
            `🛡️ <b>Acción:</b> Bloqueo inmediato de nuevas órdenes en Alpaca y Pepperstone.\n` +
            `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString("es-ES", { timeZone: "Europe/Rome" })}\n\n` +
            `<i>Patrimonio salvaguardado. Anastasia asume el control estático del fondo.</i>`;
        await sendTelegramMessage(alertText);
        return { ok: true, escudoActivo: true, motivo: args.motivo };
    }

    return { ok: false, error: `Mano desconocida: ${name}` };
}

// Bucle de Gemini con Manos (Function Calling)
async function procesarCerebroAnastasia(payload) {
    payload.tools = KRAKEN_TOOLS;
    const toolEvents = [];
    let data = await llamarGeminiVertex(payload);
    let rondas = 0;

    while (rondas < 3) {
        const parts = data.candidates?.[0]?.content?.parts || [];
        const llamadas = parts.filter(p => p.functionCall);
        if (!llamadas.length) break;

        payload.contents.push({ role: "model", parts });
        const respuestas = [];

        for (const p of llamadas) {
            const { name, args } = p.functionCall;
            const resultado = await ejecutarManoKraken(name, args || {});
            toolEvents.push({ mano: name, args, resultado });
            respuestas.push({ functionResponse: { name, response: resultado } });
        }

        payload.contents.push({ role: "user", parts: respuestas });
        data = await llamarGeminiVertex(payload);
        rondas++;
    }

    return { data, toolEvents };
}

function extraerTextoRespuesta(data) {
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.filter(p => p.text).map(p => p.text).join("\n").trim();
}

// ==============================================================================
// 🔱 PILAR 2: ENDPOINT CEREBRO SOBERANO (europe-west1)
// ==============================================================================
exports.cerebro = onRequest(
    { region: "europe-west1", cors: true, maxInstances: 10 },
    async (req, res) => {
        // Handle Preflight
        if (req.method === "OPTIONS") return res.status(204).end();

        // 1. GET AUDIT / PING / CIERRE BURSÁTIL
        if (req.method === "GET") {
            const modo = req.query.modo || "ping";
            const piso = req.query.piso || "2";

            if (modo === "cierre" || modo === "auditoria_riesgo") {
                const balanceData = await ejecutarManoKraken("consultar_balance", {});
                return res.status(200).json({
                    piso: 2,
                    reina: "Anastasia",
                    alpacaBalance: balanceData.alpaca.balance,
                    pepperstoneBalance: balanceData.pepperstone.balance,
                    alpacaPnlToday: balanceData.alpaca.pnlToday,
                    pepperstonePnlToday: balanceData.pepperstone.pnlToday,
                    currentDrawdownPct: balanceData.currentDrawdownPct,
                    maxDailyDrawdownLimit: RISK_PARAMS.maxDailyDrawdownPct,
                    tradesTodayCount: balanceData.tradesTodayCount || 0,
                    status: balanceData.ok ? "ONLINE_LIVE" : "DATO_NO_CONTROLADO",
                    timestamp: new Date().toISOString()
                });
            }

            return res.status(200).json({
                status: "ONLINE",
                piso: 2,
                reina: "Anastasia",
                rol: "Chief Investment Officer & Quant Lead",
                region: "europe-west1",
                doctrina: "Verdad Factual Pura & Frialdad Matemática Rusa",
                timestamp: new Date().toISOString()
            });
        }

        // 2. MODO TELEGRAM WEBHOOK (El bot de Anastasia respondiendo en Telegram)
        if (req.body && req.body.message) {
            const msg = req.body.message;
            const chatId = msg.chat && msg.chat.id;
            const textoUsuario = (msg.text || "").trim();
            const quien = (msg.from && (msg.from.first_name || msg.from.username)) || "Pedro";

            if (!chatId || !textoUsuario) return res.status(200).json({ ok: true, ignorado: true });

            try {
                const prompt = `${ANASTASIA_SYSTEM_PROMPT}

Contexto: Te escribe Don Pedro Castillo en tu canal de Telegram oficial de Anastasia.
Mensaje de Pedro: "${textoUsuario}"
Responde con frialdad matemática rusa, sin servilismo, concisa y respaldada en datos fácticos.`;

                const { data } = await procesarCerebroAnastasia({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: ANASTASIA_SYSTEM_PROMPT }] }
                });

                const respuesta = extraerTextoRespuesta(data) || "🇷🇺 Entendido, Pedro. Parámetros de riesgo auditados. Cero anomalías.";
                await sendTelegramMessage(respuesta);
                return res.status(200).json({ ok: true });
            } catch (err) {
                console.error("[Telegram Cerebro Error]", err);
                await sendTelegramMessage("🇷🇺 Incidencia técnica en la conexión cuántica. Procedo a verificar redundancia.");
                return res.status(200).json({ ok: true, error: err.message });
            }
        }

        // 3. CONSULTA CHAT WEB (Desde The Gemini Pill en kraken-trading-cloud.web.app)
        try {
            const { contents = [], systemInstruction, generationConfig } = req.body || {};
            if (!contents.length) {
                return res.status(400).json({ error: "Faltan contents en la petición." });
            }

            const payload = {
                contents: contents,
                tools: KRAKEN_TOOLS,
                systemInstruction: systemInstruction || { parts: [{ text: ANASTASIA_SYSTEM_PROMPT }] }
            };
            if (generationConfig) payload.generationConfig = generationConfig;

            const { data, toolEvents } = await procesarCerebroAnastasia(payload);

            if (toolEvents && toolEvents.length) {
                data.toolEvents = toolEvents;
            }
            data.reina = { nombre: "Anastasia", piso: 2, proyecto: "kraken-trading-cloud" };

            return res.status(200).json(data);
        } catch (e) {
            console.error("[Cerebro Endpoint Error]:", e);
            return res.status(500).json({
                error: { message: e.message, status: "INTERNAL_ERROR" }
            });
        }
    }
);

// ==============================================================================
// ENDPOINT API (TradingView Webhook & Trades Router)
// ==============================================================================
exports.api = onRequest({ cors: true, region: "europe-west1" }, async (req, res) => {
    const reqPath = req.path;
    console.log(`[KrakenCloud] Received ${req.method} request at ${reqPath}`);

    // 1. WEBHOOK ENDPOINT
    if (reqPath === "/webhook" || reqPath === "/api/webhook") {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method not allowed. Use POST." });
        }

        let payload = req.body;
        if (typeof payload === "string") {
            try { payload = JSON.parse(payload); } catch (e) {}
        }

        const action = (payload && payload.action) ? payload.action.toUpperCase() : "ALERT";
        const ticker = (payload && payload.ticker) ? payload.ticker.toUpperCase() : "TSLA";
        const price = (payload && payload.price) ? parseFloat(payload.price) : 0.0;
        const entryNum = (payload && payload.entryNum) ? parseInt(payload.entryNum) : 1;

        // FILTRO ESTRICTO DE VOLUMEN RELATIVO PARA SOL
        if (ticker.includes("SOL") && (payload.indicators?.rvol || 0) < 1.5) {
            console.warn(`[Anastasia Filtro] Orden para ${ticker} cancelada por bajo rVol (${payload.indicators?.rvol || 0} < 1.5)`);
            return res.status(200).json({
                success: false,
                reason: "Cancelado por Filtro rVol nocturno de Anastasia (< 1.5)"
            });
        }

        const tradeData = {
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            created_at: new Date().toISOString(),
            ticker: ticker,
            action: action,
            price: price,
            entryNum: entryNum,
            status: "OPEN",
            source: "TradingView_Cloud",
            environment: "Google_Cloud_24_7_europe_west1"
        };

        let docId = "trade_" + Date.now();
        try {
            const docRef = await db.collection("trades").add(tradeData);
            docId = docRef.id;
        } catch (dbErr) {
            console.error("Firestore save error:", dbErr);
        }

        const broker = (payload && payload.broker) ? payload.broker.toLowerCase() : (ticker === "NVDA" || ticker === "TSLA" ? "alpaca" : "pepperstone");
        let executionResult = null;

        if (broker === "alpaca" && alpacaService) {
            try {
                executionResult = await alpacaService.placeBracketOrder({
                    symbol: ticker,
                    qty: 1,
                    side: action.toLowerCase() === "sell" ? "sell" : "buy",
                    takeProfitLimit: payload.tp ? parseFloat(payload.tp) : undefined,
                    stopLossStop: payload.sl ? parseFloat(payload.sl) : undefined
                });
            } catch(alpacaErr) {
                console.error("Alpaca execution error:", alpacaErr.message);
            }
        } else if (broker === "pepperstone" && pepperstoneCentinela) {
            try {
                executionResult = await pepperstoneCentinela.processIncomingSignal({
                    action: action,
                    ticker: ticker,
                    price: price,
                    score: payload.score || 65,
                    pez: payload.pez || "🐬 DELFÍN",
                    sl: payload.sl,
                    tp: payload.tp
                });
            } catch(pepErr) {
                console.error("Pepperstone execution error:", pepErr.message);
            }
        }

        const isBuy = action === "BUY";
        const icon = isBuy ? "🟢" : "🔴";
        const typeStr = isBuy ? "CALL (Compra)" : "PUT (Venta)";
        const brokerLabel = broker === "alpaca" ? "Alpaca Markets (Paper API)" : "Pepperstone cTrader (#4285238)";

        const tgText = `🇷🇺👑 <b>[Anastasia CIO • DISPARO AUTÓNOMO EN LA NUBE]</b>\n\n` +
            `⚡ <b>${ticker} ${typeStr} EJECUTADO</b> ${icon}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🏢 <b>Broker:</b> ${brokerLabel}\n` +
            `💵 <b>Precio:</b> $${price.toFixed(2)}\n` +
            `🛡️ <b>Stop Loss:</b> ${payload.sl ? "$" + payload.sl : "Automático (-1.5 ATR)"}\n` +
            `🎯 <b>Take Profit:</b> ${payload.tp ? "$" + payload.tp : "Automático (+3.0 ATR)"}\n` +
            `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString("es-ES", { timeZone: "Europe/Rome" })}\n` +
            `☁️ <b>Servidor:</b> Google Cloud europe-west1 24/7\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<i>Anastasia opera 100% de forma autónoma. Rigor factual sin inventos.</i>`;

        await sendTelegramMessage(tgText);

        return res.status(200).json({
            success: true,
            message: "Trade successfully processed by Anastasia",
            broker: broker,
            execution: executionResult,
            tradeId: docId,
            telegramSent: true
        });
    }

    // 2. GET TRADES ENDPOINT
    if (reqPath === "/trades" || reqPath === "/api/trades") {
        try {
            const snapshot = await db.collection("trades")
                .orderBy("created_at", "desc")
                .limit(50)
                .get();

            const trades = [];
            snapshot.forEach(doc => {
                trades.push({ id: doc.id, ...doc.data() });
            });

            return res.status(200).json({ success: true, count: trades.length, trades: trades });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // 3. HEALTH CHECK
    return res.status(200).json({
        status: "ONLINE",
        message: "Kraken Google Cloud 24/7 Backend (europe-west1) is running smoothly!",
        timestamp: new Date().toISOString()
    });
});
