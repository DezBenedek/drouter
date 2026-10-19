#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
espflash save-image --chip esp32s3 --flash-size 16mb \
  --partition-table firmware/partitions.csv \
  --bootloader target/xtensa-esp32s3-espidf/release/bootloader.bin \
  --merge target/xtensa-esp32s3-espidf/release/drouter-firmware \
  target/drouter-esp32s3.bin
