# DRouter wiki

Standalone Rust NDI routing controller **Waveshare ESP32-S3-ETH** boardra, opcionális Cloudflare távoli eléréssel.

- Repo: [DezBenedek/drouter](https://github.com/DezBenedek/drouter)
- Aktuális release: **v0.2.4** (lásd: [CHANGELOG](https://github.com/DezBenedek/drouter/blob/main/CHANGELOG.md))

## Oldalak

- [[Telepites]] – firmware build és flash lépésről lépésre
- [[Beallitas]] – első boot, setup varázsló, `drouter.local`
- [[Halozat]] – AP+STA működés, Ethernet, mDNS, recovery
- [[Tavoli-eleres]] – Cloudflare relay, regisztráció, diagnosztika
- [[Kezelofelulet]] – routing táblázat, Wi-Fi és settings tudnivalók

## Státusz

**A távoli elérés v0.2.3 óta működik.** (v0.2.2-ben még törött volt a relay WebSocket handshake — részletek: [[Tavoli-eleres]].)
