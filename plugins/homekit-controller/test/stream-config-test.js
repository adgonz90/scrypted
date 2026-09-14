// Parses the capability TLVs captured from a real hap-nodejs camera accessory and checks the
// result against what that accessory was configured to advertise.

const fs = require('fs');
const path = require('path');

const SCRYPTED = path.resolve(__dirname, '../../..');
const OUT = `${SCRYPTED}/plugins/homekit-controller/tsout`;
const sc = require(path.join(OUT, 'camera/stream-config.js'));
const tlv = require(path.join(OUT, 'hap/tlv.js'));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

const video = sc.parseSupportedVideoStreamConfiguration(fs.readFileSync(path.join(__dirname, 'supported-video.bin')));
console.log('parsed video:', JSON.stringify(video));

check('video codec is H264', video.codec === 0);
check('three H264 profiles', video.profiles.length === 3 && video.profiles.join(',') === '0,1,2', video.profiles.join(','));
check('three H264 levels', video.levels.length === 3 && video.levels.join(',') === '0,1,2', video.levels.join(','));
check('packetization mode non-interleaved', video.packetizationModes.join(',') === '0', video.packetizationModes.join(','));
check('four resolutions parsed', video.resolutions.length === 4, String(video.resolutions.length));

const expected = [[1920, 1080, 30], [1280, 720, 30], [640, 360, 30], [320, 240, 15]];
expected.forEach(([w, h, f], i) => {
    const r = video.resolutions[i];
    check(`resolution ${i} is ${w}x${h}@${f}`, r && r.width === w && r.height === h && r.fps === f,
        r ? `${r.width}x${r.height}@${r.fps}` : 'missing');
});

const audio = sc.parseSupportedAudioStreamConfiguration(fs.readFileSync(path.join(__dirname, 'supported-audio.bin')));
console.log('parsed audio:', JSON.stringify(audio));

check('two audio codecs', audio.codecs.length === 2, String(audio.codecs.length));
check('first codec is OPUS 24kHz mono',
    audio.codecs[0] && audio.codecs[0].codec === 3 && audio.codecs[0].samplerate === 2 && audio.codecs[0].channels === 1,
    JSON.stringify(audio.codecs[0]));
check('second codec is AAC-ELD 16kHz mono',
    audio.codecs[1] && audio.codecs[1].codec === 2 && audio.codecs[1].samplerate === 1 && audio.codecs[1].channels === 1,
    JSON.stringify(audio.codecs[1]));
check('comfort noise not supported', audio.comfortNoise === false);

const suites = sc.parseSupportedRTPConfiguration(fs.readFileSync(path.join(__dirname, 'supported-rtp.bin')));
check('crypto suite AES_CM_128_HMAC_SHA1_80', suites.join(',') === '0', suites.join(','));

// selection helpers
check('chooseAudioCodec prefers Opus over AAC-ELD', sc.chooseAudioCodec(audio).codec === 3);
check('chooseAudioCodec honours an explicit AAC-ELD preference', sc.chooseAudioCodec(audio, 2).codec === 2);
check('largestResolution is 1920x1080', sc.largestResolution(video).width === 1920);
check('bestProfile is HIGH', sc.bestProfile(video) === 2);
check('bestLevel is LEVEL4_0', sc.bestLevel(video) === 2);

// TLV fragmentation: a value longer than 255 bytes must round trip, and a repeat that is not a
// continuation must stay a separate list entry.
const big = Buffer.alloc(600, 0xab);
const encodedBig = tlv.encode(9, big);
check('fragmented value round trips', tlv.decode(encodedBig)[9].equals(big), `${encodedBig.length} bytes encoded`);

const listed = tlv.encodeList(4, [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])]);
const asList = tlv.decodeWithLists(listed)[4];
check('delimited list decodes as separate entries', asList.length === 3 && asList[2][0] === 3, JSON.stringify(asList.map(b => b[0])));

// a short repeat with no delimiter is still two entries, because the first was not 255 bytes.
const shortRepeat = Buffer.concat([tlv.encode(7, Buffer.from([1])), tlv.encode(7, Buffer.from([2]))]);
const repeats = tlv.decodeWithLists(shortRepeat)[7];
check('short repeated type is not concatenated as a fragment', repeats.length === 2, JSON.stringify(repeats.map(b => [...b])));

// A camera whose own lists contradict each other. These are the real capabilities of an Arlo
// Baby: nine resolutions up to 1080p, but only level 3.1, whose ceiling is 3600 macroblocks per
// frame against 1080p's 8160. The camera's own data is still what gets offered first.
const inconsistent = {
    codec: 0,
    profiles: [0, 1],
    levels: [0], // LEVEL3_1
    packetizationModes: [0],
    resolutions: [
        { width: 1920, height: 1080, fps: 30 },
        { width: 1280, height: 720, fps: 30 },
        { width: 640, height: 360, fps: 30 },
        { width: 320, height: 240, fps: 30 },
    ],
};

const hd = { width: 1920, height: 1080, fps: 30 };
const r720 = { width: 1280, height: 720, fps: 30 };
const small = { width: 640, height: 360, fps: 30 };

// Advertised first: never invent a level the camera did not offer, unless nothing it offered fits.
check('a frame the advertised level can carry uses that advertised level',
    sc.advertisedLevelFor(inconsistent, r720) === 0, String(sc.advertisedLevelFor(inconsistent, r720)));
check('a small frame also uses the advertised level',
    sc.advertisedLevelFor(inconsistent, small) === 0);
check('when no advertised level fits, the highest advertised is still offered first',
    sc.advertisedLevelFor(inconsistent, hd) === 0, String(sc.advertisedLevelFor(inconsistent, hd)));
check('the lowest advertised level that fits is chosen, not the highest',
    sc.advertisedLevelFor({ ...inconsistent, levels: [0, 1, 2] }, r720) === 0);
check('1080p on a camera advertising every level picks 4.0',
    sc.advertisedLevelFor({ ...inconsistent, levels: [0, 1, 2] }, hd) === 2);

// The corrective fallback, used only after the advertised configuration is refused.
check('the level 1080p actually requires is 4.0', sc.requiredLevel(hd) === 2, String(sc.requiredLevel(hd)));
check('the level 720p30 actually requires is 3.1', sc.requiredLevel(r720) === 0);
check('1080p is flagged as exceeding the advertised level', sc.exceedsAdvertisedLevel(inconsistent, hd));
check('720p is not flagged', !sc.exceedsAdvertisedLevel(inconsistent, r720));

// Requested sizes are snapped onto the camera's own list, never passed through.
check('an unlisted request snaps to the nearest advertised size',
    sc.nearestResolution(inconsistent, 700, 400).width === 640,
    JSON.stringify(sc.nearestResolution(inconsistent, 700, 400)));
check('an exact request returns that size', sc.nearestResolution(inconsistent, 1280, 720).width === 1280);
check('no request at all returns the largest advertised', sc.nearestResolution(inconsistent).width === 1920);

// Stream management services are allowed to advertise different capabilities: a camera may offer
// full resolution on one and only a substream on another. Reading one and streaming on the other
// is how a well formed request gets rejected as an invalid value.
const mainService = {
    video: { codec: 0, profiles: [0, 1], levels: [0, 2], packetizationModes: [0], resolutions: [hd, r720] },
    audio: { codecs: [{ codec: 3, channels: 1, bitrateMode: 0, samplerate: 1 }], comfortNoise: false },
    cryptoSuites: [0],
};
const subService = {
    video: { codec: 0, profiles: [0], levels: [0], packetizationModes: [0], resolutions: [small] },
    audio: { codecs: [{ codec: 2, channels: 1, bitrateMode: 0, samplerate: 1 }], comfortNoise: false },
    cryptoSuites: [0],
};

check('the main service advertises 1080p', sc.supportsResolution(mainService, hd));
check('the substream service does NOT advertise 1080p', !sc.supportsResolution(subService, hd));
check('the substream service advertises its own size', sc.supportsResolution(subService, small));

const merged = sc.unionCapabilities([mainService, subService]);
const mergedNames = merged.video.resolutions.map(r => `${r.width}x${r.height}`);
check('the union covers resolutions from both services',
    mergedNames.includes('1920x1080') && mergedNames.includes('640x360'), mergedNames.join(', '));
check('the union does not duplicate resolutions', mergedNames.length === 3, mergedNames.join(', '));
check('the union merges profiles and levels',
    merged.video.levels.includes(0) && merged.video.levels.includes(2), merged.video.levels.join(', '));
check('the union merges audio codecs from both services',
    merged.audio.codecs.length === 2, merged.audio.codecs.map(c => c.codec).join(', '));
check('a single service unions to itself', sc.unionCapabilities([mainService]) === mainService);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
