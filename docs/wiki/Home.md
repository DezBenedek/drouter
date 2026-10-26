# DRouter wiki

Standalone Rust NDI routing controller **Waveshare ESP32-S3-ETH** boardra, opcionális Cloudflare távoli eléréssel.

- Repo: [DezBenedek/drouter](https://github.com/DezBenedek/drouter)
- Aktuális release: **v0.2.2** (lásd: [CHANGELOG](https://github.com/DezBenedek/drouter/blob/main/CHANGELOG.md))

## Oldalak

- [[Telepites]] – firmware build és flash lépésről lépésre
- [[Beallitas]] – első boot, setup varázsló, `drouter.local`
- [[Halozat]] – AP+STA működés, Ethernet, mDNS, recovery
- [[Tavoli-eleres]] – Cloudflare relay, regisztráció, diagnosztika
- [[Kezelofelulet]] – routing táblázat, Wi-Fi és settings tudnivalók

## ⚠️ Ismert hiba (v0.2.2)

**A távoli elérés (remote access) nem működik.** Az ESP32 nem tudja felépíteni a relay WebSocket kapcsolatot a `drouter.dezso.hu` felé (`websocket not connected` hurok az USB logban). Vizsgálat alatt. A helyi hálózat minden funkciója működik.
