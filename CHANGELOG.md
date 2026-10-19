# Changelog

## [0.2.0] - 2026-10-19

Complete local and remote UI redesign, focused routing workflows, and shared Sonner-style notifications.

### Added

- Locally compiled, extensively customized Pico CSS foundation shared by ESP32 and Cloudflare, with system fonts and no runtime CDN dependencies.
- Dedicated mobile navigation and one-touch saved-source buttons per output, with All Sources always visible beside them.
- Administrator Event Mode switch in the main header on every screen, with one confirmation and device-confirmed state.
- Shared success, progress and error toasts at bottom-left on desktop and above the bottom menu on mobile. Notifications stay accessible above native dialogs and the open More panel, support dismissal and timed expiry, pause on hover/focus, and respect English/Hungarian, dark mode and reduced motion.
- Browser acceptance for ten-button profiles, header Event Mode, failed/pending quick routes, toast placement/lifecycle and axe accessibility.

### Improved

- Compact desktop routing matrix, sticky headers, searchable source/output lists and preserved one-click switching.
- Inline source renaming without a second confirmation; direct device, preset and Wi-Fi editing controls.
- Simple Mode profile editor with grouped password settings and numbered, collapsible 1–10 fixed-action mappings.
- Destructive confirmations remain open until the operation completes. Partial preset failures use error feedback; route success requires actual receiver verification.
- Removed overlapping cloud/shared polling, avoided unchanged DOM replacement, preserved matrix keyboard focus, and paused background restricted-mode reads.
- Minified/gzipped ESP32 JavaScript payloads while retaining readable source files and unchanged authentication/WASM. Pico, Sass and axe are development-only dependencies.
- Preserved backend routing, security, permissions, recovery, contact information and existing configuration compatibility.

### Verification

- 24 Rust tests, 9 Worker/protocol/localization tests and 38 simulator/relay/Chromium integration checks passed.
- Desktop/mobile layouts exercised from 320 to 1920 pixels; screenshots inspected; populated local/remote routing screens passed axe WCAG 2 A/AA and 2.1 AA checks.
- Toast desktop/mobile positioning, modal visibility, manual dismissal, automatic expiry, menu access and CSP behavior verified.
- TypeScript/production build, Rust formatting/Clippy, dependency audit, ESP32-S3 cross-build and merged firmware image verified for this release.
- Live Cloudflare checks passed for localhost registration, public WSS administrator routing, restricted Simple Mode/Event Mode authorization and the deployed mobile interface.

### Release artifacts

`drouter-esp32s3.bin` is the merged 16 MB image for Waveshare ESP32-S3-ETH SKU 28972; `SHA256SUMS` verifies it. The remote interface is published at https://drouter.dezbenedek.workers.dev.

Physical ESP32/BirdDog acceptance remains outstanding; see docs/HARDWARE-ACCEPTANCE.md. This release does not change the `drouter.dezso.hu` custom-domain configuration.

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

[0.2.0]: https://github.com/DezBenedek/drouter/releases/tag/v0.2.0
