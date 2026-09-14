// Keyframe pacing and stream measurement, against simulated cameras.
//
// This is the one part of the plugin whose correct behaviour depends entirely on how the camera at
// the other end behaves, and a maintainer cannot go and buy five HomeKit cameras to find out. So
// the camera is simulated instead: a frame source with a group of pictures measured in frames, a
// framerate, and a choice about whether it honours keyframe requests at all. Every archetype that
// has caused trouble is represented here.
//
// Runs against the compiled output with no HAP involved, since none of this touches the wire.

const path = require('path');

const OUT = path.resolve(__dirname, '../tsout');
const { StreamTelemetry, KEYFRAME_FRESHNESS_MS, KEYFRAME_BACKOFF_MAX_MS } = require(path.join(OUT, 'camera/stream-telemetry.js'));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

/** One H.264 RTP packet: a 12 byte header, then a NAL of the requested kind and size. */
function packet(timestamp, keyframe, bytes = 1200) {
    const rtp = Buffer.alloc(Math.max(13, bytes));
    rtp[0] = 0x80;
    rtp[1] = 99;
    rtp.writeUInt32BE(timestamp, 4);
    rtp.writeUInt32BE(0x1234abcd, 8);
    // NAL type 5 is an IDR slice; type 1 is a non-IDR one.
    rtp[12] = keyframe ? 0x65 : 0x41;
    return rtp;
}

/**
 * Runs a simulated camera past the telemetry for a stretch of time.
 *
 * The camera emits frames at a fixed rate and starts a new group of pictures every `gopFrames`,
 * which is how encoders are really configured - the interval in seconds then falls out of the
 * framerate rather than being set directly.
 */
function simulate({
    fps,
    gopFrames,
    mode,
    seconds,
    honoursRequests = true,
    keyframeBytes = 40000,
    frameBytes = 2500,
}) {
    const requests = [];
    const censuses = [];

    const telemetry = new StreamTelemetry({
        mode,
        requestKeyframe: () => requests.push(now),
        console: { debug: () => { } },
    }, 0);

    let now = 0;
    let nextFrame = 0;
    let nextCheck = telemetry.checkIntervalMs;
    let nextCensus = 30000;
    let framesSinceKeyframe = Infinity;
    let requestPending = false;
    let timestamp = 0;
    let deliveredKeyframes = 0;

    const requestKeyframeSeen = requests.length;
    void requestKeyframeSeen;

    for (now = 0; now <= seconds * 1000; now++) {
        if (now >= nextFrame) {
            // the camera answers a request on its next frame, as an encoder would.
            const keyframe = framesSinceKeyframe >= gopFrames || (honoursRequests && requestPending);
            if (keyframe) {
                framesSinceKeyframe = 0;
                requestPending = false;
                deliveredKeyframes++;
            }
            else {
                framesSinceKeyframe++;
            }

            telemetry.onVideoPacket(packet(timestamp, keyframe, keyframe ? keyframeBytes : frameBytes), now);
            timestamp += Math.round(90000 / fps);
            nextFrame += 1000 / fps;
        }

        if (now >= nextCheck) {
            const before = requests.length;
            telemetry.checkKeyframe(now);
            if (requests.length > before)
                requestPending = true;
            nextCheck += telemetry.checkIntervalMs;
        }

        if (now >= nextCensus) {
            censuses.push(telemetry.census(now));
            nextCensus += 30000;
        }
    }

    return { telemetry, requests, censuses, deliveredKeyframes };
}

/** The mean interval between keyframes, in seconds, as the last census reported it. */
function reportedInterval(census) {
    const match = census.match(/a keyframe every ([\d.]+)s/);
    return match ? parseFloat(match[1]) : undefined;
}

function reportedFrames(census) {
    const match = census.match(/\((\d+) frames/);
    return match ? parseInt(match[1]) : undefined;
}

function reportedFps(census) {
    return parseFloat(census.match(/video: ([\d.]+)fps/)[1]);
}

// ---- a camera that already sends keyframes often enough is never asked ------------------------
{
    // 30fps with a 60 frame group: one every two seconds, well inside the search window.
    const { requests, censuses } = simulate({ fps: 30, gopFrames: 60, mode: 'auto', seconds: 90 });
    check('a camera inside the freshness target is never asked for a keyframe',
        requests.length === 0, `${requests.length} request(s)`);
    check('and the census says so rather than leaving it ambiguous',
        censuses.every(line => line.includes('none requested')), censuses[0]);
    check('its own interval is reported accurately',
        Math.abs(reportedInterval(censuses[0]) - 2) < 0.1, censuses[0]);
}

// ---- a camera slower than the search window is pulled into it ---------------------------------
{
    // 30fps with a 480 frame group: sixteen seconds on its own, far outside the window.
    const slow = simulate({ fps: 30, gopFrames: 480, mode: 'auto', seconds: 90 });
    const interval = reportedInterval(slow.censuses[slow.censuses.length - 1]);
    check('a camera slower than the search window is asked, and lands inside it',
        interval > 0 && interval * 1000 <= KEYFRAME_FRESHNESS_MS + 500,
        `${interval}s (target ${KEYFRAME_FRESHNESS_MS / 1000}s)`);
    check('the census attributes that cadence to the requests, not to the camera',
        slow.censuses[slow.censuses.length - 1].includes('all requested'),
        slow.censuses[slow.censuses.length - 1]);

    // the same camera left alone, which is what the setting is for.
    const off = simulate({ fps: 30, gopFrames: 480, mode: 'off', seconds: 90 });
    check('off asks for nothing and the camera keeps its own cadence',
        off.requests.length === 0 && Math.abs(reportedInterval(off.censuses[1]) - 16) < 1,
        `${off.requests.length} requests, ${reportedInterval(off.censuses[1])}s`);
}

// ---- a camera that ignores requests is not hammered forever ------------------------------------
{
    const { requests } = simulate({ fps: 30, gopFrames: 480, mode: 'auto', seconds: 120, honoursRequests: false });

    // Without a backoff this is one request per second for the whole stream. With one, the gap
    // doubles to its ceiling and the total is a fraction of that.
    const unbounded = 120;
    const ceiling = 120000 / KEYFRAME_BACKOFF_MAX_MS;
    check('a camera that ignores keyframe requests is backed off rather than hammered',
        requests.length < unbounded / 4, `${requests.length} requests in 120s, versus ~${unbounded} unbounded`);
    check('but is still asked periodically, in case it starts answering',
        requests.length >= ceiling - 2, `${requests.length} requests, floor ~${Math.round(ceiling)}`);

    const gaps = requests.slice(1).map((at, i) => at - requests[i]);
    check('the backoff grows and then holds at its ceiling',
        gaps[gaps.length - 1] <= KEYFRAME_BACKOFF_MAX_MS + 500 && gaps[gaps.length - 1] >= KEYFRAME_BACKOFF_MAX_MS - 500,
        `gaps: ${gaps.slice(0, 6).join(',')}... last ${gaps[gaps.length - 1]}ms`);
}

// ---- a fragmented keyframe is one keyframe ------------------------------------------------------
{
    const telemetry = new StreamTelemetry({ mode: 'off', requestKeyframe: () => { }, console: { debug: () => { } } }, 0);
    // one keyframe spread over forty packets, as a 1080p IDR really is, then another 4s later.
    for (let i = 0; i < 40; i++)
        telemetry.onVideoPacket(packet(9000, true), 100 + i * 2);
    for (let i = 0; i < 40; i++)
        telemetry.onVideoPacket(packet(369000, true), 4100 + i * 2);

    const census = telemetry.census(30000);
    check('a keyframe split across many packets is counted once',
        Math.abs(reportedInterval(census) - 4) < 0.1, census);
}

// ---- a keyframe slower to arrive than any sensible time window ---------------------------------
{
    // A 1200x1600 IDR at a modest bitrate takes hundreds of milliseconds to come down the wire.
    // Observed on a doorbell: its 5.5s interval was reported as alternating 0.3s and 5.2s, because
    // each keyframe was counted twice. The frame's RTP timestamp says which frame a packet belongs
    // to, and it does not care how long the frame took to arrive.
    const telemetry = new StreamTelemetry({ mode: 'off', requestKeyframe: () => { }, console: { debug: () => { } } }, 0);

    for (let round = 0; round < 3; round++) {
        const at = round * 5500;
        // 120 packets spread over 400ms, well beyond any coalescing window.
        for (let i = 0; i < 120; i++)
            telemetry.onVideoPacket(packet(round * 495000, true), at + i * 3.4);
        // and the predicted frames between them, each its own timestamp.
        for (let i = 1; i < 30; i++)
            telemetry.onVideoPacket(packet(round * 495000 + i * 3000, false), at + 400 + i * 60);
    }

    const census = telemetry.census(30000);
    check('a keyframe that takes 400ms to arrive is still one keyframe',
        Math.abs(reportedInterval(census) - 5.5) < 0.2, census);
}

// ---- a fixed interval asks regardless -----------------------------------------------------------
{
    const { requests } = simulate({ fps: 30, gopFrames: 60, mode: '4', seconds: 60 });
    check('a fixed interval asks even when the camera needs no help',
        requests.length >= 13 && requests.length <= 16, `${requests.length} requests in 60s at 4s`);
}

// ---- what arrives is measured, not assumed ------------------------------------------------------
{
    const { censuses } = simulate({ fps: 20, gopFrames: 100, mode: 'off', seconds: 60, keyframeBytes: 40000, frameBytes: 2500 });
    const census = censuses[0];
    check('framerate is measured from the stream', Math.abs(reportedFps(census) - 20) < 0.5, census);

    // 20fps, one keyframe of 40000 bytes every 100 frames, 2500 bytes otherwise.
    const expected = ((99 * 2500 + 40000) / 100) * 20 * 8 / 1000;
    const actual = parseInt(census.match(/, (\d+)kbps/)[1]);
    check('bitrate is measured from the stream',
        Math.abs(actual - expected) / expected < 0.05, `${actual}kbps, expected ~${Math.round(expected)}kbps`);
}

// ---- the group of pictures is a frame count, which is the thing that confuses everyone ----------
{
    // The same camera at two framerates. Its encoder setting never changes, but the interval in
    // seconds moves by the same factor as the framerate - which reads as the camera having changed
    // its keyframe behaviour when it has done nothing of the kind. Observed on an Arlo Baby going
    // from 10fps to 29fps and its interval from 16s to 5.5s.
    const slow = simulate({ fps: 10, gopFrames: 160, mode: 'off', seconds: 90 });
    const fast = simulate({ fps: 29, gopFrames: 160, mode: 'off', seconds: 90 });

    const slowCensus = slow.censuses[1];
    const fastCensus = fast.censuses[1];

    check('a fixed group of pictures reports the same frame count at any framerate',
        Math.abs(reportedFrames(slowCensus) - 160) <= 8 && Math.abs(reportedFrames(fastCensus) - 160) <= 8,
        `${reportedFrames(slowCensus)} frames at 10fps, ${reportedFrames(fastCensus)} frames at 29fps`);

    check('while the interval in seconds moves with the framerate',
        Math.abs(reportedInterval(slowCensus) - 16) < 1 && Math.abs(reportedInterval(fastCensus) - 5.5) < 0.6,
        `${reportedInterval(slowCensus)}s at 10fps, ${reportedInterval(fastCensus)}s at 29fps`);
}

// ---- a camera that sends nothing at all ---------------------------------------------------------
{
    const telemetry = new StreamTelemetry({ mode: 'auto', requestKeyframe: () => { }, console: { debug: () => { } } }, 0);
    check('a stream with no video at all says so', telemetry.census(30000).includes('no video has arrived'));

    // video, but no keyframe after the first: a camera that sends parameter sets once and then
    // only predicted frames, which leaves every later viewer with nothing to start from.
    for (let i = 0; i < 300; i++)
        telemetry.onVideoPacket(packet(i * 3000, i === 0), i * 100);
    const census = telemetry.census(30000);
    check('video with no keyframe in the window is called out rather than averaged',
        census.includes('no keyframe in the last'), census);
}

// ---- what a stream actually carried, for video that will not decode ----------------------------
{
    const { naluTypes, describeNaluTypes } = require(path.join(OUT, 'camera/h264.js'));

    /** An RTP packet whose payload is the given bytes. */
    const withPayload = (...bytes) => {
        const rtp = Buffer.alloc(12 + bytes.length);
        rtp[0] = 0x80;
        Buffer.from(bytes).copy(rtp, 12);
        return rtp;
    };

    // a fragment of a non-IDR slice: FU-A indicator, then the real type in the FU header.
    check('a fragmented slice reports the type inside it, not the fragmentation',
        naluTypes(withPayload(0x7c, 0x01, 0xaa))[0] === 1, JSON.stringify(naluTypes(withPayload(0x7c, 0x01, 0xaa))));

    // STAP-A carrying SPS then PPS, each behind a two byte length.
    const stap = withPayload(0x78, 0x00, 0x02, 0x67, 0x42, 0x00, 0x02, 0x68, 0xce);
    check('an aggregated packet reports each type it contains',
        JSON.stringify(naluTypes(stap).sort()) === '[7,8]', JSON.stringify(naluTypes(stap)));

    // MTAP24. HAP does not permit it, and this code does not unwrap it, so it has to surface as
    // itself rather than being silently mistaken for a slice.
    check('an aggregation mode HAP does not permit surfaces as itself',
        naluTypes(withPayload(0x1b, 0x00, 0x00))[0] === 27, JSON.stringify(naluTypes(withPayload(0x1b, 0x00, 0x00))));

    check('the types are named where a name helps',
        describeNaluTypes([5, 7, 27]) === '5 (IDR), 7 (SPS), 27 (MTAP24)', describeNaluTypes([5, 7, 27]));

    // and the telemetry accumulates them across the stream.
    const telemetry = new StreamTelemetry({ mode: 'off', requestKeyframe: () => { }, console: { debug: () => { } } }, 0);
    telemetry.onVideoPacket(withPayload(0x7c, 0x01, 0xaa), 0);
    telemetry.onVideoPacket(stap, 100);
    check('the telemetry remembers every type the stream carried',
        JSON.stringify(telemetry.observedNaluTypes.sort()) === '[1,7,8]',
        JSON.stringify(telemetry.observedNaluTypes));
}

// ---- RFC 3550 padding, which an aggregation packet must not be read into ----------------------
{
    const { naluTypes, containsKeyframe, describeRtpPacket } = require(path.join(OUT, 'camera/h264.js'));

    /** An RTP packet with `pad` bytes of padding appended and the padding bit set. */
    const padded = (payload, pad) => {
        const rtp = Buffer.alloc(12 + payload.length + pad);
        rtp[0] = 0x80 | 0x20;
        Buffer.from(payload).copy(rtp, 12);
        // the last byte counts the padding, itself included.
        rtp[rtp.length - 1] = pad;
        return rtp;
    };

    // STAP-A carrying two non-IDR slices, then eight bytes of padding whose values look like IDR
    // NAL headers.
    const stapa = [0x78, 0x00, 0x02, 0x41, 0x9a, 0x00, 0x02, 0x41, 0x9b];
    const withPadding = padded(stapa, 8);
    withPadding.fill(0x65, 12 + stapa.length, withPadding.length - 1);

    check('an aggregation packet is not read into its padding',
        JSON.stringify(naluTypes(withPadding)) === '[1,1]', JSON.stringify(naluTypes(withPadding)));

    // Without honouring the padding bit this reads 0x65 out of the padding and calls it an IDR,
    // which is how a camera that pads its packets appears to send a keyframe several times a
    // second while nothing downstream can find one.
    check('padding is not mistaken for a keyframe',
        containsKeyframe(withPadding) === false, `${containsKeyframe(withPadding)}`);

    // The mistake that hid a real failure: encoders repeat parameter sets every few frames, so
    // treating them as keyframes makes a camera that sends an IDR once a minute look like one
    // sending a keyframe several times a second - and suppresses every request for a real one.
    const parameterSets = Buffer.from([0x80, 0x63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x78, 0x00, 0x02, 0x67, 0x42, 0x00, 0x02, 0x68, 0xce]);
    check('parameter sets on their own are not a keyframe',
        containsKeyframe(parameterSets) === false, JSON.stringify(naluTypes(parameterSets)));
    check('but they are still reported, since their absence matters too',
        JSON.stringify(naluTypes(parameterSets).sort()) === '[7,8]', JSON.stringify(naluTypes(parameterSets)));

    // the usual shape: parameter sets and the IDR aggregated together.
    const withIdr = Buffer.from([0x80, 0x63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x78, 0x00, 0x02, 0x67, 0x42, 0x00, 0x02, 0x68, 0xce, 0x00, 0x02, 0x65, 0x88]);
    check('parameter sets aggregated with an IDR are a keyframe', containsKeyframe(withIdr) === true);

    // a genuine IDR inside the aggregation is still found through the padding.
    const realKeyframe = padded([0x78, 0x00, 0x02, 0x65, 0x88], 4);
    check('a real keyframe in a padded packet is still found', containsKeyframe(realKeyframe) === true);

    // a padding count that overruns the packet is malformed; treat the packet as unpadded.
    const nonsense = padded([0x65, 0x11], 2);
    nonsense[nonsense.length - 1] = 200;
    check('a nonsensical padding count does not truncate the payload',
        containsKeyframe(nonsense) === true, describeRtpPacket(nonsense));

    // the description says whether an aggregation packet's lengths tile its payload, which is the
    // thing that decides whether every other parser in the pipeline survives it.
    check('the packet description reports exact tiling',
        describeRtpPacket(withPadding).includes('tiles exactly'), describeRtpPacket(withPadding));

    const ragged = Buffer.from([0x80, 0x63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x78, 0x00, 0x02, 0x67, 0x42, 0x00]);
    check('and reports one that does not',
        describeRtpPacket(ragged).includes('STOPS AT'), describeRtpPacket(ragged));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
