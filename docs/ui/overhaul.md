# Single-screen dark interface

The local ESP32 UI and React remote UI now use the same routing workflows and one dark design system. The main screen is a matrix, with full-cell switch targets, checked active cells, stable keyed control updates, explicit receiver status. On mobile, receiver tabs select one column so that the table fits the viewport without horizontal scrolling; this selection survives filtering and settings dialogs. There is no sidebar, bottom navigation, appearance switch or local/remote connection label.

## Workflows

- **Add source** and **Add device** controls sit below the table. The final **Other device** row contains a native dropdown per receiver listing all discovered NDI sources, including unsaved ones; selecting a source routes it immediately without saving it. Pencil controls open modal editors. Removing an item still requires confirmation.
- Reorder reveals two arrow controls for each row and column. Source and receiver orders persist on the controller; receiver reordering validates every ID and rolls back on storage failure.
- Event Mode, the English/Hungarian language switch and Settings stay in the header. Settings opens over the table, with Simple Mode first and collapsible network, remote access, security and system sections.
- Each Simple Mode retains a separate password and an enable switch in Settings. Its dialog asks only for the password and up to ten button mappings of Name, Device and NDI source; the first button supplies the profile name automatically. Each row creates a fixed button. Editing preserves passwords left blank and existing profile names. Icons are omitted.
- Auto bugfix reads the current route, refreshes the receiver source list, resends that route and verifies receiver readback. It runs one bounded request per receiver, continues after individual failures and reports them. In Simple Mode, the server permits only the profile's receivers and sources, blocks unassigned current routes before refreshing, applies repeat limits and enforces Event Mode.

## Implementation

`scripts/design.css` owns the dark palette, responsive layout, matrix, dialogs and feedback styles. Oat’s `--muted` token is a background surface; secondary text uses `--muted-text` so disclosure hover never paints its text color as a background. Matrix hover is CSS-only and affects the pointed cell. Keyed DOM updates preserve controls during polling and routing; verified switch responses update the active route, and reads started before a switch cannot overwrite it. `build-style.mjs` bundles Oat locally; no runtime CDN or font dependency was added. `pack-web.mjs` regenerates minified/gzipped assets while preserving readable JavaScript sources. The initial local and remote HTML explicitly select dark mode, including browsers with a previously saved light preference.

`firmware/web/shared/control.js` owns matrix editing, ordering, source selectors, profile editing, restricted buttons and repair progress. The two shells retain their existing setup, network and identity flows. The remote UI uses Sonner; the embedded UI uses the lightweight matching toast stack. Notifications remain accessible above nested native dialogs.

## Acceptance

Verified on 2026-10-24: production build, 28 native Rust tests, 12 cloud tests, and all 39 simulator/relay integration checks passed. Desktop/mobile screenshots were visually reviewed.

Run `npm run build --prefix cloud`, `node scripts/pack-web.mjs`, `cargo test --workspace`, `cargo build -p drouter-simulator`, `npm test --prefix cloud`, and `DROUTER_TEST_PORT_OFFSET=20000 npm run test:e2e --prefix cloud`.

Browser acceptance covers readable open-disclosure hover, unchanged matrix DOM while hovering, preserved button identity through pending/verified routes, failed-switch state retention, password-only Simple Mode setup without profile/icon fields, actual local/relay routing, keyboard matrix navigation, responsive layouts from 320 to 1920 pixels, full-cell targets with long aliases, mobile receiver switching and retained selection, modal source-edit save/cancel, persisted receiver ordering, add-row/column dialogs, Event Mode confirmation, ten-row profile creation, duplicate-password errors, separate-password restricted login, administrator/restricted repair, partial repair failures, nested dialogs, Hungarian and axe accessibility. Native tests additionally cover invalid/duplicate receiver orders, flash-write rollback, repair readback failure, foreign targets, unassigned sources, repeat limits and event locking.

Representative screenshots are written to `docs/screenshots/`: `local-redesign-desktop.png`, `remote-redesign-mobile-hu.png`, `local-profile-editor-desktop.png`, `remote-profile-editor-mobile.png`, and `remote-simple-dark.png`.

Physical ESP32 flashing and real BirdDog hardware acceptance remain separate from simulator validation.
