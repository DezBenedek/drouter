# Beállítás (első boot)

## Setup hálózat

Első induláskor a device setup AP-t nyit:

- SSID: `DRouter-Setup-XXXX`
- Jelszó: `drouter123`
- Admin: `http://drouter.local` vagy `http://192.168.71.1`

Csatlakozz a Wi-Fi-hez, nyisd meg az admin címet, és menj végig az 5 lépéses varázslón: **név + admin jelszó → Ethernet / opcionális Wi-Fi → opcionális távoli elérés → kész**.

## Setup után

- Saját állandó AP: **`DRouter-<eszköznév>`** (pl. `DRouter-db1`), jelszó: `drouter123`.
- Admin ugyanott: **`http://drouter.local`** — a setup hálózaton és az otthoni Wi-Fi-n is.
- Átnevezéskor az AP SSID reboot nélkül követi a nevet.

## Idők (mért)

| Lépés | Idő |
|---|---|
| Reset → setup AP + HTTP kész | ~2–3 mp |
| Setup után STA connect + IP | ~8–10 mp |
| Cloud relay + idősync | +10–30 mp |

Ha „halottnak” tűnik boot után, várj fél percet: a helyi admin már 3 mp után él, a relay viszont csak az idősync után áll fel.
