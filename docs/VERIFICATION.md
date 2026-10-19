# Software verification

Verified on macOS Apple Silicon on 2026-10-19. No Waveshare board or physical BirdDog receiver was available. The Worker was subsequently deployed to Cloudflare; no physical flashing was performed.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo test --workspace` | 24 tests passed: authentication, routing/readback, Wi-Fi policy, presets, persistence, limits, replay/expiry, validation and rollback |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo build -p drouter-simulator` | Passed on macOS |
| `npm test --prefix cloud` | 9 Worker/protocol/localization tests passed |
| `npm run build --prefix cloud` | TypeScript check and production React/Vite build passed |
| `npm run test:e2e --prefix cloud` | 38 integration checks passed against fresh real Wrangler and simulator processes, including Chromium |
| `npm audit --prefix cloud` | No known vulnerabilities reported in the locked dependency set |
| `cargo +esp build --features esp --release --locked` inside `firmware/` | Xtensa ESP32-S3 release cross-build passed |
| `./scripts/firmware-image.sh` | Merged 16 MB flash image generated; no USB device accessed |

The shared authentication crate intentionally emits both `rlib` and browser `cdylib`. The ESP compiler reports that the unsupported `cdylib` output is dropped and successfully builds the `rlib`; this is the only expected cross-build warning.

## v0.2.0 release verification

The UI/UX and toast release was rebuilt and rechecked on 2026-10-19:

- `DROUTER_TEST_PORT_OFFSET=12000 ./scripts/test.sh`: Rust formatting, 24 native tests, 9 Worker tests, TypeScript/production build and all 38 simulator/relay/Chromium checks passed.
- `cargo clippy --workspace --all-targets -- -D warnings` passed; `npm audit --prefix cloud --audit-level=low` reported zero vulnerabilities.
- Real local/remote browser checks cover 320–1920px layouts, one-click routing and mobile quick sources, Event Mode transitions, inline edits, ten-button profiles, English/Hungarian, and axe accessibility. Toast checks cover desktop/mobile positions, native dialogs, dismissal, expiry and navigation access without weakening CSP.
- ESP32-S3 release cross-build passed using the existing ESP toolchain, followed by `./scripts/firmware-image.sh`. Application size: 1,888,032 / 7,340,032 bytes (25.72%); merged flash image: 16,777,216 bytes.
- Firmware SHA-256: `5eb229b0f6cc646306118795801009c8cc9b5386e4325ddda72889d2068039e8`. The release includes this binary and matching `SHA256SUMS`.
- Wrangler production dry-run passed with existing relay/registry bindings. The deployment receipt and live verification are recorded below.

No physical flashing or board/BirdDog hardware acceptance was performed.

## Integration coverage

The runner provisions a new temporary device and exercises real HTTP control against two virtual BirdDog servers. It verifies:

- The complete five-step mobile setup wizard, token-free first setup, optional Wi-Fi, finished screen, and entry into local Routing without Cloudflare.
- Real mutable virtual BirdDog HTTP state, verified source changes, ignored switches, timeouts, offline outputs, Ethernet errors, preset capture, and partial preset failures.
- Wi-Fi add/edit/password redaction, ordering, duplicate-order rejection, profile enablement, fallback/hysteresis, storage capacity, remote disconnect guards, and configuration migration. Native tests preserve old profile order, identity, and verifier.
- Device-mediated SRP login through real Wrangler, wrong passwords, encrypted command authorization, replay/expiry/revocation, malformed JSON, message limits, and request deadlines.
- Offline local control, cloud reconnection, simulator restart persistence, immutable device identity, and boot readback without forcing saved routes.
- Signed SQLite registration, duplicate live identities, proof replay, name collision while the owner is offline, stable ID across renaming, protected old-name aliases, and device impersonation rejection.
- Complete Worker restart with the same SQLite directory. Another valid identity remains unable to claim the original name, while the original device reconnects.
- Inspection of the actual SQLite database: exactly the allowed device metadata columns and reserved aliases; no password, Wi-Fi secret, preset, or routing configuration payloads.
- Password changes invalidate the previous password without changing the reserved identity. Local recovery imports the original identity, creates a new password verifier, preserves name ownership, and revokes remote sessions. Remote recovery-key export is rejected.
- Real Chromium local and React UIs at 375, 430, 768, 1366, and 1920 pixels; three-source and 64-source routing; actual source selection through desktop crosspoints and mobile sheets; keyboard navigation/Escape; native settings navigation; preset confirmation; light/dark appearance; no viewport overflow, browser runtime errors, or CSP errors.

Modification 3 additionally verifies:

- Saved-source creation, aliases, original identifiers, reordering, confirmed removal and cancellation; aliases and profiles survive an actual simulator restart.
- Independent searchable Other source selectors route different outputs without saving unsaved sources. Desktop source rows/output columns and output-first mobile sheets operate against real simulated receivers.
- Multiple distinct four-character Simple Mode passwords, profile selection, duplicate-password rejection, unique salts and Unicode scalar counting. Native tests cover supplementary-plane and combining characters, failed-proof backoff, expiration, replay and session limits.
- Restricted local and relay sessions reject administrator operations, foreign button IDs and client-supplied target overrides. Fixed buttons verify actual receiver readback and reject double taps and unavailable targets.
- Browser profile creation with multiple buttons, direct saving, cancellation of disable/delete edits, separate restricted mobile interfaces, routing feedback and no administrator navigation.
- Event Mode blocks existing and new restricted sessions locally and remotely; administrator routing remains available. Deactivation restores restricted actions and enabled profiles. Event Mode persists through process restart; missing/corrupt state locks access in native/storage tests.
- Local Simple Mode operation during Cloudflare outages. Real SQLite inspection confirms no profile names, source aliases, passwords, presets or routing configuration were persisted by Cloudflare.
- Hungarian and English local/remote login, reload persistence, profile labels retained as user content, Contact mailto links and actual Hungarian screenshots. Translation/protocol tests cover the complete dictionary and required workflow keys. Reduced-motion rules and long-label handling were inspected in the shared stylesheet.

The simulator now uses an asynchronous device mutex for background network/relay tasks and blocking-lock acquisition only inside the blocking command executor. This fixes virtual receiver starvation during concurrent password hashing and relay/network polling; the complete integration runner includes the previously failing editor path.

The 38 integration checks complement 24 native tests and nine Worker/protocol/localization tests. Desktop/mobile screenshots were inspected and refined for header density, source-search alignment, sheets, Wi-Fi list readability, and dark-mode consistency.

The runner uses a temporary simulator and SQLite registry directory, refuses occupied ports and terminates its owned process trees. Token-free setup verification uses `DROUTER_TEST_PORT_OFFSET=10000` to run alongside the user’s simulator, with HTTP ports 18080/18787 and BirdDog ports 19001/19002. Browser screenshots are in `docs/screenshots/`.

## Toolchain snapshot

- Native Rust 1.96.1.
- ESP Rust 1.97.0.0 (`rustc 1.97.0-nightly`, espup 0.18.0 installation).
- ESP-IDF 5.4.2, esp-idf-svc 0.52.1, esp-idf-hal 0.46.2.
- esp_websocket_client 1.4.0, pinned by `components_esp32s3.lock`.
- espflash 4.6.0.
- Node 22.23.2, TypeScript 5.9.3, React 19.3.1, Vite 7.3.7.
- Wrangler 4.151.2, Vitest 5.0.5, Playwright 1.64.1.

The v0.1.0 firmware application image was 1,885,056 bytes of its 7,340,032-byte slot (25.68%). `target/drouter-esp32s3.bin` is a merged 16 MB image with the configured bootloader and partition table. SHA-256: `7b118a02c74a36fd35a0a6c28814ba5ade2e99095e64a19c5f8634570fbbbf31`. Build products are ignored by version control and regenerated by the documented scripts.

Physical SPI/PSRAM, DHCP/radio timing, NVS power-cut behavior, USB flashing, actual BirdDog interoperability, eFuse security provisioning and long-running stability remain unverified. See `HARDWARE-ACCEPTANCE.md`. API 1.0 and a universal physical BirdDog discovery mechanism are not advertised. The minimal SQLite registry permanently reserves friendly names; it has no password or account database. The custom production hostname remains configured as a default; the public workers.dev deployment is recorded below.


## v0.2.0 public Cloudflare deployment verification

Published on 2026-10-19 to `https://drouter.dezbenedek.workers.dev`, tagged `v0.2.0`, Worker version `bb38989e-70ac-464e-9385-306fa9eafa8b`. Production variables and existing relay/SQLite registry bindings were preserved.

The isolated `DROUTER_LIVE_ORIGIN=https://drouter.dezbenedek.workers.dev node tests/live-relay-check.mjs` passed all four live checks: outbound localhost registration; remote administrator authentication and verified virtual BirdDog switching over public WSS; restricted Simple Mode authorization and firmware-enforced Event Mode; and the deployed mobile React interface without runtime errors or overflow.

The temporary simulator and encrypted state were removed. Only the minimal test-device registration `deploy-check-0cae375b37` remains reserved, as designed. The existing user device and `drouter.dezso.hu` DNS/custom-domain configuration were not changed.

## v0.1.0 public Cloudflare deployment verification (history)

Deployed on 2026-10-19 to `https://drouter.dezbenedek.workers.dev`, version `7b8c6cce-70ea-471f-887f-67303686bc88`. Production build and Wrangler dry-run passed before publication. Public HTTPS returned 200 with the configured CSP and security headers.

`DROUTER_LIVE_ORIGIN=https://drouter.dezbenedek.workers.dev node tests/live-relay-check.mjs` passed against an isolated localhost simulator and two real virtual BirdDog HTTP servers. It verified outbound device registration, public WSS administrator authentication, actual switch/readback, separate Simple Mode authentication, administrator API rejection, fixed-button routing, Event Mode blocking with administrator routing preserved, deactivation, and Chromium mobile login without viewport overflow or runtime errors.

The temporary simulator and encrypted local state were removed. The minimal test-device registration `deploy-check-7f7711cf6e` remains reserved by design; no passwords, source definitions, actions or profile definitions were persisted in Cloudflare. The existing local device named `router` was left unchanged. `drouter.dezso.hu` still resolves to its previous server and was not reconfigured; its current TLS certificate does not match that hostname. Use the verified workers.dev origin until custom-domain routing is configured.
