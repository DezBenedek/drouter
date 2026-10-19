# DRouter

Standalone Rust NDI routing controller for the **Waveshare ESP32-S3-ETH, SKU 28972**, with an optional Cloudflare remote relay. The ESP32 owns its configuration, password verifier, Wi-Fi credentials, receivers and presets. It controls BirdDog decoders; it never carries NDI video.

The macOS simulator runs the same authentication, validation, routing, preset, Wi-Fi selection and configuration core as the firmware. Its two virtual BirdDog HTTP servers implement mutable decoder state, configurable source lists, unavailable devices, ignored switches and request delays. The Cloudflare Worker is a real Wrangler Durable Object service, not a simulated HTTP relay.

![Remote routing interface](docs/screenshots/remote-routing.png)

## Repository

| Directory | Purpose |
| --- | --- |
| `firmware/` | Shared Rust device core, ESP-IDF hardware integration, compressed vanilla HTML/CSS/JS local UI |
| `cloud/` | Worker, hibernating Durable Object relay, React/TypeScript remote interface, relay/browser integration tests |
| `protocol/` | JSON schema, protocol/security specification, shared native/WASM SRP implementation |
| `simulator/` | Native Rust server, encrypted file storage, virtual BirdDog HTTP devices and network fault controls |
| `scripts/` | Asset regeneration, test runner, firmware image helpers |
| `docs/` | Hardware acceptance plan, implementation details, captured browser screenshots |

## Quick start on macOS

Install [Rust with rustup](https://rustup.rs/) and Node.js 22.12 or newer. The checked-in WASM and compressed local assets let you build the simulator and cloud without installing the ESP toolchain or regenerating assets. The tested native Rust version is 1.96.1; ESP builds use the separate `esp` toolchain.

From the repository root:

```sh
npm ci --prefix cloud
cargo build -p drouter-simulator
cargo run -p drouter-simulator
```

Open **http://127.0.0.1:8080**. Choose a device name and an administrator password of at least 4 Unicode characters. Ethernet defaults to DHCP; Wi-Fi and Cloud access are optional. There is no default administrator password. Choose **Devices → Discover** to register both verified virtual receivers, then use **Routing**. The simulator binds loopback only.

State is saved under `.drouter-state/` using AES-256-GCM. The directory is mode 0700 and its encryption key/files are mode 0600. Keep the complete directory, including its key, when backing up. Only one simulator can use a state directory at a time. Virtual receiver state belongs to the receiver processes and resets on restart; DRouter presets and configuration persist. Boot reads the actual current routes and does not apply a preset.

To use another simulator state directory or HTTP port:

```sh
DROUTER_STATE=/tmp/drouter-development DROUTER_PORT=8081 cargo run -p drouter-simulator
```

The virtual receiver ports default to 9001 and 9002. Set `DROUTER_BIRDDOG_PORT_BASE=19001` together with a separate HTTP port/state directory to run another isolated simulator.

## Local Cloudflare development

In a second terminal:

```sh
npm run build --prefix cloud
npm run dev --prefix cloud
```

This starts the real Worker, static React assets and Durable Object at **http://127.0.0.1:8787**. No domain, Cloudflare account, API token, D1, KV or R2 is needed for local development.

In the local device UI, open **Settings → Remote Access → Advanced · custom server**, set `http://127.0.0.1:8787`, then enable remote access. Reconnect locally after session revocation. The simulator connects automatically. Enter the ordinary device name, such as `studio-router`, and administrator password at **http://127.0.0.1:8787**. Wrangler keeps local name reservations in `.wrangler/state`; keep this directory to preserve the development registry.

For React hot reload, leave Wrangler running and start:

```sh
npm run ui --prefix cloud
```

Open **http://127.0.0.1:5173**. Vite proxies relay WebSockets to Wrangler. The development Origin exception is restricted to loopback. Production defaults to `https://drouter.dezso.hu`; ordinary users do not enter a server URL. Only the simulator accepts loopback HTTP overrides. The ESP32 requires HTTPS, verified certificates and valid system time.

## Identity, passwords and recovery

Device names use 3–32 lowercase ASCII letters, digits, and single hyphens. Remote login requires only this name and the device password. An immutable device ID is the SHA-256 digest of its Ed25519 public key. The private key stays in encrypted device configuration.

A separate SQLite Durable Object reserves each name permanently to its device ID/public key, even while offline. Registration and reconnection require a fresh, signed challenge covering the identity and requested name. Renaming preserves the ID and reserves the previous name as an alias; another identity cannot claim either name. Collisions appear in Remote Access settings. Local setup and routing still work if reservation is unavailable.

Before resetting or replacing a device, use **local Settings → Security → Export recovery file**. Keep that private file offline and secure: it proves ownership of your names. After provisioning a replacement, use **Restore identity**, supply the file and reserved name, and create a new password. Recovery never uses a cloud password database. Without the original private identity or a recovery file, reserved names cannot be reclaimed; choose a new name. Factory reset cannot release or transfer a reservation. Schema-one configurations migrate in place without replacing their identity, verifier, Wi-Fi order, receivers, or presets.

The browser authenticates directly to the device using the same RustCrypto SRP implementation on both sides. Password hardening uses PBKDF2-HMAC-SHA256; the device stores only salt and SRP verifier. Application commands and responses use directional AES-GCM keys derived from the SRP session. Cloudflare sees neither passwords, verifiers nor plaintext configuration updates. Browser memory is temporary; only appearance and language preferences are stored in localStorage; cloud SQLite contains the minimal public identity registry. See [the full protocol and trust boundary](protocol/README.md).

Sessions expire after 30 minutes. Wi-Fi/security/settings mutations require authentication within the last five minutes; reconnect to authorize them again. **Revoke all sessions** works locally and remotely. Changing the password or disabling Cloud access revokes sessions. A lost administrator password requires physical factory reset, which erases user data; the relay cannot reset it while retaining access.

## Interface

Routing opens first. Desktop uses a keyboard-accessible matrix with sticky output/source headers and independent searches. Mobile and tablet use an output list and a full-screen searchable source selector. A route remains pending until the receiver confirms it. Presets show affected outputs before multi-output application. Devices use a compact list; Settings groups General, Ethernet, Wi-Fi, Remote Access, Security, and System. Light/dark appearance follows the system initially and can be changed. Both interfaces share CSS tokens and native system fonts; the ESP32 serves vanilla JavaScript and compressed assets, while cloud uses React components.

No provisioning token is required. First boot is a five-step setup wizard: welcome, name/password, Ethernet/optional Wi-Fi profiles, optional remote access, and completion. Remote registration failure never blocks local setup.

## Tests

If another simulator is running, use `DROUTER_TEST_PORT_OFFSET=10000 ./scripts/test.sh` to test on separate ports without stopping it.

Install Chromium once:

```sh
cd cloud
npx playwright install chromium
cd ..
```

Run all host checks, Worker tests, build and end-to-end Chromium tests:

```sh
./scripts/test.sh
```

Or run them separately:

```sh
cargo test --workspace
cargo build -p drouter-simulator
npm test --prefix cloud
npm run build --prefix cloud
npm run test:e2e --prefix cloud
```

The integration runner starts and stops its own simulator and Wrangler processes, provisions a fresh temporary device, and exercises real HTTP BirdDog devices through the real relay. Ports **8080, 8787, 9001 and 9002 must be free**. It tests local and remote routing, wrong passwords, unauthorized commands, identity collisions and spoofing, source-switch verification, partial preset failures, request deadlines, Wi-Fi reordering/redaction, Ethernet failures, Cloud outage/reconnect, restart persistence, invalid JSON, oversized requests and local session revocation. Chromium also logs in to both interfaces, changes real virtual-decoder state, checks mobile overflow and captures screenshots. Native tests cover replay, expiration, pending/authentication limits, Wi-Fi fallback/preferred-network hysteresis, storage rollback and interrupted-write recovery.

## Simulator fault injection

Fault control is disabled unless you explicitly supply a secret of at least 16 characters. It is a simulator-only endpoint, separate from the production application protocol.

```sh
DROUTER_SIM_CONTROL=development-control-token cargo run -p drouter-simulator
```

Example requests:

```sh
curl http://127.0.0.1:8080/sim/faults \
  -H 'Content-Type: application/json' \
  -H 'x-simulator-token: development-control-token' \
  -d '{"receiver":0,"ignore_switch":true}'

curl http://127.0.0.1:8080/sim/faults \
  -H 'Content-Type: application/json' \
  -H 'x-simulator-token: development-control-token' \
  -d '{"cloud":false,"ethernet":false,"wifi":["Backup-Hotspot"]}'
```

Supported fields: `cloud`, `ethernet`, available `wifi` SSIDs; receiver index `receiver` with `online`, `ignore_switch`, `delay_ms` (maximum 10 seconds), or `sources` (up to 64 names). Switch failures and timeouts are real failed HTTP/readback operations, not preprogrammed successful responses. Restore `cloud:true` and `ethernet:true` independently.

Saved WPA2-Personal networks are tried in priority order, skipping disabled profiles. There is no fixed profile-count cap; the shared 24 KiB configuration budget and 13,000-byte redacted Wi-Fi-list budget are enforced before saving, so every saved profile remains manageable through the bounded protocol. Add, edit, enable, disable, remove, reconnect, and reorder networks locally or remotely. Blank edit passwords preserve the existing secret. Remote removal, disabling, or credential changes to the active Wi-Fi profile require explicit disconnect acknowledgement if Ethernet is unavailable; the physical BOOT recovery AP remains available. An absent network falls back to the next visible profile. The preferred-network check defaults to 300 seconds; two consecutive preferred scans and a minimum dwell period prevent oscillation. Retry and preferred-network policy can be changed in Settings. Credentials are never returned in `wifi.list`. WPA-Enterprise is not implemented.

## ESP32-S3 firmware build on macOS

Install Xcode command-line tools if needed (`xcode-select --install`), Homebrew Python/CMake/Ninja, and the supported ESP Rust tools:

```sh
brew install python cmake ninja
cargo install espup --locked
cargo install ldproxy --locked
cargo install espflash --locked
espup install --targets esp32s3 --export-file "$PWD/export-esp.sh"
. ./export-esp.sh
cd firmware
cargo +esp build --features esp --release
cd ..
```

Run the `cargo +esp` command **inside `firmware/`** so its `.cargo/config.toml` supplies the Xtensa target, linker and partition-table copy configuration. The target is **`xtensa-esp32s3-espidf`**. ESP-IDF is pinned to **v5.4.2**, `esp-idf-svc` to its locked 0.52 release, and `esp_websocket_client` to 1.4.0. The first build downloads ESP-IDF and managed C/Python dependencies into `.embuild/`; allow several GB of disk space. Do not put an activated Python virtualenv first on PATH when building: ESP-IDF creates its own Python environment. Re-source `export-esp.sh` in each new shell.

Firmware assets are embedded at compile time. Ordinary firmware builds need no npm/React build. If you change the shared SRP client or local assets, regenerate first:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci --prefix cloud
./scripts/build-web.sh
```

The wasm-bindgen CLI version must match `Cargo.lock`. `WASM_BINDGEN=/absolute/path/to/wasm-bindgen ./scripts/build-web.sh` selects an existing binary. Regeneration minifies the generated binding/crypto module and gzip-compresses every served local asset.

### Flashing and serial logs

Connect the board's USB-C data port. List available ports:

```sh
espflash list-ports
```

Use your actual `/dev/cu.usbmodem…` path. From the repository root:

```sh
espflash flash \
  --chip esp32s3 \
  --port /dev/cu.usbmodemYOURPORT \
  --flash-size 16mb \
  --partition-table firmware/partitions.csv \
  --bootloader target/xtensa-esp32s3-espidf/release/bootloader.bin \
  --monitor \
  target/xtensa-esp32s3-espidf/release/drouter-firmware
```

The custom ESP-IDF bootloader is required for the selected PSRAM/flash/NVS configuration. If automatic USB reset does not enter the bootloader, hold BOOT, press RESET, then release BOOT and retry. Open logs without reflashing:

```sh
espflash monitor --port /dev/cu.usbmodemYOURPORT
```

First boot prints the unique WPA2 setup AP SSID/password over USB. Join `DRouter-Setup-XXXX`, open `http://192.168.4.1`, and complete setup. AP credentials are generated securely per boot and are not uploaded. The early boot entropy source is explicitly enabled for provisioning/key generation, then disabled before Wi-Fi starts; runtime randomness uses the active Wi-Fi subsystem. The configured-device recovery flow uses the onboard BOOT button to disclose the current recovery AP credentials over USB after a three-second hold. A 12-second hold resets configuration. Boot configuration corruption never silently erases user data; USB erase remains available.

**Erasing configuration is destructive.** With the board connected, this explicitly removes the configuration partition and generates a new device identity on setup:

```sh
espflash erase-parts --port /dev/cu.usbmodemYOURPORT config
```

To return every partition to blank flash, `espflash erase-flash --port /dev/cu.usbmodemYOURPORT` erases the firmware and all keys; flash again afterward. Neither operation has been run without the physical board.

### Hardware configuration

| W5500 signal | GPIO |
| --- | --- |
| MISO | 12 |
| MOSI | 11 |
| SCLK | 13 |
| CS | 14 |
| Reset | 9 |
| Interrupt | 10 |

These assignments come from the [official Waveshare board documentation](https://docs.waveshare.com/ESP32-S3-ETH/Development-Environment-Setup-ESP-IDF). SPI2 runs at 20 MHz with DMA. No flash/PSRAM pins are repurposed. Wi-Fi and Ethernet coexist; Wi-Fi's default-route priority is higher for internet access, while connected Ethernet subnets carry BirdDog traffic. Use distinct, non-overlapping subnets when both interfaces are active.

The 16 MB partition layout reserves encrypted NVS configuration, an NVS key partition, OTA metadata and two 7 MiB application slots. It needs no microSD. OTA slots are reserved for future updates; no OTA updater is advertised. Configuration uses two revisioned, checksummed NVS blobs and avoids writes when values are unchanged. Wi-Fi driver persistence is disabled; saved profiles live in encrypted configuration. NVS encryption protects credential blobs, but development NVS keys are not protected against a physical flash dump until a reviewed flash-encryption/secure-boot provisioning process is applied. This project does not burn irreversible security eFuses automatically.

## BirdDog compatibility

The adapter implements the documented [BirdDog API 2.0](https://birddog.tv/AV/API/) endpoints `/about`, `/List`, `/connectTo` and `/refresh`, normally on port 8080. The source list accepts the documented object form and a bounded array variant. Switching sends the documented `sourceName` POST and verifies `/connectTo` readback with bounded retries. Devices that do not identify as BirdDog or do not provide decoder readback are rejected.

API 1.0 is deliberately not claimed. Automatic discovery of physical BirdDog devices is not claimed because a verified universal receiver-discovery service was not established from the API reference. Manual private IPv4 registration is implemented; simulator discovery verifies the two known virtual endpoints through the same adapter. Specific models/firmware versions still require interoperability checks against real devices; the vendor documentation is inconsistent in some response details. See [hardware acceptance](docs/HARDWARE-ACCEPTANCE.md).

## Deployment

Local development does not deploy anything. To deploy the already reviewed cloud build to your own Cloudflare account:

```sh
cd cloud
npx wrangler login
npm run deploy
```

This creates one Worker, the live relay class, and the separate SQLite registry class using the additive `v2-registry` migration. Preserve the existing `v1` migration on upgrades. The operator needs a Cloudflare account; end users do not. Use the Worker hostname as a local device advanced override during self-hosted testing. To serve the default production address, configure `drouter.dezso.hu` as the Worker's custom domain in Cloudflare. DNS ownership and deployment credentials are required for that operator step. The production domain has not been provisioned by this repository task.

The current deployed Worker is **https://drouter.dezbenedek.workers.dev**. A simulator running on localhost can connect directly to this public relay through outbound WSS; no router port forwarding or tunnel is required. In **local Settings → Remote Access → Advanced · custom server**, set this HTTPS origin, enable remote access and reconnect after authentication is renewed. Open the public Worker URL for remote control using the local device's name and password. The Mac and simulator must remain running. The default custom hostname `drouter.dezso.hu` has not been moved to this Worker.

An explicit live verification command is available after building the simulator:

```sh
cd cloud
DROUTER_LIVE_ORIGIN=https://drouter.dezbenedek.workers.dev node tests/live-relay-check.mjs
```

This uses an isolated temporary simulator on ports 18081/19011/19012 and verifies real public-relay administrator/Simple Mode login, fixed BirdDog routing, Event Mode, and the mobile browser interface. It leaves only a randomly named minimal `deploy-check-*` device registration in the production registry, as permanent name reservation requires; temporary local credentials/state and processes are removed. It does not change the existing local device configuration. This command is deliberately separate from the ordinary integration suite.

There are no mandatory D1, KV, R2 or account bindings, no cron triggers and no persistent monitoring. The registry stores only names, immutable IDs, public keys, and registration/rename/hourly connection timestamps. Presence is derived from live sockets. Worker observability is disabled in configuration; avoid enabling request-body/WebSocket logging. Hibernation attachments and cleanup alarms contain only transient authentication/connection bookkeeping. No password, verifier, local administrator session, configuration, receiver/source list, preset, or routing history is written to cloud storage.

## Verification boundary

See [the recorded software verification results](docs/VERIFICATION.md) for toolchain versions and the executed checks. `./scripts/firmware-image.sh` reproduces the merged flash image after a successful firmware build.

Software tests, browser screenshots and a firmware cross-build can establish implementation behavior before hardware arrives. They cannot establish electrical behavior, PSRAM stability, power-loss resilience on real flash, Wi-Fi roaming timing, physical Ethernet throughput, BirdDog model compatibility or 24/7 stability. The exact remaining measurements and soak tests are listed in [HARDWARE-ACCEPTANCE.md](docs/HARDWARE-ACCEPTANCE.md). Treat this as an implemented, testable initial release pending that acceptance, not a physically verified production appliance.


## Sources, Simple Mode and Event Mode

Use **Sources** to save discovered NDI sources, set DRouter-only display names, rename, remove or reorder them. Every save asks for confirmation; cancelling leaves persistent configuration unchanged. Saved sources survive temporary network absence and device restart. The desktop routing matrix has source rows and output columns. Its last row is **Other source**, with a separate searchable source selector for each output. Selecting an unsaved source routes it immediately without saving it. Mobile routing starts with an output, then offers saved sources and **All Sources**.

Administrators can create up to eight **Simple Modes**, each with a distinct password and 1–10 fixed action buttons. Create/edit the profile, set each button's output and source, and confirm the displayed mappings before saving. Each profile opens its own restricted interface when its password is entered on the normal login page. Users can press the configured buttons and log out; the ESP32 rejects administrator API requests from those sessions. Passwords require 4–128 Unicode scalar values; short passwords are weak and longer passwords are recommended. See the [counting rule and authentication restrictions](protocol/README.md#modification-3-access-control-and-configuration).

**Settings → Access Control** provides **Event Mode**, language selection and [Contact](mailto:benedek@dezso.hu). Event Mode requires administrator confirmation and temporarily locks every Simple Mode locally and remotely. It persists across device restarts, preserves profile configuration and changes no routing when disabled. Administrator routing remains available throughout. English and Hungarian are available on login, setup and the application; preference is remembered in the browser. Motion respects the operating system's reduced-motion preference.
