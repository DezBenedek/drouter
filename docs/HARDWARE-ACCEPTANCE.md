# Hardware acceptance: Waveshare ESP32-S3-ETH SKU 28972

No physical board or BirdDog receiver was attached during implementation. Every item below is unverified until measured. A successful Xtensa build and virtual-device tests do not close these items.

## Bring-up

- Confirm manufacturer SKU, ESP32-S3R8, 16 MB flash and 8 MB octal PSRAM from serial boot diagnostics. Check actual heap allocation capability and that TLS/WebAssembly asset serving do not exhaust internal RAM.
- Confirm W5500 MISO12/MOSI11/SCLK13/CS14/RST9/INT10 against the board revision and schematic. Check reset timing, interrupt-driven RX, MAC uniqueness and SPI DMA operation at 20 MHz. Leave camera and SD uninitialized.
- Verify USB-C flashing, native USB serial/JTAG logging and BOOT/RESET recovery. Confirm no crash loop prevents physical data-erasing recovery.
- Join the unique WPA2 setup AP; verify its IP is 192.168.4.1, the UI works on Safari/Chrome over plain LAN HTTP, and first setup needs no additional provisioning token. Confirm no universal/default administrator password exists.
- Verify physical recovery reveals credentials only through the USB process. Ensure the AP does not continue indefinitely after the configured timeout, and failed Wi-Fi setup remains recoverable over Ethernet or the physical AP path.

## Network behavior

- Test Ethernet DHCP, static address/mask, isolated Ethernet with no gateway, DNS, and changing settings while running. Confirm W5500 cable-unplug/replug recovers without reboot or lost configuration.
- Test simultaneous Ethernet and Wi-Fi on non-overlapping networks. Confirm BirdDog private destinations use Ethernet while internet/WSS uses Wi-Fi; repeat with Ethernet internet and no Wi-Fi.
- Add more than eight WPA2 profiles, reorder them and reboot. Test unavailable SSIDs, visible SSIDs with wrong credentials, authentication rejection and DHCP failure. Every failed profile must allow later profiles to be tried.
- Observe two five-minute preferred scans and minimum dwell before a preferred-network switch. Test a flapping AP and active routing; no repeated avoidable switch cycle may occur.
- Remove/edit the active Wi-Fi profile; verify a newly submitted password is used without reflashing. Change priority policy from both interfaces.
- Block DNS, SNTP, TLS, internet and Cloudflare separately. Local routing remains available. Invalid TLS chains and hostnames must fail; no skip-certificate-validation fallback is allowed. Confirm connection attempts back off with jitter.

## BirdDog interoperability

- Record exact decoder models and firmware versions. Verify BirdDog identity and decoder capability with `/about` and `/connectTo`.
- Capture sanitized real `/List` and `/connectTo` response fixtures. Validate source-name encodings, object/array shapes, spaces, parentheses, Unicode and percent encoding against the adapter.
- Test `/connectTo` POST source switching on each supported decoder/channel, then independently inspect actual decoder output and readback. Test asynchronous acceptance where readback settles later, stale lists, lost sources, NDI multicast/unicast modes, channel mismatch and device reboot.
- Test at least 16 receivers and 64 sources, or lower configured limits if measured heap/latency requires it. Confirm every partial preset failure is visible and errors never claim an unverified switch succeeded.
- Test actual output state remains unchanged by controller restart, network reconnection and Cloudflare reconnection.

## Flash and security

- Cut power during each stage of a configuration write. The device must select the newest valid completed slot or the previous complete slot, never silently manufacture empty user data. Repeat at least 100 cycles.
- Verify encrypted NVS does not contain plaintext Wi-Fi credentials/verifiers in ordinary reads. Development encryption keys remain physically extractable; separately review and provision secure boot/flash encryption before making resistance-to-physical-extraction claims.
- Measure flash writes during 24 hours with no configuration changes. Routing, health reads and Cloud reconnects must not write configuration.
- Verify password changes, Cloud disable and global session revocation invalidate existing local/remote sessions. Test session expiration and five-minute elevation expiry against the real device clock.
- Flood malformed/oversized frames and login attempts while monitoring peak heap and task watchdogs. There must be bounded sessions, pending work and allocation. Review the SRP implementation/version and the complete deployed browser build before public exposure.

## Soak and failure testing

Run at least seven continuous days after bring-up, followed by a longer deployment soak. Use realistic routing and preset rates; cycle Ethernet, AP visibility and Cloud availability. Track minimum internal/PSRAM free heap, task stack high-water marks, watchdog resets, reconnect frequency, HTTP latency, config write counts, route verification failures and thermal/power behavior. Exercise worst-case source lists and unavailable devices at maximum receiver count. Set measured acceptance thresholds before calling the system 24/7 production ready.

The watchdog monitors network-loop progress with a 120-second timeout. Confirm blocked tasks, driver faults and shared-core stalls trigger useful diagnostics and recovery. A cloud outage alone must never trigger a deliberate reboot. Test the optional PoE hardware only if that module is actually installed.

- Export the local identity recovery file, factory reset, and verify that a fresh identity cannot take the old reserved name. Restore the file locally with a new password and confirm authenticated name recovery and remote session revocation. Test registered-name collisions and cloud outages during setup.
- Check source selection sheets, keyboard focus, Wi-Fi ordering, and setup on actual iOS/Android browsers, including safe areas and software keyboards.

## Modification 3 acceptance

- Upgrade a configured schema-two device. Confirm identity, administrator verifier, receiver definitions, presets and Wi-Fi priorities are preserved. Sign in and explicitly inspect Event Mode before granting restricted access.
- Save, alias, reorder and remove sources using both interfaces. Cancel each confirmation and verify flash write counters and configuration revision remain unchanged. Reboot with saved sources absent from the network and verify their original identifiers and aliases remain available.
- Route through each output's Other source selector with different unsaved sources. Remove those sources from NDI discovery; confirm last known identifiers remain visible without adding saved entries. Restore discovery and verify switching/readback on actual BirdDog firmware.
- Create eight profiles with ten buttons each within the documented total storage/transport limits. Measure worst-case SRP challenge generation, browser proof generation and duplicate-password checks on real hardware. Verify deadlines, stack high-water marks, internal/PSRAM heap and watchdog feeding under simultaneous local and remote access.
- Verify four Unicode scalar passwords, supplementary-plane characters and combining marks in Safari/Chrome and the ESP32. Check unique salts after password changes, duplicate-password rejection against disabled profiles and administrator credentials, profile password-change revocation and global attempt backoff. Four-character passwords remain weak despite online restrictions.
- Log in with several restricted profiles locally and remotely. Send crafted administrator operations, foreign button IDs and target overrides; confirm firmware rejection. Remove an output/source, ignore a BirdDog switch, interrupt its HTTP response and double-tap buttons; no unverified result may appear successful.
- Activate Event Mode while restricted commands are queued and while another switch is executing. After activation is acknowledged, every subsequent restricted execute must fail. Confirm administrators retain routing, disabled profiles stay disabled, deactivation restores eligible profiles and no routing changes automatically.
- Cut power during both Event Mode activation and deactivation. Damage the latest configuration slot and verify fallback locks restricted access; damage both slots and verify recovery rather than empty initialization. Repeat while Simple Mode sessions exist through the relay.
- Test Hungarian login/setup/settings/dialogs, long Hungarian button labels, source aliases, keyboard navigation, screen readers, reduced motion and software keyboards on actual mobile devices. Verify Contact opens `mailto:benedek@dezso.hu` without any backend service.
- Include all new paths in the seven-day soak: concurrent routing, repeated profile logins, Event Mode changes, cloud disconnections, clock/session expiry and maximum lists. Periodic discovery reads must not write flash; explicit refresh may persist changed availability metadata. Monitor serialized operation latency and never infer physical readiness solely from simulator results.
