# Repo setup

Work happens in the fork: `https://github.com/adgonz90/scrypted` (forked from
`koush/scrypted`). The `@scrypted/mqtt` plugin lives at `plugins/mqtt` inside
this monorepo — same layout as the Nanit-adjacent camera plugins, it's not a
separate standalone repo.

**Check out fresh — don't reuse an existing local clone**, since this repo
wasn't previously checked out for this work (unlike the Nanit plugin fork,
which had prior local state):

```bash
git clone https://github.com/adgonz90/scrypted
cd scrypted
./npm-install.sh
code plugins/mqtt   # open just this plugin's folder in VS Code
```

From there, standard Scrypted plugin dev flow applies — launch via the VS
Code debugger pointed at the Scrypted server's IP (default `127.0.0.1`), or
build + deploy from the CLI from inside `plugins/mqtt`:

```bash
npm run build && npm run scrypted-deploy <scrypted-host-ip>
```

**Licensing note:** this plugin's `package.json` reports `license: none` on
npm, and has for every published version going back years — not a recent
change. The repo root's `LICENSE.md` explicitly punts on this ("see
individual project directories for licensing, as it will vary... some
plugins may have dependencies that require GPL compliance"), and no
per-directory license was found for `plugins/mqtt` specifically. Practically:
running a personally modified fork for your own Home Assistant setup isn't
an issue. It would matter if this fork were ever published or redistributed
publicly as a package in its own right — worth a real license check at that
point, not before.

---

# Bug: MQTT autodiscovery publishes non-standard units, no device_class

Tested `@scrypted/mqtt` against a device exposing `Thermometer` and
`HumiditySensor` interfaces (temperature/humidity from Nanit's control-channel
sensor pushes). Two issues in the discovery payload it publishes to HA:

**1. Temperature unit string is wrong.** HA receives `unit_of_measurement: "C"`
for the `Thermometer`-derived sensor. HA's valid unit for this is `"°C"` (with
the degree symbol) — without it, HA won't recognize the value as a real
temperature unit, so it can't auto-convert to °F for imperial-unit
installations, and it may not group correctly with other temperature sensors
in long-term statistics. Likely cause: Scrypted's internal `Thermometer`
interface represents unit as a bare `C`/`F` enum — the MQTT plugin's
autodiscovery code needs to map that to the actual HA unit string (`°C`/`°F`)
rather than passing it through as-is.

**2. No `device_class` set on any discovered entity.** Checked HA's entity
registry directly — every entity from this device (`MotionSensor` →
`binary_sensor`, `Online` → `binary_sensor`, `Thermometer` → `sensor`,
`HumiditySensor` → `sensor`, `BinarySensor` → `binary_sensor`) has
`original_device_class: null`. Expected mapping, same pattern HA's own MQTT
discovery schema supports:

| Scrypted interface | HA domain | Expected device_class |
|---|---|---|
| `MotionSensor` | `binary_sensor` | `motion` |
| `Online` | `binary_sensor` | `connectivity` |
| `Thermometer` | `sensor` | `temperature` |
| `HumiditySensor` | `sensor` | `humidity` |

Without this, entities get generic icons/on-off wording instead of the
correct ones, and lose device-class-aware behavior (HA Areas motion
aggregation, voice assistant exposure, etc).

**Workaround in place for now:** set `device_class` manually per-entity via
HA's entity registry override (`ha_set_entity`/UI "Show As" dropdown). This
works and persists, but only for entities that already exist — it doesn't fix
the discovery payload itself, so any new install, entity deletion/recreation,
or new device of the same type starts back at `device_class: null`. The unit
string (`"C"` vs `"°C"`) has no equivalent registry-level override available,
so it's currently just wrong in HA with no workaround applied.

**Ask:** fix `@scrypted/mqtt`'s autodiscovery payload generation
(`autodiscovery.ts`, based on the stack traces referencing this file) to:
- map `Thermometer`'s unit enum to the correct HA unit string (`°C`/`°F`)
- set `device_class` per the table above for `MotionSensor`, `Online`,
  `Thermometer`, `HumiditySensor` (and any other standard interfaces this
  plugin discovers that have an obvious HA device_class equivalent)

---

# Separate, lower-priority: reconnect error burst on plugin restart

On MQTT plugin restart, saw an immediate `Error: close`, then a connect, then
~12 repeated `mqtt client error Error: client disconnecting` thrown from
`publishAutoDiscovery` (`autodiscovery.ts:719`) and `publishState`
(`main.ts:241`) — publish calls landing on a client mid-teardown from the
previous session, right before a final clean `MQTT client connected,
publishing current state.` with no further errors.

Self-resolved and no data was lost (checked HA afterward — all entities
intact, humidity/temperature still updating). Not urgent, but if easy to fix
alongside the above: on plugin start/reload, ensure the old MQTT client
connection is fully closed before the new one starts publishing, rather than
racing the reconnect against in-flight publishes from the previous session.
