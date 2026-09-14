# Tests

These run the controller against a real HAP accessory: hap-nodejs, stood up in process, acting as
the camera. That is the same implementation physical HomeKit cameras are validated against, so a
passing run means the wire format is right rather than merely self consistent.

They borrow two things from the surrounding checkout rather than adding dependencies here: the
`hap-nodejs` installed under `plugins/homekit`, and the `ffmpeg` bundled with `server`. Build those
first if they are missing (`npm install` in `plugins/homekit`).

## Running

Compile to `tsout/` first; two of the tests load the compiled output.

```bash
npx tsc -p . --outDir tsout --sourceMap false

node test/stream-config-test.js     # TLV8 and capability parsing, against captured fixtures
node test/stream-telemetry-test.js  # keyframe pacing and stream measurement, against simulated cameras
node test/unicast-mdns-test.js      # resolving an accessory by address, against a hand written responder
node test/pairing-loopback.js       # pair setup, pair verify, encrypted session, events, snapshot
node test/controls-test.js          # child device discovery and control writes, incl. timed writes
```

Two tests load TypeScript sources from this repo directly - werift for the streaming one, and
`@scrypted/common` for the sensors one - so they run under ts-node:

```bash
TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","esModuleInterop":true,"target":"ES2021"}' \
node -r ../../sdk/node_modules/ts-node/register/transpile-only test/streaming-loopback.js

TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","esModuleInterop":true,"target":"ES2021"}' \
node -r ../../sdk/node_modules/ts-node/register/transpile-only test/sensors-test.js
```

## What each covers

**`stream-config-test.js`** parses `supported-*.bin`, which are real TLV8 characteristic values
captured from a hap-nodejs camera, and checks them against what that camera was configured to
advertise. Also covers the two TLV8 rules that are easy to get wrong: 255 byte fragmentation, and
`0x00` delimited lists.

**`stream-telemetry-test.js`** is the only test here with no HAP in it, because the behaviour it
covers depends entirely on the camera at the other end rather than on the wire format. It simulates
one: a frame source with a framerate and a group of pictures measured in *frames*, which is how
encoders are really configured, and a choice about whether it honours keyframe requests at all.

The archetypes it covers are the ones that have caused trouble. A camera already sending keyframes
faster than the search window, which must never be asked for one. A camera slower than the window,
which must be asked and must land inside it. A camera that ignores requests entirely, which must be
backed off rather than sent RTCP twice a second forever — and which must not have that backoff
reset by the keyframes it was going to send anyway. A keyframe fragmented across forty packets,
which is one keyframe. And the same camera at two framerates, which reports the same group of
pictures in frames while its interval in seconds moves by the same factor as the framerate.

That last one is worth having as a test rather than a comment: it is the observation that explains
why a camera appears to change its keyframe behaviour when it has changed nothing.

**`unicast-mdns-test.js`** covers finding an accessory's port by asking its address directly,
which is what makes adding a camera manually workable. Its responder is written out by hand rather
than borrowed from hap-nodejs, and deliberately so: `bonjour-hap` answers every query to the
multicast group regardless of who asked, so it never sends the unicast reply this depends on, while
the responders embedded in real accessories do. Both shapes of answer are covered — everything
volunteered at once, and a terse responder that has to be asked a second time for the records it
withheld.

**`pairing-loopback.js`** runs SRP pair setup, pair verify, and then exercises the encrypted
session: the accessory database, plain and TLV8 characteristic reads, an event subscription with a
real push, a response large enough to span five frames, and a snapshot.

**`controls-test.js`** builds an accessory carrying what a baby monitor and a doorbell carry — a
colour night light, speaker, microphone, switch, doorbell button, environmental sensors, and the
camera operating mode toggles — then checks each is discovered as the right kind of child device,
that sensors are *not* turned into children, and that driving the real control objects moves the
accessory. It covers the inverted mappings (a microphone switch against HAP's Mute), the 0..1 to
percentage conversion on colour, and the timed write handshake that camera operating mode
characteristics require.

It stubs `@scrypted/sdk` (see `sdk-stub.js`) because the real entry point needs generated sources
that only exist after building `sdk/types`. The stub is an identity proxy over the string enums
involved, which is exactly how they behave, so assertions still check the strings Scrypted compares,
plus a device base whose properties are plain fields and a device storage a test can seed before
the device is constructed.

**`sensors-test.js`** builds the real `HomeKitCamera` against an accessory carrying a motion
sensor, a doorbell, a battery and the environmental sensors, and drives the whole event chain:
subscribe, accessory pushes, the device routes it, the Scrypted property moves. It covers both
halves of how a value arrives - seeded from the accessory database at startup, and pushed
afterwards - because a sensor that only ever shows its startup value looks identical to a working
one until something changes.

It also covers the poll that backstops an accessory which accepts a subscription and then never
honours it, by writing a characteristic directly rather than through `updateCharacteristic` so the
value a read returns moves while nothing is pushed. That is indistinguishable from a quiet sensor,
which is what makes it worth having a test for. Last, it checks that debug logging really is off
until the setting is on, since the verbose output would otherwise bury the log.

**`streaming-loopback.js`** is the end to end one. The accessory really encodes H.264 and Opus and
sends SRTP. The test asserts that every field of `SelectedRTPStreamConfiguration` arrived at the
accessory as intended (resolution, framerate, payload types, SSRC, bitrate, profile, level, codec,
sample rate, packet time), that SPS and PPS arrive in band, that SRTP decrypts, and finally that
ffmpeg can decode the republished RTSP stream back to 1280x720 H.264 with Opus audio.

It then drives the return audio path in the other direction, sending RTP packets shaped the way
ffmpeg's muxer emits them and checking the accessory decrypts them with the payload type and SSRC
it was told to expect, repaced from the encoder's clock onto the one HAP negotiated. Talkback otherwise only runs when
someone presses the button, so nothing else here would notice it breaking.

Slice header errors in that last step are expected: the reader joins mid GOP and waits up to one
keyframe interval for the parameter sets. Rebroadcast caches those, so real consumers do not see
it.
