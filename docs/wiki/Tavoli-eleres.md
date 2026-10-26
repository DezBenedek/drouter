# Távoli elérés

## Hogyan működik

- A device kimenő WSS kapcsolatot nyit: `wss://drouter.dezso.hu/relay/<deviceId>/device`.
- A böngésző az eszköz **nevével + admin jelszóval** lép be a publikus oldalon; a jelszó/verifier sose megy át a Cloudflare-en olvashatóan (SRP + irányonkénti AES-GCM).
- Diagnosztika: `GET https://drouter.dezso.hu/relay/health` → `{"ok":true,...}`.
- Élő ellenőrzés gépről: `cd cloud && DROUTER_LIVE_ORIGIN=https://drouter.dezso.hu node tests/live-relay-check.mjs`.

## Beállítás az eszközön

Settings → Remote Access → bekapcsolás. Alap szerver: `https://drouter.dezso.hu` (egyéni szervert csak indokolt esetben). A `Connection` mező mutatja az állapotot (`connecting` / `connected` / hibanév).

## Történet

v0.2.2-ben az ESP32 nem tudott csatlakozni (`websocket not connected` hurok): az `esp_websocket_client` 1.4 BEGIN/FINISH lifecycle eseményeit az `esp-idf-svc` 0.52 `ESP_ERR_INVALID_ARG`-ként jelentette, és a kód ezt transport-hibának vette. v0.2.3 óta ezek figyelmen kívül vannak hagyva, 25 s connect + 15 s regisztrációs idővel — a relay azóta működik.
