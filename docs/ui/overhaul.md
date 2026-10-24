# Interface audit and redesign

The local and remote apps share a vanilla control module but had separate shells and redundant polling. The old stylesheet grew to 1,965 lines with conflicting mobile overrides. Six equal mobile tabs reduced labels to 9px. Routine source renames, profile creation and reordering required a second confirmation. Event Mode could only be changed through Settings, with an indicator visible only when enabled. Profile configuration stacked every field vertically, and devices/presets hid editing behind nested dialogs. Polling replaced DOM nodes even when visible state was unchanged, losing keyboard focus.

The design now uses locally bundled Oat UI 1.0.0, system typography, neutral grouped surfaces, a quiet desktop sidebar and a five-item mobile tab bar. Routing retains source rows, output columns and one-click verified crosspoints. Mobile presents numbered output cards with a separate current route, up to four saved-source actions (including the active saved source), and a searchable full-screen selector. Editors open as bottom sheets; More dismisses on outside tap or Escape. Repeated page descriptions and settings captions have been removed. Event Mode is an always-visible header switch with one confirmation and device-confirmed state. Routine edits save directly; removal, access revocation, live network changes and Event Mode retain safeguards. Profile forms group identity/password fields and compact numbered action mappings. Devices and presets expose editing directly.

## Implementation

- `scripts/build-style.mjs` bundles the pinned `@knadh/oat` stylesheet in an `oat` CSS layer beneath the shared theme and application layout in `scripts/design.css`. No Sass compiler or runtime CDN is required. Oat theme tokens map to the local light/dark palette.
- `firmware/web/shared/control.js` owns the same routing, source, profile and access workflows in both apps. Header Event Mode updates use device-confirmed information. Destructive confirmations stay open and disable cancellation while their request is executing; failures remain visible in the dialog.
- The cloud shell stops duplicate polling on pages owned by the shared controller. Routing polls four operations every ten seconds instead of six, with the former seven-operation cloud shell poll removed. Access Control polls one operation. Restricted controls avoid background and overlapping reads. Unchanged visible markup is not replaced, and routing retains keyboard focus across pending verification.
- Gzip payloads are built from minified JavaScript while keeping readable source files. The local shell/control payloads total about 19.3 KiB gzip; the English/Hungarian dictionary is about 14 KiB and Oat plus shared CSS is about 14.3 KiB. Existing cryptography and WASM are unchanged. The cloud production JS bundle is about 130 kB gzip, including React, Sonner and the existing client/authentication code. Sonner’s published CSS ships as a separate local asset; a Vite transform removes its default style injection so the existing `style-src 'self'` policy remains intact.

## Acceptance

Run `node scripts/pack-web.mjs` followed by `DROUTER_TEST_PORT_OFFSET=12000 ./scripts/test.sh` to test without disturbing a simulator on the default ports.

Verification: TypeScript/production build, 12 Worker tests and 39 real simulator/relay integration checks passed on 2026-10-19. Chromium exercises desktop and mobile layouts at 320, 375, 390, 430, 768, 899, 900, 1024, 1366, 1440 and 1920 pixels; light/dark appearance; English/Hungarian; keyboard matrix navigation; empty output-search results; outside-tap/Escape menu dismissal; actual Sonner mounting; inline rename/save/cancel; ten-button profile creation and deletion; header Event Mode confirmation/cancel; real quick-source switching; ignored-switch failures; and existing permissions, recovery and relay behavior. axe checks WCAG 2 A/AA and 2.1 AA on populated desktop and mobile routing screens in both interfaces.

Rendered screenshots are saved in `docs/screenshots/`. Representative evidence:

- [Desktop routing](../screenshots/local-redesign-desktop.png)
- [Mobile routing](../screenshots/remote-redesign-mobile.png)
- [Hungarian mobile routing](../screenshots/remote-redesign-mobile-hu.png)
- [Sources](../screenshots/remote-sources-desktop.png)
- [Profile editor](../screenshots/local-profile-editor-desktop.png)
- [Mobile Wi-Fi](../screenshots/local-wifi-mobile.png)

Physical ESP32 flashing, on-device memory measurements and real BirdDog hardware acceptance remain separate from host-simulator validation.

## Notifications

Transient login, setup, form, routing, Simple Mode and operation feedback shares one API: actual Sonner 2.0.8 in React and a matching small vanilla controller on ESP32. The remote stack supports swipe dismissal. A portal host follows native dialogs into the browser top layer. It renders at bottom-left on desktop and above the mobile tab bar (or open More panel), works in native dialog/popover top layers, supports English/Hungarian and light/dark themes, and shows at most three notifications. Progress updates replace their own toast; success follows actual device verification. Success/info dismiss after 4.5 seconds remotely and five seconds locally and errors after ten, with hover/focus pause and accessible close buttons. Destructive confirmations and persistent device lock state retain their existing behavior.

Browser acceptance additionally checks desktop/mobile placement, native modal errors, manual dismissal and automatic expiry in both local and remote apps. Representative captures: [desktop toast](../screenshots/local-toast-desktop.png), [mobile toast](../screenshots/remote-toast-mobile.png), and [dialog error](../screenshots/local-toast-dialog.png).
