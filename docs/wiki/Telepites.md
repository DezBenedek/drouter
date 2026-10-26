# Telepítés (firmware flash)

## Előfeltételek

- Rust + `esp` toolchain (`espup`, `espflash`, `ldproxy` a README szerint)
- A board USB-C **data** portja bedugva (nem csak táp)

Port ellenőrzése:

```sh
espflash list-ports
```

Tipikus port macOS-en: `/dev/cu.usbmodem101`.

## Build + flash

Repo gyökérből:

```sh
./scripts/build-firmware.sh
espflash flash \
  --chip esp32s3 \
  --port /dev/cu.usbmodem101 \
  --flash-size 16mb \
  --partition-table firmware/partitions.csv \
  --bootloader target/xtensa-esp32s3-espidf/release/bootloader.bin \
  --monitor \
  target/xtensa-esp32s3-espidf/release/drouter-firmware
```

A `--monitor` végén ott marad a soros log — az első boot adatait (setup AP név/jelszó) itt látod.

## Ha nem megy bootloaderbe

Tartsd nyomva a **BOOT** gombot, nyomd meg a **RESET**-et, engedd el a BOOT-ot, majd retry.

## Fontos tudnivalók

- Sima reflash **nem törli a konfigot**: a beállítás külön `config` partíción él. Csak az app slot (`ota_0`) íródik újra.
- Törlés csak explicit parancsra: `espflash erase-parts --port ... config`, vagy `espflash erase-flash` (minden), vagy a boardon **12 mp BOOT** / UI factory reset.
- Release image gyártása: `./scripts/firmware-image.sh` → `target/drouter-esp32s3.bin`.
