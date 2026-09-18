# Changelog

## 0.1.5

**Say so when motion has been on implausibly long.** Motion that never once drops is not a busy
room - a room with people in it produces gaps. It is something that moves without stopping and is
not alive, and HomeKit will record it and discard every clip, because its own analysis finds no
subject in any of them.

Found here as a ceiling fan clipping the corner of a living room frame: motion continuously true
for 191 minutes of recording across 20 clips, not one break, in a house that was empty. HomeKit
kept exactly one clip from that window - the dog - and binned 2.7GB of fan.

Nothing said any of this. The camera was working, the plugin was working, HomeKit was working, and
the only trace was clips quietly not appearing. A warning after thirty unbroken minutes, repeated
while it lasts, and a note of the total when it finally clears.


## 0.1.4

**Motion Timeout**, a new per-camera setting: seconds to keep reporting motion after the camera
says it has stopped. Off by default.

Some cameras report motion as a level that stays up for as long as something is moving. Others
report a series of short pulses - a camera that detects in the vendor's cloud tends to, because
what reaches it is a sequence of verdicts rather than a continuous observation. Passed through
unchanged, every gap between pulses starts a new event everywhere downstream: another HomeKit
notification, another recording, another snapshot, several times over for what a person watching
would call one thing happening.

Measured on an Arlo Baby here: 67 event snapshots requested by HomeKit against 35 recordings, and
68 clearings of motion across those 35 - roughly two notifications per actual event. The two
Ecobee cameras on the same install requested none.

Holding the signal up through the gaps collapses those back into one. It stays off by default
because it is a lie about what the accessory said, worth telling only for a camera whose pulses
are demonstrably one event - and the length of gap to bridge is a property of that camera rather
than something to guess at.


## 0.1.3

**Stop leaking connections when a camera is torn down mid start-up.** Two instances of the same
mistake: a resource created before an await, and a teardown that can run during that await
without being able to see it.

In the HAP client, a socket is known only to the invocation that made it until pair verify has
finished and it is assigned. A `stop()` in that window destroyed whatever the client held at the
time - not this socket - and then the connect resumed and handed a live socket to a client that
had been stopped. Nothing ever closed it, and it held one of the accessory's small number of
controller slots until the accessory gave up on it. The failure path was already guarded, with a
comment explaining exactly this; the success path was not.

In the camera, `release()` clears the client, so a start-up in flight would resume and use
nothing - which is how this surfaced, as `Cannot read properties of undefined (reading
'getAccessories')` on a camera that had just been added. Start-up now abandons itself if
something has replaced it, and says so as an ordinary log line rather than an error, because
`reinitialize` does exactly that on purpose every time a camera announces a new address.

Seen as three live TCP sessions to a camera that should have had one.


## 0.1.2

**Give a refresh time to be answered.** Refreshing the accessory list sent an mDNS query and then
read the cache immediately, without waiting - so the list described the network as it was *before*
the query, and an accessory that had just appeared stayed missing until refresh was pressed a
second time. Pressing it always showed the result of the previous press.

`resolve` already waited, but it waits for one known accessory id and rejects if that id does not
appear; discovery is open ended, with no id to match and no count to expect, so it needed its own
answer: query, then wait until answers stop arriving, capped so a chatty network cannot hold the
refresh open. Quiet for 750ms ends the wait, and 3s ends it regardless.


## 0.1.1

**Follow an accessory that moves.** A HAP accessory picks an arbitrary port each time its server
starts, so a reboot, a factory reset, or a HomeKit reset generally lands it on a different one.
`bonjour-hap` reports that as an `update` rather than an `up` - `up` fires only for a service the
browser has never seen before - and discovery listened to `up` alone. So the browser was reporting
the move, by name, and it was being dropped: the old address stayed cached and every connection to
it was refused with `ECONNREFUSED`, while mDNS itself worked perfectly throughout.

Refresh could not fix it either, since re-querying only produced another `update`. Only reloading
the plugin cleared the stale entry, which made it look like a cache expiry problem rather than a
missing event handler.

Both events now take the same path, and a move is logged with the addresses it moved between.

## 0.1.0

First release. Pairs HomeKit (HAP) cameras into Scrypted, the mirror image of the **HomeKit**
plugin: that one publishes Scrypted devices *to* Apple Home, this one consumes a HomeKit accessory
*as* a Scrypted device.

Verified end to end against two physical cameras — an Arlo Baby and an Ecobee doorbell — plus a
hap-nodejs accessory in eleven automated suites.

### What works

- **Pairing.** SRP-6a pair setup, Curve25519/Ed25519 pair verify, and a ChaCha20-Poly1305 framed
  session, implemented on node's own crypto so the plugin carries no native dependencies.
- **Discovery**, over mDNS, with an accessory tracked by its HomeKit id rather than its address so
  DHCP moves do not break it. A camera multicast cannot reach can be added by address alone: its
  port is resolved by querying the host directly.
- **Streaming**, decrypted from SRTP and republished as RTSP, so Rebroadcast, object detection,
  Scrypted NVR, WebRTC and HomeKit Secure Video all apply to a HomeKit camera.
- **One Scrypted stream per HAP stream service**, since the service is the camera's real unit of
  allocation, with a request falling back to whichever service is free.
- **Two way audio** into the camera's speaker, and **snapshots**.
- **Sensors** — motion, doorbell presses, battery and charge state, temperature, humidity, air
  quality and ambient light — as properties of the camera, which is what lets the HomeKit plugin
  republish them as linked services.
- **Accessory controls** as child devices: night lights, switches, speaker and microphone volume
  and mute, and the camera operating mode toggles, including the two nativeId suffixes the HomeKit
  plugin binds to the Home app's own camera settings.
- **Adaptive bitrate**, published as `MediaStreamFeedback`, so a consumer asking for a smaller
  stream reconfigures the camera rather than being ignored.

### Behaviour worth knowing about

Each of these was wrong at some point during development in a way that produced no error, which is
why they are called out rather than left in the commit history:

- **SRTP keys are per direction.** The key the controller sends is the one it encrypts with; the
  key the accessory returns is what its media must be decrypted with. hap-nodejs and everything
  built on it echo the controller's key back, which makes the two identical and hides the
  difference — until a camera that generates its own arrives and decrypts into noise.
- **HAP excepts Opus from RFC 7587's 48kHz timestamp rule**, requiring RFC 3550 pacing at the
  negotiated sample rate. Return audio sent on the wrong clock plays as static, not silence.
- **Only an IDR is a keyframe.** Encoders repeat parameter sets every few frames, and counting
  those makes a camera sending an IDR once a minute look like one sending a keyframe four times a
  second — suppressing every request for a real one.
- **A group of pictures is configured in frames, not seconds**, so a camera's keyframe interval in
  seconds moves with its framerate while nothing about its keyframe behaviour has changed.
- **Receiver reports have to be filled in.** A camera encoding to a bitrate ceiling decides whether
  to back off from what they say, and reporting zero loss leaves it no reason to.
- **HAP TLV8 delimits list entries with an empty item of type `0x00`**, and a repeated type is a
  continuation only when the previous value was exactly 255 bytes.
- **Selected audio RTP parameters must carry a comfort noise payload type** even when comfort noise
  is disabled; accessories read the field unconditionally and reject the write without it.

### Known limitations

- Cameras only; other HAP accessory types are not exposed.
- Bridged accessories are not enumerated; standalone accessories only.
- The accessory's own HomeKit Secure Video recordings are not consumed — recording is done by
  Scrypted from the live stream, which is what makes the rest of Scrypted apply.
- Two way audio needs a session negotiated as Opus. Encoding AAC-ELD requires an ffmpeg built with
  `libfdk_aac`, which the one Scrypted ships is not; receiving AAC-ELD is unaffected.
