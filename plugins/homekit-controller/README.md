# HomeKit Controller

Pairs HomeKit (HAP) cameras directly into Scrypted.

This is the mirror image of the **HomeKit** plugin. That one publishes Scrypted devices *to* Apple
Home; this one consumes a HomeKit accessory *as* a Scrypted device. Once a camera is in Scrypted it
behaves like any other camera, so the whole pipeline applies to it: Rebroadcast, object detection,
Scrypted NVR, WebRTC viewing, and the HomeKit plugin's own HomeKit Secure Video.

```
HomeKit camera ──HAP/SRTP──► HomeKit Controller ──► Rebroadcast ──┬──► HomeKit plugin (with HKSV)
                                                                  ├──► Scrypted NVR
                                                                  ├──► Object detection
                                                                  └──► WebRTC / web UI
```

## Before you start: the camera must leave the Home app

**A HomeKit accessory accepts exactly one pair setup.** If the camera is already paired to Apple
Home, it will refuse to pair with Scrypted, reporting that it is unavailable. HAP does allow
additional controllers to be added by an existing admin controller, but the Home app exposes no way
to do that.

So the order is:

1. Remove the camera from the Apple Home app, or factory reset it.
2. Pair it to Scrypted with this plugin.
3. Re-expose it to Apple Home through the **HomeKit** plugin.

After step 3 the camera is back in the Home app, but now everything passes through Scrypted. Note
that Apple Home will see it as a new accessory, so any automations referencing the old one need to
be repointed.

## Adding a camera

Discovered cameras appear automatically. Use **Add Device**, pick the camera, and enter its eight
digit setup code (the one on the accessory, its packaging, or in the vendor's app). A camera can
also be added by address if mDNS discovery does not reach it.

The pairing is stored in Scrypted, and the camera is then tracked by its HomeKit accessory id
rather than its IP, so DHCP changes do not break it.

### When the camera cannot be found

Discovery is mDNS, which is multicast and does not reliably cross a VLAN boundary — and an
accessory only announces itself every so often, so a restart can fall between announcements. None
of that stops unicast from working, so the address that last answered is remembered and used when
mDNS does not reply, and a later announcement of a different address is followed automatically.

**To add a camera discovery cannot see**, choose **Manual** as the Accessory in Add Device and
enter its address and setup code. Leave **Port** empty: a HomeKit accessory listens on an arbitrary
port, published only over mDNS, so a camera you cannot discover is one whose port you have no way
to know either. Instead the address is asked directly — RFC 6762 allows a query sent straight to a
host's port 5353, answered the same way, which travels over exactly the unicast that reaches the
camera when multicast does not.

Answering such a query is optional, and some responders only ever reply to the multicast group;
anything built on hap-nodejs, including Homebridge, is one of those. If the camera does not answer,
the plugin says so and asks for the Port, which its own app or its HomeKit setup QR code will give
you. It is rarely the 51826 that hap-nodejs defaults to — one camera here uses 5051.

A camera added this way has its address pinned, since discovery evidently cannot track it; that is
the **Address Override** in its settings, and clearing it returns the camera to being located by
mDNS. The **Last Known Address** is shown alongside.

### Cameras that only announce when asked to

Some accessories do not announce themselves at all until their own app is showing a pairing screen.
Ecobee's cameras are like this: nothing of theirs appears on the network, by multicast or unicast,
until **Add to HomeKit** is open in the Ecobee app, at which point the camera advertises for as long
as that screen is up and goes quiet again afterwards. It is a departure from HomeKit's own rules,
where an unpaired accessory advertises continuously so that it can be found, and presumably a
deliberate one: an accessory discoverable only while you are looking at it is harder to pair without
physical access.

This is worth knowing because the symptom looks like a network fault rather than a camera keeping
quiet. The camera answers on its HomeKit port perfectly well throughout — it simply never says where
that port is. So discovery shows nothing, and a manual attempt using a port noted earlier fails with
a bare `ECONNREFUSED`, which reads as a firewall or a routing problem and is neither.

The port is usually wrong by then, too. A HomeKit accessory picks an arbitrary port every time its
server starts, and opening the pairing screen restarts it, so each visit to that screen is liable to
move the camera somewhere new. A port learned on a previous attempt is not one to keep.

**So pair a camera like this in the following order:**

1. Open the vendor app and go to its **Add to HomeKit** screen. Leave it open.
2. In Scrypted, open **Add Device** for this plugin and press refresh. The camera should appear.
3. Pick it, enter the setup code, and add it — all while that screen is still up.

Refresh sends a fresh mDNS query and waits for the answers rather than returning what was already
known, so one press is enough: it returns once announcements stop arriving, and at most three
seconds after the query either way. If the camera still does not appear it is not advertising — check
that the app really is on the pairing screen, and see the note above about the Home app, since an
accessory already paired elsewhere will not offer itself to anything else.

## Unpairing

Either delete the camera from Scrypted, or use the **Unpair** button in its group on the plugin's
settings page. Both remove this controller's pairing from the accessory, leaving it free to pair
again, and then remove the Scrypted device.

If the camera cannot be reached at that moment, it is still removed from Scrypted, but the camera
itself keeps a pairing for a controller that no longer exists — and will refuse a new pair setup
until it is **factory reset**. The plugin raises an alert saying so rather than failing quietly.

The plugin page lists each paired camera with its accessory ID and current address, and the
discovered list says whether an accessory is ready to pair or already claimed by another
controller.

## HomeKit Secure Video

Scrypted's HomeKit plugin enables HKSV for any camera that reports motion. This plugin subscribes
to the accessory's own motion sensor and exposes it as Scrypted's `MotionSensor` interface, so HKSV
works with the camera's built in motion detection and no extra hardware.

To set it up:

1. Enable **Rebroadcast** on the camera so a prebuffer is available for recording.
2. Enable the camera in the **HomeKit** plugin, and turn on HomeKit Secure Video there.
3. Re-pair the bridge in the Home app if the camera was already exposed. HomeKit caches the
   accessory's capabilities at pairing time, so HKSV and any newly added features will not appear
   on an accessory it has already cached.

If the camera has no motion sensor of its own, or you want better detection, add Scrypted's
**OpenCV** or an object detection plugin as a mixin; that provides the same `MotionSensor`
interface and HKSV works identically.

### When motion never fires

Motion arrives as a HAP event: the plugin subscribes to the accessory's motion characteristic at
startup and the accessory pushes each change. HAP gives a controller no way to confirm that
subscription, though — an accessory returns success and then either sends events or it does not —
so any characteristic that has never pushed is re-read every ten seconds as a backstop. That stops
per characteristic as soon as it pushes, so a camera that behaves pays for a single round of reads.

The cost of falling back to the poll is resolution: motion is then noticed within ten seconds
rather than immediately, and a brief event between two reads is missed entirely. Turn on **Debug
Logging** to see which it is — pushed events and polled changes are logged differently, and the
accessory's service graph says whether the motion characteristic even claims to support
notifications.

Before any of that, check whether the camera can still reach the internet, and whether its own app
says detection is armed. A HomeKit camera streams locally, so it keeps working perfectly on a
network with no route out — but several vendors run the *detection* in their cloud rather than on
the camera, and one that cannot reach it reports no motion at all while behaving correctly in every
other respect. An Arlo Baby does exactly this. Neither the plugin nor HomeKit can tell that apart
from a quiet nursery, so it is worth ruling out first.

### Cameras that report a battery

Rebroadcast refuses to maintain a prebuffer for a device that reports a battery unless it also
reports a charger and says it is currently charging, since a permanent stream would flatten it.
No prebuffer means no HKSV recording.

Charge state is reported from the accessory, so a mains powered camera that says it is charging
works without intervention. A camera that reports a full battery as "not charging" while plugged in
will still be refused; turn on **Allow Prebuffer on Battery** in the camera's settings for that
case. Leave it off for a genuinely battery powered camera.

The symptom to look for is a line in the camera's Rebroadcast log saying the camera is battery
powered and will only rebroadcast on demand.

## Streams

**One Scrypted stream per HAP stream service.** The stream service is the camera's real unit of
allocation — each has its own resolutions, and a camera may offer full resolution on one and only a
substream on another — so a stream id names a service rather than a size. Each is advertised at
that service's ceiling, largest first, and the largest is marked as the local and recording stream.

This matters beyond tidiness: Rebroadcast names its session and derives its rebroadcast URL from
the advertised stream, so a stream promising a size that a *different* service would have to supply
would publish a URL labelled with a resolution its video does not match.

**The number of concurrent streams is limited by the camera**, not by Scrypted. HomeKit cameras
typically support two to four simultaneous sessions, and each Scrypted consumer that opens a stream
uses one. Rebroadcast is worth enabling for exactly this reason: it opens a single session and fans
it out to everything else.

Those sessions are not necessarily equal. HAP lets each one advertise its own resolutions, and a
camera may offer full resolution on one and a substream on another — and may permanently reserve
one for its own vendor app, leaving only the smaller one available. The plugin reads each
separately, offers only what it can actually reach, and logs the difference at startup:

```
stream service #0 (iid 100): video: 1920x1080@30, 1280x960@30, ...
stream service #1 (iid 110): video: 1280x720@30, 640x360@30, ...
camera supports 2 concurrent stream(s); the stream services advertise DIFFERENT capabilities
```

Every advertised size stays on offer regardless, because a service busy now may be free later — a
camera's own app releases the one it reserves when it stops watching. Each request takes the best
service free at that moment and snaps the requested size onto what that service offers, so a stream
started while the larger service was busy is smaller rather than absent.

The camera's settings page shows **Active Stream**: what is running, which service it is on, and
whether it is below what the camera can manage. **Retry Best Stream** drops the running streams so
the next request re-evaluates which services are free — worth pressing after closing the vendor
app, which is usually what frees the larger one.

### Keyframes and how quickly a picture appears

Video cannot start until a keyframe arrives, which is why a slow camera shows audio immediately and
a picture several seconds later. A camera sends one as soon as a stream session starts, but viewers
attach to Rebroadcast long after that, so what matters is whether a *recent* keyframe exists when
they do. One observed camera left alone went sixteen seconds between them.

The number that matters is smaller than it first appears. Rebroadcast stores ten seconds, but a
consumer starting a stream searches only the last **four** seconds of that for a keyframe to begin
at, and only **two** for a remote destination. A keyframe older than that is of no use — the search
fails and the viewer waits for the camera's next one.

Recording does not share that limit. HomeKit Secure Video widens its own prebuffer request to cover
whatever interval the camera is actually using, so recordings work at any cadence and only live
viewing pays for a slow one.

**Keyframe Requests** in the camera's settings addresses this by asking over RTCP, sending both a
Picture Loss Indication and a Full Intra Request since cameras differ in which they honour:

- **auto** (default) asks only when the newest keyframe is older than the local four second search
  window, and at most once a second while waiting for an answer. A camera that already sends them
  often enough is never asked at all, and one that ignores the requests entirely is backed off to
  every eight seconds rather than being sent RTCP for the life of the stream.
- **off** leaves the camera to its own schedule.
- **1 / 2 / 4 / 8** ask at that fixed interval regardless.

### What asking costs

Less than it looks, and not where you would expect. Measured on an Arlo Baby, auto against off:

| Keyframe Requests | interval | framerate | bitrate | first picture |
|---|---|---|---|---|
| auto | 3.8s | 28.2fps | 945kbps | 1.4s |
| off | 5.5s | 28.5–29.0fps | 955–974kbps | 1.2s, or 6.2s |

Asking every four seconds rather than leaving the camera alone cost under 1fps and about 20kbps.
Note that the camera sat at ~950kbps throughout, ignoring the 2000 it was offered: the ceiling that
matters is the camera's own, not the one requested, so a bitrate setting is not the lever it looks
like. Asking *much* harder does cost, though — see below.

What **off** costs is the first picture, and only sometimes. That camera's own cadence of 5.5
seconds is longer than the four second window a local consumer searches, so a viewer attaching
between two keyframes finds none and waits for the next — the 6.2 second start above, against 1.4
seconds when the keyframe was asked for. It is intermittent rather than consistent, which makes it
an annoying thing to debug later.

So auto earns its place: close to free, and it keeps the search window satisfied. The fixed
intervals are for cameras that ignore requests or behave unusually, not a default worth reaching
for.

### A group of pictures is counted in frames, not seconds

This is the detail that makes keyframe behaviour confusing to read. An encoder is configured with a
group of pictures measured in **frames**, so the interval in *seconds* is that number divided by
the framerate — and it moves whenever the framerate does, with nothing about the keyframe
configuration having changed at all.

The Arlo Baby holds a group of pictures of about 160 frames:

| framerate | resulting interval | frames per group |
|---|---|---|
| 10fps | 16.0s | 160 |
| 28.5fps | 5.5s | 157 |
| 29.0fps | 5.5s | 160 |

So a camera that "started sending keyframes three times more often" may have done nothing of the
kind; it may simply be running three times the framerate. The census reports both, for this reason.

It also works the other way, and this is the trap: **forcing keyframes far inside the camera's own
group of pictures costs framerate**, because the camera is at its own bitrate ceiling and a
keyframe is many times the size of the frames around it. Asking every 2.5s of a camera whose
natural group is 160 frames means demanding one roughly every 25 frames — six times its own rate —
and the encoder finds the bitrate by dropping frames. Auto's four second target lands at around 110
frames on this camera, close enough to its own 160 to cost almost nothing.

Turn on **Debug Logging** and the camera reports what it actually settled on, every thirty seconds,
independently of what was requested:

```
video: 28.2fps, 945kbps, a keyframe every 3.8s (107 frames, all requested), newest 1s old
keyframe 2 arrived 3.8s after the previous one
```

`all requested` is the part to read first: it says this cadence is the plugin's doing and would
slow to the camera's own rate if Keyframe Requests were turned off. `none requested` means the
setting is not affecting this camera at all, and changing it will do nothing.

That is the only way to see the trade. Change the setting, watch the framerate line, and keep
whichever answer the camera actually gives — cameras differ, and several ignore keyframe requests
altogether.

### Audio

HomeKit cameras offer AAC-ELD (mandatory in HAP) and usually Opus. This plugin requests **Opus** by
default, because ffmpeg and WebRTC both handle it natively and it needs no transcoding downstream.
If audio misbehaves, the codec can be forced to AAC-ELD in the camera's settings.

**Opus is the right answer almost always, and AAC-ELD is worse than it looks.** It is tempting as a
way to avoid the Opus to AAC transcode that HomeKit Secure Video does on every recording, and it
does not work:

- Scrypted's HomeKit plugin sets `FORCE_OPUS = true`, which makes it offer HKSV only **AAC-LC**.
  A HAP camera cannot produce AAC-LC — HAP defines AAC-ELD — so a recording transcode is
  unavoidable whichever of the two is chosen. It is audio only, against a `-vcodec copy` video
  stream, so it is far cheaper than it sounds.
- Choosing AAC-ELD makes that recording *wrong* rather than merely transcoded. Scrypted's SDP
  parser maps any `mpeg4` rtpmap to the codec name `aac`, so AAC-ELD arrives downstream labelled
  as plain AAC, and the HomeKit plugin copies it into a recording it has negotiated as AAC-LC.
  This is the reason `FORCE_OPUS` exists, and its comment says as much: *aac-eld is no longer
  usable without this flag being set at compile time*.
- Two way audio stops working, because encoding AAC-ELD needs an ffmpeg built with `libfdk_aac`.

So reach for it only when a camera's Opus is genuinely broken, and expect to lose talkback and
HKSV recording audio in exchange.

## Accessory controls

A HomeKit camera is rarely only a camera. Every non-streaming service the accessory exposes is
published as a child device of the camera:

| Accessory service | Becomes |
|---|---|
| Lightbulb (a baby monitor's night light) | a Light, with brightness and colour where supported |
| Switch, Outlet | a Switch |
| Speaker | a volume control, plus a mute switch |
| Microphone | a mute switch, plus a volume control where supported |
| Camera operating mode | switches for the status light, night vision, camera active, snapshots and recording audio |

Environmental sensors — temperature, humidity, air quality, ambient light, occupancy — are *not*
child devices. They are properties of the camera itself, which is what lets the HomeKit plugin
republish them as linked services on the camera accessory.

Two of these use nativeId suffixes the HomeKit plugin looks for specifically: `:statuslight` and
`:nightvision-auto` drive the Home app's own toggles inside the camera settings sheet, rather than
appearing as a second, separate switch. Look for them there, not in the accessory list.

**Each child needs the HomeKit mixin enabled** before it will be merged onto the accessory. The
merge helpers skip children that do not have it, silently.

Some of these characteristics — the status light in particular — are declared by HAP as *timed
writes*, which have to be announced with a `PUT /prepare` before the write itself. That is handled
automatically, based on the permissions the accessory advertises.

## Two way audio

Cameras that expose a speaker get Scrypted's `Intercom` interface, which also lights up the talk
button in the Home app once re-exposed. HomeKit carries return audio inside an active streaming
session, so a stream must be running for talkback to work.

Audio is encoded to the codec the session negotiated and repaced onto HomeKit's clock, which is the
negotiated sample rate rather than the one Opus normally mandates. A camera that receives it at the
wrong rate still plays it, just with static, so the symptom to listen for is crackle rather than
silence.

## Debug logging

Each camera has a **Debug Logging** switch in its settings. With it off, the log says what the
camera is doing: what it connected to, what it advertises, what is streaming, and anything that
went wrong. With it on, the log also carries everything behind that — the accessory's full service
graph including the permissions on every characteristic, every characteristic event the camera
pushes, stream negotiation and startup timing, keyframe cadence, the RTSP exchange, and the two way
audio encoder.

It is far too noisy to leave on, and it is also the only way to answer most questions about a
camera behaving oddly, so it is worth a minute with it on rather than a guess. The service graph in
particular is what the accessory really published, which is the answer to both "why is this sensor
missing" and "why does this one never fire".

## Implementation notes

The HAP controller is implemented in this plugin rather than pulled from a library, so it carries
no native dependencies:

| Concern | Implementation |
|---|---|
| Pair Setup | SRP-6a (3072 bit group, SHA-512) via `fast-srp-hap` |
| Pair Verify | Curve25519 ECDH + Ed25519, via node's built in crypto |
| Session transport | ChaCha20-Poly1305 framed HTTP, 1024 byte frames |
| TLV8 | `src/hap/tlv.ts` |
| Media | SRTP decrypted with werift, republished as RTSP |
| Discovery | mDNS `_hap._tcp` via `bonjour-hap` |

Two details that are easy to get wrong, both verified against a real accessory implementation:

- HAP TLV8 delimits list entries with an **empty item of type `0x00`**, and a repeated type is a
  continuation of the previous value only when that value was exactly 255 bytes long.
- The selected audio RTP parameters must include a **comfort noise payload type** even when
  comfort noise is disabled; accessories read the field unconditionally and reject the write
  without it.
- HAP takes RFC 7587 for Opus but **excepts its timestamp rule**, requiring RFC 3550 pacing at the
  negotiated sample rate rather than Opus's mandatory 48kHz clock. ffmpeg follows the RFC, so
  return audio has to be rescaled on the way out or the accessory hears it as static.

## Limitations

- Cameras only. Other HAP accessory types are not exposed yet.
- Bridged accessories (Homebridge, vendor bridges) are not yet enumerated; only standalone
  accessories are supported.
- The accessory's own HomeKit Secure Video recordings are not consumed. Recording is done by
  Scrypted from the live stream instead, which is what makes the rest of Scrypted useful here.
- Two way audio needs a session negotiated as Opus. Encoding AAC-ELD requires an ffmpeg built with
  `libfdk_aac`, which the one Scrypted ships is not; receiving AAC-ELD is unaffected.
- Selecting AAC-ELD also breaks HomeKit Secure Video recording audio, for a reason outside this
  plugin: Scrypted labels it as plain AAC and copies it into a recording negotiated as AAC-LC. See
  [Audio](#audio). Opus records correctly, at the cost of a cheap audio-only transcode.
