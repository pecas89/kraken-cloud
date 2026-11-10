const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

admin.initializeApp();
const db = admin.firestore();

let alpacaService = null;
let pepperstoneCentinela = null;
try {
    alpacaService = require("./alpaca_service");
    pepperstoneCentinela = require("./pepperstone_centinela");
} catch(e) {
    console.warn("Could not load broker microservices:", e.message);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function sendTelegramMessage(text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: "HTML"
            })
        });
        return await response.json();
    } catch (err) {
        console.error("Error sending Telegram message:", err);
        return null;
    }
}

exports.api = onRequest({ cors: true, region: "us-central1" }, async (req, res) => {
    const path = req.path;
    console.log(`[KrakenCloud] Received ${req.method} request at ${path}`);

    // 1. WEBHOOK ENDPOINT
    if (path === "/webhook" || path === "/api/webhook") {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method not allowed. Use POST." });
        }

        let payload = req.body;
        if (typeof payload === "string") {
            try {
                payload = JSON.parse(payload);
            } catch (e) {
                console.warn("Could not parse string body as JSON:", payload);
            }
        }

        const action = (payload && payload.action) ? payload.action.toUpperCase() : "ALERT";
        const ticker = (payload && payload.ticker) ? payload.ticker.toUpperCase() : "TSLA";
        const price = (payload && payload.price) ? parseFloat(payload.price) : 0.0;
        const entryNum = (payload && payload.entryNum) ? parseInt(payload.entryNum) : 1;

        const tradeData = {
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            created_at: new Date().toISOString(),
            ticker: ticker,
            action: action,
            price: price,
            entryNum: entryNum,
            status: "OPEN",
            source: "TradingView_Cloud",
            environment: "Google_Cloud_24_7"
        };

        // Save in Cloud Firestore
        let docId = "trade_" + Date.now();
        try {
            const docRef = await db.collection("trades").add(tradeData);
            docId = docRef.id;
        } catch (dbErr) {
            console.error("Firestore save error:", dbErr);
        }

        const broker = (payload && payload.broker) ? payload.broker.toLowerCase() : (ticker === 'NVDA' || ticker === 'TSLA' ? 'alpaca' : 'pepperstone');
        let executionResult = null;

        // Disparo Autónomo según broker
        if (broker === 'alpaca' && alpacaService) {
            try {
                executionResult = await alpacaService.placeBracketOrder({
                    symbol: ticker,
                    qty: 1, // Mínimo de plata absoluto (1 acción)
                    side: action.toLowerCase() === 'sell' ? 'sell' : 'buy',
                    takeProfitLimit: payload.tp ? parseFloat(payload.tp) : undefined,
                    stopLossStop: payload.sl ? parseFloat(payload.sl) : undefined
                });
            } catch(alpacaErr) {
                console.error("Alpaca execution error:", alpacaErr.message);
            }
        } else if (broker === 'pepperstone' && pepperstoneCentinela) {
            try {
                executionResult = await pepperstoneCentinela.processIncomingSignal({
                    action: action,
                    ticker: ticker,
                    price: price,
                    score: payload.score || 65,
                    pez: payload.pez || '🐬 DELFÍN',
                    sl: payload.sl,
                    tp: payload.tp
                });
            } catch(pepErr) {
                console.error("Pepperstone execution error:", pepErr.message);
            }
        }

        // Format Telegram Message
        const isBuy = action === "BUY";
        const icon = isBuy ? "🟢" : "🔴";
        const typeStr = isBuy ? "CALL (Compra)" : "PUT (Venta)";
        let assetEmoji = "📈";
        if (ticker.includes("NVDA")) assetEmoji = "💚";
        else if (ticker.includes("TSLA")) assetEmoji = "🚗";
        else if (ticker.includes("XAU")) assetEmoji = "🥇";
        else if (ticker.includes("SOL")) assetEmoji = "🟣";

        const brokerLabel = broker === 'alpaca' ? 'Alpaca Markets ($100k Paper)' : 'Pepperstone cTrader (€200 ECN)';

        const tgText = `🇷🇺👑 <b>[Anastasia CIO • DISPARO AUTÓNOMO EN LA NUBE]</b>\n\n` +
            `${assetEmoji} <b>${ticker} ${typeStr} EJECUTADO</b> ${icon}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🏢 <b>Broker:</b> ${brokerLabel}\n` +
            `💵 <b>Precio:</b> $${price.toFixed(2)}\n` +
            `⚡ <b>Score:</b> ${payload.score || 65} (${payload.pez || '🐬 DELFÍN'})\n` +
            `🛡️ <b>Stop Loss:</b> ${payload.sl ? '$' + payload.sl : 'Automático (-1.5 ATR)'}\n` +
            `🎯 <b>Take Profit:</b> ${payload.tp ? '$' + payload.tp : 'Automático (+3.0 ATR)'}\n` +
            `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Rome' })} (Italia)\n` +
            `☁️ <b>Servidor:</b> Google Cloud Functions 24/7\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<i>Anastasia opera 100% de forma autónoma. No tienes que hacer nada, Pedro.</i>`;

        // Send to Telegram
        await sendTelegramMessage(tgText);

        return res.status(200).json({
            success: true,
            message: "Trade successfully processed and executed autonomously by Anastasia",
            broker: broker,
            execution: executionResult,
            tradeId: docId,
            telegramSent: true
        });
    }

    // 2. GET TRADES ENDPOINT
    if (path === "/trades" || path === "/api/trades") {
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

    // 3. HEALTH CHECK & PING
    return res.status(200).json({
        status: "ONLINE",
        message: "Kraken Google Cloud 24/7 Backend is running smoothly!",
        timestamp: new Date().toISOString()
    });
});
