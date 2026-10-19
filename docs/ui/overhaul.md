# Interface audit and redesign

The local and remote apps share a vanilla control module but had separate shells and redundant polling. The old stylesheet grew to 1,965 lines with conflicting mobile overrides. Six equal mobile tabs reduced labels to 9px. Routine source renames, profile creation and reordering required a second confirmation. Event Mode could only be changed through Settings, with an indicator visible only when enabled. Profile configuration stacked every field vertically, and devices/presets hid editing behind nested dialogs. Polling replaced DOM nodes even when visible state was unchanged, losing keyboard focus.

The new design uses a locally compiled subset of Pico CSS, system typography, blue selection states, a quiet desktop sidebar and a five-item mobile tab bar. Routing retains source rows, output columns and one-click verified crosspoints. Mobile adds direct saved-source actions per output and a searchable source sheet. Event Mode is an always-visible header switch with one confirmation and device-confirmed state. Routine edits save directly; removal, access revocation, live network changes and Event Mode retain safeguards. Profile forms group identity/password fields and compact numbered action mappings. Devices and presets expose editing directly.

## Implementation

- `scripts/pico.scss` selects only Pico’s document, buttons, links, form basics and accessibility utilities. It excludes cards, navigation, grids, dropdowns and modal machinery. The compiled foundation is isolated in a CSS layer beneath `scripts/design.css`; no relaxed CSP is required.
- `firmware/web/shared/control.js` owns the same routing, source, profile and access workflows in both apps. Header Event Mode updates use device-confirmed information. Destructive confirmations stay open and disable cancellation while their request is executing; failures remain visible in the dialog.
- The cloud shell stops duplicate polling on pages owned by the shared controller. Routing polls four operations every ten seconds instead of six, with the former seven-operation cloud shell poll removed. Access Control polls one operation. Restricted controls avoid background and overlapping reads. Unchanged visible markup is not replaced, and routing retains keyboard focus across pending verification.
- Gzip payloads are built from minified JavaScript while keeping readable source files. The local shell/control payloads total about 18.8 KiB gzip; the English/Hungarian dictionary is about 14.0 KiB and shared CSS is about 8.9 KiB. Existing cryptography and WASM are unchanged. The cloud production JS bundle is about 122 kB gzip, including React and the existing client/authentication code; the redesign adds no runtime JavaScript dependency.

## Acceptance

Run `node scripts/pack-web.mjs` followed by `DROUTER_TEST_PORT_OFFSET=12000 ./scripts/test.sh` to test without disturbing a simulator on the default ports.

The checks cover 24 Rust tests, 9 Worker tests, TypeScript/production builds and 38 real simulator/relay integration checks. Chromium exercises desktop and mobile layouts at 320, 375, 390, 430, 768, 899, 900, 1024, 1366, 1440 and 1920 pixels; light/dark appearance; English/Hungarian; keyboard matrix navigation; inline rename/save/cancel; ten-button profile creation and deletion; header Event Mode confirmation/cancel; real quick-source switching; ignored-switch failures; and existing permissions, recovery and relay behavior. axe checks WCAG 2 A/AA and 2.1 AA on populated desktop and mobile routing screens in both interfaces.

Rendered screenshots are saved in `docs/screenshots/`. Representative evidence:

- [Desktop routing](../screenshots/local-redesign-desktop.png)
- [Mobile routing](../screenshots/remote-redesign-mobile.png)
- [Hungarian mobile routing](../screenshots/remote-redesign-mobile-hu.png)
- [Sources](../screenshots/remote-sources-desktop.png)
- [Profile editor](../screenshots/local-profile-editor-desktop.png)
- [Mobile Wi-Fi](../screenshots/local-wifi-mobile.png)

Physical ESP32 flashing, on-device memory measurements and real BirdDog hardware acceptance remain separate from host-simulator validation. The v0.2.0 release publishes these interfaces to the existing Cloudflare Worker; physical device flashing remains separate.

## Notifications

Transient login, setup, form, routing, Simple Mode and operation feedback now shares a small vanilla Sonner-style toast controller. It renders at bottom-left on desktop and above the mobile tab bar (or open More panel), works in native dialog/popover top layers, supports English/Hungarian and light/dark themes, and keeps at most three notifications. Progress updates replace their own toast; success follows actual device verification. Success/info dismiss after five seconds and errors after ten, with hover/focus pause and accessible close buttons. Destructive confirmations and persistent device lock state retain their existing behavior.

Browser acceptance additionally checks desktop/mobile placement, native modal errors, manual dismissal and automatic expiry in both local and remote apps. Representative captures: [desktop toast](../screenshots/local-toast-desktop.png), [mobile toast](../screenshots/remote-toast-mobile.png), and [dialog error](../screenshots/local-toast-dialog.png).
