# Távoli elérés

> ⚠️ **v0.2.2-ben nem működik** (lásd lent). A helyi hálózat teljes értékű.

## Hogyan kéne működnie

- A device kezdeményez kimenő WSS kapcsolatot: `wss://drouter.dezso.hu/relay/<deviceId>/device`.
- A böngésző az eszköz **nevével + admin jelszóval** lép be a publikus oldalon; a jelszó/verifier sose megy át a Cloudflare-en olvashatóan (SRP + irányonkénti AES-GCM).
- Diagnosztika: `GET https://drouter.dezso.hu/relay/health` → `{"ok":true,...}`.
- Élő ellenőrzés gépről: `cd cloud && DROUTER_LIVE_ORIGIN=https://drouter.dezso.hu node tests/live-relay-check.mjs`.

## Beállítás az eszközön

Settings → Remote Access → bekapcsolás. Alap szerver: `https://drouter.dezso.hu` (egyéni szervert csak indokolt esetben). A `Connection` mező mutatja az állapotot (`connecting` / `connected` / hibanév).

## Ismert hiba (v0.2.2)

Az ESP32 a TLS-ig eljut (`Certificate validated`), de a handshake minden próbálkozásnál eldobódik (`websocket not connected` hurok), így `challenge/register` meg sem történik. Élő Node-klienssel a relay átmegy, tehát a hiba ESP-oldali. Próbált enyhítés: hosszabb timeout (20 s), nagyobb WS task stack — visszaigazolásra vár.
