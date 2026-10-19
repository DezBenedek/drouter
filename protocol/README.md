# DRouter protocol v1

The device owns all state. `protocol.schema.json` defines each application request and its parameters. `generate.py` generates this schema and the TypeScript operation inventory; regenerate from the repository root with `python3 protocol/generate.py`. Rust deserialization and operation handlers enforce the same constraints, including unknown parameter rejection. Both local and remote requests reach `Device::frame` and `Device::execute`.

Application requests contain `v: 1`, a bounded string `id`, an allowlisted `op`, and object `params`. Responses contain the same `v` and `id`, `ok`, and either `result` or `error: {code,message}`. There is no arbitrary HTTP, URL, shell or subnet-scan operation. Wi-Fi profile responses omit passwords. Settings updates require `expected_revision` to prevent overwriting another administrator's changes.

## Authentication and transport

The browser and device use the same RustCrypto `srp` 0.6 implementation, compiled to native Rust on the device and WebAssembly in the browser. Group: RFC 5054 2048-bit, SHA-256, SRP-6a, username `admin`. RustCrypto's documented proof convention is used unchanged by both endpoints. The password input is first hardened using PBKDF2-HMAC-SHA256, 100,000 iterations, a per-device 32-byte salt, and a 32-byte result. Minimum password length is 12 bytes. Only salt and SRP verifier reside on the device. Cloudflare receives neither password nor verifier.

The salt is SHA-256 of UTF-8 `drouter-srp-salt-v1:` followed by the device's 32-character public identity fingerprint. The identity contains 128 bits of cryptographic uniqueness. This public, device-specific salt remains stable across password and friendly-name changes. An unavailable relay returns a synthetic challenge with the same salt derivation and random public ephemeral, then a generic failure. This avoids an explicit unknown-device response and a changing-salt existence oracle. Response timing is not claimed to be indistinguishable across arbitrary networks.

Local transport starts with `POST /session` returning a random 36-character session ID. Subsequent `POST /api` requests contain `{sid,frame}`. A local simulator WebSocket is also available at `/ws`; the ESP32 UI uses HTTP to limit resources. Remote browsers connect to `/relay/{remote_name}/browser` and receive `{type:"hello",sid}`.

1. Browser sends `{type:"auth.start",a}`.
2. Device replies `{type:"auth.challenge",salt,b}`.
3. Browser sends `{type:"auth.proof",proof}`.
4. Device verifies the SRP proof and replies `{type:"auth.ok",proof,expiresIn:1800}`.
5. Browser verifies the device's proof before accepting a session.

`protocol/auth` implements this exchange with the SRP library, not JavaScript BigInt reimplementations. Invalid public values are rejected. Challenges expire after 30 seconds. At most eight device authentication states/sessions exist. At most ten authentication starts per minute are accepted device-wide; reboot resets this volatile limiter. Successful login grants sensitive-operation access for five minutes, and ordinary access for 30 minutes. Reconnect to elevate again. Changing the password/name/cloud enablement or revoking sessions invalidates all authenticated sessions. Disconnecting the relay removes only remote sessions.

Application frames are `{type:"rpc",seq,data}`. `data` is hex AES-256-GCM ciphertext including its tag. Directional keys are HKDF-SHA256 of the SRP session key, with the session ID as salt and UTF-8 info `drouter-request-v1` or `drouter-response-v1`. Nonce: four zero bytes followed by the eight-byte big-endian sequence number. Associated data: UTF-8 `{sid}:{seq}`. Each direction starts at sequence 1; the device accepts only the next sequence and rejects replay. Reauthentication creates a fresh SRP secret and session ID. Responses correlate the decrypted request ID. The client serializes operations. The relay cannot forge valid application packets or read configuration updates.

Browser AES-GCM/HKDF use the maintained Noble implementations, allowing the local UI to work over HTTP on private LAN addresses where WebCrypto is unavailable. WASM randomness uses the browser CSPRNG. Remote access requires HTTPS/WSS; simulator loopback HTTP/WS is explicitly permitted for development. Initial provisioning trusts the physically disclosed WPA2 AP password and USB token; use a trusted LAN if provisioning over Ethernet.

## Device ownership and relay envelopes

Remote names have the form `studio-router--<32 hexadecimal characters>`. The suffix is the first 16 bytes of SHA-256 of the device Ed25519 public key. Friendly names use 3–32 lowercase ASCII letters, digits and single hyphens. The Ed25519 private key persists only on the device.

An outgoing device WebSocket connects to `/relay/{remote_name}/device`. The relay sends `{type:"challenge",nonce}`. The device returns `{type:"register",name,publicKey,signature}`. The signature covers UTF-8 `drouter-register-v1\n{name}\n{nonce}`. The relay checks the public key fingerprint and fresh signature before accepting ownership. A duplicate live connection is rejected; the device retries with backoff. A later reconnect must prove the same identity. Another key cannot reserve or take over the same full name even if the original device is offline.

The relay sends device frames as `{type:"forward",sid,frame}` and receives `{type:"reply",sid,frame}`. A device disconnect closes its remote browser sessions and clears live data in the UI. Browser disconnect produces `{type:"leave",sid}`. The Durable Object does not store application payloads. Hibernation attachments contain only roles, transient challenges, session IDs, expirations, rate counters and pending deadlines. Its only storage operation is setting a cleanup alarm.

## Limits and failures

- 32 KiB WebSocket/HTTP message maximum; encrypted payload maximum 15,000 bytes; response plaintext maximum 14,000 bytes.
- At most 12 relay sockets, eight browser/candidate sockets from one IP, one pending request per browser, 120 browser frames/minute, 600 device frames/minute.
- Relay request deadline 15 seconds. Browser deadline 17 seconds. BirdDog request timeout two seconds; device operations stop issuing requests after ten seconds. Oversized responses return a structured capacity error instead of truncating state.
- 16 receivers, 64 distinct sources, 16 presets, eight saved Wi-Fi networks, 24 KiB serialized configuration.
- Routes are successful only after reading the requested source back from the receiver. Presets return one success/failure entry per stored output. A failure can leave a partially applied matrix; there is no fictitious transaction across receivers.
- Routing readback after boot always reflects receivers. Neither boot nor Cloud reconnection applies an old preset.

## Trust boundary

SRP authenticates password knowledge; device registration authenticates ownership of the public name. TLS authenticates the deployed relay. Like every browser application, the remotely served JavaScript must be trusted: an operator able to replace that JavaScript could alter password handling. No independently audited application security claim is made. Production should use reviewed builds and an appropriate CSP. The LAN interface is designed for trusted production/control networks, not arbitrary public HTTP exposure.
