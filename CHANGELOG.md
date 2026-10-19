# Changelog

## [0.1.0] - 2026-10-19

DRouter’s first release combines the redesigned local/remote interfaces with saved-source management, restricted Simple Modes, and device-enforced Event Mode.

## Added

- Sources page with stable saved-source IDs, DRouter-only aliases, ordering, availability, restart persistence, and explicit confirmation before configuration changes.
- Desktop routing matrix with saved-source rows, BirdDog output columns, and an independent searchable Other source selector per output. Unsaved sources route immediately without being saved.
- Output-first mobile routing with searchable source sheets.
- English and Hungarian localization for local/remote login, setup, settings, routing, dialogs and access controls; remembered browser language preference.
- Multiple independently authenticated Simple Mode profiles with 1–10 fixed routing buttons, configuration confirmations, ordering, enable/disable controls and preview.
- Persistent Event Mode controlled by administrators, enforced on the ESP32 for both existing and new restricted sessions.
- Four-to-128 Unicode scalar password validation, individually salted password verifiers, duplicate-profile-password rejection, role-scoped sessions, stronger login backoff and repeat-action protection.
- Contact link, restrained motion and reduced-motion support.
- Live public-relay verification against an isolated localhost simulator.

## Improved

- Compact desktop and mobile interfaces, source selection, routing feedback and setup wizard.
- Wi-Fi editing, ordering, failover controls and remote-disconnect confirmation.
- Immutable device identity, signed registration, persistent name reservations and local identity recovery.
- Safe configuration migration to schema 3, bounded storage and transport payloads, and locked recovery when Event Mode state cannot be trusted.
- Simulator concurrency: background network/relay tasks no longer block async workers while waiting for device operations.

## Deployment and data ownership

- Live interface: https://drouter.dezbenedek.workers.dev
- A localhost simulator can connect through outbound WSS without port forwarding. Set the HTTPS origin above in local Settings → Remote Access → Advanced · custom server, then enable remote access.
- Configuration and administrator/Simple Mode verifiers remain exclusively on the device. Cloudflare persists only minimal public registration and connection metadata.
- `drouter.dezso.hu` has not been pointed at this deployment; use the verified workers.dev address.

## Verification

- 24 Rust tests, 9 Worker/protocol/localization tests and 37 simulator/relay/Chromium integration checks passed.
- Rust formatting, Clippy, TypeScript/production build and dependency audit passed.
- ESP32-S3 release cross-build and merged 16 MB flash image generation passed.
- Live Cloudflare verification passed: localhost registration, administrator and Simple Mode authentication, actual virtual BirdDog switching, Event Mode authorization and the mobile React interface.

## Firmware asset

`drouter-esp32s3.bin` is the merged 16 MB image for Waveshare ESP32-S3-ETH SKU 28972. `SHA256SUMS` verifies the download. See README.md for flashing and recovery instructions.

Physical ESP32/BirdDog interoperability, power-loss recovery, resource/latency measurements and extended soak testing remain pending. Four-character passwords are weak; longer passwords are recommended. See docs/HARDWARE-ACCEPTANCE.md and docs/VERIFICATION.md for the acceptance boundary and recorded results.

[0.1.0]: https://github.com/DezBenedek/drouter/releases/tag/v0.1.0
