#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -f ./export-esp.sh ]; then . ./export-esp.sh; fi
cd firmware
cargo +esp build --features esp --release --locked
