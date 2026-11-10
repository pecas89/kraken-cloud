using System;
using System.Net.Http;
using System.Threading.Tasks;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class KrakenSentinelcBot : Robot
    {
        [Parameter("Kraken Backend API", DefaultValue = "https://kraken-trading-cloud.web.app/api/signals")]
        public string SignalUrl { get; set; }

        [Parameter("Volumen Base (Lotes)", DefaultValue = 0.01, MinValue = 0.01, Step = 0.01)]
        public double VolumeLots { get; set; }

        [Parameter("Stop Loss (Pips)", DefaultValue = 25, MinValue = 5)]
        public double StopLossPips { get; set; }

        [Parameter("Take Profit (Pips)", DefaultValue = 50, MinValue = 10)]
        public double TakeProfitPips { get; set; }

        [Parameter("Intervalo de Escaneo (Segundos)", DefaultValue = 5, MinValue = 2)]
        public int PollingSeconds { get; set; }

        private static readonly HttpClient client = new HttpClient();
        private string lastExecutedTradeId = "";

        protected override void OnStart()
        {
            Print("🐙 [KRAKEN CLOUD] Sentinel Célula Pepperstone Iniciada en cTrader.");
            Print("🏦 Cuenta: {0} | Saldo: {1} {2} | Apalancamiento: 1:{3}", Account.Number, Account.Balance, Account.Currency, Account.Leverage);
            
            // Iniciar temporizador de escaneo de señales
            Timer.Start(TimeSpan.FromSeconds(PollingSeconds));
        }

        protected override void OnTimer()
        {
            // Consultar señales activas de Anastasia / 26 Hermanas en la nube
            CheckKrakenSignal();
        }

        private async void CheckKrakenSignal()
        {
            try
            {
                // En modo demostración local, si no hay backend activo, monitorear órdenes
                // Para conectar al webhook de Google Cloud:
                // var response = await client.GetStringAsync(SignalUrl);
            }
            catch (Exception ex)
            {
                Print("⚠️ [KRAKEN] Error de enlace con la nube: {0}", ex.Message);
            }
        }

        public void DispararOrdenMercado(TradeType tipo, double lotes, double slPips, double tpPips, string comentario)
        {
            var volumeInUnits = Symbol.QuantityToVolumeInUnits(lotes);
            var result = ExecuteMarketOrder(tipo, SymbolName, volumeInUnits, "KRAKEN", slPips, tpPips, comentario);
            
            if (result.IsSuccessful)
            {
                Print("✅ [KRAKEN EJECUTADO] {0} {1} lotes de {2} a precio {3}", tipo, lotes, SymbolName, result.Position.EntryPrice);
            }
            else
            {
                Print("❌ [KRAKEN ERROR] Falló ejecución: {0}", result.Error);
            }
        }

        protected override void OnStop()
        {
            Print("🛑 [KRAKEN CLOUD] Sentinel Célula Pepperstone Detenida.");
        }
    }
}
