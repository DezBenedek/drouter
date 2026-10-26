# Hálózat

## AP+STA egyszerre

Az ESP32 egyszerre hostol és csatlakozik (Mixed AP+STA):

- Saját AP: `DRouter-<eszköznév>`, `drouter123` (WPA2) — mindig él, ha van konfig.
- Kliens: a beállított otthoni Wi-Fi (pl. `NagymiNet`) és/vagy Ethernet (W5500, SPI).

Az AP az admin elérés biztonsági hálója: ha a Wi-Fi/Ethernet elmegy, a device hálózaton át (`http://drouter.local`) akkor is elérhető.

## mDNS

- Hostnév fixen: **`drouter`** → `http://drouter.local` mindkét hálózaton.
- Hirdetett szolgáltatás: `_http._tcp:80`.
- Megjegyzés: Windows Bonjour nélkül és sok Android böngésző nem oldja fel a `.local` neveket — ilyenkor a konkrét IP használandó (AP: `192.168.71.1`, STA: DHCP-s cím az USB logban).

## Ethernet

W5500 SPI Ethernet, DHCP alapból. Ha Ethernet és Wi-Fi egyszerre megy, **különböző, nem átfedő subnetek** kellenek (a BirdDog forgalom az Ethernet oldalon megy).

## Recovery (BOOT gomb)

- **3 mp nyomva**: felfedi az AP adatokat az USB logban.
- **12 mp nyomva**: konfig törlés + restart (új identitás, setup elölről). A foglalt relay nevek ettől még védettek maradnak.

## Státusz LED

Onboard WS2812 (GPIO21):

- kék villogás (1 Hz): setup mód, nincs konfig
- narancs gyors villogás: van konfig, de nincs net
- zöld folyamatos: online (STA/Ethernet él)
- cián folyamatos: cloud relay csatlakozva
