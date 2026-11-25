# Mudanza del motor de Render a Google Compute Engine

Máquina: **e2-micro** en **us-east1** (Carolina del Sur), disco estándar de 30 GB. Entra en la capa gratuita de Google Cloud (1 e2-micro al mes en us-west1, us-central1 o us-east1). El proyecto necesita una cuenta de facturación activa, aunque no se cobre.

> Importante: **un solo motor a la vez.** Render debe quedarse suspendido. Si se reactivan los dos, operarían dos veces en los brokers.

## 1. Crear la máquina (una vez)

Desde la carpeta del repositorio, con `gcloud` iniciado con la cuenta de Pedro:

```bash
gcloud config set project kraken-trading-cloud
gcloud services enable compute.googleapis.com

gcloud compute firewall-rules create kraken-allow-web \
  --allow tcp:80,tcp:443 --target-tags kraken-web --description "HTTPS del motor Kraken"

gcloud compute instances create kraken-engine \
  --zone us-east1-b --machine-type e2-micro \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard \
  --tags kraken-web \
  --metadata-from-file startup-script=deploy/gcp_vm_setup.sh
```

El instalador tarda unos 3-5 minutos. Instala Node 22 y Caddy, descarga el motor de GitHub y deja preparado el servicio. **El motor no arranca todavía**, porque falta el archivo de claves.

## 2. Poner las claves (una vez)

Las mismas variables que había en Render (Render → servicio → *Environment*). Como guía de nombres sirve `functions/.env.example`. El motor también usa `FIREBASE_SERVICE_ACCOUNT` (Firestore), `KRAKEN_CEREBRO_TOKEN`, `TELEGRAM_TOKEN_ANASTASIA` y las `KRAKEN_*` que hubiera.

Si el `functions/.env` del PC está completo y al día:

```bash
gcloud compute scp functions/.env kraken-engine:/tmp/kraken.env --zone us-east1-b
gcloud compute ssh kraken-engine --zone us-east1-b --command \
  "sudo mv /tmp/kraken.env /opt/kraken-cloud/functions/.env && sudo chown kraken:kraken /opt/kraken-cloud/functions/.env && sudo chmod 600 /opt/kraken-cloud/functions/.env && sudo systemctl restart kraken && sleep 15 && cat /opt/kraken-cloud/.public_domain && sudo tail -n 20 /opt/kraken-cloud/logs/kraken.log"
```

No hay que imprimir el contenido del `.env` en ningún momento.

## 3. Comprobar

```bash
DOMAIN=$(gcloud compute ssh kraken-engine --zone us-east1-b --command "cat /opt/kraken-cloud/.public_domain")
curl -s https://$DOMAIN/health
```

La URL pública queda así: `https://<ip-con-guiones>.sslip.io`, por ejemplo `https://34-75-10-20.sslip.io`. Para probar el panel con el motor nuevo antes de publicarlo: `https://kraken-trading-cloud.web.app/?api=https://<esa-url>`.

## Día a día

- **Actualizaciones:** automáticas. Cada 5 minutos la VM mira `main` en GitHub; si hay commits nuevos, los aplica (sin tocar los archivos de estado) y reinicia el motor.
- **Logs:** `sudo tail -f /opt/kraken-cloud/logs/kraken.log`
- **Reiniciar:** `sudo systemctl restart kraken` · **Parar:** `sudo systemctl stop kraken`
- **Estado:** posiciones, laboratorio fantasma y semana viven en Firestore. Un motor nuevo los recupera al arrancar.
- **La IP** solo cambia si se *detiene* la VM (un reinicio no la cambia). Si cambiara, se vuelve a ejecutar `sudo bash /opt/kraken-cloud/deploy/gcp_vm_setup.sh` y se actualiza la URL en el panel.
