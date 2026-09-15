# Fork notes: `adgonz90/scrypted`

What this fork changes relative to `koush/scrypted`, and why. It began as patches supporting a
Nanit baby camera running through Scrypted on a Raspberry Pi 4 (HAOS add-on, arm64), driven from
HomeKit and Home Assistant. It now also carries **original work** — see the HomeKit Controller
plugin below — so this checkout is no longer disposable.

Count what is on top with `git fetch upstream && git log --oneline upstream/main..HEAD`, and how
far behind with `git log --oneline HEAD..upstream/main`.

Related docs: `mqtt-plugin-discovery-fixes.md` (this repo, MQTT setup and licensing notes);
`FORK.md` in the `scryptedapp-nanit` checkout (the camera plugin itself);
`AGENT_CONTEXT.md` in the parent workspace (environment, network, deployment).

---

## Remotes

| | |
|---|---|
| `origin` | `github.com/adgonz90/scrypted` — the fork; **push here** |
| `upstream` | `github.com/koush/scrypted` — read-only |

Compare with `git fetch upstream && git log --oneline upstream/main..HEAD`.

## The patch commits

### Audio — the one that matters most

**`9413130b4` fix(common): stop corrupting AAC audio with an oversized RTP pkt_size**

`createRtspParser()` in `common/src/rtsp-server.ts` hardcoded `-pkt_size 32000` on every RTSP
output. That applies to **audio as well as video**, and AAC-hbr packs as many access units into a
packet as the budget allows. A camera sending 24 kbps mono AAC has ~70-byte frames, so a large
budget crams hundreds of AUs into one RTP packet — and ffmpeg's own depacketizer then rejects a
quarter of them with `Invalid AU size`, discarding every AU in the packet.

Measured against such a camera, codec copy, varying only this value:

| pkt_size | delivered |
|---|---|
| 1400 / 5600 / 7000 / 8192 / 8400 | **100.0%** |
| 9800 | 89.0% |
| 11200 | 77.0% |
| 32000 | 75.2% |

The same ~75% appears end to end through rebroadcast, **byte-identical over TCP and UDP** — so
it is not a network or MTU effect, only how many AUs are packed per packet. The damage is a
periodic dropout (a 186 ms gap every 720 ms: exactly 8 of every 31 AAC frames).

Set to **1400**. Not because 1500 is a hard limit — the cliff is around 8400 for that camera —
but because the real constraint is AU *count*, not bytes: halve the audio bitrate and twice as
many AUs fit the same budget, moving the cliff down. This is shared code across every camera, so
margin matters more than the negligible packet overhead. Video is unaffected in practice: H.264
is already FU-A fragmented, and HomeKit/WebRTC repacketize to their own MTU downstream.

**Why it was hard to find, and worth remembering:**

- **It looks like a client bug.** HomeKit (opus 24 kHz mono) and the Scrypted UI over WebRTC
  (opus 48 kHz stereo) chop identically despite different encoders and different RTP senders,
  because both decode via ffmpeg. **VLC plays the same stream perfectly** — its depacketizer is
  more permissive. That asymmetry is the clue that points at packetization rather than clients.
- **A file capture hides it.** Capturing to a wav gives continuous, gap-free audio, because
  samples are written contiguously regardless of arrival. It only shows up as a **sample-count
  deficit** against expected duration, or by re-capturing with `aresample=async=1` so the gaps
  become real silence.

This is a genuine upstream bug affecting any low-bitrate-AAC camera. **Worth upstreaming** — the
commit message carries the full table.

### HomeKit

**`852a99961` feat(homekit): merge camera child devices and sensors onto the accessory**

Cameras that are also `DeviceProvider`s exposed their children as separate accessories, and
sensor interfaces on the camera itself weren't exposed at all. Now:

- Temperature, Humidity and Sound are added as linked services on the camera accessory (they
  aren't part of HAP's `CameraController`, so they're ordinary services with distinct subtypes).
- `mergeOnOffDevicesByType` / `mergeLightDevicesByType` / `mergeVolumeDevicesByType` fold a
  provider's children onto the parent accessory as switches, lightbulbs, or volume controls.
- HomeKit's native `CameraOperatingModeIndicator` is bound to a `:statuslight` child's real
  `OnOff` state. Without this the native toggle in the Home app's camera settings sheet is a
  dummy backed only by local storage, while the real control sits elsewhere as a separate switch.
- `Characteristic.ConfiguredName` is set on merged on/off services — `Name` alone isn't enough
  for the Home app to label services grouped onto one accessory; it falls back to
  "Switch", "Switch 2", …

Two gotchas: every merge helper **skips children without the HomeKit mixin enabled**, silently;
and Status Light and Night Vision Automatic are deliberately excluded from the switch merge
because they're bound as native camera characteristics instead — look for them in the camera's
settings sheet, not the accessory list.

**`2a62244ae` fix(homekit): repair plugin build on Windows**

- The `AccessoryInfo.js` loader rule matched a literal forward-slash path; webpack's resource
  paths use backslashes on Windows, so the rule never matched and the loader silently never ran.
- Aliased `@scrypted/common/src/deferred` and `promise-utils` to their real files (see the
  double-hop note under prebuffer-mixin below).

### Rebroadcast

**`d4b3d48ef` fix(prebuffer-mixin): repair plugin build on Windows**

Building failed with `TS2307: Cannot find module '@scrypted/common/src/deferred'`.

`common/src/deferred.ts` and `promise-utils.ts` are the **only two files** in `@scrypted/common`
that are themselves symlinks into `server/src`. Resolving them from a plugin means following two
symlink hops — `node_modules/@scrypted/common` → `common/`, then the file → `server/src/` — and
the second fails on Windows. Every other `@scrypted/common` import is a regular file.

**Both resolvers need the redirect separately**: `tsconfig.json` `paths` for the type checker
(TS2307 comes from ts-loader, which a webpack alias does not affect), and `resolve.alias` for
webpack's bundling. The homekit fix above only did the alias half, which is sufficient there
because homekit doesn't import those two modules directly.

### MQTT

**`f0a386a53` feat(mqtt): nest child devices under their parent and publish dimmables as lights**

- `via_device` on discovered entities so a device with a real provider nests under it in Home
  Assistant (a camera's child switches appear under the camera). Root-level devices are their own
  provider and are never published, so they're skipped rather than emitting a dangling reference.
- `OnOff` + `Brightness` devices publish as a single HA `light` entity with brightness, instead of
  a switch that drops the brightness channel — and the redundant switch entity is suppressed.
- `AudioVolumeControl` added to the discovery map.

**`2de7daf27` fix(mqtt): correct HA unit/device_class in autodiscovery, fix reconnect error burst**

- Publish temperature as `°C` rather than the raw enum, so HA recognises it and can convert.
- Set `device_class` on discovered entities so HA picks correct icons and behaviour.
- `MqttPublisherMixin.release()` strips listeners before ending the client. Without it a stale
  mixin discarded during startup could still fire its `connect` handler after `end()`, throwing
  "client disconnecting" on every publish.

### SDK

**`905ca0b5f` fix(sdk): dispatch scrypted-webpack/deploy/etc by npm_lifecycle_script on Windows**

`bin/cli.js` chose which tool to run from `path.basename(process.argv[1])`, which only works when
npm installs bins as POSIX symlinks. On Windows npm generates `.cmd`/`.ps1` shims that invoke
`cli.js` directly, so `argv[1]` was always `cli.js` and every command failed with
`Unknown command: cli.js`. Falls back to `npm_lifecycle_script`.

**Without this, nothing in this repo builds on Windows.**

## Original work: the HomeKit Controller plugin

`plugins/homekit-controller/` is **not a patch**. It is a new plugin written from scratch in this
fork: a HAP *controller*, the mirror image of the `homekit` plugin that ships with Scrypted. That
one publishes Scrypted devices to Apple Home; this one pairs a HomeKit camera *into* Scrypted, so
Rebroadcast, object detection, NVR, WebRTC and HomeKit Secure Video all apply to it. It has its own
`README.md` and `CHANGELOG.md`, and eleven test suites under `test/`.

**This is the reason the fork must not be treated as disposable.** Everything else here is a patch
that could be re-derived from upstream; this cannot.

### Why it lives in the tree rather than its own repository

Three of its six dependencies are in-tree paths, and one of them has nowhere else to come from:

| | |
|---|---|
| `@scrypted/sdk` | on npm, but used here as `file:../../sdk` |
| `@scrypted/common` | on npm, but the in-tree copy carries the AAC `pkt_size` fix above |
| `@koush/werift-src` | **not published at all** — it does the SRTP, SRTCP and RTCP work |

The tests also borrow `hap-nodejs` from `plugins/homekit` and ffmpeg from `server/`.

Beyond packaging, the plugin is unusually coupled to Scrypted's internals, and reading them next to
it has repeatedly been what found a bug: Rebroadcast's `min(4000, idrInterval)` sync frame search,
the HomeKit plugin's `FORCE_OPUS` and its recording codec list, `sdp-utils`' `mpeg4` to `aac`
mapping, and the WebRTC plugin's codec preferences all shaped its behaviour.

Moving it out is possible, and the prerequisite is replacing `@koush/werift-src` — most cleanly by
implementing SRTP directly, which the plugin already has the crypto idioms for. It would also need
renaming, since `@scrypted/homekit-controller` is Scrypted's npm scope.

## Building and deploying a patched plugin

```bash
cd plugins/<plugin>
npm install && npm run build && npm run scrypted-deploy <scrypted-host-ip>
```

Needs a one-time `npx scrypted login <host>` (Scrypted's console credentials on port 10443 — not
Home Assistant's, not the camera vendor's).

**If a build fails with `TS2307` on `@scrypted/common/...`:** `common/` itself may not be
installed. It has its own `package.json` with real dependencies (including `@koush/werift-src`
pointing at the `external/werift` submodule), and imports inside `common/src/*` resolve from
there, not from the plugin. Run `npm install` in `common/`.

**A locally-built plugin used to keep upstream's version number**, so Scrypted showed no update
available, nothing in the UI marked it as custom, and reinstalling or updating it from the registry
silently reverted the patch.

Each patched plugin is now versioned ahead of upstream with a `-fork.N` tag, which fixes both
halves - the UI shows what it is, and the registry offers nothing until upstream reaches that
minor:

| Plugin | Upstream | Here | Carries |
|---|---|---|---|
| `@scrypted/homekit` | 1.2.65 | **1.3.0-fork.2** | camera child device and sensor merging, motion-bounded HKSV recordings |
| `@scrypted/prebuffer-mixin` | 0.10.70 | **0.11.0-fork.1** | the `common/` AAC `pkt_size` fix, bundled |
| `@scrypted/mqtt` | 0.0.87 | **0.1.0-fork.1** | autodiscovery and reconnect fixes |

Bump the tag (`-fork.2`, and so on) on each redeploy, so the running build is identifiable. When
upstream reaches one of these minors an update *will* appear, which is correct: the patch has to
be re-applied on top rather than quietly kept or quietly lost.

## Recurring working-tree noise

These show as modified without real content changes; safe to `git checkout --` them:

- `sdk/bin/cli.js`, `server/bin/scrypted-serve` — CRLF-only diffs
- `sdk/types/scrypted_python/scrypted_sdk/types.py` — whitespace churn in a generated file
- `plugins/*/package-lock.json` — `npm install` output
- `external/werift` — dirty submodule working tree, commit pointer unchanged
