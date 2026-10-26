# Kezelőfelület

## Routing táblázat

- Sorok = források (`+ Add source`), oszlopok = receiverek (`+ Add device` → vevő felvétele **IP + port + channel** megadásával).
- Az utolsó **Other device** sorban a legördülő minden felfedezett NDI forrást mutat mentés nélkül.
- Egy útvonal csak vevő-visszaolvasás után lesz aktív.
- **Fizikai BirdDog auto-discovery nincs**: a BirdDog API 2.0 nem dokumentál univerzális receiver-keresést, ezért hardveren kézi IP-s felvétel van (a szimulátorban a `Discover receivers` az ismert virtuális végpontokat találja meg).

## Wi-Fi szekció (Settings → Network)

- Fejléc sor: `Wi-Fi` + egyetlen `+` gomb (hozzáadás).
- Minden sor: név, alatta `Connected / Saved / Disabled`, mellette jobbra a műveletek (↑ ↓ Edit kapcsoló Reconnect Remove).

## Settings viselkedés

- A settings dialog ki/be zárása **nem tölti újra** a routing táblázatot; mentés után a tábla a háttérben frissül (spinner csak az első betöltéskor van).

## Források, Simple Mode, Event Mode

- Részletek a repo [README](https://github.com/DezBenedek/drouter/blob/main/README.md) megfelelő fejezeteiben.
