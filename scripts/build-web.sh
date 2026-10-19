#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo build -p drouter-auth --target wasm32-unknown-unknown --release
WASM_BINDGEN=${WASM_BINDGEN:-wasm-bindgen}
"$WASM_BINDGEN" target/wasm32-unknown-unknown/release/drouter_auth.wasm --target web --out-dir firmware/web/shared --out-name auth --no-typescript
node scripts/pack-web.mjs
