# Changelog

## [0.2.4] - 2026-10-26

### Fixed

- Keep the relay WebSocket alive with 30 s protocol pings so idle connections are not dropped by middleboxes (previously 300 s).

## [0.2.3] - 2026-10-26

### Fixed

- Remote access works (resolves the v0.2.2 known issue): `esp_websocket_client` 1.4's normal BEGIN/FINISH events are reported as `ESP_ERR_INVALID_ARG` by `esp-idf-svc` 0.52; ignore these unsupported lifecycle events while retaining transport-error handling. Allow 25 seconds for connection establishment and a separate 15 seconds for registration, with connection, registration and failure diagnostics.

### Added

- Onboard WS2812 status LED (GPIO21): blue blink in setup mode, fast amber blink when offline, solid green when online, solid cyan while the cloud relay is connected.
- Access Control single-profile experience: header toggle switch, inline editor auto-opened for the first enabled profile, quick enable/disable without leaving the page. New "Buttons" label in English and Hungarian.

## [0.2.2] - 2026-10-26

### Added

- mDNS on the ESP32 (`espressif/mdns 1.8.2`): the admin UI is reachable at `http://drouter.local` with an advertised `_http` service, on the setup network and on the station network.
- Persistent device access point after setup: `DRouter-<device-name>` (WPA2, alongside the station client), following renames without reboot.
- Relay diagnostics: `GET /relay/health` returns service status on the Worker.
- Local settings dialog no longer remounts the routing table; the Wi-Fi section has a single `+` button in the header row with the actions beside each entry.

### Changed

- Setup access-point password is the fixed `drouter123` instead of a random per-boot value.
- Relay WebSocket timeouts raised on the ESP32 (connect 5s to 20s, task stack 8K to 12K) with a warning log on connect failure.

### Known issues (fixed in 0.2.3)

- Remote access does not work: the ESP32 cannot establish the relay WebSocket to `drouter.dezso.hu` (`websocket not connected` loop). Under investigation.

## Unreleased

- Replace Pico with locally bundled Oat UI 1.0.0 in both interfaces; remove the Sass build step.
- Rework mobile navigation, output cards, quick-source controls, grouped lists, full-screen source selection and bottom-sheet editors. Reduce repeated page and settings copy.
- Use Sonner 2.0.8 for remote notifications with swipe dismissal and native-dialog support. Keep matching lightweight notifications on the embedded controller.
- Add outside-tap/Escape dismissal to mobile More, reset scroll on page changes and distinguish empty search results from missing receivers.

## [0.2.1] - 2026-10-19

### Fixed

- Recorded the production `drouter.dezso.hu/*` Worker route in deployment configuration. The default device address and public interface now share the verified HTTPS/WSS origin.
- Registry storage/service failures no longer masquerade as occupied names. Remote Access shows separate English/Hungarian messages for ownership conflicts, temporary registry outages, rejected identities and a second instance using the same identity.
- Configuration changes interrupt connection retry backoff within one second. Closing device sockets no longer block replacement connections, and delayed close events cannot disconnect browsers attached to a newer connection.
- Removed the relay's forced daily device disconnect; browser authorization remains independently bounded and enforced by the device.
- Local remote-access enable/disable reports the acknowledged change with a success notification before requesting reauthentication. Remote settings workflows stop refreshing a session after intentional logout. Toast entry animations retain full text contrast from the first frame.

### Changed

- Ordinary local and remote sessions last 24 hours instead of 30 minutes. The relay respects shorter lifetimes advertised by older firmware. Five-minute authorization for sensitive changes, logout, password/profile/session revocation, encrypted traffic and replay protection remain enforced.
- Passwords and session keys remain temporary browser-memory data; closing/reloading the interface or losing the device connection still requires authentication.

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

[0.2.1]: https://github.com/DezBenedek/drouter/releases/tag/v0.2.1
