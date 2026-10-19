#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo test --workspace
cargo build -p drouter-simulator
npm --prefix cloud run test
npm --prefix cloud run build
npm --prefix cloud run test:e2e
